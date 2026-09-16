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

import type {
  AgentMessage,
  AgentResult,
  AgentRunStatus,
  AgentSessionHandle,
  BridgeLogger,
  CommandSpec,
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
 * Expand a `CommandSpec` + per-run args into a concrete command line.
 *
 * The `interpreter` rule is frozen in `docs/design.md` §4 and exists because
 * WorkBuddy's `cli/bin/codebuddy` is a `#!/usr/bin/env node` script while
 * `node` is not on PATH (verified on this machine):
 * `[interpreter, executable, ...argsPrefix, ...args]`.
 */
export function buildCommandLine(
  spec: CommandSpec,
  args: readonly string[],
): { command: string; args: string[] } {
  const prefix = spec.argsPrefix ?? []
  if (spec.interpreter !== undefined && spec.interpreter !== '') {
    return {
      command: spec.interpreter,
      args: [spec.executable, ...prefix, ...args],
    }
  }
  return { command: spec.executable, args: [...prefix, ...args] }
}

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
 * `CommandSpec.argsPrefix` is the launch prefix (`mise exec --`, `openclaw`),
 * and it competes for the same protocol flags as custom args — so it is
 * filtered too. Positional tokens are never dropped: in a prefix a bare
 * `acp`/`serve` names the command, it does not re-issue a subcommand
 * (multica `filterLaunchPrefix`).
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
 * Attach a line reader to a protocol stream. Multica's `newAgentStreamScanner`
 * equivalent: split on `\n`, drop `\r`, skip blank lines.
 *
 * Returns a promise that settles when the stream ends, plus a way to stop
 * early (the openclaw result-boundary path).
 */
export function readLines(
  stream: Readable,
  onLine: (line: string) => void,
): { flushed: Promise<void>; stop: () => void } {
  let buffer = ''
  let stopped = false
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
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (line.trim() !== '') onLine(line)
      idx = buffer.indexOf('\n')
    }
  }
  stream.on('data', onData)
  stream.on('end', () => {
    if (buffer.trim() !== '') onLine(buffer)
    buffer = ''
    finish()
  })
  stream.on('error', () => finish())
  stream.on('close', () => finish())
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
 * Per-family idle-watchdog defaults, used when `AgentRunOptions.idleTimeoutMs`
 * is undefined. They are safety nets against a wedged CLI, not turn budgets —
 * the hard deadline is always `timeoutMs`. `openclaw` reuses the CLI's own
 * documented `--timeout` default (600s).
 */
export const DEFAULT_IDLE_TIMEOUT_MS = {
  claude: 300_000,
  codebuddy: 300_000,
  openclaw: 600_000,
  generic: 300_000,
} as const
