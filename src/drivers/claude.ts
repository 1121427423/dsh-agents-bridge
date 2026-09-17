/**
 * dsh-agents-bridge / drivers — the claude stream-json dialect.
 *
 * Authoritative spec: multica `server/pkg/agent/claude.go` (`buildClaudeArgs`,
 * `claudeBlockedArgs`, `handleAssistant` / `handleUser` /
 * `handleControlRequest`, the event switch in `Execute`) plus
 * `stream_json_result.go` (the shared terminal contract) and
 * `claude_deadlock_test.go` / `claude_context_exhausted_test.go`.
 *
 * This module is the *engine* for the whole claude fork: `codebuddy.ts` reuses
 * `ClaudeStreamParser` and `runStreamJsonFamily` and only swaps the dialect
 * (fixed argv + whether a managed MCP config implies `--strict-mcp-config`).
 *
 * Three things are copied deliberately because they are the expensive lessons:
 *
 *  1. **Concurrent stdin/stdout.** The prompt is written from a background task
 *     *after* the stdout reader is attached, and stdin is left OPEN after the
 *     prompt frame. A CLI that prints a startup banner before its first stdin
 *     read deadlocks a driver that serialises the two
 *     (`TestClaudeExecuteDoesNotDeadlockOnStartupStdoutBurst`, 256 KiB banner);
 *     a driver that closes stdin after the prompt cannot auto-approve a later
 *     `control_request`.
 *  2. **Only a `result` event proves success.** A clean exit is not completion:
 *     `stream ended without terminal result` is a failure, and failed runs
 *     report empty text so a partial transcript can never be mistaken for an
 *     answer.
 *  3. **`terminal_reason` outranks `is_error`.** Claude Code computes the two
 *     independently; on a context-exhausted turn only `terminal_reason`
 *     names the condition (GH #6402).
 *
 * @module dsh-agents-bridge/drivers/claude
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
  DEFAULT_IDLE_TIMEOUT_MS,
  DriverSession,
  asLogLevel,
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

// ── Blocked flags (multica `claudeBlockedArgs`, claude.go:713) ──────────────

/**
 * Flags hardcoded here that must not be overridable by caller-supplied args —
 * overriding any of them breaks the driver↔CLI protocol.
 *
 * `--effort` is owned by the per-run thinking level: the driver injects it only
 * when `effort` is set, but a caller-written duplicate is dropped rather than
 * letting two conflicting values reach the CLI.
 */
export const CLAUDE_BLOCKED_ARGS: BlockedArgs = {
  '-p': 'standalone', // non-interactive mode
  '--output-format': 'withValue', // stream-json protocol
  '--input-format': 'withValue', // stream-json protocol
  '--permission-mode': 'withValue', // bypassPermissions for autonomous operation
  '--mcp-config': 'withValue', // driver-owned
  '--effort': 'withValue', // owned by the thinking-level picker
}

/** `codebuddyBlockedArgs` is identical to claude's (codebuddy.go:27). */
export const CODEBUDDY_BLOCKED_ARGS: BlockedArgs = { ...CLAUDE_BLOCKED_ARGS }

// ── Dialect description ────────────────────────────────────────────────────

export interface StreamJsonDialect {
  readonly family: 'claude' | 'codebuddy'
  /** Used in error strings, mirroring multica's `provider` argument. */
  readonly label: string
  /** Everything before the per-run flags; differs between the fork. */
  readonly fixedArgs: readonly string[]
  readonly blockedArgs: BlockedArgs
  /**
   * claude: a managed MCP config switches to strict mode, so the child uses
   * exactly the servers the caller configured. codebuddy: NEVER — measured on
   * CodeBuddy 2.x, `--strict-mcp-config` drops the user/project/local scopes
   * instead of unioning them (MUL-5846).
   */
  readonly strictMcpConfigWhenManaged: boolean
  /**
   * claude: deliberately false. Claude Code loads the per-task CLAUDE.md from
   * the workdir, so inlining the same brief as `--append-system-prompt`
   * duplicates it on every turn (`TestBuildClaudeArgsIgnoresSystemPrompt`,
   * MUL-5392). codebuddy: true (`--append-system-prompt`, codebuddy.go:86).
   */
  readonly forwardSystemPrompt: boolean
  /**
   * claude reads the structured `terminal_reason` field; the ported codebuddy
   * switch does not, so codebuddy keeps the pre-existing contract.
   */
  readonly readsTerminalReason: boolean
  /**
   * claude's `handleUser` returns whether a tool result reported an async
   * background launch, and the run is failed for it. codebuddy's `handleUser`
   * returns nothing, so the guard does not exist there (codebuddy.go:245).
   */
  readonly detectsAsyncLaunch: boolean
  /**
   * Whether an auto-approval `control_response` also carries `allowed: true`.
   *
   * The two permission clients on this fork read DIFFERENT keys of the same
   * frame: Claude Code reads `behavior`, while CodeBuddy's
   * `SdkPermissionClientImpl.handleResponse` resolves
   * `allowed: response.allowed ?? false` — so an approval that omits `allowed`
   * is read as a denial, and the tool is refused (or the CLI waits for a
   * confirmation that never arrives). The fork's Go reference
   * (`server/pkg/agent/codebuddy.go` `handleControlRequest`) sends both keys and
   * comments that a missing one reads as a rejection; claude's
   * (`claude.go:483`) sends `behavior` alone. Hence: claude false (its wire must
   * stay byte-identical), codebuddy true.
   */
  readonly controlResponseIncludesAllowed: boolean
}

export const CLAUDE_DIALECT: StreamJsonDialect = {
  family: 'claude',
  label: 'claude',
  fixedArgs: [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    // AskUserQuestion is Claude Code's built-in interactive question tool.
    // Headless stream-json has no UI to render it in, so a call returns an
    // empty answer and the agent silently "infers" one (GitHub #2588).
    '--disallowedTools',
    'AskUserQuestion',
  ],
  blockedArgs: CLAUDE_BLOCKED_ARGS,
  strictMcpConfigWhenManaged: true,
  forwardSystemPrompt: false,
  readsTerminalReason: true,
  detectsAsyncLaunch: true,
  // Byte-compat: claude reads `behavior` and must not see an extra key.
  controlResponseIncludesAllowed: false,
}

// ── argv ────────────────────────────────────────────────────────────────────

/**
 * Options the argv builders can consume. `AgentRunOptions` (frozen ABI) covers
 * model/effort/resume/extraArgs; the rest exist so the builders are complete
 * against multica and unit-testable. See the module report for the ABI gap on
 * `maxTurns` / `systemPrompt` / `mcpConfigPath`.
 */
export interface StreamJsonArgOptions {
  readonly model?: string
  readonly effort?: string
  readonly maxTurns?: number
  readonly systemPrompt?: string
  readonly resumeSessionId?: string
  /**
   * Path to an already-materialised MCP config file. Appended LAST, after the
   * caller's args, exactly as multica does in `Execute`.
   */
  readonly mcpConfigPath?: string
  readonly extraArgs?: readonly string[]
}

/**
 * Shared argv builder for the claude fork. Order is load-bearing and copied
 * from multica: fixed protocol flags → `--strict-mcp-config` → model → effort →
 * max-turns → system prompt → resume → filtered extra/custom args.
 */
export function buildStreamJsonArgs(
  dialect: StreamJsonDialect,
  opts: StreamJsonArgOptions,
  logger?: BridgeLogger,
): string[] {
  const args: string[] = [...dialect.fixedArgs]

  if (opts.mcpConfigPath !== undefined && dialect.strictMcpConfigWhenManaged) {
    args.push('--strict-mcp-config')
  }
  if (opts.model !== undefined && opts.model !== '') {
    args.push('--model', opts.model)
  }
  if (opts.effort !== undefined && opts.effort !== '') {
    // Slotted right after --model so the launch line reads as one model+effort
    // decision; the CLI accepts the flag in any order.
    args.push('--effort', opts.effort)
  }
  if (opts.maxTurns !== undefined && opts.maxTurns > 0) {
    args.push('--max-turns', String(opts.maxTurns))
  }
  if (dialect.forwardSystemPrompt && opts.systemPrompt !== undefined && opts.systemPrompt !== '') {
    args.push('--append-system-prompt', opts.systemPrompt)
  }
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== '') {
    args.push('--resume', opts.resumeSessionId)
  }
  args.push(...filterCustomArgs(opts.extraArgs, dialect.blockedArgs, logger))
  return args
}

/** `buildClaudeArgs` equivalent. */
export function buildClaudeArgs(opts: StreamJsonArgOptions, logger?: BridgeLogger): string[] {
  return buildStreamJsonArgs(CLAUDE_DIALECT, opts, logger)
}

/**
 * The stream-json input frame. `-p` carries no value, so the prompt travels as
 * one JSON line on stdin (multica `buildClaudeInput`).
 */
export function buildClaudeInput(prompt: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    }) + '\n'
  )
}

/**
 * Environment variables that must not leak into a spawned claude/codebuddy
 * child: internal per-process session/transport markers would make the child
 * think it is a nested or resumed session.
 *
 * The user-facing `CLAUDE_CODE_*` config namespace is deliberately NOT stripped
 * (multica `isFilteredChildEnvKey`): blanket-stripping it broke Windows because
 * `CLAUDE_CODE_GIT_BASH_PATH` was silently removed.
 */
const CLAUDE_CHILD_ENV_DENYLIST: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
])

export function sanitizeClaudeChildEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (CLAUDE_CHILD_ENV_DENYLIST.has(key)) continue
    if (key.startsWith('CLAUDECODE_')) continue
    out[key] = value
  }
  return out
}

/**
 * Claude Code refuses `bypassPermissions` under root/sudo. Fail before spending
 * a process on it, with the same actionable wording as multica
 * (`claudeRootSudoPreflight`).
 */
export function claudeRootSudoPreflightError(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): string | undefined {
  if (!argsRequestBypassPermissions(args)) return undefined
  const getuid = (process as unknown as { getuid?: () => number }).getuid
  if (typeof getuid !== 'function' || getuid.call(process) !== 0) return undefined
  const sandbox = (env['IS_SANDBOX'] ?? '').toLowerCase()
  if (sandbox === '1' || sandbox === 'true' || sandbox === 'yes' || sandbox === 'on') {
    return undefined
  }
  return (
    'Claude Code refuses bypassPermissions under root/sudo privileges. ' +
    'Run the bridge as a non-root user, or set IS_SANDBOX=1 if running in a ' +
    'genuine container/sandbox'
  )
}

export function argsRequestBypassPermissions(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dangerously-skip-permissions') return true
    if (arg === '--permission-mode' && args[i + 1] === 'bypassPermissions') return true
  }
  return false
}

// ── Event normalization ────────────────────────────────────────────────────

/** Where normalized events go, and how auto-approval frames get back. */
export interface ClaudeStreamSink {
  emit(message: AgentMessage): void
  /**
   * Write one frame to the child's stdin. Used only for `control_response`
   * auto-approvals; the stream must therefore stay open for the whole run.
   */
  writeFrame(frame: string): void
  /**
   * Release the child's stdin. Called at the terminal `result` event, which is
   * the point after which no control request can still be answered.
   */
  closeInput(): void
}

/** The terminal facts one stream produced, mirroring `streamTerminalState`. */
export interface ClaudeStreamState {
  sessionId: string
  sawResult: boolean
  /** `result.result` — the authoritative final text when the run succeeded. */
  finalResultText: string
  resultIsError: boolean
  /**
   * First entry of the terminal frame's `errors[]`.
   *
   * Measured on two engines: the error path leaves `result` EMPTY and puts the
   * engine's own words in `errors[]` instead. Real captures on this machine:
   *   codebuddy-code → "Authentication required. Please use /login command to sign in to your account"
   *   workbuddy-ai   → the 401 lands in an assistant text block and `result` is ''
   * Without this, the model-facing error degraded to "<engine> returned an error
   * result without details" while the useful sentence sat unread in the transcript.
   */
  resultError: string
  /** Non-empty only for a structured reason the dialect positively recognised. */
  terminalReasonError: string
  /**
   * Fallback answer: the last *complete* assistant turn that carried text and
   * invoked no tool. Pre-tool narration must never become the final answer
   * (multica #6006).
   */
  lastAssistantText: string
  /** True when a tool result reported an async background launch. */
  sawAsyncLaunch: boolean
  usage: AgentUsage | undefined
  eventCount: number
  invalidEventCount: number
  toolUseCount: number
}

function emptyState(): ClaudeStreamState {
  return {
    sessionId: '',
    sawResult: false,
    finalResultText: '',
    resultError: '',
    resultIsError: false,
    terminalReasonError: '',
    lastAssistantText: '',
    sawAsyncLaunch: false,
    usage: undefined,
    eventCount: 0,
    invalidEventCount: 0,
    toolUseCount: 0,
  }
}

/**
 * Turn Claude Code's structured `terminal_reason` into an error string when it
 * means the turn produced no answer.
 *
 * Only `prompt_too_long` is recognised, deliberately: every other reason either
 * already arrives with `is_error` set or is a legitimate completion. On the
 * captured 2.1.220 frame a context-exhausted turn arrives as `is_error: true`
 * AND `terminal_reason: "prompt_too_long"` together — and only the latter names
 * the condition without depending on the CLI's prose.
 */
export function claudeTerminalReasonFailure(
  terminalReason: unknown,
  resultText: unknown,
): string {
  const reason = typeof terminalReason === 'string' ? terminalReason.trim() : ''
  if (reason !== 'prompt_too_long') return ''
  const detail = typeof resultText === 'string' ? resultText.trim() : ''
  let msg =
    'claude ended the turn with terminal_reason=prompt_too_long: ' +
    "the session's context window is exhausted and compaction could not recover it"
  if (detail !== '') msg += ` (${detail})`
  return msg
}

/** Per-model assistant usage, keyed by the model the block reported. */
type UsageByModel = Map<string, AgentUsage>

function addUsage(target: AgentUsage, add: AgentUsage): AgentUsage {
  return {
    inputTokens: target.inputTokens + add.inputTokens,
    outputTokens: target.outputTokens + add.outputTokens,
    cacheReadTokens: (target.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0),
    cacheWriteTokens: (target.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0),
  }
}

function usageHasTokens(u: AgentUsage | undefined): boolean {
  if (u === undefined) return false
  return (
    u.inputTokens > 0 ||
    u.outputTokens > 0 ||
    (u.cacheReadTokens ?? 0) > 0 ||
    (u.cacheWriteTokens ?? 0) > 0
  )
}

/**
 * `claudeResultUsage`: the terminal `modelUsage` map wins outright; the flat
 * `usage` object is the fallback.
 *
 * DEVIATION (documented): multica keys usage per model, while the frozen ABI
 * has one `AgentUsage`. Buckets are therefore summed across models, which is
 * the only lossless single-bucket aggregation.
 */
export function claudeResultUsage(
  msg: Record<string, unknown>,
  fallbackModel: string | undefined,
): AgentUsage | undefined {
  const modelUsage = asRecord(msg['modelUsage'])
  if (modelUsage !== undefined && Object.keys(modelUsage).length > 0) {
    let total: AgentUsage | undefined
    for (const [model, raw] of Object.entries(modelUsage)) {
      if (model === '') continue
      const entry = asRecord(raw)
      if (entry === undefined) continue
      const u: AgentUsage = {
        inputTokens: num(entry['inputTokens']),
        outputTokens: num(entry['outputTokens']),
        cacheReadTokens: num(entry['cacheReadInputTokens']),
        cacheWriteTokens: num(entry['cacheCreationInputTokens']),
      }
      if (!usageHasTokens(u)) continue
      total = total === undefined ? u : addUsage(total, u)
    }
    if (total !== undefined) return total
  }

  const flat = asRecord(msg['usage'])
  if (flat === undefined) return undefined
  const model = asString(msg['model']) ?? fallbackModel ?? ''
  if (model === '') return undefined
  const u: AgentUsage = {
    inputTokens: num(flat['input_tokens'] ?? flat['inputTokens']),
    outputTokens: num(flat['output_tokens'] ?? flat['outputTokens']),
    cacheReadTokens: num(flat['cache_read_input_tokens'] ?? flat['cacheReadInputTokens']),
    cacheWriteTokens: num(
      flat['cache_creation_input_tokens'] ?? flat['cacheCreationInputTokens'],
    ),
  }
  return usageHasTokens(u) ? u : undefined
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
 * Stateful translator for one stream-json run. Feed it raw stdout lines; it
 * emits `AgentMessage`s and writes auto-approval frames.
 *
 * Kept as a class (not a pure function) because the terminal result depends on
 * state accumulated across events: usage dedupe by message id, the assistant
 * fallback chain and the session id all span lines.
 */
export class ClaudeStreamParser {
  readonly #dialect: StreamJsonDialect
  readonly #sink: ClaudeStreamSink
  readonly #now: () => number
  readonly #state: ClaudeStreamState = emptyState()
  readonly #usageByModel: UsageByModel = new Map()
  readonly #seenUsageIds = new Set<string>()
  #fallbackModel: string | undefined
  #stdinClosed = false
  /**
   * Last `status` text emitted, used to collapse repeats. The dialect can emit a
   * burst of `system` frames per turn (a REAL capture of a single trivial prompt
   * on this machine produced 7x hook_started, 7x hook_response, 1x hook_progress
   * and 1x init before the first assistant token), and one status message per
   * frame buried the transcript under 18 identical "running" events that the
   * model then paid for on every `agents_output` poll.
   */
  #statusTextsSeen: Set<string> = new Set()

  constructor(
    dialect: StreamJsonDialect,
    sink: ClaudeStreamSink,
    now: () => number = Date.now,
    fallbackModel?: string,
  ) {
    this.#dialect = dialect
    this.#sink = sink
    this.#now = now
    this.#fallbackModel = fallbackModel
  }

  /** Facts the runner needs to decide the terminal state. */
  get state(): Readonly<ClaudeStreamState> {
    return this.#state
  }

  /** Called when the child's stdin is closed, so approvals stop being written. */
  markStdinClosed(): void {
    this.#stdinClosed = true
  }

  handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    const parsed = asRecord(tryParseJson(trimmed))
    if (parsed === undefined) {
      // A malformed frame is counted and skipped, never fatal: a CLI that logs
      // a plain-text preamble on stdout must not lose the whole run.
      this.#state.invalidEventCount++
      return
    }
    this.#state.eventCount++
    const type = asString(parsed['type']) ?? ''
    switch (type) {
      case 'assistant':
        this.#handleAssistant(parsed)
        break
      case 'user':
        this.#handleUser(parsed)
        break
      case 'system': {
        const sessionId = asString(parsed['session_id'])
        if (sessionId !== undefined && sessionId !== '') this.#state.sessionId = sessionId
        // The ABI's AgentMessage carries no session id, so the streamed status
        // is just "still running"; the backend session id lands on the result.
        //
        // Emitted ONCE, and only for the frame that actually carries news
        // (`subtype: 'init'` names the model and the permission mode). All the
        // other system frames are hook lifecycle noise: forwarding one status
        // message each floods the model's incremental reads with dead events.
        const subtype = asString(parsed['subtype']) ?? ''
        // Only frames that carry news are forwarded: `init` (the dialect names
        // model + permission mode) and `status` (CodeBuddy's own progress frame,
        // undocumented but real — see docs/driver-pitfalls.md). Hook lifecycle
        // frames are dropped, and repeated identical text is collapsed.
        if (subtype === 'init' || subtype === 'status') {
          const model = asString(parsed['model'])
          const permissionMode = asString(parsed['permissionMode'])
          const reported = asString(parsed['status'])
          const facts = [
            model !== undefined && model !== '' ? `model=${model}` : '',
            permissionMode !== undefined && permissionMode !== '' ? `permissionMode=${permissionMode}` : '',
            reported !== undefined && reported !== '' ? `status=${reported}` : '',
          ].filter((part) => part !== '')
          const text = facts.length > 0 ? `running (${facts.join(', ')})` : 'running'
          // Deduped by the SET of texts already emitted, not by the previous
          // one: the international WorkBuddy build emits `init`, then `status`,
          // then `init` AGAIN, which an "only if different from the last" rule
          // passes straight through (observed: 4 events where 3 are correct).
          if (!this.#statusTextsSeen.has(text)) {
            this.#statusTextsSeen.add(text)
            this.#sink.emit(event(this.#now, 'status', { content: text }))
          }
        }
        break
      }
      case 'result':
        this.#handleResult(parsed)
        break
      case 'log': {
        const log = asRecord(parsed['log'])
        if (log === undefined) break
        const message = asString(log['message']) ?? ''
        if (message === '') break
        this.#sink.emit(
          event(this.#now, 'log', { content: message, level: asLogLevel(log['level']) }),
        )
        break
      }
      case 'control_request':
        this.#handleControlRequest(parsed)
        break
      default:
        // Unknown event types are ignored rather than fatal: the CLI adds new
        // informational frames between releases and none of them are terminal.
        break
    }
  }

  #handleAssistant(msg: Record<string, unknown>): void {
    const content = asRecord(msg['message'])
    if (content === undefined) {
      // Unreadable body: the turn is NOT understood, so any earlier fallback
      // answer must be dropped rather than allowed to stand in for it.
      this.#state.lastAssistantText = ''
      return
    }

    const parentToolUseId = asString(msg['parent_tool_use_id']) ?? ''
    const id = asString(content['id']) ?? ''
    const model = asString(content['model']) ?? ''
    // A response can emit several assistant blocks with the same message id and
    // usage. Count its input/cache tokens once, without dropping any block.
    // output_tokens on an assistant frame is a placeholder — only the terminal
    // result's modelUsage has the real totals.
    if (
      parentToolUseId === '' &&
      model !== '' &&
      (id === '' || !this.#seenUsageIds.has(id))
    ) {
      const rawUsage = asRecord(content['usage'])
      if (rawUsage !== undefined) {
        const u: AgentUsage = {
          inputTokens: num(rawUsage['input_tokens'] ?? rawUsage['inputTokens']),
          outputTokens: num(rawUsage['output_tokens'] ?? rawUsage['outputTokens']),
          cacheReadTokens: num(
            rawUsage['cache_read_input_tokens'] ?? rawUsage['cacheReadInputTokens'],
          ),
          cacheWriteTokens: num(
            rawUsage['cache_creation_input_tokens'] ?? rawUsage['cacheCreationInputTokens'],
          ),
        }
        if (u.inputTokens > 0 || (u.cacheReadTokens ?? 0) > 0 || (u.cacheWriteTokens ?? 0) > 0) {
          if (id !== '') this.#seenUsageIds.add(id)
          // Accumulate per model, exactly as multica does: several messages can
          // share a model, and each contributes its own input/cache tokens.
          const prior = this.#usageByModel.get(model)
          this.#usageByModel.set(model, prior === undefined ? u : addUsage(prior, u))
        }
      }
    }

    const blocks = Array.isArray(content['content']) ? (content['content'] as unknown[]) : []
    let understood = true
    let turnText = ''
    let toolUses = 0
    for (const raw of blocks) {
      const block = asRecord(raw)
      if (block === undefined) {
        understood = false
        continue
      }
      switch (asString(block['type'])) {
        case 'text': {
          const text = asString(block['text']) ?? ''
          if (text !== '') {
            turnText += text
            this.#sink.emit(event(this.#now, 'text', { content: text }))
          }
          break
        }
        case 'thinking': {
          // Claude Code and its forks disagree on the field name: captured
          // CodeBuddy 2.137.1 frames carry `{"type":"thinking","thinking":"…"}`,
          // while multica's struct only reads `text` (and so silently drops
          // them). Both are accepted; nothing is lost either way.
          const text = asString(block['thinking']) ?? asString(block['text']) ?? ''
          if (text !== '') this.#sink.emit(event(this.#now, 'thinking', { content: text }))
          break
        }
        case 'tool_use': {
          toolUses++
          const name = asString(block['name']) ?? ''
          const callId = asString(block['id']) ?? ''
          this.#sink.emit(
            event(this.#now, 'tool_use', {
              tool: name,
              ...(callId === '' ? {} : { callId }),
              input: block['input'],
            }),
          )
          break
        }
        default:
          // A block type we do not render may be carrying the answer in a shape
          // we cannot read, so we must not claim this turn was silent.
          understood = false
          break
      }
    }
    this.#state.toolUseCount += toolUses

    // resolveFallback: a tool-invoking or unreadable turn clears the fallback;
    // a text turn replaces it; a thinking-only turn leaves it untouched.
    if (toolUses > 0 || !understood) {
      this.#state.lastAssistantText = ''
    } else if (turnText !== '') {
      this.#state.lastAssistantText = turnText
    }
  }

  #handleUser(msg: Record<string, unknown>): void {
    const content = asRecord(msg['message'])
    if (content === undefined) return
    const blocks = Array.isArray(content['content']) ? (content['content'] as unknown[]) : []
    for (const raw of blocks) {
      const block = asRecord(raw)
      if (block === undefined) continue
      if (asString(block['type']) !== 'tool_result') continue
      const callId = asString(block['tool_use_id']) ?? ''
      const rawContent = block['content']
      const output =
        typeof rawContent === 'string' ? rawContent : rawContent === undefined ? '' : JSON.stringify(rawContent)
      if (this.#dialect.detectsAsyncLaunch && claudeToolResultHasAsyncLaunch(rawContent)) {
        this.#state.sawAsyncLaunch = true
      }
      this.#sink.emit(
        event(this.#now, 'tool_result', {
          ...(callId === '' ? {} : { callId }),
          output,
        }),
      )
    }
  }

  #handleResult(msg: Record<string, unknown>): void {
    this.#state.sawResult = true
    this.#state.finalResultText = asString(msg['result']) ?? ''
    const errors = msg['errors']
    if (Array.isArray(errors)) {
      const first = errors.find((entry) => typeof entry === 'string' && entry.trim() !== '')
      this.#state.resultError = typeof first === 'string' ? first.trim() : ''
    }
    this.#state.resultIsError = msg['is_error'] === true
    this.#state.terminalReasonError = this.#dialect.readsTerminalReason
      ? claudeTerminalReasonFailure(msg['terminal_reason'], msg['result'])
      : ''
    const sessionId = asString(msg['session_id'])
    // Only overwrite with a non-empty id. Claude Code reports `session_id` as
    // early as the first `system` frame (multica's "early resume-pointer
    // pinning"), and a terminal frame that omits it must not erase what we
    // already know.
    if (sessionId !== undefined && sessionId !== '') this.#state.sessionId = sessionId

    const usage = claudeResultUsage(msg, this.#fallbackModel)
    if (usage !== undefined) {
      this.#state.usage = usage
    } else if (this.#usageByModel.size > 0) {
      let total: AgentUsage | undefined
      for (const u of this.#usageByModel.values()) {
        total = total === undefined ? u : addUsage(total, u)
      }
      this.#state.usage = total
    }

    // The terminal result is a protocol boundary for stdin: no further
    // control_request can be answered, and closing it lets the CLI exit.
    this.#stdinClosed = true
    this.#sink.closeInput()
  }

  #handleControlRequest(msg: Record<string, unknown>): void {
    // Auto-approve every tool use: the bridge runs headless, so a request that
    // waits for a human stalls the turn forever.
    const request = asRecord(msg['request'])
    const requestId = asString(msg['request_id']) ?? ''
    if (requestId === '') return
    const input = asRecord(request?.['input']) ?? {}
    // Force foreground execution: a backgrounded tool returns an
    // `async_launched` result and the run would outlive the transcript.
    if (input['run_in_background'] === true) input['run_in_background'] = false
    if (this.#stdinClosed) return
    // ONE decision object, two wire spellings — the rule lives here so a
    // dialect cannot half-implement it. `allowed` goes FIRST for codebuddy so
    // the frame reads in the Go reference's order (allowed, behavior,
    // updatedInput); claude's bytes are unchanged.
    const decision = this.#dialect.controlResponseIncludesAllowed
      ? { allowed: true, behavior: 'allow', updatedInput: input }
      : { behavior: 'allow', updatedInput: input }
    this.#sink.writeFrame(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: decision,
        },
      }) + '\n',
    )
  }
}

/**
 * `claudeToolResultHasAsyncLaunch`: recognise the `async_launched` status in a
 * tool result, in any of the shapes the CLI emits (object, object.content[],
 * or a bare array).
 */
export function claudeToolResultHasAsyncLaunch(raw: unknown): boolean {
  if (typeof raw === 'string') {
    raw = tryParseJson(raw)
  }
  const hasStatus = (value: unknown): boolean => {
    const record = asRecord(value)
    return record !== undefined && record['status'] === 'async_launched'
  }
  if (Array.isArray(raw)) return raw.some(hasStatus)
  const record = asRecord(raw)
  if (record === undefined) return false
  if (hasStatus(record)) return true
  const nested = record['content']
  return Array.isArray(nested) ? nested.some(hasStatus) : false
}

// ── Resume rejection (multica `resumeWasRejected` / `resolveSessionID`) ─────

/**
 * Provider messages that positively identify a *refused* resume, as opposed to
 * a failure that merely happened during a resumed run.
 *
 * Matching stays tight on purpose: a false positive throws away a recoverable
 * session pointer. The zh-CN phrase is the account-switch guardrail captured in
 * multica-ai/multica#5704; its en-US counterparts are inferred, and a miss
 * degrades to a diagnosable terminal failure rather than a silent mis-route.
 */
export const RESUME_REJECTED_PHRASES: readonly string[] = [
  'no conversation found', // claude: transcript named by --resume is absent
  'no saved session found', // qwen-code 0.20.0
  '已绑定另外', // claude 2.1.207 zh-CN account-binding guardrail
  'bound to another account',
  'bound to a different account',
]

export function resumeWasRejected(
  requestedResume: string,
  emitted: string,
  failed: boolean,
  texts: readonly string[],
): boolean {
  if (!failed || requestedResume === '') return false
  for (const text of texts) {
    const lower = text.toLowerCase()
    for (const phrase of RESUME_REJECTED_PHRASES) {
      if (lower.includes(phrase)) return true
    }
  }
  // The CLI answered with a different session than the one we asked to
  // continue: the requested transcript did not load.
  return emitted !== '' && emitted !== requestedResume
}

/**
 * A session known to be dead must not be persisted as the resume pointer, so a
 * rejected resume reports '' regardless of what the CLI echoed back.
 */
export function resolveBackendSessionId(
  requestedResume: string,
  emitted: string,
  failed: boolean,
  texts: readonly string[],
): string {
  if (resumeWasRejected(requestedResume, emitted, failed, texts)) return ''
  return emitted
}

// ── The shared stream-json engine ──────────────────────────────────────────

const STDERR_TAIL_BYTES = 8 * 1024

let sessionCounter = 0

function nextSessionId(family: string, at: number): string {
  sessionCounter = (sessionCounter + 1) % 1_000_000
  return `dsh-${family}-${at.toString(36)}-${sessionCounter.toString(36)}`
}

/** Options the runner resolves from the frozen `AgentRunOptions` + dialect. */
export interface StreamJsonRunConfig {
  readonly mcpConfigPath?: string
  readonly maxTurns?: number
  readonly systemPrompt?: string
}

/**
 * Run one claude-dialect conversation. Returns as soon as the child is spawned
 * and the readers are attached — never awaits the child (frozen ABI:
 * `agents_run` must not block on a minutes-long task).
 */
export async function runStreamJsonFamily(
  dialect: StreamJsonDialect,
  opts: AgentRunOptions,
  deps: DriverDeps,
  signal: AbortSignal,
  rt: DriverRuntime,
  config: StreamJsonRunConfig = {},
): Promise<AgentSessionHandle> {
  const now = rt.now ?? Date.now
  const startedAt = now()
  const label = dialect.label

  const argOptions: StreamJsonArgOptions = {
    model: opts.model,
    effort: opts.effort,
    maxTurns: config.maxTurns,
    systemPrompt: config.systemPrompt,
    resumeSessionId: opts.resumeSessionId,
    ...(config.mcpConfigPath === undefined ? {} : { mcpConfigPath: config.mcpConfigPath }),
    extraArgs: opts.extraArgs,
  }
  const args = buildStreamJsonArgs(dialect, argOptions, deps.logger)
  if (config.mcpConfigPath !== undefined && config.mcpConfigPath !== '') {
    // Appended last, after the caller's args, exactly as multica does.
    args.push('--mcp-config', config.mcpConfigPath)
  }

  const commandLine = buildCommandLine(
    {
      ...deps.command,
      // multica filters the launch prefix per family (FilterLaunchPrefix): a
      // prefix occupies the position that wins, so it must not be able to
      // re-assert a protocol flag the driver owns. Positional tokens such as a
      // profile name are never dropped.
      argsPrefix: filterLaunchPrefix(deps.command.argsPrefix, dialect.blockedArgs, deps.logger),
    },
    args,
  )
  const env = sanitizeClaudeChildEnv(deps.env)

  // Late-bound so the cancel hook can be wired before the process exists.
  let proc: SpawnedProcess | undefined
  let stdinClosed = false
  let settleCancelled: ((reason: string) => void) | undefined

  const session = new DriverSession({
    sessionId: nextSessionId(dialect.family, startedAt),
    agentId: opts.agent,
    startedAt,
    logger: deps.logger,
    onCancel: (reason) => {
      settleCancelled?.(reason)
    },
  })

  const preflight = claudeRootSudoPreflightError(args, env)
  if (preflight !== undefined) {
    // Fail as a settled session rather than throwing: the ABI's `run()` is
    // expected to hand back a handle even when the launch is refused.
    session.finish({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status: 'failed',
      exitCode: null,
      text: '',
      error: preflight,
      durationMs: 0,
    })
    return session
  }

  const parser = new ClaudeStreamParser(
    dialect,
    {
      emit: (message) => session.push(message),
      writeFrame: (frame) => writeToStdin(frame),
      closeInput: () => closeStdin(),
    },
    now,
    opts.model,
  )

  const stderrTail = { value: '' }
  let scanError: unknown
  let writeError: unknown
  let terminalReason: 'none' | 'cancelled' | 'timeout' | 'idle' = 'none'

  proc = rt.spawn({ command: commandLine.command, args: commandLine.args, cwd: opts.cwd, env })
  const child = proc

  deps.logger.debug('driver launched', {
    family: dialect.family,
    command: commandLine.command,
    args: commandLine.args.length,
    cwd: opts.cwd ?? process.cwd(),
  })

  // Attach the stdout reader BEFORE writing anything to stdin. The CLI emits a
  // startup banner before its first stdin read; a driver that writes first
  // deadlocks against it (multica claude_deadlock_test.go).
  const reader = readLines(child.stdout, (line) => parser.handleLine(line))
  child.stdout.on('error', (err: unknown) => {
    scanError = err
    reader.stop()
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    stderrTail.value = (stderrTail.value + text).slice(-STDERR_TAIL_BYTES)
  })
  // Swallow stderr/stdin errors: an unhandled 'error' event would take the
  // whole host process down when the child dies mid-write.
  child.stderr.on('error', () => {})
  child.stdin.on('error', () => {})

  function writeToStdin(text: string): void {
    if (stdinClosed || child.stdin.writableEnded === true) return
    try {
      child.stdin.write(text)
    } catch (err) {
      writeError = err
    }
  }

  function closeStdin(): void {
    if (stdinClosed) return
    stdinClosed = true
    parser.markStdinClosed()
    try {
      child.stdin.end()
    } catch {
      /* already gone */
    }
  }

  function finishOnce(result: AgentResult): void {
    if (session.result !== undefined) return
    closeStdin()
    session.finish(result)
  }

  function requestTerminal(reason: 'cancelled' | 'timeout' | 'idle', message: string): void {
    if (terminalReason !== 'none') return
    terminalReason = reason
    const status: AgentResult['status'] = reason === 'cancelled' ? 'cancelled' : 'timeout'
    finishOnce({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status,
      exitCode: null,
      text: '',
      error: message,
      durationMs: now() - startedAt,
      ...(parser.state.usage === undefined ? {} : { usage: parser.state.usage }),
    })
    void child.terminate().catch(() => {})
  }

  settleCancelled = (reason: string) => {
    requestTerminal('cancelled', reason === '' ? 'execution cancelled' : reason)
  }

  // Hard wall-clock deadline: 0/undefined means "no deadline" (multica's
  // runContext semantics), in which case only the idle watchdog applies.
  const hardTimeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : 0
  const hardTimer =
    hardTimeoutMs > 0
      ? setTimeout(() => {
          requestTerminal('timeout', `${label} timed out after ${hardTimeoutMs}ms`)
        }, hardTimeoutMs)
      : undefined

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS[dialect.family]
  let idleTimer: NodeJS.Timeout | undefined
  const touchIdle = (): void => {
    if (idleTimeoutMs <= 0 || terminalReason !== 'none') return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      requestTerminal('idle', `${label} produced no output for ${idleTimeoutMs}ms`)
    }, idleTimeoutMs)
  }
  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  child.stdout.on('data', touchIdle)
  touchIdle()

  const onAbort = (): void => {
    requestTerminal('cancelled', 'execution cancelled')
  }
  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  // Write the prompt from a background task. Awaiting it here would serialise
  // stdin against stdout and reintroduce the deadlock; the write result is only
  // consulted after the process has exited.
  const promptFrame = buildClaudeInput(opts.prompt)
  void (async () => {
    if (terminalReason !== 'none') return
    try {
      if (child.stdin.write(promptFrame) === false) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            child.stdin.off('drain', done)
            child.stdin.off('error', done)
            resolve()
          }
          child.stdin.once('drain', done)
          child.stdin.once('error', done)
        })
      }
    } catch (err) {
      writeError = err
    }
  })()

  // Settle once the process is gone AND stdout has flushed. Awaiting both is
  // what lets a trailing frame still be parsed after exit.
  void (async () => {
    const exit: ProcessExit = await child.exited.catch((err: unknown) => {
      return { code: null, signal: null, error: errorText(err) } satisfies ProcessExit
    })
    await reader.flushed

    if (hardTimer !== undefined) clearTimeout(hardTimer)
    clearIdle()
    signal.removeEventListener('abort', onAbort)

    if (terminalReason !== 'none' || session.result !== undefined) {
      // Cancel/timeout already settled the session; just make sure the group is
      // gone so no orphan survives the transcript.
      void child.terminate().catch(() => {})
      return
    }

    const state = parser.state
    const texts = [state.terminalReasonError, state.finalResultText, stderrTail.value]
    const failed = state.terminalReasonError !== '' || state.resultIsError

    let status: AgentResult['status'] = 'completed'
    let errMsg = ''
    if (state.terminalReasonError !== '') {
      status = 'failed'
      errMsg = state.terminalReasonError
    } else if (state.resultIsError) {
      status = 'failed'
      // Prefer the engine's own sentence, in descending order of authority:
      // `result` (used by claude), then `errors[]` (codebuddy / codebuddy-code),
      // then the last assistant text (the 401 sits there on workbuddy-ai).
      errMsg =
        state.finalResultText !== ''
          ? state.finalResultText
          : state.resultError !== ''
            ? state.resultError
            : state.lastAssistantText !== ''
              ? state.lastAssistantText
              : `${label} returned an error result without details`
    }
    if (status === 'completed' && scanError !== undefined) {
      status = 'failed'
      errMsg = `${label} stdout read error: ${errorText(scanError)}`
    }
    if (status === 'completed' && writeError !== undefined && state.sessionId === '') {
      status = 'failed'
      errMsg = `write ${label} input: ${errorText(writeError)}`
    }
    if (status === 'completed' && (exit.error !== undefined || (exit.code ?? 0) !== 0)) {
      status = 'failed'
      const detail =
        exit.error !== undefined
          ? exit.error
          : `exit status ${exit.code ?? 'null'}${exit.signal === null ? '' : ` (signal ${exit.signal})`}`
      errMsg = `${label} exited with error: ${detail}`
    }
    if (status === 'completed' && !state.sawResult) {
      status = 'failed'
      errMsg = `${label} stream ended without terminal result`
    }
    if (status === 'completed' && state.sawAsyncLaunch) {
      status = 'failed'
      errMsg = `${label} launched an async background task; bridge-managed runs require foreground execution`
    }    if (status !== 'completed' && stderrTail.value.trim() !== '') {
      errMsg = `${errMsg}: ${stderrTail.value.trim()}`
    }

    const backendSessionId = resolveBackendSessionId(
      opts.resumeSessionId ?? '',
      state.sessionId,
      status === 'failed',
      texts,
    )

    finishOnce({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status,
      exitCode: exit.code,
      // Failed runs always report empty text, so a partial transcript can never
      // be mistaken for a final answer.
      text: status === 'completed' ? (state.finalResultText !== '' ? state.finalResultText : state.lastAssistantText) : '',
      ...(errMsg === '' ? {} : { error: errMsg }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      durationMs: now() - startedAt,
      ...(backendSessionId === '' ? {} : { backendSessionId }),
    })
  })()

  return session
}

// ── Backend ────────────────────────────────────────────────────────────────

/**
 * `mcpConfigPath` cannot travel through the frozen `AgentRunOptions`, so the
 * driver also accepts it from the driver-owned environment namespace. Set
 * `DSH_AGENTS_BRIDGE_MCP_CONFIG` to an existing config file path to enable it;
 * the kernel needs no ABI change. (See the workstream report.)
 */
export function mcpConfigPathFromEnv(
  env: Readonly<Record<string, string>>,
): string | undefined {
  const value = env['DSH_AGENTS_BRIDGE_MCP_CONFIG']
  return value === undefined || value === '' ? undefined : value
}

export function createClaudeBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'claude',
    run: (opts, runDeps, signal) => {
      const runtime = resolveRuntime(rt)
      const mcpConfigPath = mcpConfigPathFromEnv(runDeps.env)
      return runStreamJsonFamily(CLAUDE_DIALECT, opts, runDeps, signal, runtime, {
        ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
      })
    },
  }
}
