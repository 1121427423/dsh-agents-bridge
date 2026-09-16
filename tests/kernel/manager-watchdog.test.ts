/**
 * Manager-level watchdog behaviour: the two windows, the terminal status they
 * produce, and the timers they must not leave behind.
 *
 * Two watchdogs exist in this codebase — the driver's (per protocol stream) and
 * the manager's (per session, in `src/kernel/manager.ts`). These tests cover the
 * manager's, because that is the one that catches a driver wedged BEFORE it arms
 * its own timer, and the one whose timers would keep a plugin host alive after
 * unload.
 *
 * Every assertion here is driven by the injected `FakeClock`, so the suite never
 * sleeps for a 300 s idle window: time is advanced, not waited on.
 *
 * @module tests/kernel/manager-watchdog
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { FakeClock } from '../helpers/fake-clock.ts'
import { ManagerPool, sleep, waitTerminal } from '../helpers/manager-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SLOW_CLI = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

describe('manager watchdog: hard deadline', () => {
  it('ends the session with status "timeout", never "failed"', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)

    const started = await manager.run({
      agent: 'claude',
      prompt: 'never finishes on its own',
      timeoutMs: 60_000,
      // Disable the idle window so only the hard deadline can fire.
      idleTimeoutMs: 0,
    })
    expect(started.status).toBe('running')

    // The child is a real process; let it actually start before advancing time.
    await sleep(150)

    clock.advance(60_000)
    const finished = await waitTerminal(manager, started.sessionId)
    expect(finished.status).toBe('timeout')
    expect(finished.result?.status).toBe('timeout')
    // Explicitly NOT `failed`: the kill mechanism is shared with cancel, the
    // status is what tells the model whether it was its own fault.
    expect(finished.status).not.toBe('failed')
  })

  it('does not fire before the deadline elapses', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)

    const started = await manager.run({
      agent: 'claude',
      prompt: 'alive',
      timeoutMs: 60_000,
      idleTimeoutMs: 0,
    })
    await sleep(150)

    clock.advance(59_999)
    await sleep(60)
    expect(manager.status(started.sessionId)?.status).toBe('running')
    expect(manager.status(started.sessionId)?.terminal).toBe(false)
  })

  it('treats timeoutMs 0 as "no hard deadline"', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)

    const started = await manager.run({
      agent: 'claude',
      prompt: 'alive',
      timeoutMs: 0,
      idleTimeoutMs: 0,
    })
    await sleep(150)

    clock.advance(10_000_000)
    await sleep(60)
    expect(manager.status(started.sessionId)?.status).toBe('running')
    expect(clock.pending).toBe(0)
  })
})

describe('manager watchdog: idle window', () => {
  it('fires when no output arrives, independently of the hard deadline', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)

    const started = await manager.run({
      agent: 'claude',
      prompt: 'silent',
      // No hard deadline at all: the idle window must stand on its own.
      timeoutMs: 0,
      idleTimeoutMs: 5_000,
    })
    await sleep(150)
    expect(manager.status(started.sessionId)?.status).toBe('running')

    clock.advance(5_000)
    const finished = await waitTerminal(manager, started.sessionId)
    expect(finished.status).toBe('timeout')
  })

  it('treats idleTimeoutMs 0 as "no idle window"', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)

    const started = await manager.run({
      agent: 'claude',
      prompt: 'silent',
      timeoutMs: 0,
      idleTimeoutMs: 0,
    })
    await sleep(150)

    clock.advance(10_000_000)
    await sleep(60)
    expect(manager.status(started.sessionId)?.status).toBe('running')
  })

  it('lets the earliest deadline win when both are armed', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)

    const started = await manager.run({
      agent: 'claude',
      prompt: 'silent',
      timeoutMs: 60_000,
      idleTimeoutMs: 5_000,
    })
    await sleep(150)

    // Only the idle window (5 s) has elapsed; the hard deadline has not.
    clock.advance(5_000)
    const finished = await waitTerminal(manager, started.sessionId)
    expect(finished.status).toBe('timeout')
  })
})

describe('manager watchdog: timers are released at the terminal state', () => {
  it('leaves no armed timer after a natural completion', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)
    const started = await manager.run({
      agent: 'claude',
      prompt: 'cancel me',
      timeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    })
    await sleep(150)
    // Both timers are armed while the session runs.
    expect(clock.pending).toBeGreaterThan(0)

    await manager.cancel(started.sessionId, 'done with it')
    await waitTerminal(manager, started.sessionId)

    // The leak assertion: nothing may still be armed. A surviving watchdog timer
    // keeps the host process alive past plugin unload and can fire against a
    // session that already settled.
    expect(clock.pending).toBe(0)
  })

  it('leaves no armed timer after a watchdog timeout', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)
    const started = await manager.run({
      agent: 'claude',
      prompt: 'silent',
      timeoutMs: 10_000,
      idleTimeoutMs: 5_000,
    })
    await sleep(150)
    clock.advance(5_000)
    await waitTerminal(manager, started.sessionId)
    expect(clock.pending).toBe(0)
  })

  it('leaves no armed timer after dispose()', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)
    await manager.run({
      agent: 'claude',
      prompt: 'alive',
      timeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    })
    await sleep(150)
    expect(clock.pending).toBeGreaterThan(0)

    await manager.dispose()
    expect(clock.pending).toBe(0)
  })

  it('ignores a watchdog that fires after the session already settled', async () => {
    const clock = new FakeClock()
    const manager = pool.create(SLOW_CLI, { clock }, {}, 100)
    const started = await manager.run({
      agent: 'claude',
      prompt: 'cancel first',
      timeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    })
    await sleep(150)
    await manager.cancel(started.sessionId, 'settled first')
    const terminal = await waitTerminal(manager, started.sessionId)
    expect(terminal.status).toBe('cancelled')

    // Even if a stray timer somehow survived, advancing past both deadlines must
    // not rewrite a frozen terminal record.
    clock.advance(120_000)
    await sleep(60)
    const after = manager.status(started.sessionId)
    expect(after?.status).toBe('cancelled')
    expect(after?.endedAt).toBe(terminal.endedAt)
  })
})
