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
import { processGone } from '../../src/kernel/spawn.ts'
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

/**
 * Seed a store the way a crashed host would have left it.
 *
 * `owner` is the OWNER EVIDENCE RR-IM-2 requires before any signal: the pid of
 * the host process that wrote the row and that process's own start time.
 * Passing `null` seeds a pre-upgrade row with no evidence at all.
 */
function seedRunningRow(
  dir: string,
  pid: number,
  startedAt: number,
  owner: { readonly pid: number; readonly startedAt: number } | null = {
    pid: 99_999,
    startedAt: startedAt - 1_000,
  },
): void {
  const store = createSessionStore({ dir })
  store.upsert({
    sessionId: 'sess_orphan',
    agentId: 'claude',
    status: 'running',
    startedAt,
    cwd: tmpdir(),
    pid,
    ...(owner === null ? {} : { ownerPid: owner.pid, ownerStartedAt: owner.startedAt }),
  })
}

/**
 * A reaper whose world is pinned to `seedRunningRow`'s row: the owner (pid
 * 99_999) is gone unless asked otherwise, the child pid 4242 is the process we
 * spawned, and `kills` records every signal.
 */
function orphanReaper(options: { ownerAlive?: boolean; childStartedAt?: number } = {}): {
  reaper: ProcessReaper
  kills: number[]
} {
  const kills: number[] = []
  const reaper: ProcessReaper = {
    isAlive: (pid) => (pid === 99_999 ? options.ownerAlive === true : false),
    startTimeMs: (pid) => (pid === 4242 ? options.childStartedAt : undefined),
    killGroup: (pid) => {
      kills.push(pid)
      return true
    },
  }
  return { reaper, kills }
}

describe('IM-4: a restart reaps the detached process tree it left behind', () => {
  it('reaps a recovered group whose owner is provably gone, and marks the row failed', () => {
    const dir = storeDir()
    const startedAt = 1_000_000
    seedRunningRow(dir, 4242, startedAt)
    const { reaper, kills } = orphanReaper({ childStartedAt: startedAt + 50 })
    const manager = pool.add(slowManager(dir, { reaper }))

    // The owner is gone AND the child pid is still the process we spawned, so
    // the group is a genuine orphan.
    expect(kills).toEqual([4242])
    const recovered = manager.status('sess_orphan')
    expect(recovered?.terminal).toBe(true)
    expect(recovered?.status).toBe('failed')
    const onDisk = createSessionStore({ dir }).reload().find((r) => r.sessionId === 'sess_orphan')
    expect(onDisk?.status).toBe('failed')
    // The stale row must not keep advertising a pid the next restart would try
    // to reap all over again.
    expect(onDisk?.pid).toBeUndefined()
    expect(onDisk?.ownerPid).toBeUndefined()
  })

  it('does NOT signal a pid that was reused by another process', () => {
    // Negative control for the CHILD guard: the owner is gone, but the pid now
    // belongs to a process that started long after this session did — killing it
    // would be killing an unrelated program. The row is still marked failed.
    const dir = storeDir()
    const startedAt = 1_000_000
    seedRunningRow(dir, 4242, startedAt)
    const { reaper, kills } = orphanReaper({ childStartedAt: startedAt + 3_600_000 })
    const manager = pool.add(slowManager(dir, { reaper }))

    expect(kills).toEqual([])
    expect(manager.status('sess_orphan')?.status).toBe('failed')
  })

  it('does not signal when the process start time cannot be established', () => {
    const dir = storeDir()
    seedRunningRow(dir, 4242, 1_000_000)
    const { reaper, kills } = orphanReaper({ childStartedAt: undefined })
    pool.add(slowManager(dir, { reaper }))
    expect(kills).toEqual([])
  })

  it('ignores a running row that carries no pid (pre-upgrade store)', () => {
    const dir = storeDir()
    const store = createSessionStore({ dir })
    store.upsert({ sessionId: 'sess_nopid', agentId: 'claude', status: 'running', startedAt: 5 })

    const kills: number[] = []
    const reaper: ProcessReaper = {
      isAlive: () => false,
      startTimeMs: () => undefined,
      // Only killGroup is recorded: `startTimeMs` is also asked for the OWNER
      // token at manager construction, and counting that as a signal would make
      // this control meaningless.
      killGroup: (pid) => {
        kills.push(pid)
        return true
      },
    }
    const manager = pool.add(slowManager(dir, { reaper }))
    expect(kills).toEqual([])
    expect(manager.status('sess_nopid')?.status).toBe('failed')
  })

  it('persists the live pid and the owner evidence while a run is running', async () => {
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
    // RR-IM-2: the row also names the host process that owns it, with that
    // process's own start time, so a second host can tell "my own live run" from
    // "a dead host's orphan" instead of killing on a guess.
    expect(row?.ownerPid).toBe(process.pid)
    expect(typeof row?.ownerStartedAt).toBe('number')

    await manager.dispose()
    // A settled row must NOT still advertise a pid (or owner) to the reaper.
    const settled = createSessionStore({ dir })
      .reload()
      .find((r) => r.sessionId === started.sessionId)
    expect(settled?.pid).toBeUndefined()
    expect(settled?.ownerPid).toBeUndefined()
    expect(settled?.ownerStartedAt).toBeUndefined()
  })
})

describe('RR-IM-2: recovery needs evidence that the OWNER died', () => {
  it('leaves a live owner\'s child and running row strictly alone', async () => {
    // Manager A is the owner: a real fixture run, its row on disk with a live
    // pid. Manager B opens the SAME store dir (a second plugin instance / a
    // second host sharing DSH_HOME). B must not reap A's tree, and must not
    // rewrite A's row: the old code did both on the assumption that any
    // persisted `running` row belongs to a dead host.
    const dir = storeDir()
    const owner = pool.add(slowManager(dir))
    const started = await owner.run({ agent: 'claude', prompt: 'keep me alive', timeoutMs: 0 })
    await sleep(400)

    const row = createSessionStore({ dir })
      .reload()
      .find((r) => r.sessionId === started.sessionId)
    expect(row?.status).toBe('running')
    expect(typeof row?.pid === 'number').toBe(true)
    // Same-process semantics: the owner token is this process, which is alive.
    expect(row?.ownerPid).toBe(process.pid)
    const childPid = row?.pid as number
    expect(processGone(childPid)).toBe(false)

    const second = pool.add(slowManager(dir))
    // B does not claim the session is live HERE (it cannot see A's transcript)…
    const viaB = second.status(started.sessionId)
    expect(viaB?.terminal).toBe(true)
    expect(viaB?.status).toBe('failed')
    // …but A's row and A's process tree are untouched.
    const after = createSessionStore({ dir })
      .reload()
      .find((r) => r.sessionId === started.sessionId)
    expect(after?.status).toBe('running')
    expect(after?.pid).toBe(childPid)
    expect(processGone(childPid)).toBe(false)
    // And A itself still believes the run is live.
    expect(owner.status(started.sessionId)?.status).toBe('running')

    await owner.dispose()
  })

  it('never signals a row with no owner evidence (unknown is not evidence)', () => {
    // The pre-upgrade row shape: a pid, a start time, and nothing about who
    // wrote it. "I cannot tell" must never become "kill it".
    const dir = storeDir()
    const startedAt = 1_000_000
    seedRunningRow(dir, 4242, startedAt, null)

    const kills: number[] = []
    const reaper: ProcessReaper = {
      // Even a permissive start-time match must not be enough on its own.
      isAlive: () => false,
      startTimeMs: (pid) => (pid === 4242 ? startedAt + 50 : undefined),
      killGroup: (pid) => {
        kills.push(pid)
        return true
      },
    }
    const manager = pool.add(slowManager(dir, { reaper }))

    expect(kills).toEqual([])
    // The row keeps saying `running`: B cannot prove the owner died, so it must
    // not publish a terminal claim over another host's live session. Callers
    // are still told it is not live HERE (restored rows are never `running`).
    expect(manager.status('sess_orphan')?.status).toBe('failed')
    const onDisk = createSessionStore({ dir }).reload().find((r) => r.sessionId === 'sess_orphan')
    expect(onDisk?.status).toBe('running')
  })

  it('recovers when the stored owner pid was recycled by a different process', () => {
    // The owner pid answers, but its start time proves it is NOT the process
    // that wrote the row — the real owner is gone, so this is a genuine orphan.
    const dir = storeDir()
    const startedAt = 1_000_000
    seedRunningRow(dir, 4242, startedAt, { pid: 99_999, startedAt: 900_000 })

    const kills: number[] = []
    const reaper: ProcessReaper = {
      isAlive: () => true,
      startTimeMs: (pid) => (pid === 4242 ? startedAt + 50 : 1_700_000_000_000),
      killGroup: (pid) => {
        kills.push(pid)
        return true
      },
    }
    const manager = pool.add(slowManager(dir, { reaper }))

    expect(kills).toEqual([4242])
    expect(manager.status('sess_orphan')?.status).toBe('failed')
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
