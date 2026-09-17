/**
 * Durability across a host restart: the two facts the store must hold while a
 * run is still LIVE.
 *
 *   - IM-4: the detached process-group pid, so a host that dies mid-run can reap
 *     the tree it left behind — guarded against PID REUSE.
 *   - IM-5: the dialect's resume pointer, so `agents_send` still works for a
 *     conversation whose run never got to settle.
 *
 * Both were previously written only at settle (or not at all), which is exactly
 * the window a restart destroys.
 *
 * @module tests/kernel/manager-recover
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBackend } from '../../src/drivers/index.ts'
import { installDriverRuntime } from '../../src/integrate.ts'
import { createLogger } from '../../src/kernel/logger.ts'
import { createAgentManager, type ManagerCreateOptions } from '../../src/kernel/manager.ts'
import type { ProcessReaper } from '../../src/kernel/spawn.ts'
import { createSessionStore } from '../../src/kernel/store.ts'
import type { AgentDescriptor } from '../../src/kernel/types.ts'
import { ManagerPool, NODE, sleep } from '../helpers/manager-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SLOW_CLI = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

function storeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'bridge-recover-'))
}

/** A manager over a store dir, with every identity pointed at the slow fixture. */
function slowManager(dir: string, extra: Partial<ManagerCreateOptions> = {}) {
  installDriverRuntime(100)
  const override: Partial<AgentDescriptor> = {
    command: { executable: NODE, argsPrefix: [SLOW_CLI] },
  }
  return createAgentManager({
    logger: createLogger('recover-test'),
    storeDir: dir,
    defaultCwd: tmpdir(),
    overrides: { claude: override, workbuddy: override, openclaw: override, autoclaw: override },
    createBackend,
    scan: false,
    ...extra,
  })
}

describe('IM-4: a restart reaps the detached process tree it left behind', () => {
  /** Seed a store the way a crashed host would have left it. */
  function seedRunningRow(dir: string, pid: number, startedAt: number): void {
    const store = createSessionStore({ dir })
    store.upsert({
      sessionId: 'sess_orphan',
      agentId: 'claude',
      status: 'running',
      startedAt,
      cwd: tmpdir(),
      pid,
    })
  }

  it('SIGKILLs the recovered process group and marks the row failed', () => {
    const dir = storeDir()
    const startedAt = 1_000_000
    seedRunningRow(dir, 4242, startedAt)

    const kills: number[] = []
    const reaper: ProcessReaper = {
      // The live pid started just after the session did: it is OUR child.
      startTimeMs: (pid) => (pid === 4242 ? startedAt + 50 : undefined),
      killGroup: (pid) => {
        kills.push(pid)
        return true
      },
    }
    const manager = pool.add(slowManager(dir, { reaper }))

    // The guarded kill fired for the recovered group...
    expect(kills).toEqual([4242])
    // ...and the row no longer claims to be running.
    const recovered = manager.status('sess_orphan')
    expect(recovered?.terminal).toBe(true)
    expect(recovered?.status).toBe('failed')
    const onDisk = createSessionStore({ dir }).reload().find((r) => r.sessionId === 'sess_orphan')
    expect(onDisk?.status).toBe('failed')
  })

  it('does NOT signal a pid that was reused by another process', () => {
    // The negative control for the guard: the pid exists, but it belongs to a
    // process that started long after this session did — killing it would be
    // killing an unrelated program. The row is still marked failed.
    const dir = storeDir()
    const startedAt = 1_000_000
    seedRunningRow(dir, 4242, startedAt)

    const kills: number[] = []
    const reaper: ProcessReaper = {
      startTimeMs: () => startedAt + 3_600_000, // one hour later: recycled pid
      killGroup: (pid) => {
        kills.push(pid)
        return true
      },
    }
    const manager = pool.add(slowManager(dir, { reaper }))

    expect(kills).toEqual([])
    expect(manager.status('sess_orphan')?.status).toBe('failed')
  })

  it('does not signal when the process start time cannot be established', () => {
    const dir = storeDir()
    seedRunningRow(dir, 4242, 1_000_000)
    const kills: number[] = []
    const reaper: ProcessReaper = {
      startTimeMs: () => undefined, // `ps` failed / pid gone
      killGroup: (pid) => {
        kills.push(pid)
        return true
      },
    }
    pool.add(slowManager(dir, { reaper }))
    expect(kills).toEqual([])
  })

  it('ignores a running row that carries no pid (pre-upgrade store)', () => {
    const dir = storeDir()
    const store = createSessionStore({ dir })
    store.upsert({ sessionId: 'sess_nopid', agentId: 'claude', status: 'running', startedAt: 5 })

    const kills: number[] = []
    const reaper: ProcessReaper = {
      startTimeMs: (pid) => {
        kills.push(pid)
        return undefined
      },
      killGroup: (pid) => {
        kills.push(pid)
        return true
      },
    }
    const manager = pool.add(slowManager(dir, { reaper }))
    expect(kills).toEqual([])
    expect(manager.status('sess_nopid')?.status).toBe('failed')
  })

  it('persists the live pid while a run is running', async () => {
    const dir = storeDir()
    const manager = slowManager(dir)
    const started = await manager.run({ agent: 'claude', prompt: 'alive', timeoutMs: 0 })
    await sleep(300)

    expect(manager.status(started.sessionId)?.status).toBe('running')
    const row = createSessionStore({ dir })
      .reload()
      .find((r) => r.sessionId === started.sessionId)
    expect(row?.status).toBe('running')
    // The pid is the spawn's process-group leader. Asserting it is a positive
    // integer is enough: the exact value is the OS's business.
    expect(typeof row?.pid === 'number' && row.pid > 0).toBe(true)

    await manager.dispose()
    // A settled row must NOT still advertise a pid to the reaper.
    const settled = createSessionStore({ dir })
      .reload()
      .find((r) => r.sessionId === started.sessionId)
    expect(settled?.pid).toBeUndefined()
  })
})

describe('IM-5: the resume pointer is durable before the run settles', () => {
  it('writes backendSessionId mid-run, from the driver stream', async () => {
    const dir = storeDir()
    const manager = slowManager(dir)
    // fake-slow-cli emits `system/init` with session_id 'fake-slow-session' and
    // then stays alive forever, so the pointer is observed while RUNNING.
    const started = await manager.run({ agent: 'claude', prompt: 'remember me', timeoutMs: 0 })
    await sleep(400)

    const snapshot = manager.status(started.sessionId)
    expect(snapshot?.status).toBe('running')

    // A crash-and-restart would read the store, not the in-memory session.
    const row = createSessionStore({ dir })
      .reload()
      .find((r) => r.sessionId === started.sessionId)
    expect(row?.status).toBe('running')
    expect(row?.backendSessionId).toBe('fake-slow-session')

    // And a fresh manager over the same dir can resume once the run settles.
    await manager.dispose()
    const restarted = pool.add(slowManager(dir))
    const recovered = restarted.status(started.sessionId)
    expect(recovered?.result?.backendSessionId).toBe('fake-slow-session')
  })
})
