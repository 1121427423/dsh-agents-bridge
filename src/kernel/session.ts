/**
 * `AgentSessionHandle` implementation: an append-only event buffer, a
 * single-settlement terminal promise and an immutable snapshot view.
 *
 * The handle is the seam between a driver (which pushes events and eventually
 * completes) and the manager (which reads the buffer incrementally). Two rules
 * make the manager's life simple:
 *
 *   1. `done` resolves exactly once and never rejects — a driver bug becomes a
 *      `failed` result instead of an unhandled rejection.
 *   2. `complete()` is idempotent — the manager races a driver settle against a
 *      watchdog/cancel fallback, and the first writer wins.
 *
 * @module dsh-agents-bridge/kernel/session
 */

import type {
  AgentId,
  AgentMessage,
  AgentResult,
  AgentRunStatus,
  AgentSessionHandle,
  AgentUsage,
  BridgeLogger,
  SessionSnapshot,
} from './types.ts'

export type TerminalStatus = Exclude<AgentRunStatus, 'running'>

/** Everything needed to derive the terminal `AgentResult`. */
export interface SessionCompletion {
  readonly status: TerminalStatus
  readonly exitCode: number | null
  readonly text?: string
  readonly error?: string
  readonly usage?: AgentUsage
  readonly backendSessionId?: string
  readonly endedAt?: number
}

export interface AgentSessionInit {
  readonly sessionId: string
  readonly agentId: AgentId
  readonly startedAt?: number
  readonly logger?: BridgeLogger
  /** Registered by the manager; performs the real SIGTERM → SIGKILL dance. */
  readonly onCancel?: (reason?: string) => Promise<void> | void
}

/** A message as a driver produces it: `at` is filled in by the session. */
export type AgentMessageInput = Omit<AgentMessage, 'at'> & { readonly at?: number }

export interface AgentSession extends AgentSessionHandle {
  /** Append one event. `at` defaults to now. Ignored after the terminal state. */
  push(message: AgentMessageInput): void
  /**
   * Copy newly produced events from a driver-owned buffer.
   * Returns how many were copied (0 = nothing new).
   */
  sync(source: readonly AgentMessage[]): number
  /** Settle the session. Idempotent; returns the winning result. */
  complete(completion: SessionCompletion): AgentResult
  setCancelHandler(handler: (reason?: string) => Promise<void> | void): void
  /** True once `cancel()` has been observed (the driver may still be running). */
  readonly cancelRequested: boolean
  readonly cancelReason: string | undefined
  /**
   * Manager-side marker: set *before* cancelling so the terminal status becomes
   * `timeout` even though the mechanism is the same three-stage kill.
   */
  markTimedOut(kind: 'idle' | 'timeout'): void
  readonly timeoutKind: 'idle' | 'timeout' | undefined
  /** Status that overrides whatever the driver reports, if any. */
  terminalOverride(): TerminalStatus | undefined
}

export function createAgentSession(init: AgentSessionInit): AgentSession {
  const startedAt = init.startedAt ?? Date.now()
  const logger = init.logger
  const buffer: AgentMessage[] = []

  let sourceCursor = 0
  let result: AgentResult | undefined
  let endedAt: number | undefined
  let cancelRequested = false
  let cancelReason: string | undefined
  let cancelPromise: Promise<void> | undefined
  let cancelHandler: ((reason?: string) => Promise<void> | void) | undefined = init.onCancel
  let timeoutKind: 'idle' | 'timeout' | undefined

  let resolveDone: (value: AgentResult) => void = () => {}
  const done = new Promise<AgentResult>((resolve) => {
    resolveDone = resolve
  })

  function terminalOverride(): TerminalStatus | undefined {
    if (timeoutKind !== undefined) return 'timeout'
    if (cancelRequested) return 'cancelled'
    return undefined
  }

  function complete(completion: SessionCompletion): AgentResult {
    if (result !== undefined) return result
    const status = terminalOverride() ?? completion.status
    endedAt = completion.endedAt ?? Date.now()
    const settled: AgentResult = Object.freeze({
      sessionId: init.sessionId,
      agentId: init.agentId,
      status,
      exitCode: completion.exitCode,
      text: completion.text ?? '',
      ...(completion.error !== undefined ? { error: completion.error } : {}),
      ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      durationMs: Math.max(0, endedAt - startedAt),
      ...(completion.backendSessionId !== undefined
        ? { backendSessionId: completion.backendSessionId }
        : {}),
    })
    result = settled
    resolveDone(settled)
    return settled
  }

  function push(message: AgentMessageInput): void {
    if (result !== undefined) return // the transcript is frozen at the terminal state
    buffer.push(Object.freeze({ ...message, at: message.at ?? Date.now() }) as AgentMessage)
  }

  function sync(source: readonly AgentMessage[]): number {
    if (source.length < sourceCursor) {
      // The driver swapped its buffer (e.g. a resumed handle); re-read it all.
      sourceCursor = 0
    }
    let copied = 0
    for (let index = sourceCursor; index < source.length; index += 1) {
      const message = source[index]
      if (message !== undefined) {
        buffer.push(Object.freeze({ ...message }) as AgentMessage)
        copied += 1
      }
    }
    sourceCursor = source.length
    return copied
  }

  return {
    sessionId: init.sessionId,
    agentId: init.agentId,
    startedAt,
    get messages() {
      return buffer
    },
    done,
    async cancel(reason?: string): Promise<void> {
      if (result !== undefined) return // already terminal: idempotent no-op
      if (!cancelRequested) {
        cancelRequested = true
        cancelReason = reason
      }
      if (cancelPromise) return cancelPromise
      const handler = cancelHandler
      if (!handler) return
      cancelPromise = Promise.resolve()
        .then(() => handler(reason))
        .then(
          () => undefined,
          (err: unknown) => {
            logger?.warn('cancel handler failed', {
              sessionId: init.sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          },
        )
      return cancelPromise
    },
    snapshot(): SessionSnapshot {
      const last = buffer.length > 0 ? buffer[buffer.length - 1] : undefined
      return Object.freeze({
        sessionId: init.sessionId,
        agentId: init.agentId,
        status: result?.status ?? 'running',
        startedAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
        messageCount: buffer.length,
        ...(last !== undefined ? { lastMessage: last } : {}),
        ...(result !== undefined ? { result } : {}),
        terminal: result !== undefined,
      })
    },
    push,
    sync,
    complete,
    setCancelHandler(handler) {
      cancelHandler = handler
    },
    get cancelRequested() {
      return cancelRequested
    },
    get cancelReason() {
      return cancelReason
    },
    markTimedOut(kind) {
      timeoutKind = timeoutKind ?? kind
    },
    get timeoutKind() {
      return timeoutKind
    },
    terminalOverride,
  }
}
