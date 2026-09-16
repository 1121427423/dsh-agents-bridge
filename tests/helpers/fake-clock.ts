/**
 * Deterministic timer queue shared by every suite that needs to drive time.
 *
 * Extracted from tests/kernel/watchdog.test.ts when the manager suite needed
 * the same clock: the whole point of the `Clock` seam is that a watchdog test
 * never really sleeps (a 5 s grace window would make the suite unusable), and
 * duplicating the queue would let the two copies drift.
 *
 * `pending` is the leak detector: after a run reaches a terminal state both the
 * watchdog timers must be gone, and the only way to assert that is to look at
 * what is still armed.
 *
 * @module tests/helpers/fake-clock
 */

import type { Clock } from '../../src/kernel/watchdog.ts'

export class FakeClock implements Clock {
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
