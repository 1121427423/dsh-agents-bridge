/**
 * `AgentManager`: the facade the model-facing tool surface talks to.
 *
 * The one hard rule (design doc D5): `run()` returns immediately with a
 * `running` snapshot. A tool call has a timeout measured in seconds while an
 * agent task lasts minutes, so nothing in the start path may await the child
 * process. The child is driven by a detached task; the caller polls
 * `output()` / `status()`.
 *
 * The manager owns no dialect knowledge: it asks the injected
 * `createBackend(family, deps)` factory for a driver (kernel never imports
 * `src/drivers/**`, design doc D3) and only speaks the frozen
 * `AgentSessionHandle` / `AgentBackend` contracts.
 *
 * @module dsh-agents-bridge/kernel/manager
 */

import { randomUUID } from 'node:crypto'

import type {
  AgentDescriptor,
  AgentManager,
  AgentMessage,
  AgentResult,
  AgentRunOptions,
  AgentRunStatus,
  AgentSessionHandle,
  DriverDeps,
  ManagerOptions,
  ProbeResult,
  SessionOutput,
  SessionSnapshot,
} from './types.ts'
import { childLogger } from './logger.ts'
import { createRegistry, type AgentRegistry, type ResolvedIdentity } from './registry.ts'
import { createAgentSession, type AgentSession, type SessionCompletion } from './session.ts'
import { createSessionStore, type StoredSession } from './store.ts'
import { createWatchdog, type Watchdog } from './watchdog.ts'
import type { ScanOptions } from '../tracks/desktop/scan.ts'

/**
 * How often the manager copies newly produced events out of the driver's
 * buffer. The ABI exposes `messages` as a plain array (no event emitter), so
 * polling is the contract-compatible way to see progress *and* to keep the idle
 * watchdog honest (a new event must reset the idle window).
 */
const POLL_INTERVAL_MS = 100
/** Upper bound on how long a driver's `cancel()` may take before we move on. */
const CANCEL_AWAIT_MS = 3_000
/** How long we wait for the driver's `done` to settle after cancelling. */
const CANCEL_SETTLE_MS = 2_000

type TerminalStatus = Exclude<AgentRunStatus, 'running'>

/** The subset of a driver result the manager consumes. */
interface DriverOutcome {
  readonly status: TerminalStatus
  readonly exitCode: number | null
  readonly text?: string
  readonly error?: string
  readonly usage?: AgentResult['usage']
  readonly backendSessionId?: string
}

interface LiveSession {
  readonly session: AgentSession
  readonly descriptor: AgentDescriptor
  readonly resolved: ResolvedIdentity
  readonly options: AgentRunOptions
  readonly abort: AbortController
  readonly watchdog: Watchdog
  readonly resumedFrom?: string
  /** Resolves when `startRun` finished settling this session. */
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
  handle: AgentSessionHandle | undefined
  poll: NodeJS.Timeout | undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Resolves true when `promise` settles before `ms` elapses. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (value: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    promise.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), max)
}

/**
 * `ManagerOptions` plus the desktop-scan knob.
 *
 * `scan` is declared HERE rather than in `types.ts` on purpose: `types.ts` is
 * the frozen ABI *leaf* (it imports nothing), and naming `ScanOptions` there
 * would make the ABI depend on a track implementation. The field is additive
 * and optional, so every existing caller — and the ABI itself — is unchanged;
 * an embedder (or a test) that wants probing off the host's installed apps
 * passes `scan: false` or an explicit `scan: { roots: [...] }`.
 */
export type ManagerCreateOptions = ManagerOptions & {
  readonly scan?: false | ScanOptions
}

export function createAgentManager(options: ManagerCreateOptions): AgentManager {
  const logger = options.logger
  const registry: AgentRegistry = createRegistry({
    logger: childLogger(logger, 'registry'),
    overrides: options.overrides,
    extraDescriptors: options.extraDescriptors,
    ...(options.scan === undefined ? {} : { scan: options.scan }),
  })
  const store = createSessionStore({
    dir: options.storeDir,
    logger: childLogger(logger, 'store'),
  })

  const live = new Map<string, LiveSession>()
  /** Sessions from a previous process: metadata only, no transcript. */
  const restored = new Map<string, StoredSession>()
  let disposed = false

  for (const record of store.reload()) {
    if (record.status === 'running') {
      // The process that owned this run is gone, so claiming `running` would be
      // a lie; record the truth and stop advertising it as live.
      const stale: StoredSession = {
        ...record,
        status: 'failed',
        endedAt: record.endedAt ?? Date.now(),
      }
      restored.set(record.sessionId, stale)
      store.upsert(stale)
    } else {
      restored.set(record.sessionId, record)
    }
  }

  /* -------------------------------------------------------------- helpers */

  function syncFromHandle(rec: LiveSession): number {
    const handle = rec.handle
    if (!handle) return 0
    const added = rec.session.sync(handle.messages)
    if (added > 0) rec.watchdog.touch()
    return added
  }

  function liveSnapshot(rec: LiveSession): SessionSnapshot {
    syncFromHandle(rec)
    return rec.session.snapshot()
  }

  function restoredSnapshot(record: StoredSession): SessionSnapshot {
    const status: TerminalStatus = record.status === 'running' ? 'failed' : record.status
    const endedAt = record.endedAt ?? record.startedAt
    const result: AgentResult = Object.freeze({
      sessionId: record.sessionId,
      agentId: record.agentId,
      status,
      exitCode: null,
      text: '',
      ...(record.status === 'running'
        ? { error: 'the bridge restarted while this session was running; it is no longer live' }
        : {}),
      durationMs: Math.max(0, endedAt - record.startedAt),
      ...(record.backendSessionId !== undefined ? { backendSessionId: record.backendSessionId } : {}),
    })
    return Object.freeze({
      sessionId: record.sessionId,
      agentId: record.agentId,
      status,
      startedAt: record.startedAt,
      endedAt,
      messageCount: 0,
      result,
      terminal: true,
    })
  }

  function toStoreRecord(rec: LiveSession): StoredSession {
    const snapshot = rec.session.snapshot()
    const backendSessionId = snapshot.result?.backendSessionId
    return {
      sessionId: snapshot.sessionId,
      agentId: snapshot.agentId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      ...(snapshot.endedAt !== undefined ? { endedAt: snapshot.endedAt } : {}),
      ...(backendSessionId !== undefined ? { backendSessionId } : {}),
      ...(rec.options.cwd !== undefined ? { cwd: rec.options.cwd } : {}),
      ...(rec.options.model !== undefined ? { model: rec.options.model } : {}),
      ...(rec.resumedFrom !== undefined ? { resumedFrom: rec.resumedFrom } : {}),
    }
  }

  /**
   * The real cancellation path, registered as the session's cancel handler:
   * abort the signal, run the driver's three-stage kill, then guarantee the
   * session reaches a terminal state even if the driver is wedged.
   */
  async function cancelInternal(rec: LiveSession, reason?: string): Promise<void> {
    const session = rec.session
    rec.abort.abort()
    const handle = rec.handle
    if (handle) {
      await settleWithin(
        Promise.resolve(handle.cancel(reason)).catch((err: unknown) => {
          logger.warn('driver cancel failed', {
            sessionId: session.sessionId,
            error: errorMessage(err),
          })
        }),
        CANCEL_AWAIT_MS,
      )
    }
    if (await settleWithin(rec.settled, CANCEL_SETTLE_MS)) return
    if (!session.snapshot().terminal) {
      logger.warn('driver did not settle after cancel; forcing terminal state', {
        sessionId: session.sessionId,
      })
      session.complete({
        status: 'cancelled',
        exitCode: null,
        text: '',
        error: reason !== undefined ? `cancelled: ${reason}` : 'cancelled',
      })
    }
  }

  function settleFromDriver(rec: LiveSession, outcome: DriverOutcome): void {
    const override = rec.session.terminalOverride()
    const status = override ?? outcome.status
    const completion: SessionCompletion = {
      status,
      exitCode: outcome.exitCode,
      text: outcome.text ?? '',
      ...(status !== outcome.status
        ? { error: outcome.error ?? `run ${status}` }
        : outcome.error !== undefined
          ? { error: outcome.error }
          : {}),
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      ...(outcome.backendSessionId !== undefined ? { backendSessionId: outcome.backendSessionId } : {}),
    }
    rec.session.complete(completion)
  }

  /** Drive one backend to completion. Never throws; always settles the session. */
  async function startRun(rec: LiveSession, resolved: ResolvedIdentity): Promise<void> {
    const { session, descriptor } = rec
    const runLogger = childLogger(logger, `run:${descriptor.id}`)
    try {
      const deps: DriverDeps = { command: resolved.command, env: resolved.env, logger: runLogger }
      const backend = options.createBackend(descriptor.family, deps)
      const handle = await backend.run(rec.options, deps, rec.abort.signal)
      rec.handle = handle
      syncFromHandle(rec)
      if (session.snapshot().terminal) {
        // Cancelled/timed out while the backend was still starting up: make sure
        // the freshly created child does not outlive the session.
        await settleWithin(
          Promise.resolve(handle.cancel('session already terminal')).catch(() => undefined),
          CANCEL_AWAIT_MS,
        )
        return
      }
      rec.poll = setInterval(() => syncFromHandle(rec), POLL_INTERVAL_MS)
      const outcome: DriverOutcome = await handle.done.then(
        (result) => result,
        (err: unknown): DriverOutcome => ({
          status: 'failed',
          exitCode: null,
          text: '',
          error: errorMessage(err),
        }),
      )
      syncFromHandle(rec)
      settleFromDriver(rec, outcome)
    } catch (err) {
      const message = errorMessage(err)
      runLogger.error('run failed to start', { sessionId: session.sessionId, error: message })
      session.complete({
        status: session.terminalOverride() ?? 'failed',
        exitCode: null,
        text: '',
        error: message,
      })
    } finally {
      if (rec.poll !== undefined) {
        clearInterval(rec.poll)
        rec.poll = undefined
      }
      rec.watchdog.stop()
      store.upsert(toStoreRecord(rec))
      rec.resolveSettled()
    }
  }

  async function runInternal(runOptions: AgentRunOptions, resumedFrom?: string): Promise<SessionSnapshot> {
    if (disposed) throw new Error('the agent manager has been disposed')
    const descriptor = registry.get(runOptions.agent)
    if (!descriptor) {
      throw new Error(
        `unknown agent "${runOptions.agent}"; run agents_probe to see the identities this bridge can drive`,
      )
    }
    if (descriptor.unsupported) {
      throw new Error(`${descriptor.id} cannot be driven: ${descriptor.unsupported.reason}`)
    }
    if (runOptions.mode === 'connect') {
      throw new Error('mode "connect" is not implemented in v1; omit mode to spawn the CLI')
    }
    const resolved = registry.resolve(descriptor.id)
    if (resolved.reason !== undefined) {
      throw new Error(`${descriptor.id} is not available: ${resolved.reason}`)
    }

    const cwd = runOptions.cwd ?? options.defaultCwd
    const model = runOptions.model ?? resolved.model
    const effective: AgentRunOptions = {
      ...runOptions,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(model !== undefined ? { model } : {}),
    }

    const sessionId = `sess_${randomUUID()}`
    const runLogger = childLogger(logger, `session:${sessionId}`)
    const abort = new AbortController()
    let resolveSettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })

    const session = createAgentSession({
      sessionId,
      agentId: descriptor.id,
      logger: runLogger,
      onCancel: (reason) => cancelInternal(rec, reason),
    })

    const watchdog = createWatchdog({
      timeoutMs: effective.timeoutMs,
      idleTimeoutMs: effective.idleTimeoutMs,
      logger: runLogger,
      onFire: (fire) => {
        if (rec.session.snapshot().terminal) return
        // Mark before cancelling: the kill mechanism is shared, the *status* is not.
        rec.session.markTimedOut(fire.kind)
        runLogger.warn('run watchdog fired', {
          kind: fire.kind,
          elapsedMs: fire.elapsedMs,
        })
        void rec.session.cancel(`watchdog:${fire.kind}`)
      },
    })

    const rec: LiveSession = {
      session,
      descriptor,
      resolved,
      options: effective,
      abort,
      watchdog,
      settled,
      resolveSettled,
      handle: undefined,
      poll: undefined,
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    }

    live.set(sessionId, rec)
    store.upsert(toStoreRecord(rec))
    // Deliberately not awaited: `run()` must return while the task keeps going.
    void startRun(rec, resolved).catch((err: unknown) => {
      runLogger.error('run task crashed', { sessionId, error: errorMessage(err) })
    })
    return rec.session.snapshot()
  }

  return {
    probe(probeOptions): Promise<readonly ProbeResult[]> {
      return registry.probe(probeOptions)
    },

    run(runOptions): Promise<SessionSnapshot> {
      return runInternal(runOptions)
    },

    status(sessionId) {
      const rec = live.get(sessionId)
      if (rec) return liveSnapshot(rec)
      const stored = restored.get(sessionId)
      return stored ? restoredSnapshot(stored) : undefined
    },

    list(): readonly SessionSnapshot[] {
      const snapshots: SessionSnapshot[] = []
      for (const rec of live.values()) snapshots.push(liveSnapshot(rec))
      for (const [sessionId, stored] of restored) {
        if (!live.has(sessionId)) snapshots.push(restoredSnapshot(stored))
      }
      // Newest first: the model almost always wants the run it just started.
      return snapshots.sort((a, b) => b.startedAt - a.startedAt)
    },

    output(sessionId, outputOptions): SessionOutput | undefined {
      const rec = live.get(sessionId)
      if (rec) {
        syncFromHandle(rec)
        const messages: readonly AgentMessage[] = rec.session.messages
        const start = clampIndex(outputOptions?.sinceIndex ?? 0, messages.length)
        const limit = outputOptions?.limit
        const end =
          limit !== undefined && limit > 0 ? Math.min(messages.length, start + limit) : messages.length
        return {
          sessionId,
          status: rec.session.snapshot().status,
          messages: messages.slice(start, end),
          nextIndex: end,
        }
      }
      const stored = restored.get(sessionId)
      if (!stored) return undefined
      // Known session from a previous process: metadata yes, transcript no.
      return {
        sessionId,
        status: restoredSnapshot(stored).status,
        messages: [],
        nextIndex: 0,
      }
    },

    async cancel(sessionId, reason?: string): Promise<boolean> {
      const rec = live.get(sessionId)
      if (!rec) return false
      if (rec.session.snapshot().terminal) return false
      await rec.session.cancel(reason)
      return true
    },

    async send(sessionId, prompt): Promise<SessionSnapshot> {
      const rec = live.get(sessionId)
      const stored = rec ? undefined : restored.get(sessionId)
      let target: SessionSnapshot | undefined
      if (rec) target = liveSnapshot(rec)
      else if (stored) target = restoredSnapshot(stored)
      if (!target) {
        throw new Error(`unknown session "${sessionId}"; run agents_status to list known sessions`)
      }
      if (!target.terminal) {
        throw new Error(
          `session ${sessionId} is still ${target.status}; wait for it to finish or cancel it before sending a new prompt`,
        )
      }
      const descriptor = registry.get(target.agentId)
      if (!descriptor) {
        throw new Error(`session ${sessionId} belongs to unknown agent "${target.agentId}"`)
      }
      const backendSessionId = target.result?.backendSessionId
      if (backendSessionId === undefined || backendSessionId === '') {
        throw new Error(
          `cannot resume session ${sessionId}: the ${descriptor.id} driver reported no backend session id, so there is nothing to continue (v1 resume is best-effort — start a new run with agents_run)`,
        )
      }
      const cwd = rec?.options.cwd ?? stored?.cwd
      const model = rec?.options.model ?? stored?.model
      return runInternal(
        {
          agent: descriptor.id,
          prompt,
          resumeSessionId: backendSessionId,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(model !== undefined ? { model } : {}),
        },
        sessionId,
      )
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      const pending: Promise<void>[] = []
      for (const rec of live.values()) {
        if (rec.session.snapshot().terminal) continue
        pending.push(rec.session.cancel('dispose'))
      }
      await Promise.allSettled(pending)
      for (const rec of live.values()) {
        if (rec.poll !== undefined) {
          clearInterval(rec.poll)
          rec.poll = undefined
        }
        rec.watchdog.stop()
        store.upsert(toStoreRecord(rec))
      }
      store.flush()
      live.clear()
    },
  }
}
