/**
 * dsh-agents-bridge client half — pure logic. NO React, NO plugin services,
 * NO `fetch`: only data transforms and formatting.
 *
 * Kept in one file (mirroring `dsh-history/lib/types/client/util.d.ts`, which
 * separates "util" from "component" for exactly this reason) so every rule the
 * panel obeys — how a duration reads, how a status is labelled, how an
 * incremental transcript read is merged, when polling stops — is unit-testable
 * without a browser or a rendering environment.
 *
 * @module dsh-agents-bridge/client/util
 */

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One agent event as the host projects it (`SessionOutput.messages`).
 *
 * Declared as a narrow structural subset of the kernel's frozen `AgentMessage`
 * rather than imported: the client half is bundled for the browser and must not
 * pull in `src/kernel/types.ts` (a type-only import would still drag the module
 * graph through `tsc`). The host is the single place that validates shapes.
 */
export interface ClientMessage {
  readonly index: number
  readonly type: string
  readonly text?: string | undefined
  readonly tool?: string | undefined
  readonly level?: string | undefined
  readonly at: number
}

/** Terminal + live statuses, matching the kernel's `AgentRunStatus`. */
export type ClientRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'

/** One session row (`SessionSnapshot` projection). */
export interface ClientSession {
  readonly sessionId: string
  readonly agentId: string
  readonly status: ClientRunStatus
  readonly startedAt: number
  readonly endedAt?: number | undefined
  readonly messageCount: number
  readonly lastMessage?: ClientMessage | undefined
  readonly terminal: boolean
  readonly result?: {
    readonly status: ClientRunStatus
    readonly text?: string | undefined
    readonly error?: string | undefined
    /**
     * The child's exit status, as `AgentResult.exitCode` carries it.
     *
     * `undefined` (the ABI's `null`) means "this run has no exit status" — a
     * cancel, or a row restored from a previous host — and the row must render
     * NOTHING for it rather than a fabricated `0`.
     */
    readonly exitCode?: number | undefined
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | undefined
  } | undefined
}

/** One engine row (`ProbeResult` projection). */
export interface ClientProbeResult {
  readonly id: string
  readonly displayName?: string | undefined
  readonly track?: string | undefined
  readonly available: boolean
  readonly reason?: string | undefined
  readonly health?: {
    readonly launch?: string | undefined
    readonly credential?: string | undefined
    readonly detail?: string | undefined
  } | undefined
  readonly models?: readonly string[] | undefined
}

/** Result payload of the `output` route. */
export interface ClientOutputPayload {
  readonly sessionId: string
  readonly status: ClientRunStatus
  readonly nextIndex: number
  // The host also sends `firstIndex` / `dropped` (ABI v8). Neither is carried
  // here on purpose: every message already carries its own ABSOLUTE `index`
  // (the merge key), so `messages[0].index` is the whole story about a trimmed
  // head, and `dropped` is PER READ rather than cumulative — see
  // `SupervisorSnapshot.transcriptDropped`.
  readonly terminal: boolean
  readonly messages: readonly ClientMessage[]
  readonly result?: {
    readonly status: ClientRunStatus
    readonly text?: string | undefined
    readonly error?: string | undefined
    readonly exitCode?: number | undefined
    readonly durationMs?: number | undefined
    readonly inputTokens?: number | undefined
    readonly outputTokens?: number | undefined
    readonly reasoningTokens?: number | undefined
  } | undefined
}

/* -------------------------------------------------------------------------- */
/* Formatting primitives                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The subset of the dictionary the formatters need.
 *
 * Declared structurally rather than importing `Dict` from `./i18n.ts`: `util`
 * is the leaf module (i18n depends on nothing here), and a structural parameter
 * means a caller can pass a `Dict` — which is a SUPERSET of these keys — with no
 * cast. Structural typing is what makes `statusLabel(status, translator.current())`
 * typecheck without a single `as`.
 */
export interface Labels {
  readonly running: string
  readonly completed: string
  readonly failed: string
  readonly cancelled: string
  readonly timeout: string
  readonly tokens: string
  readonly instantaneous: string
}

/**
 * Render a millisecond duration the way a human reads a wall clock.
 *
 * Three registers, because the panel shows all three at once:
 *  - under a second → `0.4s` (a run that just started should not read `0s`)
 *  - under a minute → `12s`
 *  - under an hour  → `3m04s` (seconds matter when you watch a task)
 *  - beyond that    → `2h05m`
 *
 * A negative or non-finite input is a CLOCK problem (the host stamps epoch ms
 * and a browser can be behind), never a reason to print `NaN`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Compact token count: `842`, `12.4k`, `1.2M`.
 *
 * A raw `12403` in a narrow sidebar is unreadable at a glance, and the exact
 * value is recoverable from the transcript view. Below 1000 the exact number is
 * kept because that is the range where every one of them matters.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Total token spend of one session.
 *
 * Returns `undefined` while the run has not reported usage. `reasoningTokens`
 * is deliberately NOT added: codex counts reasoning INSIDE `output_tokens`
 * (see the kernel ABI), so summing it would double-count.
 */
export function sessionTokens(session: ClientSession): { readonly input: number; readonly output: number } | undefined {
  const usage = session.result?.usage
  if (usage === undefined) return undefined
  return { input: usage.inputTokens, output: usage.outputTokens }
}

/** One-line token figure for a row, or the "no usage yet" placeholder. */
export function formatTokenSummary(session: ClientSession, labels: Labels): string {
  const usage = sessionTokens(session)
  if (usage === undefined) return labels.instantaneous
  return `${labels.tokens} ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`
}

/** Localized label for one run status. */
export function statusLabel(status: ClientRunStatus, labels: Labels): string {
  switch (status) {
    case 'running':
      return labels.running
    case 'completed':
      return labels.completed
    case 'failed':
      return labels.failed
    case 'cancelled':
      return labels.cancelled
    case 'timeout':
      return labels.timeout
    default:
      // An unknown future status must still render something readable rather
      // than blanking the row.
      return String(status)
  }
}

/**
 * Collapse whitespace and clip one preview line.
 *
 * The preview is the row's whole value proposition — one line that says what
 * the agent is doing — so it is normalized (an event payload is routinely a
 * multi-line markdown blob) and clipped at a word-ish boundary.
 */
export function previewText(value: string | undefined, max = 160): string {
  if (value === undefined) return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max).trimEnd()}…`
}

/**
 * The row's preview: the last event if there is one, else the final result's
 * text, else its error.
 *
 * Order matters: while a session runs, the last event is the live signal; once
 * it ends, the result text is the answer a human wants — and an error must
 * never be hidden by a stale preview.
 */
export function sessionPreview(session: ClientSession): string {
  if (session.status !== 'running' && session.result?.error !== undefined && session.result.error !== '') {
    return previewText(session.result.error)
  }
  const last = session.lastMessage
  if (last !== undefined) {
    const body = last.type === 'tool_use' || last.type === 'tool_result' ? last.tool : last.text
    const rendered = previewText(body)
    if (rendered !== '') {
      return last.type === 'tool_use' || last.type === 'tool_result' ? `[${last.type}] ${rendered}` : rendered
    }
  }
  if (session.result?.text !== undefined) return previewText(session.result.text)
  return ''
}

/** Elapsed wall time of a session, measured against a caller-supplied clock. */
export function sessionElapsed(session: ClientSession, now: number): number {
  return (session.endedAt ?? now) - session.startedAt
}

/* -------------------------------------------------------------------------- */
/* Ordering, grouping, counters                                               */
/* -------------------------------------------------------------------------- */

/**
 * Running sessions first (oldest first — the one that has been going longest is
 * the one a human is worried about), then finished ones newest-first.
 *
 * Deliberately NOT `manager.list()`'s order: that is tuned for the model asking
 * "what did I just start", while a supervisor panel is answering "what is still
 * alive, and what just happened".
 */
export function sortSessions(sessions: readonly ClientSession[]): ClientSession[] {
  return [...sessions].sort((left, right) => {
    if (left.terminal !== right.terminal) return left.terminal ? 1 : -1
    if (!left.terminal) return left.startedAt - right.startedAt
    return right.startedAt - left.startedAt
  })
}

/** Unread failures are the only thing here that needs a human's attention. */
export interface AttentionCounts {
  readonly running: number
  readonly failed: number
  /** Failures the human has not opened yet (see {@link markSeen}). */
  readonly unseenFailures: number
}

/**
 * Count what the indicator badge shows.
 *
 * @param sessions - current rows.
 * @param seen - session ids whose failure the human has already looked at.
 */
export function countAttention(sessions: readonly ClientSession[], seen: ReadonlySet<string>): AttentionCounts {
  let running = 0
  let failed = 0
  let unseenFailures = 0
  for (const session of sessions) {
    if (session.status === 'running') running += 1
    if (session.status === 'failed') {
      failed += 1
      if (!seen.has(session.sessionId)) unseenFailures += 1
    }
  }
  return { running, failed, unseenFailures }
}

/** Record a session as looked-at. Returns the same set when nothing changed. */
export function markSeen(seen: ReadonlySet<string>, sessionIds: readonly string[]): ReadonlySet<string> {
  const missing = sessionIds.filter(id => !seen.has(id))
  if (missing.length === 0) return seen
  return new Set([...seen, ...missing])
}

/* -------------------------------------------------------------------------- */
/* Incremental transcript merging                                             */
/* -------------------------------------------------------------------------- */

/**
 * Merge an incremental read into the transcript the panel already holds.
 *
 * The whole point of `sinceIndex`: the transcript is append-only on the host,
 * so a read from `nextIndex` returns only new events and the client appends.
 * A read from an EARLIER index (which the panel does after a reload, or when a
 * `limit`-bounded read left a gap) must MERGE rather than duplicate, or the
 * transcript double-prints every line. `index` is the host-assigned absolute
 * position, so it is the merge key.
 *
 * @param existing - transcript held so far.
 * @param incoming - freshly read events.
 * @param cap - maximum events retained (oldest dropped first: a supervisor
 *              watches the tail, and an unbounded array would grow forever).
 */
export function mergeMessages(
  existing: readonly ClientMessage[],
  incoming: readonly ClientMessage[],
  cap = 2_000,
): ClientMessage[] {
  if (incoming.length === 0) return existing.length > cap ? existing.slice(existing.length - cap) : [...existing]
  // Fast path: a pure append is the common case and needs no map.
  const lastExisting = existing.length > 0 ? existing[existing.length - 1] : undefined
  const firstIncoming = incoming[0]
  if (lastExisting !== undefined && firstIncoming !== undefined && firstIncoming.index === lastExisting.index + 1) {
    const merged = [...existing, ...incoming]
    return merged.length > cap ? merged.slice(merged.length - cap) : merged
  }
  const byIndex = new Map<number, ClientMessage>()
  for (const message of existing) byIndex.set(message.index, message)
  for (const message of incoming) byIndex.set(message.index, message)
  const merged = [...byIndex.values()].sort((left, right) => left.index - right.index)
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/**
 * Drop events the panel should not show as transcript rows.
 *
 * `log` events are the driver's own chatter (`[log] stderr …`) and would drown
 * the transcript in a busy run; they are kept out of the VISIBLE list but stay
 * in the buffer, so a future "show diagnostics" toggle is a view change and not
 * a re-read. Everything else is shown: a supervisor must never have an event
 * silently hidden.
 */
export function isDisplayable(message: ClientMessage): boolean {
  return message.type !== 'log' || message.level === 'error' || message.level === 'warn'
}

/* -------------------------------------------------------------------------- */
/* Poll scheduling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Why the scheduler is in a given state — surfaced in the UI so "it stopped
 * updating" is never a mystery.
 */
export type PollMode = 'running' | 'idle' | 'hidden' | 'paused'

/** How often the panel refreshes, and how much it backs off when hidden. */
export interface PollPolicy {
  /** Interval while at least one session is running. */
  readonly activeMs: number
  /** Multiplier applied while `document.hidden` is true. */
  readonly hiddenFactor: number
}

/** The default policy: 1.5s while live, 10x slower on a background tab. */
export const DEFAULT_POLL_POLICY: PollPolicy = { activeMs: 1_500, hiddenFactor: 10 }

/**
 * Decide whether to poll, and how soon.
 *
 * The requirement is explicit: polling is a LIVENESS mechanism, so it must not
 * spin. Two independent brakes:
 *
 *  - no session is running → the host's answer cannot change by itself, so
 *    polling stops entirely (`delayMs: -1`). This is the case that matters:
 *    an idle panel must not burn a request every 1.5s forever.
 *  - the tab is hidden → the human cannot see the update, so the interval is
 *    multiplied down. A live run is still watched (a background tab that
 *    silently stopped polling would show a stale "running" forever), but 15s
 *    instead of 1.5s.
 *
 * A `paused` override lets the caller stop polling without losing the state
 * (e.g. while a cancel confirmation modal is open and a refresh would yank the
 * row out from under the pointer).
 */
export function pollDecision(input: {
  readonly running: number
  readonly hidden: boolean
  readonly paused: boolean
  readonly policy?: PollPolicy
}): { readonly mode: PollMode; readonly delayMs: number } {
  if (input.paused) return { mode: 'paused', delayMs: -1 }
  if (input.running === 0) return { mode: 'idle', delayMs: -1 }
  const policy = input.policy ?? DEFAULT_POLL_POLICY
  if (input.hidden) return { mode: 'hidden', delayMs: policy.activeMs * policy.hiddenFactor }
  return { mode: 'running', delayMs: policy.activeMs }
}

/* -------------------------------------------------------------------------- */
/* Engine availability                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Roll the probe results up into the one sentence the panel's status bar says.
 *
 * Unavailable engines are counted, not hidden: "2 of 3 engines unavailable" is
 * the fact that stops a human from asking "why is nothing starting?".
 */
export function summarizeEngines(results: readonly ClientProbeResult[]): {
  readonly total: number
  readonly available: number
  readonly withModels: number
  readonly credentialIssues: readonly string[]
} {
  let available = 0
  let withModels = 0
  const credentialIssues: string[] = []
  for (const result of results) {
    if (result.available) available += 1
    if ((result.models?.length ?? 0) > 0) withModels += 1
    const credential = result.health?.credential
    if (result.available && (credential === 'missing' || credential === 'invalid')) {
      credentialIssues.push(`${result.id}: ${credential}${result.health?.detail === undefined ? '' : ` (${result.health.detail})`}`)
    }
  }
  return { total: results.length, available, withModels, credentialIssues }
}

/** Readable one-liner for one credential state (never the raw enum). */
export function credentialLabel(credential: string | undefined): string {
  switch (credential) {
    case 'ok':
      return 'ok'
    case 'missing':
      return 'missing'
    case 'invalid':
      return 'invalid'
    case 'not-applicable':
      return 'n/a'
    case 'unknown':
      return 'unknown'
    case undefined:
      return '—'
    default:
      return credential
  }
}
