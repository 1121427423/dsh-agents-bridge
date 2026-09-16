/**
 * Cancellation must not leave a process tree behind.
 *
 * This is the one that matters: a bridge that can start an agent but cannot
 * reliably stop it turns every cancelled run into leaked CPU, leaked file
 * handles and — eventually — a machine the user has to reboot. These tests run
 * REAL processes (no mocks) because the whole claim is about what the operating
 * system does with SIGTERM, the grace window and process groups.
 *
 * The fixture (`tests/fixtures/fake-forking-cli.mjs`) forks a grandchild and
 * deliberately ignores SIGTERM, so:
 *   - the grandchild proves `detached: true` really creates a process GROUP that
 *     `process.kill(-pid, …)` reaches, and
 *   - the ignored SIGTERM proves the grace window actually expires and SIGKILL
 *     is what ends the tree (a single-SIGTERM implementation fails here).
 *
 * The report path reaches the fixture through `CommandSpec.env`, because each
 * driver appends its own dialect flags in its own order — a positional argument
 * is not addressable from a fake CLI that has to work under every dialect.
 *
 * Time budget: one real grace window of 120 ms per cancellation, never 5 s.
 *
 * @module tests/kernel/manager-cancel
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { processGone } from '../../src/kernel/spawn.ts'
import {
  ManagerPool,
  readForkReport,
  sleep,
  waitAllGone,
  waitForkReady,
  waitTerminal,
} from '../helpers/manager-harness.ts'
import type { AgentManager, ManagerOptions } from '../../src/kernel/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FORKING_CLI = path.join(here, '..', 'fixtures', 'fake-forking-cli.mjs')
const SLOW_CLI = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

/** Long enough to be a real grace window, short enough to keep the suite fast. */
const GRACE_MS = 120

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

function forkingManager(reportPath: string): AgentManager {
  return pool.create(FORKING_CLI, {}, { BRIDGE_FORK_REPORT: reportPath }, GRACE_MS)
}

/**
 * A manager whose engine never exits on its own, with a short grace window.
 * `graceMs` is installed through the driver runtime seam (see the harness), not
 * through `ManagerOptions` — one installation path, so a test cannot configure a
 * window that production code would ignore.
 */
function slowManager(overrides: Partial<ManagerOptions> = {}): AgentManager {
  return pool.create(SLOW_CLI, overrides, {}, GRACE_MS)
}

function reportPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'bridge-fork-')), 'report.json')
}

describe('cancellation kills the whole process tree', () => {
  it('leaves no orphan: child AND grandchild are gone after cancel', async () => {
    const report = reportPath()
    const manager = forkingManager(report)

    const started = await manager.run({
      agent: 'claude',
      prompt: 'fork a child and stay alive',
      timeoutMs: 0,
    })
    expect(started.status).toBe('running')

    // Wait for BOTH processes to exist before cancelling: cancelling earlier
    // would pass trivially and prove nothing about group-kill.
    const ready = await waitForkReady(report)
    expect(ready.childPid).toBeGreaterThan(0)
    expect(ready.grandchildPid).toBeGreaterThan(0)
    // Sanity: the grandchild is alive before we cancel, so its later absence is
    // meaningful rather than a process that never existed.
    expect(processGone(ready.grandchildPid!)).toBe(false)
    expect(manager.status(started.sessionId)?.status).toBe('running')

    const cancelled = await manager.cancel(started.sessionId, 'test: tree must die')
    expect(cancelled).toBe(true)

    const finished = await waitTerminal(manager, started.sessionId)
    expect(finished.status).toBe('cancelled')
    expect(finished.terminal).toBe(true)

    // The actual proof: neither process exists any more. `process.kill(pid, 0)`
    // throwing ESRCH is the same check `ps` would make.
    expect(await waitAllGone([ready.childPid, ready.grandchildPid])).toBe(true)
    expect(processGone(ready.childPid)).toBe(true)
    expect(processGone(ready.grandchildPid!)).toBe(true)

    // And the fixture really did receive SIGTERM and refuse to exit, i.e. the
    // kernel had to escalate rather than getting lucky with a prompt exit.
    expect(readForkReport(report)?.childSignal).toBe('SIGTERM')
  })

  it('kills the group within the escalation budget, not the test timeout', async () => {
    const report = reportPath()
    const manager = forkingManager(report)
    const started = await manager.run({ agent: 'claude', prompt: 'ignore SIGTERM', timeoutMs: 0 })
    const ready = await waitForkReady(report)

    const startedAt = Date.now()
    await manager.cancel(started.sessionId, 'test: escalate')
    await waitTerminal(manager, started.sessionId)
    const elapsed = Date.now() - startedAt

    // A SIGTERM-only implementation would sit here until the test timeout.
    expect(elapsed).toBeLessThan(4_000)
    expect(await waitAllGone([ready.childPid, ready.grandchildPid])).toBe(true)
  })

  it('is idempotent: repeated cancels do not throw and do not change the outcome', async () => {
    const manager = slowManager()
    const started = await manager.run({ agent: 'claude', prompt: 'stay alive', timeoutMs: 0 })
    await sleep(120)

    expect(await manager.cancel(started.sessionId, 'first')).toBe(true)
    // Already terminal: the second call reports "nothing to do" rather than
    // re-running the kill, and never throws.
    expect(await manager.cancel(started.sessionId, 'second')).toBe(false)
    expect(await manager.cancel(started.sessionId)).toBe(false)

    const terminal = await waitTerminal(manager, started.sessionId)
    expect(terminal.status).toBe('cancelled')

    // Frozen: further reads must not move the record.
    const before = JSON.stringify(manager.status(started.sessionId))
    await sleep(80)
    expect(JSON.stringify(manager.status(started.sessionId))).toBe(before)
  })

  it('reports false for an unknown session instead of throwing', async () => {
    const manager = slowManager()
    expect(await manager.cancel('sess_does_not_exist')).toBe(false)
  })

  it('records the cancel reason on the terminal result', async () => {
    const manager = slowManager()
    const started = await manager.run({ agent: 'claude', prompt: 'stay alive', timeoutMs: 0 })
    await sleep(120)
    await manager.cancel(started.sessionId, 'user asked to stop')
    const finished = await waitTerminal(manager, started.sessionId)
    expect(finished.status).toBe('cancelled')
    expect(finished.result?.error).toContain('cancelled')
  })
})

describe('dispose() reaps every live session', () => {
  it('kills all running children so unloading the plugin leaves no orphan', async () => {
    const report = reportPath()
    const manager = forkingManager(report)

    // Two live sessions at once: dispose() must handle the set, not just one.
    // `codex` is a real built-in id (a made-up one would be rejected by the
    // registry before any process existed, proving nothing about dispose).
    const first = await manager.run({ agent: 'claude', prompt: 'session one', timeoutMs: 0 })
    const ready = await waitForkReady(report)
    const second = await manager.run({ agent: 'codex', prompt: 'session two', timeoutMs: 0 })

    expect(manager.status(first.sessionId)?.status).toBe('running')
    expect(manager.status(second.sessionId)?.status).toBe('running')

    await manager.dispose()

    // The manager stops tracking them, but the OS processes must really be gone.
    expect(await waitAllGone([ready.childPid, ready.grandchildPid])).toBe(true)
    expect(processGone(ready.grandchildPid!)).toBe(true)
    // Disposed sessions stay readable, with a truthful terminal status.
    expect(manager.status(first.sessionId)?.terminal).toBe(true)
    expect(manager.status(first.sessionId)?.status).toBe('cancelled')
  })

  it('is safe to call twice and refuses new runs afterwards', async () => {
    const manager = slowManager()
    await manager.dispose()
    await expect(manager.dispose()).resolves.toBeUndefined()
    await expect(manager.run({ agent: 'claude', prompt: 'too late' })).rejects.toThrow(/disposed/)
  })

  it('leaves no unreaped child process after dispose', async () => {
    const manager = slowManager()
    await manager.run({ agent: 'claude', prompt: 'stay alive', timeoutMs: 0 })
    await sleep(120)
    await manager.dispose()

    // `ProcessWrap` is libuv's *wait* handle, and libuv releases it lazily (on
    // the next GC pass), so it is not evidence of a leak — a `ChildProcess`
    // reference would be. The real claim is behavioural: every pid is gone,
    // which the orphan tests above assert directly with `process.kill(pid, 0)`.
    const unreaped = process.getActiveResourcesInfo().filter((kind) => kind === 'ChildProcess')
    expect(unreaped).toEqual([])
  })
})

describe('cancelled sessions stay cancelled', () => {
  it('does not let a late driver settle overwrite the cancelled status', async () => {
    const manager = slowManager()
    const started = await manager.run({ agent: 'claude', prompt: 'stay alive', timeoutMs: 0 })
    await sleep(120)
    await manager.cancel(started.sessionId, 'first writer wins')

    const terminal = await waitTerminal(manager, started.sessionId)
    expect(terminal.status).toBe('cancelled')

    // Wait past any plausible late settle from the driver.
    await sleep(250)
    const after = manager.status(started.sessionId)
    expect(after?.status).toBe('cancelled')
    expect(after?.result?.status).toBe('cancelled')
    expect(after?.endedAt).toBe(terminal.endedAt)
  })

  it('freezes the transcript at the terminal state', async () => {
    const manager = slowManager()
    const started = await manager.run({ agent: 'claude', prompt: 'stay alive', timeoutMs: 0 })
    await sleep(120)
    await manager.cancel(started.sessionId, 'freeze')
    await waitTerminal(manager, started.sessionId)

    const first = manager.output(started.sessionId)
    expect(first).toBeDefined()
    await sleep(120)
    const second = manager.output(started.sessionId)
    expect(second?.messages.length).toBe(first?.messages.length)
    expect(second?.nextIndex).toBe(first?.nextIndex)
  })
})
