/**
 * dsh-agents-bridge — the nine model-facing tool definitions.
 *
 * This module is deliberately PURE: it touches no `ctx`, starts no process, and
 * holds no mutable state. `register.ts` owns the wiring, `index.ts` owns the
 * lifecycle. Keeping the definitions free of host access means they can be
 * unit-tested (and re-registered under a different scope) without a harness.
 *
 * Contract source of truth: `docs/design.md` §5. Names and parameters are
 * frozen there — a rename here breaks the published tool surface.
 *
 * The one hard design constraint lives in `agents_run`: its `execute` MUST
 * return as soon as the child is spawned. A tool call carries a cooperative
 * timeout budget while an agent CLI task is minutes long, so waiting there would
 * abort every real task. Waiting is a SEPARATE tool (`agents_wait`) whose whole
 * point is the bounded wait; `agents_run` itself still never awaits a session.
 * See the same promise in `index.ts`'s system-prompt section.
 *
 * Error copy is a feature here, not an afterthought: every message that reaches
 * the model has to name the offending parameter, the value it received and the
 * next action, because a model that only learns "that failed" burns another turn
 * guessing. `describeRunFailure` / `unknownSessionMessage` are the two places
 * that guarantee it for the run and session paths.
 *
 * @module dsh-agents-bridge/tools/definitions
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DRIVER_FAMILIES } from '../drivers/index.ts'
import type { AgentManager, AgentMessage, AgentResult, SessionSnapshot } from '../kernel/types.ts'
import { AgentRunRejectedError } from '../kernel/types.ts'
import { MAX_TIMER_DELAY_MS, normalizeRunWindowMs } from '../kernel/watchdog.ts'
import type { JobSeat } from '../host/jobs.ts'
import { redactSecrets } from '../tracks/host-files.ts'

/** Lifecycle states a session can be in, in the order a model should reason about them. */
const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'timeout'] as const

/** Transport modes v1 understands (`connect` is reserved, not implemented). */
const TRANSPORT_MODES = ['spawn', 'connect'] as const

/**
 * Event kinds rendered by `agents_output`. Mirrors `AgentMessageType`.
 *
 * Kept as a local tuple rather than imported: `defineTool` needs a literal
 * tuple for `enum` inference, and `AgentMessageType` is a type (no runtime
 * value to spread). A drift is caught by the `enum` schema in the output
 * contract — the kernel validates every emitted message against it.
 */
const MESSAGE_TYPES = ['text', 'thinking', 'tool_use', 'tool_result', 'status', 'log', 'error'] as const

/**
 * `agents_wait` bounds.
 *
 * A tool call carries a cooperative timeout budget while an agent run lasts
 * minutes, so a wait may only ever be a *bounded* wait — long enough to absorb
 * a normal task's tail, short enough that the caller still gets an answer
 * inside its own budget. Values above the cap are clamped rather than rejected:
 * the model asked for "wait as long as it takes", and the honest answer is
 * "I waited the longest I am allowed to, here is where things stand".
 */
export const MAX_WAIT_TIMEOUT_MS = 60_000
export const DEFAULT_WAIT_TIMEOUT_MS = 20_000

/**
 * Cap a per-run window (`timeoutMs` / `idleTimeoutMs`) at the timer ceiling.
 *
 * The schema leaves both unbounded on purpose: 0 means "no deadline", so a
 * caller expressing "this may take a very long time" writes a very large
 * number. Node does not reject a `setTimeout` delay above `MAX_TIMER_DELAY_MS` —
 * it rewrites it to **1 ms**, which would turn that intent into an immediate
 * timeout. The value is therefore lowered HERE, at the boundary where it enters
 * the kernel, exactly as `agents_wait` caps its own window at
 * `MAX_WAIT_TIMEOUT_MS`; the watchdog applies the same clamp again for callers
 * that reach the kernel directly.
 *
 * RR-MI-9: it is the kernel's own {@link normalizeRunWindowMs}, not a second
 * spelling of it. Besides the ceiling it also collapses every non-finite and
 * every non-positive value onto `0` — the one non-positive value with a
 * meaning — so a `-1` or a `0.5` (which `setTimeout` would fire at once) cannot
 * reach the kernel through this door either.
 */
function capRunWindow(ms: number): number {
  return normalizeRunWindowMs(ms)
}

/**
 * The model-facing floor for `idleTimeoutMs` (RR-MI-9).
 *
 * The tool schema DSL has no `minimum` keyword (`defineTool` rejects one:
 * "parameters.idleTimeoutMs.minimum is not supported by the value schema DSL"),
 * so the bound this ledger asks for is enforced HERE, where a value refused
 * with a sentence is worth more to the model than a validation error — and the
 * description above the knob states it too, because that is the part the model
 * actually reads.
 *
 * `0` is deliberately NOT accepted: at the kernel it means "no deadline", so an
 * idle window of 0 silently disables the idle watchdog, which is the opposite
 * of what a caller writing a small number meant. Omitting the knob is the way
 * to ask for the family default.
 */
const MIN_IDLE_WINDOW_MS = 1

/** The refusal copy for an `idleTimeoutMs` below {@link MIN_IDLE_WINDOW_MS}. */
function idleWindowRefusal(value: number): string {
  return `idleTimeoutMs must be at least ${MIN_IDLE_WINDOW_MS} ms; got ${String(value)}. `
    + 'Omit it to use this agent family\'s default idle window (claude/codebuddy: 30 minutes, '
    + 'others 5-10 minutes), or pass the number of milliseconds of silence that should fail the run.'
}

/**
 * Normalize one `idleTimeoutMs`.
 *
 * Throws {@link idleWindowRefusal} for a value below the floor, so the caller
 * can either let it out as a tool error (single run) or report it per entry
 * (batch) — but it must never reach `describeRunFailure`, whose tail copy
 * ("nothing was started, check the concurrency cap") would be noise here.
 */
function idleWindow(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  const normalized = capRunWindow(value)
  if (normalized < MIN_IDLE_WINDOW_MS) throw new Error(idleWindowRefusal(value))
  return normalized
}

/**
 * How often `agents_wait` re-reads the manager's snapshots.
 *
 * Matched to the manager's own 100ms event-sync interval: polling faster would
 * not observe anything the manager has not copied out of the driver yet, and
 * `status()` is a pure in-memory read (no subprocess, no I/O), so this is a
 * cheap loop either way.
 */
const WAIT_POLL_MS = 100

/** Events one `agents_wait` read returns per session before deferring the rest. */
const MAX_WAIT_EVENTS = 40

/**
 * Cap on one `agents_run_many` call.
 *
 * Sixteen is the point where a single call stops being a fan-out a human can
 * read back and starts being a batch job — and the concurrent-session cap will
 * refuse most of it anyway. Beyond this the answer is "split into batches",
 * which is stated in the error rather than left to be discovered.
 */
export const MAX_PARALLEL_RUNS = 16

/** How many known session ids an error message lists before eliding. */
const MAX_LISTED_SESSIONS = 8

/** One text block. Every `render` returns content in this shape. */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * Render a millisecond duration compactly. Models reason about wall-clock
 * budget when deciding whether to keep polling, so a raw `183421` is worse
 * than `3m3s`.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h${minutes}m`
  return `${minutes}m${seconds}s`
}

/**
 * Render one normalized agent event as a single readable line.
 *
 * Format (`docs/design.md` §5 and the integration test expectations):
 *   `[tool_use] Bash`
 *   `[text] <first line of the assistant text>`
 *   `[error] <message>`
 *
 * Long payloads are truncated per line and fully elided beyond a small count;
 * a model that needs the whole transcript should narrow its `limit` instead of
 * receiving a payload that crowds out its context window.
 */
export function renderMessage(message: AgentMessage, index: number): string {
  const prefix = `#${index} [${message.type}]`
  switch (message.type) {
    case 'tool_use':
      return `${prefix} ${message.tool ?? 'unknown'}${message.input === undefined ? '' : ` ${truncate(compactJson(message.input), 200)}`}`
    case 'tool_result': {
      const body = message.output ?? message.content ?? ''
      return `${prefix} ${message.tool ?? 'unknown'}${body.length === 0 ? '' : ` → ${truncate(firstLine(body), 200)}`}`
    }
    case 'text':
    case 'thinking':
    case 'status':
    case 'log':
      return `${prefix} ${truncate(firstLine(message.content ?? ''), 400)}`
    case 'error':
      return `${prefix} ${truncate(firstLine(message.content ?? 'unknown error'), 400)}`
    default:
      // Unreachable for the frozen union, but an unknown future type must not
      // crash a render: the model still gets to see that something happened.
      return `${prefix} ${truncate(firstLine(message.content ?? ''), 200)}`
  }
}

/** First non-empty line of a payload, so a multi-line text event stays one row. */
function firstLine(value: string): string {
  const lines = value.split('\n')
  for (const line of lines) {
    if (line.trim().length > 0) return line.trim()
  }
  return ''
}

/** Best-effort JSON for tool inputs; never throws on a cycle or a getter. */
function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Hard cap one rendered line so a single event cannot flood the result. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Per-line and total caps for one `agents_output` read. */
const MAX_RENDERED_MESSAGES = 80
const MAX_RENDERED_CHARS = 12_000

/** Longest `path=` value a probe row prints, in characters. */
const MAX_RENDERED_PATH_CHARS = 200

/** UTF-16 code-unit halves of an astral character (`charCodeAt` gives NaN past the end). */
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Make one `command.executable` value safe for an `agents_probe` ROW.
 *
 * The kernel keeps this value VERBATIM on purpose — it is launch data an
 * operator must see exactly to declare a descriptor for it — so the sanitising
 * belongs HERE, at the single point the value becomes model-visible text.
 *
 * The channel is real: a scanned executable is `path.join(root, entry.name)`,
 * i.e. it is built from the bundle's DIRECTORY NAME, which is attacker-chosen
 * under the user-writable `~/Applications`. IM-12 hardened `notes`,
 * `displayName` and `id`, but this value reaches the row untouched, so a
 * directory name containing a newline (plus `available; path=`) forged extra
 * rows in the probe table the model reads, and a credential-looking path
 * component was echoed. So:
 *
 *   1. collapse to ONE line (whitespace runs, newlines included),
 *   2. redact credential-looking substrings,
 *   3. bound the length — but elide the MIDDLE instead of the tail. The tail
 *      (`…/bin/codebuddy`) is what identifies the file and the head names the
 *      root; a head-only cap (what `oneLine` does) would strip the only part an
 *      operator can act on and leave the row unrecognisable.
 */
function renderExecutablePath(raw: string): string {
  const safe = redactSecrets(raw.replace(/\s+/g, ' ').trim())
  if (safe.length <= MAX_RENDERED_PATH_CHARS) return safe
  const head = Math.ceil((MAX_RENDERED_PATH_CHARS - 1) / 2)
  const tail = MAX_RENDERED_PATH_CHARS - 1 - head
  // Both cuts are counted in UTF-16 CODE UNITS, and an astral character — an
  // emoji in a bundle directory name, which is attacker-chosen under the
  // user-writable `~/Applications` — is TWO of them. Either cut can therefore
  // land INSIDE a pair and emit a lone half: a 😀 straddling the head cut
  // rendered as `…a\ud83d…`, a row carrying invalid UTF-16 that every reader
  // downstream has to survive (SV-1). Step each cut off the pair instead of
  // slicing through it — the elision stays inside its 200-unit budget, both
  // ends stay recognisable, and an ASCII path is elided exactly as before.
  const headEnd = isHighSurrogate(safe.charCodeAt(head - 1)) ? head - 1 : head
  const tailStart = safe.length - tail
  const tailFrom = isLowSurrogate(safe.charCodeAt(tailStart)) ? tailStart + 1 : tailStart
  return `${safe.slice(0, headEnd)}…${safe.slice(tailFrom)}`
}

/**
 * Render a probe table. Unavailable identities are shown WITH their reason.
 *
 * The parameter is a structural projection rather than `ProbeResult[]` so the
 * renderer also accepts the schema-inferred value (this repo's
 * `noUncheckedIndexedAccess` turns every inferred key optional — see the note
 * in the `agents_status` render). At runtime the registry has already validated
 * the value against `output.schema`, so the fallbacks below are unreachable for
 * a conforming kernel; they exist so a render can never throw.
 */
function renderProbe(
  results: readonly {
    readonly id?: string | undefined
    readonly displayName?: string | undefined
    readonly family?: string | undefined
    readonly available?: boolean | undefined
    readonly executable?: string | undefined
    readonly version?: string | undefined
    readonly reason?: string | undefined
  }[],
): ContentBlock[] {
  if (results.length === 0) {
    return text('No agent identities are registered. Add one to the plugin config (`descriptors`) or the kernel registry.')
  }
  const lines = results.map(result => {
    // The executable is the one output column NOT produced by the scan's own
    // hardening: it comes from the bundle's directory name. Sanitise it here.
    const path = result.executable === undefined ? '-' : renderExecutablePath(result.executable)
    const version = result.version === undefined ? '' : ` v${result.version}`
    const status = result.available === true ? 'available' : `unavailable (${result.reason ?? 'reason not reported'})`
    return `${result.available === true ? '✓' : '✗'} ${result.id ?? 'unknown'} [${result.family ?? 'unknown'}] ${result.displayName ?? ''} — ${status}; path=${path}${version}`
  })
  const usable = results.filter(r => r.available === true).map(r => r.id ?? 'unknown')
  const tail = usable.length === 0
    ? 'Nothing is drivable on this host: do not call agents_run.'
    : `Drivable now: ${usable.join(', ')}. Pass one of these ids as agents_run.agent.`
  return text([...lines, '', tail].join('\n'))
}


/* -------------------------------------------------------------------------- */
/* Shared plumbing: error copy, cursors, event rendering                       */
/* -------------------------------------------------------------------------- */

/** Real-timer sleep. `agents_wait` is the only caller and it always bounds it. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Accept the two spellings the model actually uses for "these sessions".
 *
 * A single id is the common case (`agents_run` → one session), a list is the
 * fan-out case. Rejecting one spelling to force the other costs a turn for no
 * benefit, so both are accepted and normalized here.
 */
function normalizeIds(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  const raw = typeof value === 'string' ? [value] : value
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** The ids this bridge currently knows, capped so an error stays readable. */
function knownSessionIds(manager: AgentManager): string {
  const ids = manager.list().map((session) => session.sessionId)
  if (ids.length === 0) return 'no sessions yet'
  const shown = ids.slice(0, MAX_LISTED_SESSIONS).join(', ')
  return ids.length > MAX_LISTED_SESSIONS ? `${shown}, … (${ids.length} total)` : shown
}

/**
 * The message for "that session id means nothing to me".
 *
 * Lists what DOES exist, because the realistic cause is a stale or mistyped id
 * (the model copied it from an earlier turn, or the bridge restarted). Naming
 * the known ids turns a dead end into a one-step fix.
 */
function unknownSessionMessage(manager: AgentManager, sessionId: string): string {
  return (
    `unknown session "${sessionId}". This bridge knows: ${knownSessionIds(manager)}. ` +
    'Call agents_status to list them with their statuses, or agents_run to start a new session.'
  )
}

/**
 * Identity ids for an "unknown agent" refusal — best effort, never fatal.
 *
 * The frozen `AgentManager` ABI has no "list identities" method, so `probe()` is
 * the only source, and it is the right one: it includes identities added by
 * config. It is cached (60s TTL) and internally bounded (per-version timeout),
 * and this runs only on the error path of an already-failed `run`, so the cost
 * is paid at most once per mistake. If it fails, the kernel's own message
 * already tells the model to call `agents_probe`.
 */
async function knownIdentities(manager: AgentManager): Promise<string | undefined> {
  try {
    const results = await manager.probe()
    if (results.length === 0) return undefined
    return results
      .map((result) => (result.available ? result.id : `${result.id} (unavailable)`))
      .join(', ')
  } catch {
    return undefined
  }
}

/** What to do next when a start was refused and the kernel did not already say. */
const RUN_FAILURE_TAIL =
  'Nothing was started. Call agents_probe for a drivable identity, check the agents-bridge config for ' +
  'cwd/agent policy and the concurrency cap, then retry.'

const SEND_FAILURE_TAIL =
  'Call agents_status to list the sessions this bridge knows about, or agents_run to start a fresh one.'

/**
 * Turn a kernel refusal into a message the model can act on.
 *
 * Policy refusals already carry the offending value and the allowed set (see
 * `kernel/policy.ts`), so they are passed through untouched; what this adds is
 * the missing step for the two cases the kernel cannot describe — an agent id
 * that does not exist (only `probe` knows the list) and an identity that exists
 * but is not drivable.
 *
 * The refusal is enriched IN PLACE rather than replaced. `AgentRunRejectedError`
 * is the ABI v3 contract that makes a refusal machine-readable (`code`, `value`,
 * `allowed`, `maxConcurrent`); re-wrapping it in a plain `Error` to reword the
 * prose would quietly throw that away, and an embedder that classifies refusals
 * by `code` would start seeing an untyped error.
 */
async function describeRunFailure(
  manager: AgentManager,
  err: unknown,
  action: 'run' | 'send',
): Promise<Error> {
  if (err instanceof AgentRunRejectedError) {
    if (err.code === 'unknown-agent') {
      const known = await knownIdentities(manager)
      if (known !== undefined) err.message = `${err.message}. Known identities: ${known}`
    } else if (err.code === 'unsupported-agent') {
      err.message = `${err.message}. Pick a drivable identity from agents_probe instead.`
    }
    // `agent-not-allowed`, `cwd-*` and `max-concurrent` already name the value,
    // the allowed range and the way out.
    return err
  }
  const message = err instanceof Error ? err.message : String(err)
  // If the message already names one of our tools, the kernel already said what
  // to do next and a second instruction would just be noise.
  const tail = message.includes('agents_') ? '' : ` ${action === 'run' ? RUN_FAILURE_TAIL : SEND_FAILURE_TAIL}`
  return new Error(`${message}${tail}`)
}

/**
 * The terminal-result projection shared by `agents_output` and `agents_wait`.
 *
 * Deliberately identical in both tools: the model learns one shape for "how the
 * run ended" and the two tools cannot drift into describing the same result
 * differently.
 */
function projectResult(result: AgentResult) {
  return {
    status: result.status,
    text: truncate(result.text, MAX_RENDERED_CHARS),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    durationMs: result.durationMs,
    ...(result.backendSessionId === undefined ? {} : { backendSessionId: result.backendSessionId }),
    ...(result.usage === undefined
      ? {}
      : {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          // Disclosure, not a bucket: codex counts reasoning INSIDE
          // output_tokens (see `AgentUsage.reasoningTokens` in the ABI).
          ...(result.usage.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: result.usage.reasoningTokens }),
        }),
  }
}

/** One projected event, as both `agents_output` and `agents_wait` emit it. */
interface RenderedEvent {
  readonly index?: number | undefined
  readonly type?: string | undefined
  readonly text?: string | undefined
  readonly tool?: string | undefined
}

/**
 * Render normalized events as one readable block per event.
 *
 * Consecutive `text`/`thinking` events are joined: some dialects emit one event
 * per streamed delta, and a line per fragment is pure noise in the model's
 * context. `tool_use`/`tool_result` keep their own line so a tool call is never
 * mistaken for prose.
 *
 * The join is decided by whether the PREVIOUS event was text, not by whether any
 * text has ever been seen: a sticky flag glued every later text event onto
 * whatever block happened to be last — tool output included — so the prose lost
 * its own index/type and the tool output gained a sentence (IM-19).
 */
function renderEventBlocks(messages: readonly RenderedEvent[]): string[] {
  let previousWasText = false
  const blocks: string[] = []
  for (const message of messages) {
    const prefix = `#${message.index ?? 0} [${message.type ?? 'log'}]`
    const isText = message.type === 'text' || message.type === 'thinking'
    if (isText && previousWasText && blocks.length > 0) {
      const last = blocks.length - 1
      blocks[last] = `${blocks[last] ?? ''}${message.text ?? ''}`
      continue
    }
    switch (message.type) {
      case 'tool_use':
      case 'tool_result':
        blocks.push(
          `${prefix} ${message.tool ?? 'unknown'}${message.text === undefined ? '' : ` → ${message.text}`}`,
        )
        break
      default:
        blocks.push(`${prefix} ${message.text ?? ''}`)
        break
    }
    previousWasText = isText
  }
  return blocks
}

/**
 * The nine tools. `AgentManager` is closed over per-tool via a factory so the
 * same definition table cannot accidentally capture a stale manager: the entry
 * passes the live one once, at registration time.
 */
export function createToolDefinitions(manager: AgentManager, seat: JobSeat = {}) {
  /* ------------------------------------------------- completion notices */
  // How often a registered job checks its session, and how long a session that
  // has VANISHED from the manager is tolerated before the job reports that it is
  // gone. A session is always known right after `run()` resolves; a momentary
  // `undefined` is a race, a persistent one is a restart.
  const JOB_POLL_MS = 250
  const JOB_VANISH_TICKS = 20

  /**
   * Wait for one session to reach a terminal state.
   *
   * This is the producer side of the host's job contract, so it is deliberately
   * NOT bounded by a tool-call budget: the jobs runtime owns the lifetime, and
   * the kernel's own watchdogs are what end a wedged session. It never rejects:
   * a job that throws here would be a producer that did not settle.
   */
  async function waitForTerminal(sessionId: string): Promise<SessionSnapshot | undefined> {
    let missing = 0
    for (;;) {
      const snapshot = manager.status(sessionId)
      if (snapshot !== undefined) {
        if (snapshot.terminal) return snapshot
        missing = 0
      } else if (++missing >= JOB_VANISH_TICKS) {
        return undefined
      }
      await delay(JOB_POLL_MS)
    }
  }

  /** The last few readable lines of a session, for the completion notice. */
  function tailOf(sessionId: string): string | undefined {
    const snapshot = manager.status(sessionId)
    const from = Math.max(0, (snapshot?.messageCount ?? 0) - 4)
    const page = manager.output(sessionId, { sinceIndex: from, limit: 4 })
    const parts = (page?.messages ?? [])
      .map(message => message.content ?? message.output ?? '')
      .filter(part => part !== '')
    if (parts.length === 0) {
      const last = snapshot?.lastMessage?.content ?? snapshot?.lastMessage?.output ?? ''
      return last === '' ? undefined : last
    }
    return parts.join('\n')
  }

  /**
   * Register a just-started session with the host, so its completion opens a
   * model turn instead of waiting to be polled.
   *
   * Returns `undefined` — meaning "this run gets no notice" — whenever the host
   * has no job registry, the call has no agent behind it, or the registry
   * refuses. Never throws: a missing notice must not fail the delegation.
   */
  function announceCompletion(
    snapshot: SessionSnapshot,
    owner: unknown,
    prompt: string,
  ): string | undefined {
    const registrar = seat.registrar
    // The owner check lives HERE, not only in the registrar: this layer is the
    // one that knows whether an agent is behind the call, and a registration
    // request nobody can serve should never be made. `createJobRegistrar`
    // repeats the check because a job with no owner would be a job with no
    // session to announce into — defence in depth on the same invariant.
    if (registrar === undefined || owner === undefined) return undefined
    return registrar.register({
      sessionId: snapshot.sessionId,
      agentId: snapshot.agentId,
      label: prompt,
      owner,
      waitTerminal: () => waitForTerminal(snapshot.sessionId),
      cancel: reason => {
        void manager.cancel(snapshot.sessionId, reason).catch(() => {})
      },
      tail: () => tailOf(snapshot.sessionId),
    })
  }

  /** `agents_probe` — is anything drivable on this host? The smoke tool. */
  const probe = defineTool({
    name: 'agents_probe',
    description:
      'Probe this host for drivable agent CLIs (Claude Code, CodeBuddy/WorkBuddy, OpenClaw/AutoClaw, …). '
      + 'Call this before the first agents_run of a session to learn which agent ids exist, and to see why a '
      + 'known-but-undrivable app (sealed desktop bundle) is unavailable. Results are cached; pass refresh to re-probe.',
    parameters: {
      refresh: {
        type: 'boolean',
        description: 'Bypass the probe cache and re-resolve executables and versions on PATH.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            track: { type: 'string', enum: ['cli', 'desktop'] },
            // Derived, not transcribed: this list used to be a hand-kept copy of
            // `ProtocolFamily`, so adding a family meant remembering a spot the
            // compiler could not point at (it caught `DRIVER_FAMILIES` and both
            // idle-timeout tables, but this enum is data). Reading the driver's
            // own list keeps the model-facing schema and the union in step.
            family: { type: 'string', enum: [...DRIVER_FAMILIES] },
            available: { type: 'boolean' },
            executable: { type: 'string' },
            version: { type: 'string' },
            reason: { type: 'string' },
            // `ProbeResult.capabilities` — which engine knobs this dialect
            // supports. The registry has always returned it; this schema did not
            // declare it, and `additionalProperties: false` turns an undeclared
            // field into a hard materialization error ("capabilities is not a
            // declared property"), so `agents_probe` failed for EVERY identity.
            // Keep this list in sync with `AgentDescriptor['capabilities']`.
            capabilities: {
              type: 'object',
              additionalProperties: false,
              properties: {
                resume: { type: 'boolean' },
                model: { type: 'boolean' },
                effort: { type: 'boolean' },
                mcpConfig: { type: 'boolean' },
                clientTools: { type: 'boolean' },
              },
            },
            notes: { type: 'string' },
            health: {
              type: 'object',
              additionalProperties: false,
              properties: {
                launch: { type: 'string', enum: ['ok', 'missing', 'unsupported'] },
                credential: {
                  type: 'string',
                  enum: ['ok', 'missing', 'invalid', 'unknown', 'not-applicable'],
                },
                detail: { type: 'string' },
                configPath: { type: 'string' },
              },
            },
            models: { type: 'array', items: { type: 'string' } },
            modelsSource: { type: 'string' },
            authMethods: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      render: (_args, value) => renderProbe(value),
    },
    execute: async (args) => {
      const results = await manager.probe(args.refresh === undefined ? {} : { refresh: args.refresh })
      // Spread into mutable JSON arrays: the kernel returns `readonly` views,
      // and `output.schema` materialization must see plain lossless JSON.
      return results.map(({ models, authMethods, capabilities, ...rest }) => ({
        ...rest,
        // `ProbeResult.models` is a readonly view; materialization needs a
        // plain mutable array to satisfy the schema type. Same for the ACP-only
        // `authMethods`, and for `capabilities` (a `readonly` descriptor field
        // that must reach the schema as a plain object).
        ...(capabilities === undefined ? {} : { capabilities: { ...capabilities } }),
        ...(models === undefined ? {} : { models: [...models] }),
        ...(authMethods === undefined ? {} : { authMethods: [...authMethods] }),
      }))
    },
  })

  /** `agents_run` — fire and forget. Returns the session id and nothing else. */
  const run = defineTool({
    name: 'agents_run',
    description:
      'Start ONE agent CLI task in the background on this host. Returns IMMEDIATELY with a sessionId — it never '
      + 'waits for the task to finish (these tasks take minutes; a tool call does not). Then call agents_wait to '
      + 'wait for it in one bounded call, or agents_output to read the transcript incrementally. Use agents_run_many '
      + 'instead when several independent tasks should start together. The session keeps running even if this '
      + 'conversation moves on.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'Agent identity to drive, as reported by agents_probe (e.g. workbuddy, autoclaw, claude).',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The task / instruction handed to the delegated agent, in full. It cannot see this conversation.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the delegated agent. Defaults to the bridge default (usually the current project).',
      },
      model: {
        type: 'string',
        description: 'Model override for dialects that support one. Ignored by dialects that do not.',
      },
      effort: {
        type: 'string',
        description: 'Runtime-native reasoning effort (e.g. low / medium / high) where the dialect supports it.',
      },
      timeoutMs: {
        type: 'integer',
        description:
          `Hard wall-clock deadline in ms, capped at ${MAX_TIMER_DELAY_MS}. 0 or omitted = no deadline (idle watchdog only).`,
      },
      idleTimeoutMs: {
        type: 'integer',
        description:
          `No-output window in ms before the run is failed; ${MIN_IDLE_WINDOW_MS}..${MAX_TIMER_DELAY_MS}. Omitted = `
          + 'the per-family default (30 minutes for claude/codebuddy, who emit nothing for the whole duration of a '
          + 'tool call; 5-10 minutes elsewhere). Lower it to catch a wedged engine sooner, or raise it if this task '
          + 'legitimately spends longer than that in one tool call. 0 is NOT "no idle deadline" — omit the knob for '
          + 'the default instead.',
      },
      mode: {
        type: 'string',
        enum: [...TRANSPORT_MODES],
        description: "Transport mode. v1 implements 'spawn'; 'connect' is reserved and not implemented.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          agent: { type: 'string' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          startedAt: { type: 'integer' },
          jobId: { type: 'string' },
        },
      },
      render: (_args, value) => text(
        [
          `started ${value.agent} session ${value.sessionId} (status=${value.status})`,
          ...(value.jobId === undefined
            ? []
            : [
                `host job ${value.jobId}: its completion will be announced in this session — you do NOT have to poll for it.`,
              ]),
          '',
          `Next: agents_wait { "sessionIds": "${value.sessionId}", "timeoutMs": 20000 } to wait for it in ONE call`,
          `(a timeout there is normal — call it again), or agents_output { "sessionId": "${value.sessionId}", "sinceIndex": 0 }`,
          `to read the transcript, or agents_status { "sessionId": "${value.sessionId}" } for a one-line liveness check.`,
          'Do not re-run the task while it is running; keep the returned nextIndex and pass it back to read only new events.',
          ...(value.jobId === undefined
            ? []
            : ['If you would rather wait than be told, agents_wait still works; the notice arrives either way.']),
        ].join('\n'),
      ),
    },
    execute: async (args, exec) => {
      // Same contract as each `agents_run_many` entry: a whitespace-only prompt
      // is refused at this boundary, not handed to every driver to interpret
      // (several would shift it into an option or stdin slot by accident).
      const prompt = args.prompt.trim()
      if (prompt === '') {
        throw new Error(
          'prompt is required and must be non-empty; the delegated agent cannot see this conversation, so the prompt has to contain the whole task (paths, constraints, acceptance criteria).',
        )
      }
      // The kernel's `run()` resolves once the child is spawned and the session
      // is registered — it does NOT await `done`. Everything optional is spread
      // conditionally so an omitted knob is absent rather than `undefined`.
      // RR-MI-9: refused BEFORE the run starts — both so a window that is not
      // a window never reaches the kernel, and so the refusal goes to the model
      // as itself instead of wearing `describeRunFailure`'s "nothing was
      // started" tail.
      const idleTimeoutMs = idleWindow(args.idleTimeoutMs)
      let snapshot: SessionSnapshot
      try {
        snapshot = await manager.run({
          agent: args.agent,
          prompt,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.effort === undefined ? {} : { effort: args.effort }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: capRunWindow(args.timeoutMs) }),
          ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        })
      } catch (err) {
        throw await describeRunFailure(manager, err, 'run')
      }
      // Hand the session to the host's job registry so its completion opens a
      // model turn (see host/jobs.ts). `exec.agent` is the CALLING agent — the
      // agent loop sets it — and it is what makes the notice land in the right
      // session. Without one, no job is created: an unowned job would settle
      // with nobody to tell.
      const jobId = announceCompletion(snapshot, exec?.agent, prompt)
      return {
        sessionId: snapshot.sessionId,
        agent: snapshot.agentId,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        ...(jobId === undefined ? {} : { jobId }),
      }
    },
  })

  /**
   * `agents_run_many` — the parallel fan-out form of `agents_run`.
   *
   * Same validation, same policy, same fire-and-forget contract; the only new
   * behaviour is that one call starts N sessions and one refused entry cannot
   * take the other entries down with it. Entries are started sequentially
   * (each `run()` returns as soon as its child is spawned) so the result array
   * stays in the caller's order, but nothing waits for any child.
   */
  const runMany = defineTool({
    name: 'agents_run_many',
    description:
      `Start up to ${MAX_PARALLEL_RUNS} agent sessions in ONE call — use this instead of issuing N agents_run calls for ` +
      'independent tasks ("these 5 files, one agent each"). Returns IMMEDIATELY with one sessionId per entry; it never '
      + 'waits for any of them. Each entry is started independently: an entry that is refused (unknown agent, cwd outside '
      + 'the allowed roots, or the concurrent-session cap) comes back with its own error and does NOT abort the rest. '
      + 'Wait for the batch with one agents_wait call.',
    parameters: {
      runs: {
        type: 'array',
        required: true,
        description:
          `One entry per session to start (1..${MAX_PARALLEL_RUNS}). Entries start concurrently; the result order matches this array.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agent: {
              type: 'string',
              required: true,
              description: 'Agent identity from agents_probe.',
            },
            prompt: {
              type: 'string',
              required: true,
              description: 'The full task for this entry; the delegated agent cannot see this conversation.',
            },
            cwd: { type: 'string', description: 'Working directory for this entry. Defaults to the bridge default.' },
            model: { type: 'string', description: 'Model override where the dialect supports one.' },
            effort: { type: 'string', description: 'Runtime-native reasoning effort where the dialect supports it.' },
            timeoutMs: {
              type: 'integer',
              description: `Hard wall-clock deadline in ms for this entry, capped at ${MAX_TIMER_DELAY_MS}. 0 = none.`,
            },
            idleTimeoutMs: {
              type: 'integer',
              description:
                `No-output window in ms for this entry; ${MIN_IDLE_WINDOW_MS}..${MAX_TIMER_DELAY_MS}. Omitted = the `
                + 'per-family default; raise it for an entry whose single tool call legitimately runs longer than '
                + 'that. 0 is not accepted — omit the knob for the default.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requested: { type: 'integer' },
          started: { type: 'integer' },
          failed: { type: 'integer' },
          runs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                agent: { type: 'string' },
                started: { type: 'boolean' },
                sessionId: { type: 'string' },
                status: { type: 'string', enum: [...RUN_STATUSES] },
                jobId: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        // `?? []` — see the note in the agents_status render below.
        const runs = value.runs ?? []
        const lines = runs.map((entry) => {
          const head = `#${entry.index ?? 0} ${entry.agent ?? 'unknown'}`
          return entry.started === true
            ? `✓ ${head} → session ${entry.sessionId ?? '?'} (status=${entry.status ?? 'running'})`
              + (entry.jobId === undefined ? '' : `, job ${entry.jobId} will announce itself`)
            : `✗ ${head} → ${entry.error ?? 'refused'}`
        })
        const started = runs.filter((entry) => entry.started === true)
        const body = [
          `requested ${value.requested ?? runs.length}, started ${value.started ?? started.length}, failed ${value.failed ?? 0}`,
          '',
          ...lines,
        ]
        if (started.length > 0) {
          const ids = started.map((entry) => `"${entry.sessionId ?? ''}"`).join(', ')
          body.push(
            '',
            `Next: agents_wait { "sessionIds": [${ids}], "timeoutMs": 20000 } to wait for the whole batch in one call`,
            '(a timeout there is normal — it returns whatever is still running and you call it again), then',
            'agents_output per session for the transcripts. Failed entries were not started: fix what the error names and re-send only those.',
          )
        } else {
          body.push('', 'Nothing started. Fix what the errors name (agents_probe lists the identities this bridge can drive) and retry.')
        }
        return text(body.join('\n'))
      },
    },
    execute: async (args, exec) => {
      const requested = args.runs
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new Error(
          'runs must contain at least one entry; for a single task call agents_run instead.',
        )
      }
      if (requested.length > MAX_PARALLEL_RUNS) {
        throw new Error(
          `runs has ${requested.length} entries but one call starts at most ${MAX_PARALLEL_RUNS}. ` +
            `Split it into batches of ${MAX_PARALLEL_RUNS} and call agents_run_many again for the next batch ` +
            '(concurrent sessions are separately capped by maxConcurrent).',
        )
      }
      const results: Array<{
        index: number
        agent: string
        started: boolean
        sessionId?: string
        status?: (typeof RUN_STATUSES)[number]
        jobId?: string
        error?: string
      }> = []
      for (const [index, entry] of requested.entries()) {
        const agent = typeof entry.agent === 'string' ? entry.agent.trim() : ''
        const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : ''
        if (agent === '') {
          results.push({
            index,
            agent: '',
            started: false,
            error: `runs[${index}].agent is required and must be a non-empty identity id; call agents_probe for the ids this bridge can drive.`,
          })
          continue
        }
        if (prompt === '') {
          results.push({
            index,
            agent,
            started: false,
            error:
              `runs[${index}].prompt is required and must be non-empty; the delegated agent cannot see this ` +
              'conversation, so the prompt has to contain the whole task (paths, constraints, acceptance criteria).',
          })
          continue
        }
        // Same floor as `agents_run`, per entry — and refused the same way the
        // other per-entry refusals are: reported as that entry's error, with no
        // `describeRunFailure` tail (the batch may well have started others).
        const rawIdle = entry.idleTimeoutMs
        if (rawIdle !== undefined && capRunWindow(rawIdle) < MIN_IDLE_WINDOW_MS) {
          results.push({
            index,
            agent,
            started: false,
            error: `runs[${index}] (${agent}): ${idleWindowRefusal(rawIdle)}`,
          })
          continue
        }
        try {
          const snapshot = await manager.run({
            agent,
            prompt,
            ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
            ...(entry.model === undefined ? {} : { model: entry.model }),
            ...(entry.effort === undefined ? {} : { effort: entry.effort }),
            ...(entry.timeoutMs === undefined ? {} : { timeoutMs: capRunWindow(entry.timeoutMs) }),
            ...(rawIdle === undefined ? {} : { idleTimeoutMs: capRunWindow(rawIdle) }),
          })
          // One job PER ENTRY, not one for the batch: a fan-out's whole point is
          // that the caller learns about each session as it lands, and a batch
          // job would announce only the slowest one.
          const jobId = announceCompletion(snapshot, exec?.agent, prompt)
          results.push({
            index,
            agent: snapshot.agentId,
            started: true,
            sessionId: snapshot.sessionId,
            status: snapshot.status,
            ...(jobId === undefined ? {} : { jobId }),
          })
        } catch (err) {
          // Per-entry isolation is the whole point: one refused entry (bad id,
          // denied cwd, concurrency cap) must not roll back the others, and the
          // index prefix is what makes a partially-started batch actionable.
          const failure = await describeRunFailure(manager, err, 'run')
          results.push({
            index,
            agent,
            started: false,
            error: `runs[${index}] (${agent}): ${failure.message}`,
          })
        }
      }
      const started = results.filter((entry) => entry.started).length
      const hint = started === results.length
        ? `All ${started} session(s) started. Wait for them with one agents_wait call.`
        : started === 0
          ? 'Nothing started — every entry was refused. Read each entry\'s error, fix it, and re-send.'
          : `${started} of ${results.length} started. The failed entries were NOT started: fix what their errors name and re-send only those.`
      return {
        requested: requested.length,
        started,
        failed: results.length - started,
        runs: results,
        hint,
      }
    },
  })

  /** `agents_status` — cheap liveness. No sessionId = every live session. */
  const status = defineTool({
    name: 'agents_status',
    description:
      'List session snapshots. Pass sessionId for one session, or omit it for every session this plugin owns '
      + '(running first, then most recently ended). Cheap: use it to decide whether to keep waiting instead of '
      + 'pulling events with agents_output.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Session to inspect. Omit to list all live and retained sessions.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                agentId: { type: 'string' },
                status: { type: 'string', enum: [...RUN_STATUSES] },
                startedAt: { type: 'integer' },
                endedAt: { type: 'integer' },
                messageCount: { type: 'integer' },
                terminal: { type: 'boolean' },
                lastMessageType: { type: 'string', enum: [...MESSAGE_TYPES] },
                lastMessage: { type: 'string' },
                resultStatus: { type: 'string', enum: [...RUN_STATUSES] },
                exitCode: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // NOTE on `?? []`: this repo compiles with `noUncheckedIndexedAccess`,
        // which makes every key of an inferred object schema optional from the
        // renderer's point of view. The schema still REQUIRES them at runtime
        // (the registry validates before render), so the fallback is dead code
        // for a conforming value and only exists to keep the render pure-typed.
        const sessions = value.sessions ?? []
        if (sessions.length === 0) {
          return text('No sessions yet. Start one with agents_run.')
        }
        const lines = sessions.map(session => {
          const ended = session.endedAt === undefined ? '' : ` ended=${new Date(session.endedAt).toISOString()}`
          const last = session.lastMessage === undefined ? '' : `\n    last[${session.lastMessageType ?? 'log'}] ${session.lastMessage}`
          const result = session.resultStatus === undefined
            ? ''
            : `\n    result: ${session.resultStatus}${session.exitCode === undefined ? '' : ` exit=${session.exitCode}`}${session.error === undefined ? '' : ` error=${session.error}`}`
          return `• ${session.sessionId} agent=${session.agentId} status=${session.status} messages=${session.messageCount}${ended}${last}${result}`
        })
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      if (args.sessionId !== undefined && manager.status(args.sessionId) === undefined) {
        // An empty list would read as "no such session" only to a human; the
        // model needs to be told, and told what does exist.
        throw new Error(unknownSessionMessage(manager, args.sessionId))
      }
      const snapshots = args.sessionId === undefined
        ? manager.list()
        : [manager.status(args.sessionId)].filter((value): value is SessionSnapshot => value !== undefined)
      // Running sessions first, then the most recently started — that ordering
      // matches the question the model is usually asking ("what is still alive?").
      const ordered = [...snapshots].sort((left, right) => {
        if (left.terminal !== right.terminal) return left.terminal ? 1 : -1
        return right.startedAt - left.startedAt
      })
      return {
        sessions: ordered.map(session => {
          const result = session.result
          return {
            sessionId: session.sessionId,
            agentId: session.agentId,
            status: session.status,
            startedAt: session.startedAt,
            ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
            messageCount: session.messageCount,
            terminal: session.terminal,
            ...(session.lastMessage === undefined ? {} : { lastMessageType: session.lastMessage.type, lastMessage: renderMessage(session.lastMessage, session.messageCount - 1) }),
            ...(result === undefined ? {} : {
              resultStatus: result.status,
              ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
              ...(result.error === undefined ? {} : { error: result.error }),
            }),
          }
        }),
      }
    },
  })

  /**
   * `agents_wait` — the bounded wait.
   *
   * Exists because the alternative costs the caller a turn (and its tokens) per
   * poll: a ten-minute task would otherwise take dozens of `agents_output`
   * round-trips to notice it ended. It is a SEPARATE tool on purpose — the
   * invariant that `agents_run` never awaits (design doc D5) is untouched.
   *
   * It never cancels, never fails on timeout, and never mutates a session: the
   * only thing it can do is return later.
   */
  const wait = defineTool({
    name: 'agents_wait',
    description:
      'Wait (bounded) until sessions reach a terminal state, instead of polling agents_output in a loop. Returns as '
      + `soon as every named session is terminal, or — with until:"any" — as soon as one is; otherwise it returns when `
      + `timeoutMs elapses (default ${DEFAULT_WAIT_TIMEOUT_MS}, capped at ${MAX_WAIT_TIMEOUT_MS}). A timeout is a NORMAL `
      + 'result (timedOut=true), not an error: nothing was cancelled and the runs are still going, so call agents_wait '
      + 'again or pull the increment with agents_output. It never waits longer than timeoutMs.',
    parameters: {
      sessionIds: {
        oneOf: [
          { type: 'string', description: 'A single session id.' },
          { type: 'array', items: { type: 'string' }, description: 'Several session ids (a fan-out batch).' },
        ],
        required: true,
        description: 'Session(s) to wait for, as returned by agents_run / agents_run_many.',
      },
      timeoutMs: {
        type: 'integer',
        description:
          `Upper bound in milliseconds. Default ${DEFAULT_WAIT_TIMEOUT_MS}; values above ${MAX_WAIT_TIMEOUT_MS} are clamped to it.`,
      },
      until: {
        type: 'string',
        enum: ['all', 'any'],
        description:
          "Default 'all' = wait for every session. 'any' = return as soon as one is terminal; the rest keep running.",
      },
      sinceIndex: {
        type: 'integer',
        description:
          'Also return new events from this index for each session. Omit to return no events (you still get each nextIndex).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waitedMs: { type: 'integer' },
          timedOut: { type: 'boolean' },
          until: { type: 'string', enum: ['all', 'any'] },
          timeoutMs: { type: 'integer' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                agentId: { type: 'string' },
                status: { type: 'string', enum: [...RUN_STATUSES] },
                terminal: { type: 'boolean' },
                waitedMs: { type: 'integer' },
                nextIndex: { type: 'integer' },
                firstIndex: { type: 'integer' },
                dropped: { type: 'integer' },
                result: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string', enum: [...RUN_STATUSES] },
                    text: { type: 'string' },
                    error: { type: 'string' },
                    exitCode: { type: 'integer' },
                    durationMs: { type: 'integer' },
                    backendSessionId: { type: 'string' },
                    inputTokens: { type: 'integer' },
                    outputTokens: { type: 'integer' },
                    // Disclosure, not a bucket to add up: codex counts reasoning
                    // INSIDE output_tokens (see AgentUsage.reasoningTokens).
                    reasoningTokens: { type: 'integer' },
                  },
                },
                events: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      index: { type: 'integer' },
                      type: { type: 'string', enum: [...MESSAGE_TYPES] },
                      text: { type: 'string' },
                      tool: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (args, value) => {
        // `?? []` — see the note in the agents_status render below.
        const sessions = value.sessions ?? []
        const timeoutMs = value.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
        const requested = args.timeoutMs
        const clampNote =
          requested !== undefined && requested > timeoutMs
            ? ` (you asked for ${formatDuration(requested)}; capped at ${formatDuration(timeoutMs)})`
            : ''
        const stillRunning = sessions.filter((session) => session.terminal !== true).length
        const header = value.timedOut === true
          ? `waited ${formatDuration(value.waitedMs ?? 0)} — timed out with ${stillRunning} of ${sessions.length} session(s) still running${clampNote}`
          : value.until === 'any'
            ? `waited ${formatDuration(value.waitedMs ?? 0)} — a session reached a terminal state (until=any${clampNote})`
            : `waited ${formatDuration(value.waitedMs ?? 0)} — every session is terminal (until=all${clampNote})`
        const body = [header, '']
        for (const session of sessions) {
          body.push(
            `• ${session.sessionId ?? '?'} agent=${session.agentId ?? '?'} status=${session.status ?? '?'} ` +
              `terminal=${session.terminal === true} waited=${formatDuration(session.waitedMs ?? 0)} nextIndex=${session.nextIndex ?? 0}`,
          )
          const result = session.result
          if (result !== undefined) {
            const usage = result.inputTokens === undefined
              ? ''
              : ` tokens=${result.inputTokens}in/${result.outputTokens ?? 0}out`
            body.push(`    result: ${result.status ?? '?'} duration=${formatDuration(result.durationMs ?? 0)}${usage}`)
            if (result.error !== undefined) body.push(`    error: ${result.error}`)
            if ((result.text ?? '').length > 0) body.push('    final text:', `    ${result.text ?? ''}`)
          } else if (session.terminal !== true) {
            body.push('    still running when this wait ended')
          }
          if ((session.dropped ?? 0) > 0) {
            body.push(`    warning: ${session.dropped ?? 0} earlier event(s) fell out of the host's bounded transcript before this read; indices below are absolute (firstIndex=${session.firstIndex ?? 0}).`)
          }
          const events = session.events ?? []
          if (events.length > 0) {
            body.push(...renderEventBlocks(events).map((line) => `    ${line}`))
          }
        }
        if (value.timedOut === true) {
          const ids = sessions
            .filter((session) => session.terminal !== true)
            .map((session) => `"${session.sessionId ?? ''}"`)
          body.push(
            '',
            'This is not an error and nothing was cancelled — the runs above are still working.',
            `Next: agents_wait { "sessionIds": [${ids.join(', ')}], "timeoutMs": ${timeoutMs} } to keep waiting, or ` +
              'agents_output per session (with the nextIndex above) to read what has happened so far, or agents_cancel if the direction is wrong.',
          )
        } else {
          body.push(
            '',
            `Next: agents_output { "sessionId": "<id>", "sinceIndex": <nextIndex> } for the full tail of any session, then report the results.`,
          )
        }
        return text(body.join('\n'))
      },
    },
    execute: async (args) => {
      const ids = normalizeIds(args.sessionIds)
      if (ids.length === 0) {
        throw new Error(
          'sessionIds must name at least one session: pass the sessionId agents_run returned, or the list ' +
            'agents_run_many returned. Call agents_status to see what is currently running.',
        )
      }
      const requested = args.timeoutMs
      if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
        throw new Error(
          `timeoutMs must be a positive number of milliseconds (1..${MAX_WAIT_TIMEOUT_MS}); got ${String(requested)}. ` +
            `Omit it to use the ${DEFAULT_WAIT_TIMEOUT_MS}ms default.`,
        )
      }
      const timeoutMs = Math.min(Math.floor(requested ?? DEFAULT_WAIT_TIMEOUT_MS), MAX_WAIT_TIMEOUT_MS)
      const until = args.until ?? 'all'
      // Fail before waiting, not after: a typo would otherwise cost the whole
      // timeout budget and then report the same thing.
      for (const id of ids) {
        if (manager.status(id) === undefined) throw new Error(unknownSessionMessage(manager, id))
      }

      const startedAt = Date.now()
      const deadline = startedAt + timeoutMs
      /** When each session was first OBSERVED terminal — the per-session wait. */
      const terminalAt = new Map<string, number>()
      const isTerminal = (id: string): boolean => manager.status(id)?.terminal === true
      const satisfied = (): boolean =>
        until === 'any' ? ids.some(isTerminal) : ids.every(isTerminal)

      for (;;) {
        for (const id of ids) {
          if (!terminalAt.has(id) && isTerminal(id)) terminalAt.set(id, Date.now())
        }
        if (satisfied()) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        // Bounded by `remaining`, so the wait can overshoot only by the time one
        // `status()` read takes — never by a whole poll interval.
        await delay(Math.min(WAIT_POLL_MS, remaining))
      }
      const endedAt = Date.now()

      const sessions = ids.map((id) => {
        const snapshot = manager.status(id)
        // Unreachable: every id was checked above. Kept total so a session that
        // vanished mid-wait (dispose) reports the truth instead of a crash.
        if (snapshot === undefined) throw new Error(unknownSessionMessage(manager, id))
        const events = args.sinceIndex === undefined
          ? undefined
          : manager.output(id, { sinceIndex: args.sinceIndex, limit: MAX_WAIT_EVENTS })
        const result = snapshot.result
        return {
          sessionId: snapshot.sessionId,
          agentId: snapshot.agentId,
          status: snapshot.status,
          terminal: snapshot.terminal,
          waitedMs: Math.max(0, (terminalAt.get(id) ?? endedAt) - startedAt),
          // Cursor semantics match agents_output: pass it back to read only what
          // is new. With no sinceIndex this is "where the transcript stands now",
          // which is what makes a later incremental read cheap.
          nextIndex: events?.nextIndex ?? snapshot.messageCount,
          ...(result === undefined ? {} : { result: projectResult(result) }),
          ...(events === undefined
            ? {}
            : {
                firstIndex: events.firstIndex ?? args.sinceIndex ?? 0,
                dropped: events.dropped ?? 0,
                events: events.messages.map((message, offset) => ({
                  index: (events.firstIndex ?? args.sinceIndex ?? 0) + offset,
                  type: message.type,
                  ...(message.content === undefined ? {} : { text: truncate(message.content, 4_000) }),
                  ...(message.tool === undefined ? {} : { tool: message.tool }),
                })),
              }),
        }
      })
      const timedOut = !satisfied()
      const hint = timedOut
        ? `Timed out after ${timeoutMs}ms with ${sessions.filter((session) => !session.terminal).length} session(s) still running. ` +
          'This is a normal result: nothing was cancelled. Call agents_wait again to keep waiting, or agents_output for the increment.'
        : until === 'any'
          ? 'At least one session is terminal; the others are still running. Read their nextIndex values and call agents_wait again for the rest.'
          : 'Every session is terminal. Read each result above, or agents_output with the nextIndex for the full tail.'
      return {
        waitedMs: Math.max(0, endedAt - startedAt),
        timedOut,
        until,
        timeoutMs,
        sessions,
        hint,
      }
    },
  })

  /** `agents_output` — the incremental event read. The model's only window in. */
  const output = defineTool({
    name: 'agents_output',
    description:
      'Read new events from a session since an index. Returns normalized messages plus nextIndex — pass that '
      + 'nextIndex back on the next call to receive only what is new (do not re-read from 0). Use limit to cap a '
      + 'burst. Prefer ONE agents_wait call over repeated reads while a session is still running: agents_output is '
      + 'for reading, not for waiting. When the status is terminal, the final result is in this read.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Session id returned by agents_run.',
      },
      sinceIndex: {
        type: 'integer',
        description: 'Index of the first event to return. Start at 0, then pass the previous call\'s nextIndex.',
      },
      limit: {
        type: 'integer',
        description:
          'Maximum number of events to return in this read. Reads are capped at 80 events; nextIndex always '
          + 'points at the first event NOT shown, so passing it back never skips one.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          nextIndex: { type: 'integer' },
          firstIndex: { type: 'integer' },
          dropped: { type: 'integer' },
          terminal: { type: 'boolean' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                type: { type: 'string', enum: [...MESSAGE_TYPES] },
                text: { type: 'string' },
                tool: { type: 'string' },
                callId: { type: 'string' },
                level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
                at: { type: 'integer' },
              },
            },
          },
          result: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: [...RUN_STATUSES] },
              text: { type: 'string' },
              error: { type: 'string' },
              exitCode: { type: 'integer' },
              durationMs: { type: 'integer' },
              backendSessionId: { type: 'string' },
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              // Disclosure, not a bucket to add up: codex counts reasoning
              // INSIDE output_tokens (see AgentUsage.reasoningTokens).
              reasoningTokens: { type: 'integer' },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        // `?? []` — see the note in the agents_status render above.
        const messages = value.messages ?? []
        // One readable line per event; see `renderEventBlocks` for why
        // consecutive streamed text is joined.
        const blocks = renderEventBlocks(messages)
        const dropped = value.dropped ?? 0
        const header = `session ${value.sessionId} status=${value.status} events=${messages.length} firstIndex=${value.firstIndex ?? 0} nextIndex=${value.nextIndex}`
        const body: string[] = [header]
        if (dropped > 0) {
          body.push(`warning: ${dropped} earlier event(s) were dropped from this host's bounded transcript before you asked; the first line below is absolute index ${value.firstIndex ?? 0}, not index 0.`)
        }
        if (blocks.length === 0) {
          body.push(value.terminal === true ? '(no new events)' : '(no new events yet — the agent is still working)')
        } else {
          body.push('', ...blocks)
        }
        const result = value.result
        if (result !== undefined) {
          const usage = result.inputTokens === undefined
            ? ''
            : ` tokens=${result.inputTokens}in/${result.outputTokens ?? 0}out`
          body.push('', `result: ${result.status} duration=${formatDuration(result.durationMs ?? 0)}${usage}`)
          if (result.error !== undefined) body.push(`error: ${result.error}`)
          if ((result.text ?? '').length > 0) body.push('', 'final text:', result.text ?? '')
          if (result.backendSessionId !== undefined) {
            body.push('', `resumable backend session: ${result.backendSessionId}`)
          }
        }
        body.push('', `Next: agents_output { "sessionId": "${value.sessionId}", "sinceIndex": ${value.nextIndex} }${value.terminal === true ? ' (terminal — no further events will arrive)' : ''}`)
        return text(body.join('\n'))
      },
    },
    execute: async (args) => {
      // ALWAYS bound the read by the render budget, even when the caller named no
      // limit: `nextIndex` is the manager's `sinceIndex + messages.length`
      // (`manager.ts:727-733`) while the render below shows only
      // MAX_RENDERED_MESSAGES of them. Let the manager return everything and the
      // cursor describes events the model never saw, so a caller following the
      // documented "pass nextIndex back" hint skips them silently (IM-17). With
      // the limit always sent, `nextIndex === sinceIndex + messages.length` by
      // construction.
      //
      // `Math.max(1, …)`: the manager reads a non-positive limit as "no limit"
      // (`manager.ts:727`), which would reopen exactly that gap — a 0 is clamped
      // to a single event instead.
      const limit = Math.min(
        args.limit === undefined ? MAX_RENDERED_MESSAGES : Math.max(1, args.limit),
        MAX_RENDERED_MESSAGES,
      )
      const read = manager.output(args.sessionId, {
        ...(args.sinceIndex === undefined ? {} : { sinceIndex: args.sinceIndex }),
        limit,
      })
      if (read === undefined) {
        throw new Error(unknownSessionMessage(manager, args.sessionId))
      }
      const sinceIndex = args.sinceIndex ?? 0
      const firstIndex = read.firstIndex ?? sinceIndex
      const dropped = read.dropped ?? 0
      // Truncate before rendering: the render layer caps characters, and a
      // model that asked for 10k events would otherwise blow its own context.
      // The rendered index is ABSOLUTE, just like the kernel's cursor: after
      // the ring trims, `sinceIndex` can be below `firstIndex`, and prefixing
      // the retained slice at the stale request would re-number every event.
      const messages = read.messages.slice(0, MAX_RENDERED_MESSAGES).map((message, offset) => ({
        index: firstIndex + offset,
        type: message.type,
        ...(message.content === undefined ? {} : { text: truncate(message.content, 4_000) }),
        ...(message.tool === undefined ? {} : { tool: message.tool }),
        ...(message.callId === undefined ? {} : { callId: message.callId }),
        ...(message.level === undefined ? {} : { level: message.level }),
        at: message.at,
      }))
      const snapshot = manager.status(args.sessionId)
      const result = snapshot?.result
      const hint = read.status === 'running'
        ? `Still running. Read only new events with sinceIndex=${read.nextIndex}, or call agents_wait to wait for the run in ONE bounded call instead of reading in a loop.`
        : `Session is ${read.status}. Read the final result above, then report it; no further events will arrive.`
      return {
        sessionId: read.sessionId,
        status: read.status,
        nextIndex: read.nextIndex,
        firstIndex,
        dropped,
        terminal: snapshot?.terminal ?? read.status !== 'running',
        messages,
        ...(result === undefined ? {} : { result: projectResult(result) }),
        hint,
      }
    },
  })

  /**
   * `agents_usage` — the bill.
   *
   * Token spend is reported per session by the drivers and otherwise scattered
   * across snapshots; nobody can answer "what did today's orchestration cost"
   * from the other eight tools. This tool is the one place that adds it up, and
   * the one place that has to be careful about HOW: `reasoningTokens` is a
   * DISCLOSURE field, not a bucket (`AgentUsage` in the frozen ABI says codex
   * counts it INSIDE `outputTokens`), so it is summed and shown separately and
   * never added into `totalTokens` — doing so would double-count exactly the
   * spend a person is trying to see.
   */
  const usage = defineTool({
    name: 'agents_usage',
    description:
      'Total the token spend and wall-clock time of sessions — "what did this orchestration cost?". Returns one row '
      + 'per session plus a summary. Defaults to every session this bridge knows about, finished ones included. '
      + 'reasoningTokens is reported separately because engines that report it count it INSIDE outputTokens; it is '
      + 'never added into totalTokens.',
    parameters: {
      sessionIds: {
        oneOf: [
          { type: 'string', description: 'A single session id.' },
          { type: 'array', items: { type: 'string' }, description: 'Several session ids.' },
        ],
        description: 'Sessions to total. Omit for every session this bridge knows about.',
      },
      includeFinished: {
        type: 'boolean',
        description:
          'Default true — finished sessions are included, so the total covers the whole batch. Pass false to total only what is still running. Ignored when sessionIds names sessions explicitly: an id you asked for is always totalled.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                agentId: { type: 'string' },
                status: { type: 'string', enum: [...RUN_STATUSES] },
                terminal: { type: 'boolean' },
                durationMs: { type: 'integer' },
                /** False when the engine reported no usage (still running, or the dialect has none). */
                usageReported: { type: 'boolean' },
                inputTokens: { type: 'integer' },
                outputTokens: { type: 'integer' },
                cacheReadTokens: { type: 'integer' },
                cacheWriteTokens: { type: 'integer' },
                /** Disclosure: already included in outputTokens. Never add it to totalTokens. */
                reasoningTokens: { type: 'integer' },
              },
            },
          },
          summary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessions: { type: 'integer' },
              running: { type: 'integer' },
              finished: { type: 'integer' },
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              cacheReadTokens: { type: 'integer' },
              cacheWriteTokens: { type: 'integer' },
              /** Sum of the four exclusive buckets. Excludes reasoningTokens. */
              totalTokens: { type: 'integer' },
              /** Disclosure only — NOT part of totalTokens. */
              reasoningTokens: { type: 'integer' },
              totalDurationMs: { type: 'integer' },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        // `?? []` — see the note in the agents_status render above.
        const sessions = value.sessions ?? []
        const summary = value.summary
        const count = (n: number | undefined): string => (n ?? 0).toLocaleString('en-US')
        if (sessions.length === 0) {
          return text(
            'No sessions to total. Start one with agents_run (or agents_run_many), then call agents_usage again.',
          )
        }
        const body = [
          `Usage across ${summary?.sessions ?? sessions.length} session(s) — `
            + `${summary?.finished ?? 0} finished, ${summary?.running ?? 0} still running.`,
          '',
          `  input        ${count(summary?.inputTokens)}`,
          `  output       ${count(summary?.outputTokens)}`,
          `  cache read   ${count(summary?.cacheReadTokens)}`,
          `  cache write  ${count(summary?.cacheWriteTokens)}`,
          `  total        ${count(summary?.totalTokens)} tokens  (input + output + cache read + cache write)`,
          `  reasoning    ${count(summary?.reasoningTokens)} tokens  (disclosure only — already counted INSIDE outputTokens, so NOT added to the total)`,
          // The SUM of per-session durations, not the wall-clock span of the
          // batch: parallel sessions overlap, and reporting a span would make
          // a 4-way fan-out look four times cheaper than it was.
          `  run time     ${formatDuration(summary?.totalDurationMs ?? 0)} (sum of per-session durations; parallel sessions overlap)`,
          '',
        ]
        for (const session of sessions) {
          const tokens = session.usageReported === true
            ? `${count(session.inputTokens)}in/${count(session.outputTokens)}out cache ${count(session.cacheReadTokens)}r/${count(session.cacheWriteTokens)}w`
            : 'no usage reported yet (it arrives with the terminal result)'
          body.push(
            `• ${session.sessionId ?? '?'} ${session.agentId ?? '?'} ${session.status ?? '?'} `
              + `${formatDuration(session.durationMs ?? 0)} — ${tokens}`,
          )
        }
        body.push('', value.note ?? '')
        return text(body.join('\n'))
      },
    },
    execute: async (args) => {
      const requested = normalizeIds(args.sessionIds)
      const includeFinished = args.includeFinished !== false
      if (requested.length > 0) {
        for (const id of requested) {
          if (manager.status(id) === undefined) throw new Error(unknownSessionMessage(manager, id))
        }
      }
      const selected = requested.length > 0
        ? requested
        : manager
            .list()
            .filter((snapshot) => includeFinished || !snapshot.terminal)
            .map((snapshot) => snapshot.sessionId)

      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      let reasoningTokens = 0
      let totalDurationMs = 0
      let running = 0
      const now = Date.now()
      const rows = selected.map((sessionId) => {
        const snapshot = manager.status(sessionId)
        // Unreachable for the requested case (checked above) and for the
        // default case (`list()` produced the ids); kept total so a session
        // disposed mid-call reports the truth instead of crashing.
        if (snapshot === undefined) throw new Error(unknownSessionMessage(manager, sessionId))
        const usageValue = snapshot.result?.usage
        const durationMs =
          snapshot.result?.durationMs ?? Math.max(0, (snapshot.endedAt ?? now) - snapshot.startedAt)
        const row = {
          sessionId: snapshot.sessionId,
          agentId: snapshot.agentId,
          status: snapshot.status,
          terminal: snapshot.terminal,
          durationMs,
          usageReported: usageValue !== undefined,
          inputTokens: usageValue?.inputTokens ?? 0,
          outputTokens: usageValue?.outputTokens ?? 0,
          cacheReadTokens: usageValue?.cacheReadTokens ?? 0,
          cacheWriteTokens: usageValue?.cacheWriteTokens ?? 0,
          reasoningTokens: usageValue?.reasoningTokens ?? 0,
        }
        inputTokens += row.inputTokens
        outputTokens += row.outputTokens
        cacheReadTokens += row.cacheReadTokens
        cacheWriteTokens += row.cacheWriteTokens
        // Summed for disclosure, deliberately NOT folded into the total: see
        // the `AgentUsage.reasoningTokens` note in the frozen ABI.
        reasoningTokens += row.reasoningTokens
        totalDurationMs += durationMs
        if (!snapshot.terminal) running += 1
        return row
      })
      return {
        sessions: rows,
        summary: {
          sessions: rows.length,
          running,
          finished: rows.length - running,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
          reasoningTokens,
          totalDurationMs,
        },
        note:
          'totalTokens adds the four exclusive buckets (input, output, cache read, cache write) only. ' +
          'reasoningTokens is a disclosure field: engines that report it count it inside outputTokens, so adding it ' +
          'again would double-count. Sessions with usageReported=false have not reported yet — the numbers land ' +
          'with their terminal result.',
      }
    },
  })

  /** `agents_cancel` — graceful signal, then a process-group kill. Idempotent. */
  const cancel = defineTool({
    name: 'agents_cancel',
    description:
      'Cancel a running session. Idempotent: cancelling an already-terminal session reports cancelled=false and '
      + 'does not change its recorded outcome. Cancellation signals the whole process group, so a delegated agent '
      + "cannot leave orphaned children behind. Pass reason to record why (it is logged and shown to the child on "
      + 'platforms that deliver it).',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Session to cancel, as returned by agents_run.',
      },
      reason: {
        type: 'string',
        description: 'Short human-readable reason recorded with the cancellation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          cancelled: { type: 'boolean' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => text(
        `${value.cancelled ? 'cancelling' : 'not cancelled'} session ${value.sessionId} (status=${value.status})`
        + `\n${value.note}`,
      ),
    },
    execute: async (args) => {
      const before = manager.status(args.sessionId)
      if (before === undefined) throw new Error(unknownSessionMessage(manager, args.sessionId))
      const requested = await manager.cancel(args.sessionId, args.reason)
      const snapshot = manager.status(args.sessionId)
      const status = snapshot?.status ?? before.status
      const note = !requested
        // `requested === false` has exactly two causes and they are both
        // terminal, so this says which state it is already in rather than
        // leaving the model to wonder whether the id was wrong.
        ? `Nothing to cancel: session ${args.sessionId} is already ${before.status}, and a terminal session keeps its recorded outcome. Start new work with agents_run.`
        : status === 'running'
          // Three-phase cancel is asynchronous by design (SIGTERM → grace →
          // SIGKILL process group); the model must not assume it is done.
          ? 'Cancellation requested. The child is being signalled and will be killed after its grace window — re-check with agents_status.'
          : 'Cancellation settled. Read the tail of the transcript with agents_output for any partial output.'
      return { sessionId: args.sessionId, cancelled: requested, status, note }
    },
  })

  /** `agents_send` — continue a finished conversation in a new, tracked run. */
  const send = defineTool({
    name: 'agents_send',
    description:
      'Continue a previous session with a new prompt. The delegated agent picks the conversation up where it left '
      + 'off (the backend resume pointer is used when the dialect supports one), and the follow-up runs as a NEW '
      + 'tracked session with its own sessionId — the kernel never reuses the original bridge id. A session that '
      + 'was never launched, or one the dialect cannot resume, is refused rather than silently restarted as a '
      + 'fresh conversation. Returns immediately like agents_run, then poll agents_output with the returned '
      + 'sessionId.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Session to continue, as returned by agents_run.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'Follow-up instruction for the delegated agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          /** Always true in v1: send only exists to continue a backend conversation. */
          resumed: { type: 'boolean' },
          /** The session id this follow-up continues — never equal to sessionId. */
          resumedFrom: { type: 'string' },
          messageCount: { type: 'integer' },
        },
      },
      render: (_args, value) => text(
        [
          `continued ${value.resumedFrom} as ${value.sessionId} (status=${value.status}, messages=${value.messageCount})`,
          '',
          `Next: agents_wait { "sessionIds": "${value.sessionId}", "timeoutMs": 20000 } to wait for the follow-up in one call,`,
          `or agents_output { "sessionId": "${value.sessionId}", "sinceIndex": ${value.messageCount} } to read only the new turns` +
          ' (sinceIndex=0 re-reads the whole transcript).',
        ].join('\n'),
      ),
    },
    execute: async (args) => {
      // Same boundary contract as `agents_run` and each `agents_run_many` entry:
      // a whitespace-only prompt is refused here instead of reaching the
      // dialect's resume path, where it can land in an option or stdin slot.
      const prompt = args.prompt.trim()
      if (prompt === '') {
        throw new Error(
          'prompt is required and must be non-empty; the delegated agent cannot see this conversation, so the follow-up has to contain the whole task (paths, constraints, acceptance criteria).',
        )
      }
      let snapshot: SessionSnapshot
      try {
        snapshot = await manager.send(args.sessionId, prompt)
      } catch (err) {
        throw await describeRunFailure(manager, err, 'send')
      }
      // v1 semantics, stated honestly (D43 / audit L4): the kernel always
      // mints a fresh bridge session for a follow-up, so
      // `resumed: snapshot.sessionId === args.sessionId` could never be true.
      // What the field must say is that the backend conversation IS being
      // continued, and `resumedFrom` names which one.
      return {
        sessionId: snapshot.sessionId,
        status: snapshot.status,
        resumed: true,
        resumedFrom: args.sessionId,
        messageCount: snapshot.messageCount,
      }
    },
  })

  // Registration order is the order the model reads the tools in: discover,
  // start (one, then many), observe (status, wait, output, usage), interrupt,
  // continue. `TOOL_NAMES` below must stay in this exact order — the host
  // registers them in array order and tests assert on the resulting list.
  return [probe, run, runMany, status, wait, output, usage, cancel, send] as const
}

/** The full definition table shape, for `register.ts` and tests. */
export type ToolDefinitions = ReturnType<typeof createToolDefinitions>

/** Convenience export used by the system-prompt section to name the surface. */
export const TOOL_NAMES = [
  'agents_probe',
  'agents_run',
  'agents_run_many',
  'agents_status',
  'agents_wait',
  'agents_output',
  'agents_usage',
  'agents_cancel',
  'agents_send',
] as const
