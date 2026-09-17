/**
 * dsh-agents-bridge client half — the supervisor store.
 *
 * One shared, React-independent state container that both slots read:
 *
 *   - `conversation.session.header.utilities` (the indicator) needs only the
 *     counts, and must run even when the sidebar slot is unavailable;
 *   - `sidebar.right.pane.tab` (the panel) needs the sessions, the selected
 *     session's transcript and the engine table.
 *
 * A store rather than React context because the two slots are mounted by the
 * HOST in unrelated subtrees and neither can pass props to the other. React
 * subscribes through `useSyncExternalStore`, so the snapshot must be a stable
 * object identity between changes (see `emit`).
 *
 * NOTHING here touches React or the DOM beyond `document.hidden`, so the whole
 * scheduling policy is testable with a fake clock.
 *
 * @module dsh-agents-bridge/client/store
 */

import type { BridgeApi } from './api.ts'
import { ApiError } from './api.ts'
import type { Translator } from './i18n.ts'
import type { ClientMessage, ClientProbeResult, ClientSession } from './util.ts'
import { countAttention, mergeMessages, pollDecision, sortSessions, type PollMode, type PollPolicy } from './util.ts'

/** What the panel needs to render its engine strip. */
export interface EngineState {
  readonly loading: boolean
  readonly results: readonly ClientProbeResult[]
  readonly available: boolean
  readonly cached: boolean
  readonly error?: string | undefined
}

/** The one snapshot both slots subscribe to. */
export interface SupervisorSnapshot {
  readonly loaded: boolean
  readonly loading: boolean
  readonly sessions: readonly ClientSession[]
  readonly counts: { readonly running: number; readonly failed: number; readonly unseenFailures: number }
  readonly concurrency: { readonly running: number; readonly limit: number }
  readonly engines: EngineState
  /** `undefined` when no session is open in the transcript view. */
  readonly selectedId: string | undefined
  readonly transcript: readonly ClientMessage[]
  readonly transcriptLoading: boolean
  /** Epoch ms of the last successful `status` read (for "updated Ns ago"). */
  readonly updatedAt: number
  /** `undefined` when the last read succeeded; otherwise the localized reason. */
  readonly error: string | undefined
  readonly pollMode: PollMode
  /** Sessions whose failure the human has already opened. */
  readonly seen: ReadonlySet<string>
}

/** Configuration the panel owns (a UI preference, not plugin config). */
export interface SupervisorOptions {
  readonly policy: PollPolicy
  /** Auto-refresh toggle: `false` stops polling entirely (manual refresh only). */
  readonly autoRefresh: boolean
}

/** The store face the components and the plugin body use. */
export interface SupervisorStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => SupervisorSnapshot
  /** Start polling. Idempotent. */
  readonly start: () => void
  /** Stop polling and drop every subscription. Idempotent. */
  readonly stop: () => void
  /** Force one refresh now (the Refresh button). */
  readonly refresh: () => Promise<void>
  /** Re-probe engines with the expensive `refresh` flag. */
  readonly refreshEngines: () => Promise<void>
  /** Open the transcript view for a session and load its first events. */
  readonly openSession: (sessionId: string) => Promise<void>
  /** Close the transcript view (back to the list). */
  readonly closeSession: () => void
  /** Cancel a running session and report the localized outcome. */
  readonly cancelSession: (sessionId: string) => Promise<{ readonly ok: boolean; readonly message: string }>
  /** Change the UI preferences. */
  readonly setOptions: (patch: Partial<SupervisorOptions>) => void
  readonly getOptions: () => SupervisorOptions
  /** Follow a host locale change. */
  readonly setTranslator: (translator: Translator) => void
}

/** How often the transcript view pulls new events while its session is live. */
const TRANSCRIPT_REFRESH_MS = 1_200

/**
 * Map an `ApiError` to the human sentence the panel shows.
 *
 * The panel never prints a raw code or a stack: every branch ends in copy the
 * user can act on ("restart DSH and retry"), because the alternative — showing
 * `{ok:false,error:{code:'forbidden'}}` — is exactly what a supervisor UI must
 * not do.
 */
export function describeApiError(error: unknown, translator: Translator): string {
  if (error instanceof ApiError) {
    switch (error.kind) {
      case 'forbidden':
        return translator.t('errorForbidden')
      case 'missing':
        return translator.t('errorMissing')
      case 'network':
        return translator.t('errorNetwork')
      default:
        return translator.t('errorInternal', { detail: error.message })
    }
  }
  return translator.t('errorInternal', { detail: error instanceof Error ? error.message : String(error) })
}

/**
 * Build the store.
 *
 * @param api - the host API face (injectable for tests).
 * @param translator - the live translator.
 * @param options - initial UI preferences.
 * @param clock - `setTimeout`/`clearTimeout` seam plus a hidden-tab probe, so
 *                the whole scheduler can be driven by a fake clock in a test.
 */
export function createSupervisorStore(
  api: BridgeApi,
  translator: Translator,
  options: SupervisorOptions,
  clock: {
    readonly setTimeout: (handler: () => void, ms: number) => unknown
    readonly clearTimeout: (handle: unknown) => void
    readonly now: () => number
    readonly hidden: () => boolean
    readonly onVisibilityChange: (listener: () => void) => () => void
  },
): SupervisorStore {
  const listeners = new Set<() => void>()
  let currentOptions = options
  let currentTranslator = translator

  let sessions: readonly ClientSession[] = []
  let counts = { running: 0, failed: 0, unseenFailures: 0 }
  let concurrency = { running: 0, limit: 0 }
  let loaded = false
  let loading = false
  let updatedAt = 0
  let error: string | undefined
  let pollMode: PollMode = 'idle'
  let seen: ReadonlySet<string> = new Set()

  let engines: EngineState = { loading: false, results: [], available: false, cached: false }

  let selectedId: string | undefined
  let transcript: readonly ClientMessage[] = []
  let transcriptNextIndex = 0
  let transcriptLoading = false
  let transcriptError: string | undefined
  /**
   * Whether the OPEN transcript's session has ended, as reported by the output
   * read itself.
   *
   * The `sessions` row cannot answer this while a transcript is open: the list
   * poller is paused (`schedule()` pauses on `selectedId !== undefined`), so the
   * row is frozen at whatever it said when the transcript opened. Without this
   * flag a session that finishes while the human is watching keeps the 1.2s
   * transcript poll running forever on a transcript that cannot change.
   */
  let transcriptTerminal = false
  /**
   * The transcript's own timer, separate from the list poller.
   *
   * Declared with the rest of the state (NOT next to its helpers below the
   * return) because `openSession` reaches it through `startTranscriptTimer`:
   * a `let` in a later block is in its temporal dead zone when the returned
   * object's methods first run.
   */
  let transcriptTimer: unknown

  let timer: unknown
  let started = false
  let inFlight = false
  /** Guards against a visibility flip racing an in-flight read. */
  let generation = 0

  // A stable snapshot object: `useSyncExternalStore` compares by identity, so
  // rebuilding this on every `getSnapshot()` call would loop forever. It is
  // rebuilt only when something actually changed.
  let snapshot: SupervisorSnapshot = build()

  function build(): SupervisorSnapshot {
    return {
      loaded,
      loading,
      sessions,
      counts,
      concurrency,
      engines,
      selectedId,
      transcript,
      transcriptLoading,
      updatedAt,
      error,
      pollMode,
      seen,
      // Surfaced for the transcript view, which shows its own failure inline.
      ...(transcriptError === undefined ? {} : { transcriptError }),
    } as SupervisorSnapshot
  }

  function emit(): void {
    snapshot = build()
    for (const listener of listeners) {
      // A broken subscriber must not stop the others from being notified.
      try {
        listener()
      } catch {
        /* ignore */
      }
    }
  }

  function schedule(): void {
    if (timer !== undefined) {
      clock.clearTimeout(timer)
      timer = undefined
    }
    const decision = pollDecision({
      running: counts.running,
      hidden: clock.hidden(),
      paused: !currentOptions.autoRefresh || selectedId !== undefined,
      policy: currentOptions.policy,
    })
    pollMode = decision.mode
    if (decision.delayMs < 0 || !started) {
      emit()
      return
    }
    const scheduleGeneration = generation
    timer = clock.setTimeout(() => {
      timer = undefined
      if (scheduleGeneration !== generation || !started) return
      void refresh().then(() => {
        if (selectedId !== undefined) void loadTranscript()
      })
    }, decision.delayMs)
    emit()
  }

  async function refresh(): Promise<void> {
    if (inFlight) return
    inFlight = true
    loading = true
    emit()
    try {
      const result = await api.status()
      sessions = sortSessions(result.sessions)
      concurrency = result.concurrency
      counts = countAttention(sessions, seen)
      updatedAt = result.now
      // Only clear a previous error once a read actually succeeded — a panel
      // that flickers between "error" and "no data" is worse than a stale error.
      error = undefined
      loaded = true
    } catch (caught) {
      error = describeApiError(caught, currentTranslator)
      // A failed read must not clear the rows: the last known state is still
      // the best information the human has, and the error strip says it is stale.
    } finally {
      inFlight = false
      loading = false
      emit()
      if (started) schedule()
    }
  }

  async function loadTranscript(): Promise<void> {
    if (selectedId === undefined) return
    const sessionId = selectedId
    transcriptLoading = true
    emit()
    try {
      const read = await api.output(sessionId, transcriptNextIndex)
      if (selectedId !== sessionId) return
      transcript = mergeMessages(transcript, read.messages)
      transcriptNextIndex = read.nextIndex
      transcriptTerminal = read.terminal
      transcriptError = undefined
    } catch (caught) {
      if (selectedId !== sessionId) return
      transcriptError = describeApiError(caught, currentTranslator)
      error = transcriptError
    } finally {
      if (selectedId === sessionId) {
        transcriptLoading = false
        emit()
      }
    }
  }

  async function loadEngines(refresh: boolean): Promise<void> {
    engines = { ...engines, loading: true }
    emit()
    try {
      const result = await api.probe(refresh)
      engines = { loading: false, results: result.results, available: result.available, cached: result.cached }
    } catch (caught) {
      engines = {
        loading: false,
        results: engines.results,
        available: engines.available,
        cached: false,
        error: describeApiError(caught, currentTranslator),
      }
    }
    emit()
  }

  const offVisibility = clock.onVisibilityChange(() => {
    // Coming back to a visible tab must refresh immediately: the human is
    // looking at a panel whose last read may be 15s old.
    if (!clock.hidden() && started) void refresh().then(() => schedule())
    else schedule()
  })

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    getSnapshot: () => snapshot,

    start() {
      if (started) return
      started = true
      generation += 1
      // Probe once on mount (the cached path — the host answers from its own
      // cache unless we ask for a refresh), then poll status only.
      void loadEngines(false)
      void refresh()
    },

    stop() {
      if (!started) return
      started = false
      generation += 1
      offVisibility()
      if (timer !== undefined) {
        clock.clearTimeout(timer)
        timer = undefined
      }
      listeners.clear()
    },

    async refresh() {
      await refresh()
      if (selectedId !== undefined) await loadTranscript()
    },

    async refreshEngines() {
      await loadEngines(true)
    },

    async openSession(sessionId) {
      selectedId = sessionId
      transcript = []
      transcriptNextIndex = 0
      transcriptTerminal = false
      transcriptError = undefined
      seen = new Set([...seen, sessionId])
      counts = countAttention(sessions, seen)
      emit()
      // Stop the list poller while a transcript is open: `schedule()` sees
      // `selectedId !== undefined` and pauses, and the transcript gets its own
      // faster cadence below.
      schedule()
      await loadTranscript()
      startTranscriptTimer()
    },

    closeSession() {
      selectedId = undefined
      transcript = []
      transcriptNextIndex = 0
      transcriptTerminal = false
      transcriptError = undefined
      stopTranscriptTimer()
      emit()
      schedule()
    },

    async cancelSession(sessionId) {
      try {
        const result = await api.cancel(sessionId, 'cancelled from the supervisor panel')
        await refresh()
        return {
          ok: result.cancelled,
          message: result.cancelled ? currentTranslator.t('cancelRequested') : result.note,
        }
      } catch (caught) {
        const message = describeApiError(caught, currentTranslator)
        return { ok: false, message: currentTranslator.t('cancelFailed', { detail: message }) }
      }
    },

    setOptions(patch) {
      currentOptions = { ...currentOptions, ...patch }
      schedule()
    },

    getOptions: () => currentOptions,

    setTranslator(next) {
      currentTranslator = next
      emit()
    },
  }

  /* --- transcript cadence: separate from the list poller ------------------ */

  function stopTranscriptTimer(): void {
    if (transcriptTimer !== undefined) {
      clock.clearTimeout(transcriptTimer)
      transcriptTimer = undefined
    }
  }

  /**
   * Poll the open transcript faster than the list, but ONLY while its session
   * is running. A finished transcript cannot change (the host's session is
   * append-only and terminal), so polling it would be pure waste — the same
   * "stop when idle" rule the list obeys.
   */
  function startTranscriptTimer(): void {
    stopTranscriptTimer()
    if (selectedId === undefined || !started) return
    // The list row is frozen while a transcript is open, so it is only half the
    // answer: `transcriptTerminal` carries what the OUTPUT read reported, which
    // is the only signal that stays current with the poller paused (MI-10).
    if (transcriptTerminal) return
    const session = sessions.find(entry => entry.sessionId === selectedId)
    if (session === undefined || session.terminal) return
    transcriptTimer = clock.setTimeout(() => {
      transcriptTimer = undefined
      void loadTranscript().then(() => startTranscriptTimer())
    }, TRANSCRIPT_REFRESH_MS)
  }
}
