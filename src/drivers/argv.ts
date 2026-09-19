/**
 * dsh-agents-bridge / drivers — shared argv construction, the blocked-flag
 * table, the driver runtime seam, and the plumbing every dialect reuses.
 *
 * Ported from multica `server/pkg/agent/claude.go` (`blockedArgMode`,
 * `filterCustomArgs`, `unshellQuoteArg`), `launch.go`
 * (`filterLaunchPrefix`) and `stream_json_result.go` (the shared terminal
 * contract).
 *
 * ── WHAT THE KERNEL MUST PROVIDE (the injection seam) ──────────────────────
 *
 * `DriverDeps` (frozen ABI, `src/kernel/types.ts`) deliberately carries no
 * `spawn` field, so workstream A (kernel) injects the process factory here
 * instead. The kernel must, once during construction — before the first
 * `AgentBackend.run()` — call:
 *
 *     import { setDriverRuntime } from './drivers/index.ts'
 *     setDriverRuntime({ spawn: mySpawnFn })
 *
 * where `mySpawnFn` satisfies:
 *
 *     export interface SpawnFn {
 *       (spec: SpawnSpec): SpawnedProcess
 *     }
 *     export interface SpawnSpec {
 *       readonly command: string                     // interpreter ?? executable
 *       readonly args: readonly string[]             // [executable?, ...argsPrefix, ...args] when an interpreter is set
 *       readonly cwd?: string
 *       readonly env: Readonly<Record<string, string>>
 *     }
 *     export interface SpawnedProcess {
 *       readonly pid?: number
 *       readonly stdin: Writable                     // node:stream — protocol frames are written here
 *       readonly stdout: Readable                    // node:stream — protocol frames are read here
 *       readonly stderr: Readable                    // node:stream — diagnostics only, never parsed
 *       readonly exited: Promise<ProcessExit>        // never rejects
 *       terminate(): Promise<void>                   // SIGTERM → grace (5s) → SIGKILL on the process GROUP
 *     }
 *     export interface ProcessExit {
 *       readonly code: number | null
 *       readonly signal: string | null
 *       readonly error?: string                      // ENOENT/EACCES: no process ever ran
 *     }
 *
 * Contracts the drivers depend on (all verified against multica's Go code):
 *
 *  1. `spawn` must be synchronous and must NOT throw for a missing binary —
 *     report ENOENT through `exited.error` instead. A driver that has to
 *     `.catch()` a spawn failure cannot distinguish it from a run failure.
 *  2. `stdout`/`stderr` must be flowing before the driver writes stdin. The
 *     drivers attach their readers before the first stdin write precisely
 *     because the CLI emits a startup banner before reading its first frame
 *     (multica `claude_deadlock_test.go`): a driver that awaits the prompt
 *     write first deadlocks against a 256 KiB banner.
 *  3. `terminate()` must signal the whole process GROUP, not just the leader —
 *     agent CLIs spawn MCP servers and tool subprocesses that inherit stdout.
 *  4. `stdin` must stay open after the prompt frame. Control-request
 *     auto-approval writes back on the same stream; closing it leaves the
 *     child waiting for a response until its own fallback timeout.
 *
 * `setDriverRuntime` is required to be called before the first `run()`; every
 * driver surfaces a readable error if it is missing rather than crashing with
 * `undefined is not a function`.
 *
 * @module dsh-agents-bridge/drivers/argv
 */

import type { Readable, Writable } from 'node:stream'

import {
  StreamOverflowError,
  resolveStreamLimits,
  type StreamLimits,
} from '../kernel/stream-limits.ts'
import { MAX_TIMER_DELAY_MS } from '../kernel/watchdog.ts'
import type {
  AgentMessage,
  AgentResult,
  AgentRunStatus,
  AgentSessionHandle,
  BridgeLogger,
  SessionSnapshot,
} from '../kernel/types.ts'

// ── Runtime seam ────────────────────────────────────────────────────────────

/** Outcome of a child process. `error` is set only when spawn itself failed. */
export interface ProcessExit {
  readonly code: number | null
  readonly signal: string | null
  /** ENOENT/EACCES and friends: the process never ran. */
  readonly error?: string
}

/** Minimal process handle a driver needs. Kernel `spawn.ts` implements it. */
export interface SpawnedProcess {
  readonly pid?: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  /** Resolves once, at process exit. Never rejects. */
  readonly exited: Promise<ProcessExit>
  /**
   * Request termination of the whole process group: graceful signal, grace
   * window, then force. Idempotent.
   */
  terminate(): Promise<void>
}

/** What a driver asks the kernel to launch. */
export interface SpawnSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: Readonly<Record<string, string>>
}

export interface SpawnFn {
  (spec: SpawnSpec): SpawnedProcess
}

/** Everything a driver needs from the host that is not in the frozen ABI. */
export interface DriverRuntime {
  readonly spawn: SpawnFn
  /** Injectable clock so tests do not depend on wall time. */
  readonly now?: () => number
  /**
   * SIGTERM → SIGKILL grace window for cancelled runs, in ms.
   *
   * Lives on the runtime seam rather than in `SpawnSpec` because it is a
   * *policy* setting (host config), not a per-run argument: every driver would
   * otherwise have to thread a value it does not interpret from `AgentRunOptions`
   * down to `spawn()` untouched. `undefined` = the spawner's own default (5 s).
   */
  readonly graceMs?: number
}

let runtime: DriverRuntime | undefined

/**
 * Install the process factory. The kernel calls this once at construction.
 * Kept as a module-level seam because `DriverDeps` is frozen and carries no
 * `spawn` field — see the module header.
 */
export function setDriverRuntime(rt: DriverRuntime): void {
  if (rt === undefined || rt === null || typeof rt.spawn !== 'function') {
    throw new Error(
      'dsh-agents-bridge: setDriverRuntime requires { spawn: (spec) => SpawnedProcess }',
    )
  }
  runtime = rt
}

/** Clear the installed runtime. Test-only convenience; the kernel never needs it. */
export function clearDriverRuntime(): void {
  runtime = undefined
}

/** The installed runtime, or a readable error naming the missing seam. */
export function getDriverRuntime(): DriverRuntime {
  if (runtime === undefined) {
    throw new Error(
      'dsh-agents-bridge: no driver runtime installed. The kernel must call ' +
        "setDriverRuntime({ spawn }) from './drivers/index.ts' before running an agent.",
    )
  }
  return runtime
}

/** Resolve a runtime for one call: an explicit one wins over the global seam. */
export function resolveRuntime(explicit?: DriverRuntime): DriverRuntime {
  return explicit ?? getDriverRuntime()
}

// ── Command line assembly ───────────────────────────────────────────────────

/**
 * The ONE argv constructor — `[interpreter, executable, ...argsPrefix, ...args]`
 * (frozen rule, `docs/design.md` §4).
 *
 * Re-exported, not re-implemented: the canonical body lives in
 * `kernel/command-line.ts` because the kernel's version probe and the drivers'
 * run path MUST agree on the head of this vector, and the kernel may not import
 * `drivers/**` (see `src/integrate.ts`). The drivers keep importing it from
 * here so no call site had to move.
 */
export { buildCommandLine } from '../kernel/command-line.ts'

// ── Blocked flags (multica `blockedArgMode` + `filterCustomArgs`) ───────────

/**
 * How a blocked flag consumes its value. Mirrors multica's `blockedArgMode`
 * exactly, because getting it wrong leaves a stray value token behind that the
 * CLI reads as a positional argument.
 */
export type BlockedArgMode = 'withValue' | 'standalone' | 'optionalValue'

export type BlockedArgs = Readonly<Record<string, BlockedArgMode>>

/** Every family's protocol-critical flag set, keyed by the flag the CLI sees. */
export const BLOCKED_ARG_MODE = {
  withValue: 'withValue',
  standalone: 'standalone',
  optionalValue: 'optionalValue',
} as const satisfies Record<string, BlockedArgMode>

/**
 * Strip one layer of shell-style quotes from an argument, because users type
 * `--deny-tool='write'` in config fields while the child is spawned without a
 * shell (multica `unshellQuoteArg`).
 *
 * Only flag-shaped args (`-x=…`, `--flag=…`) get inline-value unquoting; plain
 * assignment syntax like `model="o3"` is left alone since the quotes may be
 * semantic for the child (Codex `-c model="o3"`).
 */
export function unshellQuoteArg(arg: string): string {
  if (arg.startsWith('-')) {
    const idx = arg.indexOf('=')
    if (idx > 0) {
      const value = arg.slice(idx + 1)
      const unquoted = stripSurroundingQuotes(value)
      return unquoted === undefined ? arg : arg.slice(0, idx + 1) + unquoted
    }
  }
  return stripSurroundingQuotes(arg) ?? arg
}

function stripSurroundingQuotes(value: string): string | undefined {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return undefined
}

/**
 * Remove protocol-critical flags from caller-supplied args so a run cannot
 * break the channel it is talking over. Intentionally narrow: we only block
 * what would break driver↔CLI communication, not every dangerous flag.
 *
 * Returns a fresh array; the input is never mutated.
 */
export function filterCustomArgs(
  args: readonly string[] | undefined,
  blocked: BlockedArgs,
  logger?: BridgeLogger,
): string[] {
  if (args === undefined || args.length === 0) return []
  const filtered: string[] = []
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (raw === undefined) continue
    const arg = unshellQuoteArg(raw)
    let flag = arg
    let hasInlineValue = false
    const idx = arg.indexOf('=')
    if (idx > 0) {
      flag = arg.slice(0, idx)
      hasInlineValue = true
    }
    const mode = blocked[flag]
    if (mode === undefined) {
      filtered.push(arg)
      continue
    }
    logger?.warn('custom args: blocked protocol-critical flag, skipping', { flag })
    if (mode === 'withValue' && !hasInlineValue) {
      // The next token is this flag's value — drop it too, or it is re-read
      // as a positional argument.
      i++
    } else if (mode === 'optionalValue' && !hasInlineValue) {
      const next = args[i + 1]
      if (next !== undefined && !unshellQuoteArg(next).startsWith('-')) i++
    }
  }
  return filtered
}

/**
 * `CommandSpec.argsPrefix` is the launch prefix (`mise exec --`, `--profile autoclaw`),
 * and it competes for the same protocol flags as custom args — so it is
 * filtered too. Positional tokens are never dropped: in a prefix a bare
 * `acp`/`serve` names the command, it does not re-issue a subcommand
 * (multica `filterLaunchPrefix`).
 *
 * That last rule is why this filter cannot save a prefix that repeats a
 * DRIVER-OWNED subcommand: `agent` is positional, so it passes straight
 * through and the final argv becomes `openclaw agent agent …`. Keeping the
 * subcommand out of `argsPrefix` is the descriptor's job, and
 * `tests/integration/argv-shape.test.ts` is the guard.
 */
export function filterLaunchPrefix(
  prefix: readonly string[] | undefined,
  blocked: BlockedArgs,
  logger?: BridgeLogger,
): string[] {
  if (prefix === undefined || prefix.length === 0) return []
  const filtered: string[] = []
  for (let i = 0; i < prefix.length; i++) {
    const raw = prefix[i]
    if (raw === undefined) continue
    const arg = unshellQuoteArg(raw)
    if (!arg.startsWith('-')) {
      filtered.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    const mode = blocked[flag]
    if (mode === undefined) {
      filtered.push(arg)
      continue
    }
    logger?.warn('runtime args prefix: blocked protocol-critical flag, skipping', { flag })
    if (mode === 'withValue' && eq <= 0) {
      i++
    } else if (mode === 'optionalValue' && eq <= 0) {
      const next = prefix[i + 1]
      if (next !== undefined && !unshellQuoteArg(next).startsWith('-')) i++
    }
  }
  return filtered
}

/** True when args already carry `flag`, as a bare token or `flag=value`. */
export function argsContainFlag(args: readonly string[], flag: string): boolean {
  const prefix = flag + '='
  return args.some((a) => a === flag || a.startsWith(prefix))
}

// ── Model-supplied slot hygiene (D43, audit M1/L2) ──────────────────────────

/**
 * The character set a model-supplied VALUE may carry before it is placed into
 * an argv slot: letters, digits, and the token punctuation every known CLI
 * accepts (`- . _ : / +`), with the first character restricted so the value
 * can never itself read as a flag.
 *
 * This covers the shapes CLIs actually use — `claude-sonnet-4.5`,
 * `gpt-5.1-codex`, `openrouter/openai/o3`, `sess_<uuid>`, `high`, `o3:high` —
 * and refuses precisely everything dangerous: `--flag`, `-p`, embedded spaces,
 * quotes (shell and TOML, e.g. codex's `-c key="${effort}"`), `=` (would close
 * one pair and open another), and newlines. Backtick/`$` were never legal in
 * argv, but keeping them out also makes the values safe to log and to embed in
 * docs queries.
 */
export const ARGV_SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/

/** Test-only predicate; builders should use `assertArgvSafeValue`. */
export function isArgvSafeValue(value: string): boolean {
  return ARGV_SAFE_VALUE_PATTERN.test(value.trim())
}

/**
 * Refuse a model-supplied value that is not an argv-safe token, naming the
 * slot it was headed for. Returns the trimmed token so the builder can place
 * the clean value.
 *
 * ONE refusal point per slot, with the offending value named — the same error
 * shape MI-20 established for the codex resume slot, now shared by every
 * driver (audit: the TOML effort string and the claude/zcode/generic resume
 * flags all had the same unchecked path).
 */
export function assertArgvSafeValue(label: string, value: string): string {
  const token = value.trim()
  if (!ARGV_SAFE_VALUE_PATTERN.test(token)) {
    throw new Error(
      `${label} must be an argv-safe token (letters and digits plus ._:/+-, never starting with "-"); ` +
        `got ${JSON.stringify(value.length > 80 ? value.slice(0, 80) + '…' : value)}. ` +
        'If this value is legitimate for a new engine, widen ARGV_SAFE_VALUE_PATTERN in src/drivers/argv.ts.',
    )
  }
  return token
}

// ── Session plumbing shared by every dialect ────────────────────────────────

export interface DriverSessionInit {
  readonly sessionId: string
  readonly agentId: string
  readonly startedAt: number
  readonly logger: BridgeLogger
  /**
   * Invoked exactly once, the first time `cancel()` is called. The driver
   * terminates the child and then calls `finish()` with a `cancelled` result.
   */
  readonly onCancel: (reason: string) => void
}

/**
 * `AgentSessionHandle` implementation shared by all four dialects: a
 * transcript buffer, a one-shot `done` promise and an idempotent `cancel`.
 *
 * The kernel owns the durable record; this only has to be a faithful buffer of
 * what the driver observed (frozen ABI §`AgentSessionHandle`).
 */
export class DriverSession implements AgentSessionHandle {
  readonly sessionId: string
  readonly agentId: string
  readonly startedAt: number
  readonly done: Promise<AgentResult>

  readonly #logger: BridgeLogger
  readonly #onCancel: (reason: string) => void
  #messages: AgentMessage[] = []
  #status: AgentRunStatus = 'running'
  #result: AgentResult | undefined
  #backendSessionId: string | undefined
  #pid: number | undefined
  #cancelRequested = false
  #resolveDone: ((result: AgentResult) => void) | undefined

  constructor(init: DriverSessionInit) {
    this.sessionId = init.sessionId
    this.agentId = init.agentId
    this.startedAt = init.startedAt
    this.#logger = init.logger
    this.#onCancel = init.onCancel
    this.done = new Promise<AgentResult>((resolve) => {
      this.#resolveDone = resolve
    })
  }

  get messages(): readonly AgentMessage[] {
    return this.#messages
  }

  get status(): AgentRunStatus {
    return this.#status
  }

  get result(): AgentResult | undefined {
    return this.#result
  }

  /**
   * Publish the dialect's conversation id the moment it is observed (ABI v6).
   *
   * The kernel persists it immediately, so a host restart mid-run cannot lose
   * the resume pointer (IM-5). First non-empty value wins: drivers re-emit the
   * id on several frames. A resume the engine later rejects is reported as no
   * `backendSessionId` on the terminal result, which stays authoritative.
   */
  pinBackendSessionId(backendSessionId: string | undefined): void {
    if (backendSessionId === undefined || backendSessionId === '') return
    this.#backendSessionId = this.#backendSessionId ?? backendSessionId
  }

  get backendSessionId(): string | undefined {
    // Only what was OBSERVED mid-run. Deliberately does not fall back to the
    // terminal result: a driver that rejected a resume reports no id there, and
    // conflating the two would re-publish a dead pointer.
    return this.#backendSessionId
  }

  /**
   * Settle-time resolution, which OVERWRITES (and can clear) the pinned id.
   *
   * A driver that discovers the id it observed is NOT resumable — claude's
   * rejected-resume path — passes `''` so the kernel does not persist a dead
   * pointer. For every other driver the observed value simply stands, which is
   * what keeps the pointer durable across a crash mid-run (IM-5).
   */
  settleBackendSessionId(backendSessionId: string): void {
    this.#backendSessionId = backendSessionId === '' ? undefined : backendSessionId
  }

  /**
   * Record the spawned child's pid (ABI v6).
   *
   * The kernel persists it with the `running` row so a host that dies mid-run
   * can reap the detached process tree on restart (IM-4). Called by every
   * driver right after `rt.spawn()`; a failed spawn simply never calls it.
   */
  attachProcess(pid: number | undefined): void {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return
    this.#pid = this.#pid ?? pid
  }

  get pid(): number | undefined {
    return this.#pid
  }

  /** Append one normalized event. Ignored after the terminal state. */
  push(message: AgentMessage): void {
    if (this.#status !== 'running') return
    this.#messages.push(message)
  }

  /** Settle the session. The first call wins; later calls are no-ops. */
  finish(result: AgentResult): void {
    if (this.#result !== undefined) return
    this.#result = result
    this.#status = result.status
    const resolve = this.#resolveDone
    this.#resolveDone = undefined
    this.#logger.debug('driver session settled', {
      sessionId: this.sessionId,
      status: result.status,
      messages: this.#messages.length,
    })
    resolve?.(result)
  }

  cancel(reason?: string): Promise<void> {
    if (this.#cancelRequested) return Promise.resolve()
    this.#cancelRequested = true
    this.#onCancel(reason ?? 'cancelled')
    return Promise.resolve()
  }

  snapshot(): SessionSnapshot {
    const last = this.#messages[this.#messages.length - 1]
    return {
      sessionId: this.sessionId,
      agentId: this.agentId,
      status: this.#status,
      startedAt: this.startedAt,
      endedAt: this.#result === undefined ? undefined : this.startedAt + this.#result.durationMs,
      messageCount: this.#messages.length,
      lastMessage: last,
      result: this.#result,
      terminal: this.#result !== undefined,
    }
  }
}

// ── Small shared helpers ───────────────────────────────────────────────────

/** Build one normalized event with the observation timestamp filled in. */
export function event(
  now: () => number,
  type: AgentMessage['type'],
  fields: Omit<AgentMessage, 'type' | 'at'> = {},
): AgentMessage {
  return { type, at: now(), ...fields }
}

/** JSON.parse that returns `undefined` instead of throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Narrowing helper for decoded protocol frames. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** `unknown` → string, for fields that may be a string, number or object. */
export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** Normalize the multica log-level vocabulary onto our ABI's levels. */
export function asLogLevel(value: unknown): AgentMessage['level'] {
  const raw = typeof value === 'string' ? value.toLowerCase() : ''
  switch (raw) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'warning':
      return raw === 'warning' ? 'warn' : (raw as AgentMessage['level'])
    case 'error':
    case 'fatal':
      return 'error'
    default:
      return 'info'
  }
}

/** Error text for a failed spawn/read without leaking a stack into the result. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Clamp a caller- or config-supplied timer delay to the runtime's ceiling.
 *
 * `setTimeout` does not reject a delay above 2^31-1: it silently rewrites it to
 * **1 ms** and emits `TimeoutOverflowWarning`. For a run watchdog that turns a
 * caller's "effectively no deadline" (a very large number) into an immediate
 * timeout — the child is signalled right after spawn and the run is reported as
 * a timeout it never had (RR-MI-5). Every driver-side timer whose delay comes
 * from `AgentRunOptions` or a descriptor env var must pass through here.
 *
 * One number for both layers: this is the kernel's own {@link MAX_TIMER_DELAY_MS}
 * (imported, never re-declared), so the watchdog and the drivers can never drift
 * onto different ceilings.
 *
 * `Math.min` is what makes the guard total, and dropping the old
 * `Number.isFinite` test is the fix (SV-2): `Infinity` used to be handed to
 * `setTimeout` unchanged, which rewrites it to **1 ms** and warns — and
 * `Infinity > 0` is true, so no driver's own `<= 0` guard stopped it, whatever
 * this comment used to claim. `Math.floor(Infinity)` is still `Infinity`, and
 * `Math.min` then lowers it to the ceiling.
 *
 * What is still passed through, and why: `NaN` (every comparison and every
 * `Math.*` propagates it) and `-Infinity`. Both are disarmed by each driver's
 * own `> 0` guard, and silently turning a `NaN` delay into a three-week
 * deadline would hide the caller bug it is meant to surface — the same reason
 * a negative finite delay is left alone.
 */
export function clampTimerDelay(ms: number): number {
  return Math.min(Math.floor(ms), MAX_TIMER_DELAY_MS)
}

/** Options for {@link readLines}. */
export interface ReadLinesOptions extends StreamLimits {
  /**
   * Keep whitespace-only lines instead of dropping them.
   *
   * The protocol dialects want them gone (a blank line is not a frame), but the
   * generic driver's contract is verbatim stdout, so it opts in (IM-9).
   */
  readonly preserveBlankLines?: boolean
  /**
   * Called once when a stream crosses {@link MAX_STREAM_LINE_BYTES} or
   * {@link MAX_STREAM_TOTAL_BYTES}, after which the reader has detached and
   * `flushed` has resolved.
   *
   * A limit breach is NOT recoverable by truncation: the caller must fail the
   * run and terminate the process group (MI-4). The reader cannot do that
   * itself — it has no handle on the child — so it reports instead of hiding.
   */
  readonly onOverflow?: (overflow: StreamOverflowError) => void
}

/**
 * Attach a line reader to a protocol stream. Multica's `newAgentStreamScanner`
 * equivalent: split on `\n`, drop `\r`, and (unless
 * {@link ReadLinesOptions.preserveBlankLines}) skip blank lines.
 *
 * Two bounds are enforced because the plugin runs in-process: a single
 * un-newlined run may not exceed `maxLineBytes`, and one stream may not deliver
 * more than `maxTotalBytes` in total. Crossing either detaches the reader and
 * reports through `onOverflow` — never a silent truncation, which downstream
 * would parse as a complete frame (MI-4).
 *
 * Returns a promise that settles when the stream ends, plus a way to stop
 * early (the openclaw result-boundary path).
 */
export function readLines(
  stream: Readable,
  onLine: (line: string) => void,
  options: ReadLinesOptions = {},
): { flushed: Promise<void>; stop: () => void } {
  const limits = resolveStreamLimits(options)
  const preserveBlankLines = options.preserveBlankLines === true
  let buffer = ''
  /** Byte length of `buffer`, maintained incrementally — see the cap below. */
  let bufferedBytes = 0
  let totalBytes = 0
  let stopped = false
  let overflowed = false
  let settle: (() => void) | undefined
  const flushed = new Promise<void>((resolve) => {
    settle = resolve
  })
  const finish = (): void => {
    if (settle === undefined) return
    const done = settle
    settle = undefined
    done()
  }
  const detach = (): void => {
    stream.off('data', onData)
    stream.off('end', onEnd)
    stream.off('error', onError)
    stream.off('close', onClose)
  }
  const overflow = (kind: 'line' | 'total'): void => {
    if (overflowed) return
    overflowed = true
    const error =
      kind === 'line'
        ? new StreamOverflowError('line', bufferedBytes, limits.maxLineBytes)
        : new StreamOverflowError('total', totalBytes, limits.maxTotalBytes)
    // Drop the offending buffer BEFORE reporting: the whole point is that the
    // host stops holding it.
    buffer = ''
    bufferedBytes = 0
    detach()
    finish()
    options.onOverflow?.(error)
  }
  function onData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const textBytes = Buffer.byteLength(text, 'utf8')
    totalBytes += textBytes
    if (totalBytes > limits.maxTotalBytes) {
      overflow('total')
      return
    }
    buffer += text
    bufferedBytes += textBytes
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      bufferedBytes -= Buffer.byteLength(raw, 'utf8') + 1
      const line = raw.replace(/\r$/, '')
      if (preserveBlankLines || line.trim() !== '') onLine(line)
      idx = buffer.indexOf('\n')
    }
    // Checked AFTER the split: `buffer` is now the single un-newlined run, so a
    // chunk full of ordinary frames can never trip the line cap.
    if (bufferedBytes > limits.maxLineBytes) overflow('line')
  }
  function onEnd(): void {
    if (preserveBlankLines ? buffer !== '' : buffer.trim() !== '') onLine(buffer)
    buffer = ''
    bufferedBytes = 0
    finish()
  }
  function onError(): void {
    finish()
  }
  function onClose(): void {
    finish()
  }
  stream.on('data', onData)
  stream.on('end', onEnd)
  stream.on('error', onError)
  stream.on('close', onClose)
  return {
    flushed,
    stop: () => {
      if (stopped) return
      stopped = true
      stream.off('data', onData)
      finish()
    },
  }
}

/**
 * Idle window for the two stream-json dialects, in ms.
 *
 * WHY 30 MINUTES (IM-8). claude's stream-json writes NOTHING between the
 * assistant `tool_use` frame and the following `tool_result` frame — stdout is
 * silent for the entire duration of the tool. The idle watchdog only sees
 * stdout, so with a 300 s window every tool call longer than five minutes was
 * killed as "no output" and reported as a timeout: a healthy run destroyed by
 * its own safety net.
 *
 * The window therefore has to sit above the trusted upper bound of a SINGLE
 * tool call, not above a turn: Claude Code's own per-call ceiling is 600 s
 * (Bash `timeout` max) and a wrapping MCP server can exceed it, so 1800 s is
 * 3x the engine's own knob. It stays a safety net rather than a budget — the
 * hard deadline is still `timeoutMs`, and a caller that knows better can set
 * `idleTimeoutMs` per run.
 *
 * `src/kernel/manager.ts` keeps an equal table on purpose (its watchdog is the
 * outer layer and the only thing that catches a driver wedged before it arms
 * this timer), so the two numbers MUST move together.
 */
export const STREAM_JSON_IDLE_TIMEOUT_MS = 1_800_000

/**
 * Per-family idle-watchdog defaults, used when `AgentRunOptions.idleTimeoutMs`
 * is undefined. They are safety nets against a wedged CLI, not turn budgets —
 * the hard deadline is always `timeoutMs`. `openclaw` reuses the CLI's own
 * documented `--timeout` default (600s).
 */
export const DEFAULT_IDLE_TIMEOUT_MS = {
  claude: STREAM_JSON_IDLE_TIMEOUT_MS,
  codebuddy: STREAM_JSON_IDLE_TIMEOUT_MS,
  openclaw: 600_000,
  generic: 300_000,
  // zcode streams lifecycle events throughout a turn; 300s of SILENCE from an
  // engine whose turn-failure event arrives in seconds is a stall, not thought.
  zcode: 300_000,
} as const
