/**
 * Run watchdogs: one idle window (no new events) and one hard wall-clock
 * deadline. Both clocks are injected so unit tests can drive time instead of
 * sleeping, and both are cleared the moment the run reaches a terminal state —
 * no dangling handles, so a test process can always exit on its own.
 *
 * Semantics (design doc §7):
 *   - `timeoutMs`     hard deadline; 0/undefined = no deadline.
 *   - `idleTimeoutMs` no-output window, reset by `touch()` on every event.
 *   - Firing reports `kind`, and the manager turns that into `status:'timeout'`.
 *
 * @module dsh-agents-bridge/kernel/watchdog
 */

import type { BridgeLogger } from './types.ts'

export type WatchdogKind = 'idle' | 'timeout'

export interface WatchdogFire {
  readonly kind: WatchdogKind
  /** Wall-clock ms since the watchdog was armed. */
  readonly elapsedMs: number
  readonly idleMs?: number
  readonly timeoutMs?: number
}

/** Minimal timer seam: `globalThis` timers by default, fake timers in tests. */
export interface Clock {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Epoch ms, used only for the `elapsedMs` report. */
  now?(): number
}

export interface WatchdogOptions {
  /** Hard wall-clock deadline in ms; 0/undefined disables it. */
  readonly timeoutMs?: number
  /** Idle window in ms; 0/undefined disables it. */
  readonly idleTimeoutMs?: number
  readonly clock?: Clock
  readonly logger?: BridgeLogger
  readonly onFire: (fire: WatchdogFire) => void
}

export interface Watchdog {
  /** Reset the idle window (called whenever a new event is observed). */
  touch(): void
  /** Disarm both timers. Idempotent. */
  stop(): void
  readonly stopped: boolean
  readonly fired: WatchdogFire | undefined
}

export const systemClock: Clock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout)
  },
  now: () => Date.now(),
}

/**
 * The largest delay a single timer can hold: 2^31-1 ms (Node's own ceiling).
 *
 * `setTimeout` does not reject a larger delay — it silently rewrites it to
 * **1 ms** and emits `TimeoutOverflowWarning`. For a watchdog that turns a
 * caller's "no deadline" (a very large number) into an immediate timeout: the
 * child is SIGTERM/SIGKILLed right after spawn and the run is reported as a
 * timeout. `positive()` therefore clamps to this value, and the tool layer caps
 * the same value at the boundary. Exported so both layers use ONE number.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Normalize a user-supplied window: non-finite/non-positive disables the timer,
 * and anything above the runtime ceiling is LOWERED to it (never passed
 * through, which the runtime would collapse to 1 ms).
 */
function positive(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), MAX_TIMER_DELAY_MS)
}

export function createWatchdog(options: WatchdogOptions): Watchdog {
  const clock = options.clock ?? systemClock
  const hardMs = positive(options.timeoutMs)
  const idleMs = positive(options.idleTimeoutMs)
  // Call through `clock` (not through a detached reference) so a class-based
  // clock keeps its `this` binding — the previous `clock.now ?? Date.now`
  // form detaches the method and breaks any clock that reads instance state.
  const now = (): number => clock.now?.() ?? Date.now()
  const armedAt = now()

  let stopped = false
  let fired: WatchdogFire | undefined
  let idleHandle: unknown
  let hardHandle: unknown

  function clearIdle(): void {
    if (idleHandle !== undefined) {
      clock.clearTimeout(idleHandle)
      idleHandle = undefined
    }
  }

  function clearHard(): void {
    if (hardHandle !== undefined) {
      clock.clearTimeout(hardHandle)
      hardHandle = undefined
    }
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    clearIdle()
    clearHard()
  }

  function fire(kind: WatchdogKind): void {
    if (stopped || fired !== undefined) return
    stopped = true
    const elapsedMs = Math.max(0, now() - armedAt)
    fired = Object.freeze({
      kind,
      elapsedMs,
      ...(idleMs !== undefined ? { idleMs } : {}),
      ...(hardMs !== undefined ? { timeoutMs: hardMs } : {}),
    })
    clearIdle()
    clearHard()
    options.logger?.warn('run watchdog fired', { kind, elapsedMs })
    try {
      options.onFire(fired)
    } catch (err) {
      options.logger?.error('watchdog handler threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function armIdle(): void {
    if (idleMs === undefined) return
    clearIdle()
    idleHandle = clock.setTimeout(() => fire('idle'), idleMs)
  }

  if (hardMs !== undefined) {
    hardHandle = clock.setTimeout(() => fire('timeout'), hardMs)
  }
  armIdle()

  return {
    touch(): void {
      if (stopped) return
      armIdle()
    },
    stop,
    get stopped() {
      return stopped
    },
    get fired() {
      return fired
    },
  }
}
