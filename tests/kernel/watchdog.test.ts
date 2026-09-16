import { describe, expect, it, vi } from 'vitest'

import { createWatchdog, type Clock, type WatchdogFire } from '../../src/kernel/watchdog.ts'

/** Deterministic timer queue: `advance()` fires everything that came due. */
class FakeClock implements Clock {
  #now = 0
  #nextId = 1
  #timers = new Map<number, { at: number; handler: () => void }>()

  /** `Clock.now` is a method on the interface. Exposing it as a number field
   *  made the watchdog detach the reference and throw "now is not a function". */
  now(): number {
    return this.#now
  }

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.#nextId++
    this.#timers.set(id, { at: this.#now + ms, handler })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number)
  }

  /** Fire due timers one at a time, in due order, letting handlers re-arm. */
  advance(ms: number): void {
    const target = this.#now + ms
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      this.#timers.delete(id)
      this.#now = Math.max(this.#now, timer.at)
      timer.handler()
    }
    this.#now = target
  }

  get pending(): number {
    return this.#timers.size
  }
}

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
})
