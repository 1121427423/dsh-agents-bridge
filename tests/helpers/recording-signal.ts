/**
 * An `AbortSignal` stand-in that records its listeners.
 *
 * Why this exists: a driver registers an abort listener for the whole run and
 * must release it on EVERY settle path, including the early returns taken by a
 * cancelled / timed-out run. A listener left behind keeps the run-scoped
 * closure — the spawn handle, the parser, the session — reachable from the
 * caller's `AbortController`. The real `AbortSignal` offers no way to observe
 * that, so tests that assert the release need a seam that can be asked how many
 * listeners are still attached.
 *
 * The tests deliberately do NOT drive cancellation through this object: the
 * platform releases a `once` listener itself the moment it fires, so an
 * abort-driven cancel would report zero listeners whether or not the driver
 * released anything. Cancelling through the session instead is the case that
 * exposes the leak.
 *
 * @module tests/helpers/recording-signal
 */

interface Registration {
  readonly type: string
  readonly listener: () => void
}

export class RecordingSignal {
  aborted = false
  #registrations: Registration[] = []

  addEventListener(type: string, listener: () => void): void {
    this.#registrations.push({ type, listener })
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#registrations = this.#registrations.filter(
      (entry) => !(entry.type === type && entry.listener === listener),
    )
  }

  /** Number of listeners still registered for `type` (default: abort). */
  listenerCount(type = 'abort'): number {
    return this.#registrations.filter((entry) => entry.type === type).length
  }

  /** The driver only ever calls the two methods above plus `.aborted`. */
  asAbortSignal(): AbortSignal {
    return this as unknown as AbortSignal
  }
}
