/**
 * dsh-agents-bridge / drivers — OpenClaw / AutoClaw.
 *
 * Authoritative spec: multica `server/pkg/agent/openclaw.go`
 * (`buildOpenclawArgs`, `openclawBlockedArgs`, `processOutput`,
 * `openclawEvent`, `openclawResult`, `parseOpenclawUsage`) and
 * `openclaw_stdout.go` (`readOpenclawStdout`).
 *
 * Verified against the real binary (OpenClaw 2026.6.8 shipped inside
 * AutoClaw.app): `openclaw agent` accepts `--local`, `--json`,
 * `-m/--message`, `--model`, `--session-id`, `--session-key`, `--agent`,
 * `--thinking`, `--timeout` (default 600), `--verbose`, `--deliver`. That
 * matches multica's `buildOpenclawArgs` exactly, plus `--thinking`, which is
 * newer than the Go code — see the effort mapping below.
 *
 * Three quirks worth knowing before touching this file:
 *
 *  1. **`--json` is the protocol, not a rendering choice.** It is blocked from
 *     caller args: overriding it silently changes the stdout format the driver
 *     parses.
 *  2. **The complete result blob is the protocol boundary.** Observed in
 *     production: `openclaw agent --local --json` printed its full result and
 *     then did NOT exit — T+24s result written, T+8min the slot was still held
 *     and the user had seen nothing. A driver that waits for EOF hangs forever.
 *     So: once the buffer parses as a complete result AND stdout has been idle
 *     for a grace window, the run is finished and the process is terminated.
 *     Idle alone is not enough (an agent may think for minutes) and parseable
 *     alone is not enough (more output may be coming).
 *  3. **The blob is pretty-printed, not NDJSON.** openclaw 2026.5.x/6.x emits
 *     one multi-line JSON object, so line-scanner-only parsing sees nothing.
 *     Both shapes are handled: the whole-buffer result first, then the
 *     streaming-event fallback.
 *
 * DEVIATION (documented, no behaviour lost): multica runs
 * `<exe> --version` before every task and hard-fails below 2026.5.5, because
 * older builds wrote their JSON to stderr and looked silent. That probe is a
 * second process on the `agents_run` fast path, so it is replaced here by the
 * same diagnosis at failure time: when nothing parses, the stderr tail is
 * checked for a JSON blob and the upgrade hint is attached to the error.
 *
 * @module dsh-agents-bridge/drivers/openclaw
 */

import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentRunOptions,
  AgentSessionHandle,
  AgentUsage,
  BridgeLogger,
  DriverDeps,
} from '../kernel/types.ts'

import { randomUUID } from 'node:crypto'

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DriverSession,
  argsContainFlag,
  asRecord,
  asString,
  assertArgvSafeValue,
  buildCommandLine,
  clampTimerDelay,
  errorText,
  event,
  filterCustomArgs,
  filterLaunchPrefix,
  readLines,
  resolveRuntime,
  tryParseJson,
  type BlockedArgs,
  type DriverRuntime,
  type ProcessExit,
  type SpawnedProcess,
} from './argv.ts'

/** `openclawBlockedArgs` (openclaw.go:39). */
export const OPENCLAW_BLOCKED_ARGS: BlockedArgs = {
  '--local': 'standalone', // local mode for bridge execution
  '--json': 'standalone', // JSON output IS the driver communication protocol
  '--session-id': 'withValue', // managed here for session resumption
  '--message': 'withValue', // the prompt is supplied by the driver
  // `openclaw agent` binds a model to a pre-registered agent; the runtime knob
  // is `--agent <id>`, so a caller-supplied `--model` is dropped rather than
  // allowed to fight the binding. (2026.6.8 does also accept `--model`; the
  // binding is still what multica validated.)
  '--model': 'withValue',
  '--system-prompt': 'withValue', // instructions are folded into --message
}

/** Canonical failure string, depended on by log-grep alerts in multica. */
export const OPENCLAW_NO_PARSEABLE_OUTPUT = 'openclaw returned no parseable output'

/** Lowest openclaw that emits its `--json` result on stdout (multica PR #2101). */
export const MIN_OPENCLAW_VERSION = '2026.5.5'

/** Default idle window before a complete result blob is treated as terminal. */
export const DEFAULT_OPENCLAW_RESULT_IDLE_GRACE_MS = 2000

/** First line of the config-invalid failure openclaw prints when a profile is missing. */
export const OPENCLAW_CONFIG_INVALID_MARKER = 'OpenClaw config is invalid'

/** The `--profile <name>` (or `--profile=<name>`) an identity's prefix selects. */
export function openclawProfileFromArgsPrefix(
  argsPrefix: readonly string[] | undefined,
): string | undefined {
  if (argsPrefix === undefined) return undefined
  for (let i = 0; i < argsPrefix.length; i++) {
    const arg = argsPrefix[i]
    if (arg === undefined) continue
    if (arg === '--profile') {
      const value = argsPrefix[i + 1]
      if (value !== undefined && value !== '') return value
    } else if (arg.startsWith('--profile=')) {
      return arg.slice('--profile='.length)
    }
  }
  return undefined
}

/**
 * Turn openclaw's config-invalid failure into something actionable.
 *
 * Measured on this machine: a bare `openclaw.mjs agent …` fails with
 *
 *     OpenClaw config is invalid
 *     File: ~/.openclaw/openclaw.json
 *     Problem: - <root>: Invalid input
 *     Fix: openclaw doctor --fix
 *
 * because `~/.openclaw/openclaw.json` is a stub holding only `mcpServers`,
 * while the AutoClaw desktop app keeps its complete config in its own profile
 * directory (`~/.openclaw-autoclaw/openclaw.json`, verified with
 * `openclaw --profile autoclaw config validate`). Without this hint the model
 * sees a config error and has no idea the fix is a `--profile` prefix.
 */
export function openclawConfigDiagnosis(
  text: string,
  argsPrefix: readonly string[] | undefined,
): string {
  if (!text.includes(OPENCLAW_CONFIG_INVALID_MARKER)) return ''
  const file = /File:\s*(\S+)/.exec(text)?.[1]
  const profile = openclawProfileFromArgsPrefix(argsPrefix)
  const headline = file === undefined
    ? OPENCLAW_CONFIG_INVALID_MARKER
    : `${OPENCLAW_CONFIG_INVALID_MARKER} (File: ${file})`
  const hint =
    profile === undefined
      ? 'No --profile prefix is in use, so the default profile is being read. ' +
        'Desktop installs (e.g. AutoClaw) keep a complete config under a named ' +
        'profile: try the global prefix `--profile autoclaw` BEFORE the `agent` ' +
        'subcommand, and verify with `openclaw --profile autoclaw config validate`.'
      : `The identity already passes \`--profile ${profile}\`, so re-check that ` +
        `~/.openclaw-${profile}/openclaw.json is the file that validates ` +
        `(\`openclaw --profile ${profile} config validate\`).`
  return `${headline}. ${hint} Fix: openclaw doctor --fix`
}

// ── argv ────────────────────────────────────────────────────────────────────

export interface OpenclawArgOptions {
  readonly prompt: string
  readonly sessionId: string
  readonly model?: string
  /** Runtime-native reasoning level → `--thinking` (OpenClaw 2026.6.x). */
  readonly effort?: string
  readonly timeoutMs?: number
  /** Folded into `--message`: openclaw has no `--system-prompt` flag. */
  readonly systemPrompt?: string
  readonly mode?: 'spawn' | 'connect'
  readonly extraArgs?: readonly string[]
}

/**
 * `buildOpenclawArgs` equivalent.
 *
 * `--local` is the embedded-mode opt-in; `openclaw agent` otherwise defaults to
 * Gateway routing. v1 only implements local (`run()` refuses `mode: 'connect'`),
 * and `--local` stays in the blocked set so mode remains the single source of
 * truth.
 *
 * `--thinking` is appended AFTER the caller's args on purpose: the CLI's
 * last-wins parsing then gives the driver's effort the final say without having
 * to block a flag multica never knew about.
 */
export function buildOpenclawArgs(opts: OpenclawArgOptions, logger?: BridgeLogger): string[] {
  const args: string[] = ['agent']
  if (opts.mode !== 'connect') args.push('--local')
  args.push('--json', '--session-id', opts.sessionId)
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    // Whole seconds, truncated — `int(opts.Timeout.Seconds())` in multica.
    args.push('--timeout', String(Math.floor(opts.timeoutMs / 1000)))
  }

  const customArgs = filterCustomArgs(opts.extraArgs, OPENCLAW_BLOCKED_ARGS, logger)
  if (opts.model !== undefined && opts.model !== '' && !argsContainFlag(customArgs, '--agent')) {
    args.push('--agent', assertArgvSafeValue('openclaw model', opts.model))
  }
  args.push(...customArgs)

  if (opts.effort !== undefined && opts.effort !== '') {
    args.push('--thinking', assertArgvSafeValue('openclaw effort', opts.effort))
  }

  // Instructions must be inline: openclaw loads AGENTS.md from its own
  // workspace directory, not from cwd (openclaw.go buildOpenclawArgs comment).
  const prompt =
    opts.systemPrompt !== undefined && opts.systemPrompt !== ''
      ? `${opts.systemPrompt}\n\n${opts.prompt}`
      : opts.prompt
  args.push('--message', prompt)
  return args
}

// ── Protocol frames ────────────────────────────────────────────────────────

/**
 * One streaming NDJSON event (`openclawEvent`).
 *
 * Event types: `text` (text), `tool_use` (tool/callId/input), `tool_result`
 * (tool/callId/text), `error` (text | structured error | message), `lifecycle`
 * (phase `error`/`failed`/`cancelled`), `step_start`, `step_finish` (usage).
 */
export interface OpenclawEvent {
  readonly type: string
  readonly sessionId?: string
  readonly text?: string
  readonly tool?: string
  readonly callId?: string
  readonly input?: unknown
  readonly usage?: Record<string, unknown>
  readonly phase?: string
  readonly error?: unknown
  readonly message?: string
}

/** The legacy single-blob final result (`openclawResult`). */
export interface OpenclawResultBlob {
  readonly payloads?: readonly { readonly text?: string }[]
  readonly meta?: {
    readonly durationMs?: number
    readonly agentMeta?: Record<string, unknown>
  }
}

/**
 * Extract a human-readable error from an event, mirroring `errorMessage()`:
 * structured error → text → message → sentinel. The structured shape is
 * PaperClip-compatible (`name` + `data.message`).
 */
export function openclawEventErrorMessage(ev: OpenclawEvent): string {
  const structured = asRecord(ev.error)
  if (structured !== undefined) {
    const data = asRecord(structured['data'])
    const dataMessage = data === undefined ? undefined : asString(data['message'])
    if (dataMessage !== undefined && dataMessage !== '') return dataMessage
    const message = asString(structured['message'])
    if (message !== undefined && message !== '') return message
    const name = asString(structured['name'])
    if (name !== undefined && name !== '') return name
  }
  if (ev.text !== undefined && ev.text !== '') return ev.text
  if (ev.message !== undefined && ev.message !== '') return ev.message
  return 'unknown openclaw error'
}

function int64(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return 0
}

function firstOf(data: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = int64(data[key])
    if (value !== 0) return value
  }
  return 0
}

/**
 * `parseOpenclawUsage`: tolerate the field-name variants across protocol
 * versions and PaperClip.
 *
 *   input   / inputTokens  / input_tokens
 *   output  / outputTokens / output_tokens
 *   cacheRead / cachedInputTokens / cached_input_tokens / cache_read
 *   cacheWrite / cacheCreationInputTokens / cache_creation_input_tokens / cache_write
 */
export function parseOpenclawUsage(data: Record<string, unknown>): AgentUsage {
  return {
    inputTokens: firstOf(data, ['input', 'inputTokens', 'input_tokens']),
    outputTokens: firstOf(data, ['output', 'outputTokens', 'output_tokens']),
    cacheReadTokens: firstOf(data, [
      'cacheRead',
      'cachedInputTokens',
      'cached_input_tokens',
      'cache_read',
      'cache_read_input_tokens',
    ]),
    cacheWriteTokens: firstOf(data, [
      'cacheWrite',
      'cacheCreationInputTokens',
      'cache_creation_input_tokens',
      'cache_write',
    ]),
  }
}

/**
 * `tryParseOpenclawEvent`: a line is an event only when it starts with `{` and
 * decodes to an object with a non-empty `type`.
 */
export function tryParseOpenclawEvent(line: string): OpenclawEvent | undefined {
  if (line === '' || line[0] !== '{') return undefined
  const parsed = asRecord(tryParseJson(line))
  if (parsed === undefined) return undefined
  const type = asString(parsed['type'])
  if (type === undefined || type === '') return undefined
  const usage = asRecord(parsed['usage'])
  return {
    type,
    sessionId: asString(parsed['sessionId']),
    text: asString(parsed['text']),
    tool: asString(parsed['tool']),
    callId: asString(parsed['callId']),
    input: parsed['input'],
    usage,
    phase: asString(parsed['phase']),
    error: parsed['error'],
    message: asString(parsed['message']),
  }
}

/**
 * `tryParseOpenclawResult`: the legacy blob, recognised only when it actually
 * looks like one (`payloads` present or `meta.durationMs` non-zero) so an
 * unrelated JSON line is not swallowed.
 */
export function tryParseOpenclawResult(raw: string): OpenclawResultBlob | undefined {
  if (raw === '' || raw[0] !== '{') return undefined
  const parsed = asRecord(tryParseJson(raw))
  if (parsed === undefined) return undefined
  const meta = asRecord(parsed['meta'])
  const payloads = parsed['payloads']
  const durationMs = meta === undefined ? 0 : int64(meta['durationMs'])
  if (!Array.isArray(payloads) && durationMs === 0) return undefined
  return parsed as OpenclawResultBlob
}

/**
 * `parseWholeBufferOpenclawResult`: try the whole stdout text as one blob, then
 * retry from each line that starts with `{` so a log or event preamble does not
 * defeat the parse. Only line *starts* are considered — scanning for braces at
 * arbitrary offsets would false-match JSON fragments inside log lines.
 *
 * EVERY candidate start is tried, not just the first (MI-5). Returning on the
 * first `{`-starting line meant that a stream carrying events AND a trailing
 * single-line result blob — a real shape — never found its result: the first
 * candidate was an event frame, the parse failed, and the scan gave up. The
 * boundary then never armed and the completed answer was thrown away when the
 * idle watchdog fired.
 *
 * Candidates are bounded by the LAST result marker in the buffer (a blob must
 * carry `payloads` or a non-zero `meta.durationMs`), so an ordinary event
 * stream — no marker at all — costs one substring scan and no parsing, which is
 * what keeps the cheap gate cheap.
 */
export function parseWholeBufferOpenclawResult(text: string): OpenclawResultBlob | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const direct = tryParseOpenclawResult(trimmed)
  if (direct !== undefined) return direct
  const markerAt = lastResultMarkerOffset(trimmed)
  if (markerAt < 0) return undefined
  const lines = trimmed.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const start = offset
    offset += (line?.length ?? 0) + 1
    // A candidate can only be the blob's opening line if the blob's own marker
    // still lies ahead of it; offsets grow, so nothing later can qualify.
    if (start > markerAt) break
    if (line === undefined || line.length === 0 || line[0] !== '{') continue
    const parsed = tryParseOpenclawResult(lines.slice(i).join('\n').trim())
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** Text offset of the last `payloads` / `durationMs` key, or -1 when absent. */
function lastResultMarkerOffset(text: string): number {
  return Math.max(text.lastIndexOf('"payloads"'), text.lastIndexOf('"durationMs"'))
}

/** Everything one openclaw stdout produced (`openclawEventResult`). */
export interface OpenclawStreamState {
  status: 'completed' | 'failed'
  output: string
  error: string
  sessionId: string
  model: string
  usage: AgentUsage | undefined
  /** True once at least one NDJSON event or result blob was understood. */
  gotEvents: boolean
  /** True when the run was cut short because the result was complete. */
  cutShort: boolean
  /** Non-JSON stdout lines, in order (the raw fallback). */
  rawLines: readonly string[]
  eventCount: number
}

/**
 * Stateful translator for one `openclaw agent --json` stdout.
 *
 * Feed it raw lines; call `finish()` when stdout ends (or when the
 * complete-result boundary fires). Emits normalized `AgentMessage`s as it goes.
 *
 * Every line is retained even when it parses as an event, because the final
 * result blob is pretty-printed across many lines: the buffer, not the line, is
 * the parse unit for the terminal result.
 */
export class OpenclawStreamParser {
  readonly #sink: { emit(message: AgentMessage): void }
  readonly #now: () => number
  #output = ''
  #sessionId = ''
  #model = ''
  #usage: AgentUsage | undefined
  #status: 'completed' | 'failed' = 'completed'
  #error = ''
  #gotEvents = false
  #cutShort = false
  #eventCount = 0
  readonly #rawLines: string[] = []
  /**
   * The buffer text at the moment a result blob was last applied. Guards
   * against emitting the same payloads twice when a single-line blob is applied
   * by the line scanner and then seen again by the whole-buffer parse in
   * `finish()`.
   */
  #appliedBlobBuffer: string | undefined

  constructor(sink: { emit(message: AgentMessage): void }, now: () => number = Date.now) {
    this.#sink = sink
    this.#now = now
  }

  get state(): OpenclawStreamState {
    return {
      status: this.#status,
      output: this.#output,
      error: this.#error,
      sessionId: this.#sessionId,
      model: this.#model,
      usage: this.#usage,
      gotEvents: this.#gotEvents,
      cutShort: this.#cutShort,
      rawLines: this.#rawLines,
      eventCount: this.#eventCount,
    }
  }

  /** The complete stdout text seen so far, for whole-buffer result detection. */
  bufferedText(): string {
    return this.#rawLines.join('\n')
  }

  markCutShort(): void {
    this.#cutShort = true
  }

  handleLine(line: string): void {
    this.#rawLines.push(line)

    const ev = tryParseOpenclawEvent(line)
    if (ev !== undefined) {
      this.#eventCount++
      this.#handleEvent(ev)
      return
    }

    const blob = tryParseOpenclawResult(line)
    if (blob !== undefined) {
      this.#applyResultBlob(blob)
      this.#appliedBlobBuffer = this.bufferedText()
      return
    }

    // Not JSON: a log line. Kept for the raw-output fallback.
  }

  #handleEvent(ev: OpenclawEvent): void {
    this.#gotEvents = true
    if (ev.sessionId !== undefined && ev.sessionId !== '') this.#sessionId = ev.sessionId
    switch (ev.type) {
      case 'text':
        if (ev.text !== undefined && ev.text !== '') {
          this.#output += ev.text
          this.#sink.emit(event(this.#now, 'text', { content: ev.text }))
        }
        break
      case 'tool_use':
        this.#sink.emit(
          event(this.#now, 'tool_use', {
            ...(ev.tool === undefined ? {} : { tool: ev.tool }),
            ...(ev.callId === undefined ? {} : { callId: ev.callId }),
            input: ev.input,
          }),
        )
        break
      case 'tool_result':
        this.#sink.emit(
          event(this.#now, 'tool_result', {
            ...(ev.tool === undefined ? {} : { tool: ev.tool }),
            ...(ev.callId === undefined ? {} : { callId: ev.callId }),
            output: ev.text ?? '',
          }),
        )
        break
      case 'error': {
        const message = openclawEventErrorMessage(ev)
        this.#sink.emit(event(this.#now, 'error', { content: message, level: 'error' }))
        this.#status = 'failed'
        this.#error = message
        break
      }
      case 'lifecycle': {
        const phase = ev.phase ?? ''
        if (phase === 'error' || phase === 'failed' || phase === 'cancelled') {
          const message = openclawEventErrorMessage(ev)
          this.#sink.emit(event(this.#now, 'error', { content: message, level: 'error' }))
          this.#status = 'failed'
          this.#error = message
        }
        break
      }
      case 'step_start':
        this.#sink.emit(event(this.#now, 'status', { content: 'running' }))
        break
      case 'step_finish':
        if (ev.usage !== undefined) {
          const add = parseOpenclawUsage(ev.usage)
          const prior = this.#usage
          this.#usage =
            prior === undefined
              ? add
              : {
                  inputTokens: prior.inputTokens + add.inputTokens,
                  outputTokens: prior.outputTokens + add.outputTokens,
                  cacheReadTokens: (prior.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0),
                  cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0),
                }
        }
        break
      default:
        break
    }
  }

  #applyResultBlob(blob: OpenclawResultBlob): void {
    this.#gotEvents = true
    const payloads = Array.isArray(blob.payloads) ? blob.payloads : []
    for (const payload of payloads) {
      const text = asString(payload?.text)
      if (text !== undefined && text !== '') {
        this.#output += text
        this.#sink.emit(event(this.#now, 'text', { content: text }))
      }
    }
    const agentMeta = blob.meta?.agentMeta
    if (agentMeta !== undefined) {
      const sessionId = asString(agentMeta['sessionId'])
      if (sessionId !== undefined && sessionId !== '') this.#sessionId = sessionId
      const model = asString(agentMeta['model'])
      if (model !== undefined) this.#model = model.trim()
      const usage = asRecord(agentMeta['usage'])
      if (usage !== undefined && this.#usage === undefined) {
        // Prefer the final result's usage only when streaming events reported
        // nothing, mirroring processOutput.
        this.#usage = parseOpenclawUsage(usage)
      }
    }
  }

  /**
   * End of stdout: the whole-buffer result parse, then the raw-output fallback,
   * then the canonical no-parseable-output failure.
   */
  finish(): OpenclawStreamState {
    // The whole-buffer parse is authoritative for the current CLI: it emits one
    // pretty-printed blob that no single line can match. Skipped when the same
    // buffer was already applied by the line scanner, so a single-line blob is
    // not emitted twice.
    const buffer = this.bufferedText()
    if (this.#appliedBlobBuffer !== buffer) {
      const whole = parseWholeBufferOpenclawResult(buffer)
      if (whole !== undefined) {
        this.#applyResultBlob(whole)
        this.#appliedBlobBuffer = buffer
      }
    }

    // A result blob — line-level or whole-buffer — is a clean terminal state,
    // whatever a stream of events reported before it.
    if (this.#appliedBlobBuffer !== undefined) {
      this.#status = 'completed'
      this.#error = ''
      return this.state
    }

    if (!this.#gotEvents) {
      const trimmed = this.#rawLines.join('\n').trim()
      if (trimmed !== '') {
        this.#output = trimmed
        this.#sink.emit(event(this.#now, 'text', { content: trimmed }))
        this.#status = 'completed'
        return this.state
      }
      this.#status = 'failed'
      this.#error = OPENCLAW_NO_PARSEABLE_OUTPUT
      return this.state
    }
    return this.state
  }

  /**
   * Attach the version-upgrade hint when a run produced nothing parseable and
   * stderr carried a JSON blob — the signature of an openclaw older than
   * 2026.5.5, which wrote its `--json` output to stderr (multica PR #2101).
   */
  diagnoseNoOutput(stderrTail: string): string {
    if (this.#error !== OPENCLAW_NO_PARSEABLE_OUTPUT) return this.#error
    for (const line of stderrTail.split('\n')) {
      if (line.trimStart().startsWith('{')) {
        return (
          `${OPENCLAW_NO_PARSEABLE_OUTPUT}: stderr carried JSON, which means the ` +
          `installed openclaw is older than ${MIN_OPENCLAW_VERSION} and writes its ` +
          `--json result to stderr. Upgrade openclaw (min ${MIN_OPENCLAW_VERSION}) ` +
          `or run 'openclaw --version' to confirm.`
        )
      }
    }
    return this.#error
  }
}

// ── Engine ──────────────────────────────────────────────────────────────────

const STDERR_TAIL_BYTES = 8 * 1024

let sessionCounter = 0

function nextSessionId(at: number): string {
  sessionCounter = (sessionCounter + 1) % 1_000_000
  return `dsh-openclaw-${at.toString(36)}-${sessionCounter.toString(36)}`
}

/**
 * A fresh session id for `--session-id`.
 *
 * `openclaw agent` REFUSES to run without a session selector, in both modes:
 *
 *   --local    → "Error: Pass --to <E.164>, --session-key, --session-id, or
 *                 --agent to choose a session"
 *   (gateway)  → "Error: No target session selected. Use --agent <id>,
 *                 --session-key <key>, --session-id <id>, or --to <E.164>"
 *
 * so every run mints one. It is a UUID rather than a made-up string because the
 * id has to remain a valid selector when `agents_send` later resumes this
 * conversation by passing it back as `--session-id`.
 */
export function newOpenclawSessionId(): string {
  return randomUUID()
}

function openclawIdleGraceFromEnv(env: Readonly<Record<string, string>>): number {
  const raw = env['DSH_AGENTS_BRIDGE_OPENCLAW_IDLE_GRACE_MS']
  if (raw === undefined || raw === '') return DEFAULT_OPENCLAW_RESULT_IDLE_GRACE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_OPENCLAW_RESULT_IDLE_GRACE_MS
}

/**
 * Run one `openclaw agent` conversation. Returns as soon as the child is
 * spawned; the complete-result boundary ends it early when it fires.
 *
 * Throws for `mode: 'connect'` (gateway routing): v1 implements the embedded
 * local loop only, and a readable refusal beats a confusing silent failure.
 */
export async function runOpenclaw(
  opts: AgentRunOptions,
  deps: DriverDeps,
  signal: AbortSignal,
  rt: DriverRuntime,
): Promise<AgentSessionHandle> {
  if (opts.mode === 'connect') {
    throw new Error(
      'dsh-agents-bridge: openclaw gateway/connect mode is not implemented in v1. ' +
        "Drop the mode (or pass mode: 'spawn') to run the embedded local agent loop. " +
        'Gateway routing needs a configured remote Gateway and is tracked as P4.',
    )
  }

  const now = rt.now ?? Date.now
  const startedAt = now()
  const sessionId = nextSessionId(startedAt)
  // Always present: `openclaw agent` refuses to run without a session selector,
  // and the id it was launched with is what a later resume has to pass back.
  const agentSessionId = opts.resumeSessionId ?? newOpenclawSessionId()

  const args = buildOpenclawArgs(
    {
      prompt: opts.prompt,
      sessionId: agentSessionId,
      model: opts.model,
      effort: opts.effort,
      timeoutMs: opts.timeoutMs,
      mode: 'spawn',
      extraArgs: opts.extraArgs,
    },
    deps.logger,
  )
  const commandLine = buildCommandLine(
    {
      ...deps.command,
      // autoclaw's identity puts the global `--profile autoclaw` in argsPrefix,
      // which MUST precede the `agent` subcommand. Filtering it like every other
      // prefix keeps a prefix from re-asserting a protocol flag, while the
      // positional `agent`/profile tokens pass through untouched.
      argsPrefix: filterLaunchPrefix(deps.command.argsPrefix, OPENCLAW_BLOCKED_ARGS, deps.logger),
    },
    args,
  )

  // Declared before the session so the cancel hook always closes over an
  // initialized binding.
  let settleCancelled: (reason: string) => void = () => {}

  const session = new DriverSession({
    sessionId,
    agentId: opts.agent,
    startedAt,
    logger: deps.logger,
    onCancel: (reason) => settleCancelled(reason),
  })
  // ABI v6: openclaw's conversation id is chosen at launch, not discovered in
  // the stream, so it is known from the start and can be persisted immediately
  // (IM-5). A resume that the engine rejects still reports no id at settle,
  // which the kernel treats as authoritative.
  session.pinBackendSessionId(agentSessionId)

  const parser = new OpenclawStreamParser({ emit: (m) => session.push(m) }, now)
  const stderrTail = { value: '' }
  let terminalReason: 'none' | 'cancelled' | 'timeout' | 'idle' | 'overflow' = 'none'
  let hardTimer: NodeJS.Timeout | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let boundaryTimer: NodeJS.Timeout | undefined
  let boundaryArmed = false

  const child: SpawnedProcess = rt.spawn({
    command: commandLine.command,
    args: commandLine.args,
    cwd: opts.cwd,
    env: deps.env,
  })
  // ABI v6: hand the kernel the pid it persists for the post-restart reap (IM-4).
  session.attachProcess(child.pid)

  deps.logger.debug('driver launched', {
    family: 'openclaw',
    command: commandLine.command,
    args: commandLine.args.length,
    agentSessionId,
  })

  // The prompt travels in `--message`, so nothing will ever read stdin; close it
  // immediately instead of leaving a pipe the child could block on.
  try {
    child.stdin.end()
  } catch {
    /* already gone */
  }

  function clearTimers(): void {
    if (boundaryTimer !== undefined) clearTimeout(boundaryTimer)
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    boundaryTimer = undefined
    hardTimer = undefined
    idleTimer = undefined
  }

  function finishOnce(result: AgentResult): void {
    if (session.result !== undefined) return
    clearTimers()
    // ONE release point for every settle path, including the early returns for
    // cancel / timeout / idle / overflow: the removal used to sit behind that
    // return, so a cancelled run kept its listener (MI-18). `onAbort` is a
    // hoisted declaration so this place can own it.
    signal.removeEventListener('abort', onAbort)
    session.finish(result)
  }

  function requestTerminal(
    reason: 'cancelled' | 'timeout' | 'idle' | 'overflow',
    message: string,
  ): void {
    if (terminalReason !== 'none') return
    terminalReason = reason
    finishOnce({
      sessionId,
      agentId: opts.agent,
      status: reason === 'cancelled' ? 'cancelled' : reason === 'overflow' ? 'failed' : 'timeout',
      exitCode: null,
      text: '',
      error: message,
      durationMs: now() - startedAt,
    })
    void child.terminate().catch(() => {})
  }

  settleCancelled = (reason: string) => {
    requestTerminal('cancelled', reason === '' ? 'execution cancelled' : reason)
  }

  // Config-supplied grace, clamped to the runtime's timer ceiling (RR-MI-5).
  const idleGraceMs = clampTimerDelay(openclawIdleGraceFromEnv(deps.env))

  function finishAtBoundary(): void {
    if (boundaryArmed || terminalReason !== 'none') return
    boundaryArmed = true
    parser.markCutShort()
    deps.logger.warn(
      'openclaw delivered its result but did not exit; treating the complete result as the protocol boundary',
    )
    reader.stop()
    void child.terminate().catch(() => {})
  }

  function armResultBoundary(line: string): void {
    if (boundaryArmed || terminalReason !== 'none') return
    // Cheap gate before the O(n) whole-buffer parse: only two shapes can close a
    // top-level result object — a bare `}` on its own line (the pretty-printed
    // blob the CLI emits today) or a single line that opens and closes one.
    // Without this, every nested `}` of a 1000-line blob costs a full parse.
    const trimmed = line.trim()
    const candidate = trimmed === '}' || (line.startsWith('{') && trimmed.endsWith('}'))
    if (!candidate) return
    if (parseWholeBufferOpenclawResult(parser.bufferedText()) === undefined) return
    if (idleGraceMs <= 0) {
      finishAtBoundary()
      return
    }
    if (boundaryTimer !== undefined) clearTimeout(boundaryTimer)
    boundaryTimer = setTimeout(finishAtBoundary, idleGraceMs)
  }

  const reader = readLines(
    child.stdout,
    (line) => {
      parser.handleLine(line)
      armResultBoundary(line)
    },
    {
      // A stream that never emits a newline would grow this reader's buffer in
      // the host process; fail loudly and kill the group instead (MI-4).
      onOverflow: (overflow) => requestTerminal('overflow', overflow.message),
    },
  )
  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    stderrTail.value = (stderrTail.value + text).slice(-STDERR_TAIL_BYTES)
  })
  child.stderr.on('error', () => {})
  child.stdin.on('error', () => {})

  // Caller-supplied windows are clamped to the runtime's timer ceiling: an
  // over-large delay is silently rewritten to 1 ms by `setTimeout`, which would
  // turn "no deadline" into an immediate timeout (RR-MI-5).
  const hardTimeoutMs =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? clampTimerDelay(opts.timeoutMs) : 0
  if (hardTimeoutMs > 0) {
    hardTimer = setTimeout(() => {
      requestTerminal('timeout', `openclaw timed out after ${hardTimeoutMs}ms`)
    }, hardTimeoutMs)
  }

  const idleTimeoutMs = clampTimerDelay(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS.openclaw)
  const touchIdle = (): void => {
    if (idleTimeoutMs <= 0 || terminalReason !== 'none') return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      requestTerminal('idle', `openclaw produced no output for ${idleTimeoutMs}ms`)
    }, idleTimeoutMs)
  }
  child.stdout.on('data', touchIdle)
  touchIdle()

  // A hoisted declaration: `finishOnce` above releases this listener, and the
  // two are mutually recursive by design (same shape as the codex driver).
  function onAbort(): void {
    requestTerminal('cancelled', 'execution cancelled')
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  void (async () => {
    const exit: ProcessExit = await child.exited.catch((err: unknown) => {
      return { code: null, signal: null, error: errorText(err) } satisfies ProcessExit
    })
    await reader.flushed

    if (terminalReason !== 'none' || session.result !== undefined) {
      void child.terminate().catch(() => {})
      return
    }

    const state = parser.finish()

    let status: AgentResult['status'] = state.status
    let errMsg = state.error

    if (state.cutShort) {
      // A complete result is the protocol boundary: ignore whatever the
      // lingering process did afterwards, the reply is already in hand.
      status = 'completed'
      errMsg = ''
    } else if (exit.error !== undefined) {
      status = 'failed'
      errMsg = `openclaw failed to start: ${exit.error}`
    } else if ((exit.code ?? 0) !== 0 && status === 'completed') {
      status = 'failed'
      errMsg = `openclaw exited with error: exit status ${exit.code ?? 'null'}`
    }

    // A config-invalid run can still exit 0 and print its complaint as plain
    // stdout text, which the raw-output fallback would otherwise report as a
    // *successful* answer.
    const combinedText = `${state.output}\n${stderrTail.value}`
    const configDiagnosis = openclawConfigDiagnosis(combinedText, deps.command.argsPrefix)
    if (configDiagnosis !== '' && status === 'completed' && state.eventCount === 0) {
      status = 'failed'
      errMsg = configDiagnosis
    }

    if (status === 'failed') {
      if (configDiagnosis !== '') {
        errMsg = configDiagnosis
      } else {
        // Only replace the "nothing parsed" case with the richer diagnosis; a
        // start/exit failure keeps its own message.
        if (errMsg === '' || errMsg === OPENCLAW_NO_PARSEABLE_OUTPUT) {
          errMsg = parser.diagnoseNoOutput(stderrTail.value)
        }
        if (stderrTail.value.trim() !== '') {
          errMsg = `${errMsg}: ${stderrTail.value.trim()}`
        }
      }
    }

    finishOnce({
      sessionId,
      agentId: opts.agent,
      status,
      exitCode: exit.code,
      // Failed runs report no text so a partial transcript cannot be mistaken
      // for an answer.
      text: status === 'completed' ? state.output : '',
      ...(errMsg === '' ? {} : { error: errMsg }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      durationMs: now() - startedAt,
      // The selector the run was launched with — that is the value a later
      // `agents_send` has to pass back as `--session-id`. The runtime's own
      // `meta.agentMeta.sessionId` names its session *file*, which is not a
      // valid CLI selector.
      backendSessionId: agentSessionId,
    })
  })()

  return session
}

export function createOpenclawBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'openclaw',
    run: (opts, runDeps, signal) => runOpenclaw(opts, runDeps, signal, resolveRuntime(rt)),
  }
}
