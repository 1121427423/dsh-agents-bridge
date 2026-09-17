/**
 * `agents_send` / resume robustness.
 *
 * The failure this suite exists to prevent: the model treats a minutes-long
 * agent run as a chat, sends a second prompt mid-flight, and gets silence. The
 * second-worst: the bridge restarts, and every session the model was tracking
 * vanishes from `status()` even though the store still holds it.
 *
 * Resume is inherently best-effort — the engine on the other side may have
 * forgotten a session id it accepted ten minutes ago — so the requirement is not
 * "resume always works" but "a resume that cannot work says so, immediately and
 * in a way the model can act on".
 *
 * @module tests/kernel/manager-resume
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createBackend } from '../../src/drivers/index.ts'
import { installDriverRuntime } from '../../src/integrate.ts'
import { createLogger } from '../../src/kernel/logger.ts'
import { createAgentManager } from '../../src/kernel/manager.ts'
import type { AgentDescriptor, AgentManager, ManagerOptions } from '../../src/kernel/types.ts'
import { ManagerPool, NODE, sleep, waitTerminal } from '../helpers/manager-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const STREAM_CLI = path.join(here, '..', 'fixtures', 'fake-stream-json-cli.mjs')
const SLOW_CLI = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

/** The replay fixture reports this id from its `system/init` frame. */
const FAKE_BACKEND_SESSION = 'fake-session-0001'

function streamManager(storeDir: string): AgentManager {
  installDriverRuntime(100)
  const override: Partial<AgentDescriptor> = {
    command: { executable: NODE, argsPrefix: [STREAM_CLI] },
  }
  const options: ManagerOptions = {
    logger: createLogger('resume-test'),
    storeDir,
    defaultCwd: tmpdir(),
    overrides: { claude: override, workbuddy: override, openclaw: override, autoclaw: override },
    createBackend,
  }
  return pool.add(createAgentManager(options))
}

describe('send() on a session that is still running', () => {
  it('refuses with an actionable message instead of silently doing nothing', async () => {
    const manager = pool.create(SLOW_CLI, {}, {}, 100)
    const started = await manager.run({ agent: 'claude', prompt: 'still going', timeoutMs: 0 })
    await sleep(150)
    expect(manager.status(started.sessionId)?.status).toBe('running')

    const error = await manager.send(started.sessionId, 'are you done?').catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)

    const message = (error as Error).message
    // Names the session and its live status...
    expect(message).toContain(started.sessionId)
    expect(message).toContain('running')
    // ...and tells the model what to do next, not just what went wrong.
    expect(message).toMatch(/agents_status|agents_cancel|agents_run/)
  })

  it('still refuses while the session is being cancelled but not yet terminal', async () => {
    const manager = pool.create(SLOW_CLI, {}, {}, 100)
    const started = await manager.run({ agent: 'claude', prompt: 'going', timeoutMs: 0 })
    await sleep(150)
    void manager.cancel(started.sessionId, 'stopping')
    // The precondition is ASSERTED, not assumed. The old `if (status ===
    // 'running')` skipped its only assertion whenever spawn or the fixture
    // failed, so the test went green having checked nothing (MI-15). `cancel()`
    // is fire-and-forget and its terminal transition needs an await, so the
    // status read here is deterministic — no branch is needed.
    const status = manager.status(started.sessionId)?.status
    expect(status).toBe('running')
    await expect(manager.send(started.sessionId, 'ping')).rejects.toThrow(/still running/)
  })
})

describe('send() on an unknown or unresumable session', () => {
  it('names an unknown session and points at status/run', async () => {
    const manager = pool.create(SLOW_CLI, {}, {}, 100)
    const error = await manager.send('sess_nope', 'hello').catch((err: unknown) => err)
    expect((error as Error).message).toContain('sess_nope')
    expect((error as Error).message).toMatch(/agents_status|agents_run/)
  })

  it('explains that a session with no backend id cannot be resumed', async () => {
    // The slow fixture never emits a session_id, so no resume pointer is ever
    // captured: this is the "engine gave us nothing to continue" case.
    const manager = pool.create(SLOW_CLI, {}, {}, 100)
    const started = await manager.run({ agent: 'claude', prompt: 'no session id', timeoutMs: 0 })
    await sleep(150)
    await manager.cancel(started.sessionId, 'done')
    await waitTerminal(manager, started.sessionId)

    const error = await manager.send(started.sessionId, 'continue').catch((err: unknown) => err)
    const message = (error as Error).message
    expect(message).toContain('cannot resume')
    expect(message).toMatch(/agents_run/)
  })
})

describe('the resume pointer survives a restart', () => {
  it('persists backendSessionId and keeps status() working after recreation', async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), 'bridge-resume-'))
    const first = streamManager(storeDir)

    const started = await first.run({ agent: 'claude', prompt: 'remember me', timeoutMs: 0 })
    const finished = await waitTerminal(first, started.sessionId)
    expect(finished.status).toBe('completed')
    expect(finished.result?.backendSessionId).toBe(FAKE_BACKEND_SESSION)

    // Simulate a plugin restart: dispose, then build a new manager over the SAME
    // store directory. This is what an HMR reload or a host restart does.
    await first.dispose()

    const second = streamManager(storeDir)
    const recovered = second.status(started.sessionId)
    expect(recovered).toBeDefined()
    expect(recovered?.terminal).toBe(true)
    expect(recovered?.status).toBe('completed')
    // The resume pointer is the thing that makes `agents_send` possible at all.
    expect(recovered?.result?.backendSessionId).toBe(FAKE_BACKEND_SESSION)
  })

  it('exposes recovered sessions through list() too', async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), 'bridge-resume-'))
    const first = streamManager(storeDir)
    const started = await first.run({ agent: 'claude', prompt: 'list me', timeoutMs: 0 })
    await waitTerminal(first, started.sessionId)
    await first.dispose()

    const second = streamManager(storeDir)
    const listed = second.list().find((session) => session.sessionId === started.sessionId)
    expect(listed).toBeDefined()
    expect(listed?.terminal).toBe(true)
  })

  it('does not claim a pre-restart session is still running', async () => {
    // A stored `running` row belongs to a process that no longer exists. Telling
    // the model "still running" would make it poll forever for a dead session.
    const storeDir = mkdtempSync(path.join(tmpdir(), 'bridge-resume-'))
    installDriverRuntime(100)
    const override: Partial<AgentDescriptor> = {
      command: { executable: NODE, argsPrefix: [SLOW_CLI] },
    }
    const first = pool.add(
      createAgentManager({
        logger: createLogger('resume-test'),
        storeDir,
        defaultCwd: tmpdir(),
        overrides: { claude: override, workbuddy: override, openclaw: override, autoclaw: override },
        createBackend,
      }),
    )
    const started = await first.run({ agent: 'claude', prompt: 'killed mid flight', timeoutMs: 0 })
    await sleep(150)
    expect(first.status(started.sessionId)?.status).toBe('running')

    // Dispose WITHOUT cancelling first: the store still says `running`, which is
    // exactly the state a crashed host leaves behind.
    first.dispose().catch(() => undefined)
    await sleep(200)

    const second = streamManager(storeDir)
    const recovered = second.status(started.sessionId)
    expect(recovered).toBeDefined()
    expect(recovered?.terminal).toBe(true)
    expect(recovered?.status).not.toBe('running')
  })
})
