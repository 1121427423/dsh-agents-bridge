/**
 * dsh-agents-bridge / drivers — the codex `exec --json` dialect.
 *
 * Authoritative spec, in two halves that must be kept apart:
 *
 *  1. **The envelope** — `codex-rs/exec/src/exec_events.rs` in openai/codex
 *     (`ThreadEvent`, `ThreadItem`, `ThreadItemDetails`, `Usage`). Every claim
 *     below about a field name was checked against that source *and* against
 *     real captures on this machine; see `tests/fixtures/CODEX-PROVENANCE.md`
 *     for which fixture is a measurement and which is a transcription.
 *  2. **The launch contract** — `codex exec --json [--skip-git-repo-check]
 *     [-C <cwd>] [-m <model>] [-s <sandbox>] [PROMPT]`, verified against
 *     codex-cli 0.154.0 (nvm; the Homebrew cask on this host is 0.144.6, so
 *     never assume the newer dialect from the bare `codex` on PATH).
 *
 * Five things here are expensive lessons rather than transcription:
 *
 *  1. **A positional prompt still reads stdin, and an open stdin pipe HANGS the
 *     run.** Measured: `codex exec --json … "reply with OK"` with stdin held open
 *     by an idle pipe produced **zero** stdout lines after 25s; the identical
 *     command with `< /dev/null` completed in seconds. This is the exact inverse
 *     of the claude driver's rule ("keep stdin open for control responses"), so
 *     the driver closes stdin immediately after spawn and never writes a prompt
 *     frame. A prompt that travels on stdin instead (`-`/no positional arg) would
 *     reintroduce this class of deadlock for no benefit.
 *  2. **`--json` and `-C` cannot be handed back to the caller.** `--json` IS the
 *     protocol; `-C`/`-s` are owned by the run (workdir / sandbox policy) so two
 *     competing values cannot reach the CLI.
 *  3. **An `error` event is not a failure.** The captured credential-rejected run
 *     emits `error` (five retries) and only then `turn.failed`; a captured
 *     *successful* run emits two `error` items (a hooks warning and a skills
 *     budget warning) before its `turn.completed`. So error items are reported
 *     and remembered, but the terminal state is decided by `turn.completed` /
 *     `turn.failed` / the exit code.
 *  4. **The value of a `-c` override is parsed as TOML.** `-c model="o3"` works
 *     because of the quotes; this host's own brief contains the counter-example
 *     that fails loudly: on 0.154.0 `-c model_providers.openai.base_url=…` is
 *     rejected outright ("`model_providers` contains reserved built-in provider
 *     IDs: `openai`") — a *custom* provider id is required. Nothing in this
 *     driver needs a provider override; the note is here so the next person does
 *     not repeat the hour it cost.
 *  5. **stderr on this host is mostly noise.** The MCP client prints
 *     `rmcp::transport::worker … Transport channel closed` for every configured
 *     server it cannot reach, and the skills loader prints traversal-limit
 *     errors. Those must never be reported as a run failure, and blindly
 *     appending the stderr tail to a failure message buries the real cause — so
 *     the tail is filtered before it is used for diagnosis.
 *
 * @module dsh-agents-bridge/drivers/codex
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

import {
  DriverSession,
  asRecord,
  asString,
  buildCommandLine,
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

// ── Blocked flags ───────────────────────────────────────────────────────────

/**
 * Flags the driver owns. Overriding any of these breaks the driver↔CLI contract
 * or lets two competing values reach the CLI:
 *
 *  - `--json` is the protocol: without it stdout is human prose, not JSONL.
 *  - `--skip-git-repo-check` is a bridge policy (runs happen in arbitrary
 *    workdirs, so codex must not refuse a non-repo cwd).
 *  - `-C`/`--cd` and `-s`/`--sandbox` are the run's identity: the workdir and
 *    the sandbox policy come from the run, not from a caller's leftovers.
 *
 * `-c/--config` is deliberately NOT blocked: provider/model overrides and MCP
 * server registrations travel that way, and the dialect has no other channel.
 */
export const CODEX_BLOCKED_ARGS: BlockedArgs = {
  '--json': 'standalone',
  '--skip-git-repo-check': 'standalone',
  '-C': 'withValue',
  '--cd': 'withValue',
  '-s': 'withValue',
  '--sandbox': 'withValue',
}

/** Sandbox modes `codex exec -s` accepts (verified from `codex exec --help`). */
export const CODEX_SANDBOX_MODES: readonly string[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

/**
 * Idle-watchdog default for codex, in ms.
 *
 * Deliberately local instead of an entry in `argv.ts`'s `DEFAULT_IDLE_TIMEOUT_MS`
 * table: that table is keyed by the four pre-existing families and lives in a
 * module shared with the other dialects, so adding a key there would be an edit
 * outside this workstream for no behavioural gain. The value matches the other
 * 300s families.
 */
export const DEFAULT_CODEX_IDLE_TIMEOUT_MS = 300_000

/**
 * Environment variable that selects the sandbox policy, e.g.
 * `DSH_AGENTS_BRIDGE_CODEX_SANDBOX=workspace-write`.
 *
 * It travels in `DriverDeps.env` because the frozen `AgentRunOptions` has no
 * sandbox field (the same zero-ABI-change backdoor the claude driver uses for
 * `--mcp-config`). Unset means "let codex use its own configured default",
 * which is the only choice that cannot silently widen a user's sandbox policy.
 */
export const CODEX_SANDBOX_ENV = 'DSH_AGENTS_BRIDGE_CODEX_SANDBOX'

export function codexSandboxFromEnv(
  env: Readonly<Record<string, string>>,
): string | undefined {
  const raw = env[CODEX_SANDBOX_ENV]
  if (raw === undefined || raw === '') return undefined
  return raw
}

// ── argv ────────────────────────────────────────────────────────────────────

export interface CodexArgOptions {
  /** Last positional argument. codex reads stdin only when this is absent or `-`. */
  readonly prompt: string
  /** `-C <dir>`: the agent's working root. Dropped when resuming (see below). */
  readonly cwd?: string
  readonly model?: string
  /** Runtime-native reasoning level → `-c model_reasoning_effort="<level>"`. */
  readonly effort?: string
  readonly sandbox?: string
  /** Resume an existing conversation: `codex exec resume <id> <prompt>`. */
  readonly resumeSessionId?: string
  readonly extraArgs?: readonly string[]
}

/**
 * `codex exec` argv.
 *
 * Order follows the verified contract: subcommand(s) → `--json` → policy flags →
 * model → sandbox → effort → filtered caller args → positional prompt last.
 *
 * **Resume is a subcommand, not a flag.** `codex exec resume [OPTIONS]
 * [SESSION_ID] [PROMPT]` (verified from `codex exec resume --help` on 0.154.0),
 * and its own option set is *not* the same as `exec`'s: it accepts `--json`,
 * `-m`, `--skip-git-repo-check` and `-c`, but **not** `-C/--cd` or `-s/--sandbox`
 * — passing those makes clap reject the whole invocation. So the resume form
 * omits both and relies on the spawn cwd for the working directory. `--json`
 * still has to be emitted: without it the resumed turn is not JSONL either.
 */
export function buildCodexArgs(opts: CodexArgOptions, logger?: BridgeLogger): string[] {
  const resuming = opts.resumeSessionId !== undefined && opts.resumeSessionId !== ''
  const args: string[] = ['exec']
  if (resuming) args.push('resume')
  args.push('--json')
  args.push('--skip-git-repo-check')
  if (!resuming && opts.cwd !== undefined && opts.cwd !== '') {
    args.push('-C', opts.cwd)
  }
  if (opts.model !== undefined && opts.model !== '') {
    args.push('-m', opts.model)
  }
  if (!resuming && opts.sandbox !== undefined && opts.sandbox !== '') {
    args.push('-s', opts.sandbox)
  }
  if (opts.effort !== undefined && opts.effort !== '') {
    // Verified on 0.154.0: the request body then carries
    // `"reasoning":{"effort":"<level>"}`. The quotes are part of the TOML value
    // that `-c` parses, so the level is quoted here.
    args.push('-c', `model_reasoning_effort="${opts.effort}"`)
  }
  args.push(...filterCustomArgs(opts.extraArgs, CODEX_BLOCKED_ARGS, logger))
  if (resuming) args.push(opts.resumeSessionId ?? '')
  args.push(opts.prompt)
  return args
}

// ── Event normalization ────────────────────────────────────────────────────

/**
 * `ThreadItemDetails` variant tags this driver renders as tool traffic. Read off
 * the upstream enum (see the module header) plus the compiled binary's own
 * variant names (`item.started` / `mcp_tool_call` / `file_change` / … are all
 * present as string constants in codex 0.154.0).
 *
 * `collab_tool_call` and `dynamic_tool_call` are in this build's enum, so they
 * are treated as tool calls rather than left to the unknown-type path — one of
 * them (`collab_tool_call`) is how the sub-agent tools this host exposes travel.
 */
export const CODEX_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'collab_tool_call',
  'dynamic_tool_call',
  'web_search',
])

/** Terminal facts of one `codex exec --json` stdout. */
export interface CodexStreamState {
  /** `thread.started.thread_id` — the launcher's own id, stable across a resume. */
  threadId: string
  sawTurnCompleted: boolean
  sawTurnFailed: boolean
  /** `turn.failed.error.message`. */
  turnFailure: string
  /** Last top-level `error.message`. Non-terminal on its own (codex retries). */
  lastError: string
  /** Last `agent_message.text` — the answer when the turn completes. */
  finalAgentText: string
  usage: AgentUsage | undefined
  /** Decoded JSONL frames, valid or not, excluding blank lines. */
  lineCount: number
  /** Lines that were not JSON at all (a banner, a stray log line). */
  invalidLineCount: number
  /** Frames with a `type` this driver does not know. */
  unknownEventCount: number
  toolUseCount: number
}

function emptyState(): CodexStreamState {
  return {
    threadId: '',
    sawTurnCompleted: false,
    sawTurnFailed: false,
    turnFailure: '',
    lastError: '',
    finalAgentText: '',
    usage: undefined,
    lineCount: 0,
    invalidLineCount: 0,
    unknownEventCount: 0,
    toolUseCount: 0,
  }
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * `Usage` → `AgentUsage` (upstream `ThreadEvent::TurnCompleted(TurnCompletedEvent)`).
 *
 * Field mapping is exact:
 *
 *   input_tokens            → inputTokens
 *   output_tokens           → outputTokens
 *   cached_input_tokens     → cacheReadTokens
 *   cache_write_input_tokens→ cacheWriteTokens
 *
 * `reasoning_output_tokens` is deliberately NOT added to `outputTokens`: in this
 * dialect it is a *subset* of `output_tokens` (OpenAI-style accounting), so
 * adding it would double-count. The frozen `AgentUsage` has no bucket for it —
 * reported as an ABI observation rather than smuggled into a wrong field.
 */
export function parseCodexUsage(raw: unknown): AgentUsage | undefined {
  const usage = asRecord(raw)
  if (usage === undefined) return undefined
  const reasoning = num(usage['reasoning_output_tokens'])
  const parsed: AgentUsage = {
    inputTokens: num(usage['input_tokens']),
    outputTokens: num(usage['output_tokens']),
    cacheReadTokens: num(usage['cached_input_tokens']),
    cacheWriteTokens: num(usage['cache_write_input_tokens']),
    // Reported, never summed into outputTokens: codex counts it INSIDE
    // output_tokens (see AgentUsage.reasoningTokens in the kernel ABI).
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
  if (
    parsed.inputTokens === 0 &&
    parsed.outputTokens === 0 &&
    (parsed.cacheReadTokens ?? 0) === 0 &&
    (parsed.cacheWriteTokens ?? 0) === 0
  ) {
    return undefined
  }
  return parsed
}

/**
 * The `input` recorded for a tool item: the fields that identify the invocation,
 * never the whole envelope (`id`/`type`/`status` are driver bookkeeping).
 */
export function codexToolInput(item: Record<string, unknown>): unknown {
  switch (asString(item['type'])) {
    case 'command_execution':
      return { command: asString(item['command']) ?? '' }
    case 'file_change':
      return { changes: item['changes'] }
    case 'mcp_tool_call':
      return {
        server: asString(item['server']) ?? '',
        tool: asString(item['tool']) ?? '',
        arguments: item['arguments'],
      }
    case 'collab_tool_call':
      return {
        tool: asString(item['tool']) ?? '',
        prompt: item['prompt'],
        receiver_thread_ids: item['receiver_thread_ids'],
      }
    case 'web_search':
      return { query: asString(item['query']) ?? '', action: item['action'] }
    default:
      return item
  }
}

/**
 * The `output` recorded for a completed tool item, as a string.
 *
 * `command_execution` keeps `aggregated_output` verbatim — except that a
 * non-zero `exit_code` or a non-`completed` `status` is appended, because
 * `AgentMessage` has no status field and an empty output from a failed command
 * is otherwise indistinguishable from a successful silent one.
 */
export function codexToolOutput(item: Record<string, unknown>): string {
  const type = asString(item['type']) ?? ''
  if (type === 'command_execution') {
    const output = asString(item['aggregated_output']) ?? ''
    const status = asString(item['status']) ?? ''
    const exitCode = item['exit_code']
    const numericExit = typeof exitCode === 'number' ? exitCode : undefined
    const notes: string[] = []
    if (numericExit !== undefined && numericExit !== 0) notes.push(`exit_code=${numericExit}`)
    if (status !== '' && status !== 'completed' && status !== 'in_progress') {
      notes.push(`status=${status}`)
    }
    return notes.length === 0 ? output : `${output}\n[${notes.join(' ')}]`
  }
  if (type === 'mcp_tool_call') {
    const result = item['result']
    if (result !== undefined && result !== null) return JSON.stringify(result)
    const error = asRecord(item['error'])
    if (error !== undefined) return `error: ${asString(error['message']) ?? ''}`
    return ''
  }
  if (type === 'file_change') {
    const changes = item['changes']
    if (Array.isArray(changes)) {
      return changes
        .map((raw) => {
          const change = asRecord(raw)
          if (change === undefined) return JSON.stringify(raw)
          return `${asString(change['kind']) ?? 'update'} ${asString(change['path']) ?? ''}`
        })
        .join('\n')
    }
    return ''
  }
  return JSON.stringify(item)
}

/**
 * Stateful translator for one `codex exec --json` stdout. Feed it raw lines; it
 * emits `AgentMessage`s and accumulates the terminal facts.
 *
 * Kept as a class because the terminal decision spans lines: the thread id, the
 * last `agent_message`, the usage and the tool announcements all come from
 * different frames, and `turn.failed` may arrive after five `error` frames.
 */
export class CodexStreamParser {
  readonly #sink: { emit(message: AgentMessage): void }
  readonly #now: () => number
  readonly #state: CodexStreamState = emptyState()
  /** Item ids already announced as `tool_use`, so a started→completed pair does not double-report. */
  readonly #announcedTools = new Map<string, string>()

  constructor(sink: { emit(message: AgentMessage): void }, now: () => number = Date.now) {
    this.#sink = sink
    this.#now = now
  }

  get state(): Readonly<CodexStreamState> {
    return this.#state
  }

  handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    this.#state.lineCount++

    const parsed = asRecord(tryParseJson(trimmed))
    if (parsed === undefined) {
      // A banner or a stray log line on stdout. Kept as a debug-level log so the
      // transcript stays explainable, but NEVER fatal: the dialect is versioned
      // by an external tool and this machine already prints non-JSON noise.
      this.#state.invalidLineCount++
      this.#sink.emit(
        event(this.#now, 'log', { content: trimmed, level: 'debug' }),
      )
      return
    }

    const type = asString(parsed['type']) ?? ''
    switch (type) {
      case 'thread.started': {
        const threadId = asString(parsed['thread_id'])
        if (threadId !== undefined && threadId !== '') this.#state.threadId = threadId
        this.#sink.emit(event(this.#now, 'status', { content: 'running' }))
        break
      }
      case 'turn.started':
        this.#sink.emit(event(this.#now, 'status', { content: 'running' }))
        break
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = asRecord(parsed['item'])
        if (item === undefined) break
        this.#handleItem(type, item)
        break
      }
      case 'turn.completed': {
        this.#state.sawTurnCompleted = true
        const usage = parseCodexUsage(parsed['usage'])
        if (usage !== undefined) this.#state.usage = usage
        break
      }
      case 'turn.failed': {
        this.#state.sawTurnFailed = true
        const error = asRecord(parsed['error'])
        const message = error === undefined ? undefined : asString(error['message'])
        this.#state.turnFailure =
          message !== undefined && message !== '' ? message : 'codex turn failed without details'
        // Also surfaced as an error message: a consumer reading only the
        // transcript must be able to see why the turn ended.
        this.#sink.emit(
          event(this.#now, 'error', { content: this.#state.turnFailure, level: 'error' }),
        )
        break
      }
      case 'error': {
        // NOT terminal: codex retries inside a turn and only then exits. The text
        // is remembered for the non-zero-exit diagnosis.
        const message = asString(parsed['message']) ?? ''
        if (message !== '') {
          this.#state.lastError = message
          this.#sink.emit(event(this.#now, 'error', { content: message, level: 'error' }))
        }
        break
      }
      default: {
        // Unknown envelope type: describe it instead of dropping it silently, and
        // never crash — a newer codex may add frames at any time.
        this.#state.unknownEventCount++
        const label = type === '' ? '<missing type>' : type
        this.#sink.emit(
          event(this.#now, 'log', {
            content: `unrecognized codex event type ${JSON.stringify(label)}: ${trimmed}`,
            level: 'info',
          }),
        )
        break
      }
    }
  }

  #handleItem(eventType: string, item: Record<string, unknown>): void {
    const itemType = asString(item['type']) ?? ''
    const itemId = asString(item['id']) ?? ''
    // codex's `item.started`/`item.updated` carry the same id as the eventual
    // `item.completed`, so the id is the correlation key for a callId.
    const callId = itemId

    switch (itemType) {
      case 'agent_message': {
        const text = asString(item['text']) ?? ''
        if (text !== '') {
          this.#state.finalAgentText = text
          this.#sink.emit(event(this.#now, 'text', { content: text }))
        }
        return
      }
      case 'reasoning': {
        const text = asString(item['text']) ?? ''
        if (text !== '') this.#sink.emit(event(this.#now, 'thinking', { content: text }))
        return
      }
      case 'error': {
        // Non-fatal by construction (an item, not a `ThreadErrorEvent`): the
        // captured success run carries two of these and still completes.
        const message = asString(item['message']) ?? ''
        if (message !== '') {
          this.#state.lastError = message
          this.#sink.emit(event(this.#now, 'error', { content: message, level: 'error' }))
        }
        return
      }
      default:
        break
    }

    if (!CODEX_TOOL_ITEM_TYPES.has(itemType)) {
      // A known-but-unmapped or brand-new item type. Its payload may carry
      // information we cannot interpret, so it is logged, never dropped and
      // never fatal.
      this.#state.unknownEventCount++
      this.#sink.emit(
        event(this.#now, 'log', {
          content: `unmapped codex item type ${JSON.stringify(itemType)}: ${JSON.stringify(item)}`,
          level: 'info',
        }),
      )
      return
    }

    // Announce the call once, whichever frame introduces the item: `file_change`
    // is documented as completed-only, while `command_execution` arrives as a
    // started→completed pair and is also observed in an updated→completed shape.
    if (!this.#announcedTools.has(itemId) || this.#announcedTools.get(itemId) !== itemType) {
      this.#announcedTools.set(itemId, itemType)
      this.#state.toolUseCount++
      this.#sink.emit(
        event(this.#now, 'tool_use', {
          // The dialect's own item type is the tool name: it is version-stable
          // and self-describing, and the richer identity (server/tool for MCP,
          // command for exec) lives in `input` without loss.
          tool: itemType,
          ...(callId === '' ? {} : { callId }),
          input: codexToolInput(item),
        }),
      )
    }

    // Only a terminal frame produces a result; an `item.started` has no output
    // yet (measured: `aggregated_output` is `""`, `exit_code` is `null`).
    if (eventType === 'item.started') return
    this.#sink.emit(
      event(this.#now, 'tool_result', {
        tool: itemType,
        ...(callId === '' ? {} : { callId }),
        output: codexToolOutput(item),
      }),
    )
  }
}

// ── stderr diagnosis ───────────────────────────────────────────────────────

/**
 * stderr lines that are known environment noise, not run diagnostics.
 *
 * Both patterns were measured on this host while capturing the fixtures:
 * the MCP client prints one transport error per configured-but-unreachable
 * server, and the skills loader prints a traversal-limit error per skills root.
 * They are dropped from a failure message *and* never promote a run to failed.
 */
export const CODEX_STDERR_NOISE: readonly RegExp[] = [
  /rmcp::transport::worker/,
  /skills scan reached its traversal limit/,
  /^Reading additional input from stdin\.\.\.$/,
]

/**
 * The part of a stderr tail worth showing a human on failure. Returns '' when
 * everything was noise, so a caller can distinguish "no diagnosis" from
 * "diagnosis that happens to be empty".
 */
export function codexStderrDiagnosis(raw: string): string {
  const kept = raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .filter((line) => !CODEX_STDERR_NOISE.some((pattern) => pattern.test(line)))
  return kept.join('\n').trim()
}

// ── Engine ──────────────────────────────────────────────────────────────────

const STDERR_TAIL_BYTES = 8 * 1024

let sessionCounter = 0

function nextSessionId(at: number): string {
  sessionCounter = (sessionCounter + 1) % 1_000_000
  return `dsh-codex-${at.toString(36)}-${sessionCounter.toString(36)}`
}

/**
 * Run one `codex exec --json` conversation. Returns as soon as the child is
 * spawned and the readers are attached — never awaits the child (frozen ABI:
 * `agents_run` must not block on a minutes-long task).
 */
export async function runCodex(
  opts: AgentRunOptions,
  deps: DriverDeps,
  signal: AbortSignal,
  rt: DriverRuntime,
): Promise<AgentSessionHandle> {
  const now = rt.now ?? Date.now
  const startedAt = now()

  const args = buildCodexArgs(
    {
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      sandbox: codexSandboxFromEnv(deps.env),
      resumeSessionId: opts.resumeSessionId,
      extraArgs: opts.extraArgs,
    },
    deps.logger,
  )
  const commandLine = buildCommandLine(
    {
      ...deps.command,
      // The launch prefix (`mise exec --`, a profile flag) competes for the same
      // protocol flags, so it is filtered like the other dialects do. Positional
      // prefix tokens are never dropped.
      argsPrefix: filterLaunchPrefix(deps.command.argsPrefix, CODEX_BLOCKED_ARGS, deps.logger),
    },
    args,
  )

  // Declared with a no-op body BEFORE the session, because the session's cancel
  // hook is captured at construction and would otherwise close over a binding in
  // its temporal dead zone.
  let settleCancelled: (reason: string) => void = () => {}

  const session = new DriverSession({
    sessionId: nextSessionId(startedAt),
    agentId: opts.agent,
    startedAt,
    logger: deps.logger,
    onCancel: (reason) => settleCancelled(reason),
  })

  const parser = new CodexStreamParser({ emit: (message) => session.push(message) }, now)
  const stderrTail = { value: '' }
  let terminalReason: 'none' | 'cancelled' | 'timeout' | 'idle' = 'none'
  let scanError: unknown
  let hardTimer: NodeJS.Timeout | undefined
  let idleTimer: NodeJS.Timeout | undefined

  const child: SpawnedProcess = rt.spawn({
    command: commandLine.command,
    args: commandLine.args,
    cwd: opts.cwd,
    env: deps.env,
  })
  // ABI v6: hand the kernel the pid it persists for the post-restart reap (IM-4).
  session.attachProcess(child.pid)

  deps.logger.debug('driver launched', {
    family: 'codex',
    command: commandLine.command,
    args: commandLine.args.length,
    resume: opts.resumeSessionId !== undefined && opts.resumeSessionId !== '',
  })

  // MANDATORY, and the opposite of the claude driver: with a positional prompt
  // but an open stdin pipe codex blocks forever waiting for more input
  // (measured: no stdout for 25s). There is no control channel to keep open —
  // codex `exec` never asks a question on stdin — so close it at once.
  try {
    child.stdin.end()
  } catch {
    /* already gone */
  }

  function clearTimers(): void {
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    hardTimer = undefined
    idleTimer = undefined
  }

  function finishOnce(result: AgentResult): void {
    if (session.result !== undefined) return
    clearTimers()
    signal.removeEventListener('abort', onAbort)
    session.finish(result)
  }

  function requestTerminal(reason: 'cancelled' | 'timeout' | 'idle', message: string): void {
    if (terminalReason !== 'none') return
    terminalReason = reason
    finishOnce({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status: reason === 'cancelled' ? 'cancelled' : 'timeout',
      exitCode: null,
      text: '',
      error: message,
      durationMs: now() - startedAt,
      ...(parser.state.usage === undefined ? {} : { usage: parser.state.usage }),
    })
    // Graceful signal → grace window → process-group kill, owned by the runtime.
    void child.terminate().catch(() => {})
  }

  settleCancelled = (reason: string) => {
    requestTerminal('cancelled', reason === '' ? 'execution cancelled' : reason)
  }

  // Attach the reader before any other work so no early frame is lost.
  const reader = readLines(child.stdout, (line) => {
    parser.handleLine(line)
    // ABI v6: codex names its thread id in the first events; publish it as soon
    // as it is seen so the kernel can persist the resume pointer (IM-5).
    session.pinBackendSessionId(parser.state.threadId)
  })
  child.stdout.on('error', (err: unknown) => {
    scanError = err
    reader.stop()
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    stderrTail.value = (stderrTail.value + text).slice(-STDERR_TAIL_BYTES)
  })
  // Swallow stream errors: an unhandled 'error' event would take the host down
  // when the child dies mid-write.
  child.stderr.on('error', () => {})
  child.stdin.on('error', () => {})

  const hardTimeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : 0
  if (hardTimeoutMs > 0) {
    hardTimer = setTimeout(() => {
      requestTerminal('timeout', `codex timed out after ${hardTimeoutMs}ms`)
    }, hardTimeoutMs)
  }

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_CODEX_IDLE_TIMEOUT_MS
  const touchIdle = (): void => {
    if (idleTimeoutMs <= 0 || terminalReason !== 'none') return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      requestTerminal('idle', `codex produced no output for ${idleTimeoutMs}ms`)
    }, idleTimeoutMs)
  }
  child.stdout.on('data', touchIdle)
  touchIdle()

  // A hoisted declaration (not a `const`) because `finishOnce` above removes this
  // listener, and the two are mutually recursive by design.
  function onAbort(): void {
    requestTerminal('cancelled', 'execution cancelled')
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  // Settle once the process is gone AND stdout has flushed: awaiting both is what
  // lets a trailing `turn.completed` frame still be parsed after exit.
  void (async () => {
    const exit: ProcessExit = await child.exited.catch((err: unknown) => {
      return { code: null, signal: null, error: errorText(err) } satisfies ProcessExit
    })
    await reader.flushed

    if (terminalReason !== 'none' || session.result !== undefined) {
      // Cancel/timeout already settled the session; make sure the group is gone
      // so no orphan outlives the transcript.
      void child.terminate().catch(() => {})
      return
    }

    const state = parser.state
    const stderrDiagnosis = codexStderrDiagnosis(stderrTail.value)

    let status: AgentResult['status'] = 'completed'
    let errMsg = ''

    if (state.sawTurnFailed) {
      // The dialect's own terminal failure. Preferred over the exit code because
      // it carries the message; on the captured credential-rejected run both
      // agree (`turn.failed` + exit 1).
      status = 'failed'
      errMsg = state.turnFailure !== '' ? state.turnFailure : state.lastError
      if (errMsg === '') errMsg = 'codex reported a failed turn without details'
    } else if (exit.error !== undefined) {
      status = 'failed'
      errMsg = `codex failed to start: ${exit.error}`
    } else if ((exit.code ?? 0) !== 0) {
      // Non-zero exit: the last `error` text is the cause (codex retries inside
      // the turn, so earlier error frames are retries, not the failure).
      status = 'failed'
      const detail = `exit status ${exit.code ?? 'null'}${exit.signal === null ? '' : ` (signal ${exit.signal})`}`
      errMsg =
        state.lastError !== ''
          ? `${state.lastError} (codex ${detail})`
          : `codex exited with error: ${detail}`
    } else if (!state.sawTurnCompleted) {
      // A clean exit with no terminal turn event: the stream was truncated. A
      // partial transcript must never be reported as an answer.
      status = 'failed'
      errMsg =
        state.lastError !== ''
          ? `codex stream ended without a terminal turn event (last error: ${state.lastError})`
          : 'codex stream ended without a terminal turn event'
    }
    if (status === 'completed' && scanError !== undefined) {
      status = 'failed'
      errMsg = `codex stdout read error: ${errorText(scanError)}`
    }
    if (status !== 'completed' && stderrDiagnosis !== '') {
      errMsg = `${errMsg}: ${stderrDiagnosis}`
    }

    finishOnce({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status,
      exitCode: exit.code,
      // Failed runs report no text, so a partial transcript cannot be mistaken
      // for a final answer (the claude/codebuddy contract).
      text: status === 'completed' ? state.finalAgentText : '',
      ...(errMsg === '' ? {} : { error: errMsg }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      durationMs: now() - startedAt,
      // The launcher's own thread id, and the value a later resume must pass
      // back to `codex exec resume <id>`. Verified: a resumed run re-emits the
      // same `thread_id` in `thread.started`, so this pointer stays stable.
      ...(state.threadId === '' ? {} : { backendSessionId: state.threadId }),
    })
  })()

  return session
}

export function createCodexBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'codex',
    run: (opts, runDeps, signal) => runCodex(opts, runDeps, signal, resolveRuntime(rt)),
  }
}
