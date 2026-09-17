import { describe, expect, it, vi } from 'vitest'

import { createWatchdog, MAX_TIMER_DELAY_MS, type WatchdogFire } from '../../src/kernel/watchdog.ts'
import { FakeClock } from '../helpers/fake-clock.ts'

describe('createWatchdog', () => {
  it('fires the hard deadline once with kind "timeout"', () => {
    const clock = new FakeClock()
    const fires: WatchdogFire[] = []
    const watchdog = createWatchdog({
      timeoutMs: 1_000,
      clock,
      onFire: (fire) => fires.push(fire),
    })

    clock.advance(999)
    expect(fires).toHaveLength(0)
    clock.advance(1)
    expect(fires).toHaveLength(1)
    expect(fires[0]?.kind).toBe('timeout')
    expect(fires[0]?.timeoutMs).toBe(1_000)
    expect(watchdog.fired?.kind).toBe('timeout')
    expect(watchdog.stopped).toBe(true)

    clock.advance(10_000)
    expect(fires).toHaveLength(1)
    expect(clock.pending).toBe(0)
  })

  it('fires the idle window and resets it on touch', () => {
    const clock = new FakeClock()
    const fires: WatchdogFire[] = []
    const watchdog = createWatchdog({
      idleTimeoutMs: 100,
      clock,
      onFire: (fire) => fires.push(fire),
    })

    clock.advance(90)
    watchdog.touch() // new event: window restarts
    clock.advance(90)
    expect(fires).toHaveLength(0)
    clock.advance(20)
    expect(fires).toHaveLength(1)
    expect(fires[0]?.kind).toBe('idle')
    expect(fires[0]?.idleMs).toBe(100)
  })

  it('lets the hard deadline win over a busy idle window', () => {
    const clock = new FakeClock()
    const fires: WatchdogFire[] = []
    const watchdog = createWatchdog({
      timeoutMs: 100,
      idleTimeoutMs: 30,
      clock,
      onFire: (fire) => fires.push(fire),
    })
    // Events keep arriving every 20 ms, so the idle window never elapses.
    for (let step = 0; step < 4; step += 1) {
      clock.advance(20)
      watchdog.touch()
    }
    expect(fires).toHaveLength(0)
    clock.advance(20)
    expect(fires).toHaveLength(1)
    expect(fires[0]?.kind).toBe('timeout')
  })

  it('arms nothing when both windows are disabled', () => {
    const clock = new FakeClock()
    const onFire = vi.fn()
    const watchdog = createWatchdog({ timeoutMs: 0, idleTimeoutMs: 0, clock, onFire })
    expect(clock.pending).toBe(0)
    watchdog.touch()
    expect(clock.pending).toBe(0)
    clock.advance(1_000_000)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('clears both timers on stop and ignores later touches', () => {
    const clock = new FakeClock()
    const onFire = vi.fn()
    const watchdog = createWatchdog({ timeoutMs: 500, idleTimeoutMs: 100, clock, onFire })
    expect(clock.pending).toBe(2)

    watchdog.stop()
    expect(watchdog.stopped).toBe(true)
    expect(clock.pending).toBe(0)

    watchdog.touch()
    clock.advance(10_000)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('contains a throwing onFire handler', () => {
    const clock = new FakeClock()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const watchdog = createWatchdog({
      timeoutMs: 10,
      clock,
      logger,
      onFire: () => {
        throw new Error('handler exploded')
      },
    })
    expect(() => clock.advance(10)).not.toThrow()
    expect(watchdog.fired?.kind).toBe('timeout')
    expect(logger.error).toHaveBeenCalled()
  })

  it('clamps a deadline above 2^31 ms to the runtime ceiling instead of arming it', () => {
    const clock = new FakeClock()
    const fires: WatchdogFire[] = []
    const watchdog = createWatchdog({
      timeoutMs: 2_147_483_648,
      clock,
      onFire: (fire) => fires.push(fire),
    })

    // 2147483647 is the largest delay a timer can hold; a larger one must be
    // LOWERED to it. Advancing to the ceiling is exactly the boundary the
    // unclamped value would miss.
    clock.advance(MAX_TIMER_DELAY_MS - 1)
    expect(fires).toHaveLength(0)
    clock.advance(1)
    expect(fires).toHaveLength(1)
    expect(fires[0]?.kind).toBe('timeout')
    expect(fires[0]?.timeoutMs).toBe(MAX_TIMER_DELAY_MS)
    expect(watchdog.fired?.timeoutMs).toBe(MAX_TIMER_DELAY_MS)
  })

  it('does not turn a deadline above 2^31 ms into an immediate real timeout', async () => {
    // The injected clock stores the raw delay, so it cannot observe Node's own
    // overflow rule: `setTimeout` rewrites any delay above 2^31-1 to 1 ms and
    // emits `TimeoutOverflowWarning`. That is the production defect, so this
    // one test uses the REAL clock and a real (short) wait.
    const fires: WatchdogFire[] = []
    const warnings: string[] = []
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name)
    }
    process.on('warning', onWarning)
    const watchdog = createWatchdog({
      timeoutMs: 2_147_483_648,
      onFire: (fire) => fires.push(fire),
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(watchdog.fired).toBeUndefined()
      expect(fires).toHaveLength(0)
      expect(warnings).not.toContain('TimeoutOverflowWarning')
    } finally {
      watchdog.stop()
      process.off('warning', onWarning)
    }
  })
})
