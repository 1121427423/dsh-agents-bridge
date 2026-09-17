/**
 * dsh-agents-bridge / drivers — ZCode (the CLI bundled inside ZCode.app).
 *
 * Authoritative field notes: `docs/findings-zcode-headless.md` (2026-09-17,
 * ZCode 0.16.5, probed live on this host). Read it before touching this file;
 * the proven/inferred split below is copied from there deliberately, because
 * this dialect is NOT a Claude fork and the difference is load-bearing.
 *
 * What makes zcode its own family:
 *
 *  1. **The envelope is not claude's stream-json.** One JSON object per line:
 *     `{eventId, seq, sessionId, turnId, timestamp, traceId, type, payload}`
 *     with dotted lifecycle names (`turn.started`, `tool.call.completed`,
 *     `session.model.updated`, …) and payloads nested under `payload`
 *     [proven — captured live]. The claude runner's assumptions (message
 *     objects with `message.content[]`, a `result` terminal line, a
 *     stream-json INPUT on stdin) are all false here: there is no
 *     `--input-format`, so the prompt travels in argv and stdin is closed.
 *
 *  2. **`turn.failed` must never be inferred from silence.** Both live runs
 *     printed a `turn.failed` event and STDERR (`Error: Model creation failed
 *     (traceId: …)`) [proven]; the first of them then HUNG instead of exiting
 *     (>120s). So the terminal event itself — not EOF, not exit — is the
 *     protocol boundary, and closing the run kills the process group after a
 *     short flush grace (the openclaw lesson, applied to events instead of a
 *     blob).
 *
 *  3. **Two advertised flags do not exist.** 0.16.5's own `--help` lists
 *     `--max-turns` and selection travel, but the parser REJECTS both
 *     (`Unknown option '--max-turns'`) [proven]. The driver never passes
 *     them and blocks callers from doing so. Model selection travels in the
 *     engine's own store (`defaultModelSelection`), not argv: `opts.model`
 *     is ignored with a log line, because there is no honest way to force it
 *     headless on this build.
 *
 *  4. **The bundled CLI cannot be launched bare.** Without
 *     `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` it dies at startup with
 *     「无法定位 CLI ZCode Built-in Provider Config」 [proven]. The desktop
 *     catalog descriptor carries the variable; this driver additionally
 *     DERIVES it from the executable's own bundle when env is missing, so a
 *     relocated bundle still works instead of silently launching a broken
 *     CLI.
 *
 * The happy path is unverified BY DESIGN of the record-8 blocker (the operator
 * account has no entitled model on this host): every [proven] claim in the
 * tests is a captured line; every mapping marked [inferred] is exercised only
 * against hand-written fixtures and parses leniently — an unknown event type
 * is ignored and counted, never fatal.
 *
 * @module dsh-agents-bridge/drivers/zcode
 */

import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentRunOptions,
  BridgeLogger,
  DriverDeps,
} from '../kernel/types.ts'

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  DEFAULT_IDLE_TIMEOUT_MS,
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

/** The env var that makes the bundled CLI launchable at all [proven, §1]. */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'

/** Provider config, at its in-bundle location relative to `zcode.cjs` [proven, §1]. */
export function deriveZcodeProviderConfigFile(executable: string): string {
  return path.join(path.dirname(executable), '..', 'config', 'provider', 'zcode-builtin.json')
}

/**
 * Every token through which a caller could replace the prompt, the protocol,
 * the selection, the permission mode, or the resume selector. `--model` and
 * `--max-turns` are blocked although 0.16.5's parser rejects them: blocking
 * costs nothing and a future parser that ACCEPTS them must not silently
 * steal a run from the driver [proven divergence, §2].
 */
export const ZCODE_BLOCKED_ARGS: BlockedArgs = {
  '-p': 'withValue',
  '--prompt': 'withValue',
  '--output-format': 'withValue',
  '--json': 'standalone',
  '--resume': 'withValue',
  '-c': 'standalone',
  '--continue': 'standalone',
  '--mode': 'withValue',
  '--permission-mode': 'withValue',
  '--surface': 'withValue',
  '--cwd': 'withValue',
  '--settings': 'withValue',
  '--attach': 'withValue',
  '--model': 'withValue',
  '--max-turns': 'withValue',
  '--target': 'withValue',
  '--target-replace': 'standalone',
  '--browser-use': 'withValue',
  '--browser-executable': 'withValue',
  '--force-mcs': 'standalone',
}

/**
 * Grace between a terminal lifecycle event and the process-group kill: long
 * enough for trailing `session.*` events to flush, short enough that a CLI
 * which hangs after `turn.failed` [proven, §3] cannot hold a bridge slot.
 */
export const DEFAULT_ZCODE_TERMINAL_GRACE_MS = 2000

export function zcodeTerminalGraceFromEnv(env: Readonly<Record<string, string>>): number {
  const raw = env['DSH_AGENTS_BRIDGE_ZCODE_TERMINAL_GRACE_MS']
  if (raw === undefined || raw === '') return DEFAULT_ZCODE_TERMINAL_GRACE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ZCODE_TERMINAL_GRACE_MS
}

export interface ZcodeArgOptions {
  readonly prompt: string
  readonly resumeSessionId?: string
  readonly extraArgs?: readonly string[]
  readonly argsPrefix?: readonly string[]
}

/** Per-run argv: protocol flags first, resume, then filtered extras. */
export function buildZcodeArgs(opts: ZcodeArgOptions, logger?: BridgeLogger): string[] {
  const args = ['--prompt', opts.prompt, '--output-format', 'stream-json']
  if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== '') {
    args.push('--resume', opts.resumeSessionId)
  }
  args.push(...filterCustomArgs(opts.extraArgs, ZCODE_BLOCKED_ARGS, logger))
  return args
}

interface ZcodeParserState {
  status: AgentResult['status']
  output: string
  error: string
  /** The `sess_…` id observed on the envelope: the ONLY valid resume selector. */
  backendSessionId: string
  /** A lifecycle terminal was observed; EOF/exit no longer matters. */
  terminalSeen: 'completed' | 'failed' | undefined
  unknownEventCount: number
  sawAnyEvent: boolean
}

/**
 * Pull a human-readable string out of an error payload. Live shape [proven]:
 * `{code, message, detail, underlyingErrorMessage, type, attribution}`.
 */
function zcodeErrorText(error: unknown): string {
  const rec = asRecord(error)
  if (rec === undefined) return asString(error) ?? 'unknown error'
  const parts = [asString(rec.message), asString(rec.underlyingErrorMessage), asString(rec.detail)]
  const code = asString(rec.code)
  const message = parts.filter((p): p is string => p !== undefined && p !== '' && p !== parts[0]).join(' — ')
  const head = parts[0] ?? 'error'
  return code === undefined ? `${head}${message === '' ? '' : `: ${message}`}` : `${head} (${code}${message === '' ? '' : `: ${message}`})`
}

/**
 * The streaming text candidates for `text.delta` [inferred — the live host
 * never produced one past the record-8 selection wall]. Three spellings are
 * tried in order and the FIRST string wins; if none is a string the event is
 * ignored. When a live turn is finally observed, this is the first function to
 * be pinned against the real payload.
 */
function zcodeDeltaText(payload: Record<string, unknown>): string | undefined {
  const direct = asString(payload.text) ?? asString(payload.delta)
  if (direct !== undefined) return direct
  const content = payload.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .map((block) => asString(asRecord(block)?.text))
      .filter((t): t is string => t !== undefined && t !== '')
    if (texts.length > 0) return texts.join('')
  }
  return undefined
}

/**
 * One ZCode Protocol stream. Lenient by contract: a line that is not JSON, or
 * an envelope without a string `type`, is counted and dropped. Only the
 * [proven] terminal pair (`turn.completed` / `turn.failed`) can close a run.
 */
export class ZcodeEventParser {
  readonly #emit: (message: AgentMessage) => void
  readonly #now: () => number
  readonly #parts: string[] = []
  #toolCalls = 0

  constructor(emit: (message: AgentMessage) => void, now: () => number) {
    this.#emit = emit
    this.#now = now
  }

  readonly state: ZcodeParserState = {
    status: 'completed',
    output: '',
    error: '',
    backendSessionId: '',
    terminalSeen: undefined,
    unknownEventCount: 0,
    sawAnyEvent: false,
  }

  handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    const envelope = asRecord(tryParseJson(trimmed))
    const type = asString(envelope?.type)
    if (envelope === undefined || type === undefined) {
      this.state.unknownEventCount += 1
      return
    }
    this.state.sawAnyEvent = true
    const sessionId = asString(envelope.sessionId)
    if (sessionId !== undefined && sessionId.startsWith('sess_')) {
      this.state.backendSessionId = sessionId
    }
    const payload = asRecord(envelope.payload) ?? {}
    switch (type) {
      case 'text.delta': {
        const text = zcodeDeltaText(payload)
        if (text !== undefined) this.#parts.push(text)
        break
      }
      case 'tool.call.started': {
        this.#toolCalls += 1
        this.#emit(
          event(this.#now, 'tool_use', {
            tool: asString(payload.tool) ?? asString(payload.name) ?? `tool-${this.#toolCalls}`,
            ...(asString(payload.toolCallId) !== undefined ? { callId: asString(payload.toolCallId) } : {}),
            input: payload.input ?? payload.args,
          }),
        )
        break
      }
      case 'tool.call.completed':
      case 'tool.call.failed':
      case 'tool.permission.denied': {
        this.#emit(
          event(this.#now, 'tool_result', {
            tool: asString(payload.tool) ?? asString(payload.name),
            ...(asString(payload.toolCallId) !== undefined ? { callId: asString(payload.toolCallId) } : {}),
            output: asString(payload.output) ?? asString(payload.result),
            level: type === 'tool.call.completed' ? 'info' : 'warn',
          }),
        )
        break
      }
      case 'turn.failed': {
        this.state.status = 'failed'
        this.state.error = zcodeErrorText(payload.error ?? payload)
        this.state.terminalSeen = 'failed'
        break
      }
      case 'turn.completed': {
        this.state.terminalSeen = 'completed'
        break
      }
      default: {
        // session.*, compact.*, goal_*, plan.*, tool.updated, message.*, and
        // anything a future build adds: lifecycle detail, not the transcript.
        this.state.unknownEventCount += 1
        break
      }
    }
  }

  finish(): ZcodeParserState {
    this.state.output = this.#parts.join('')
    return this.state
  }
}

/** Launch one `--prompt` turn and adapt the event stream to the bridge ABI. */
export async function runZcode(
  opts: AgentRunOptions,
  deps: DriverDeps,
  signal: AbortSignal,
  rt: DriverRuntime,
): Promise<DriverSession> {
  const now = rt.now ?? Date.now
  const startedAt = now()
  const bridgeSessionId = randomUUID()

  if (opts.model !== undefined && opts.model !== '') {
    // 0.16.5 rejects `--model` outright [proven §2]; selection lives in the
    // engine's own defaultModelSelection store. Say so instead of lying.
    deps.logger.info('zcode: ignoring model selector — the CLI has no --model; set the engine default (findings §4)', {
      requested: opts.model,
    })
  }

  const commandLine = buildCommandLine(
    {
      ...deps.command,
      argsPrefix: filterLaunchPrefix(deps.command.argsPrefix, ZCODE_BLOCKED_ARGS, deps.logger),
    },
    buildZcodeArgs(
      {
        prompt: opts.prompt,
        ...(opts.resumeSessionId === undefined ? {} : { resumeSessionId: opts.resumeSessionId }),
        ...(opts.extraArgs === undefined ? {} : { extraArgs: opts.extraArgs }),
        argsPrefix: [],
      },
      deps.logger,
    ),
  )

  // The bundled CLI is unlaunchable without the provider-config env [proven
  // §1]. The catalog descriptor carries it; derive it from the executable when
  // a relocated bundle (or a settings override) dropped that env instead.
  const env: Record<string, string> = { ...deps.env }
  if (env[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV] === undefined || env[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV] === '') {
    env[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV] = deriveZcodeProviderConfigFile(deps.command.executable)
  }

  let settleCancelled: (reason: string) => void = () => {}
  const session = new DriverSession({
    sessionId: bridgeSessionId,
    agentId: opts.agent,
    startedAt,
    logger: deps.logger,
    onCancel: (reason) => settleCancelled(reason),
  })

  const parser = new ZcodeEventParser((m) => session.push(m), now)
  const stderrTail = { value: '' }
  let terminalReason: 'none' | 'cancelled' | 'timeout' | 'idle' | 'overflow' = 'none'
  let hardTimer: NodeJS.Timeout | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let boundaryArmed = false

  const child: SpawnedProcess = rt.spawn({
    command: commandLine.command,
    args: commandLine.args,
    cwd: opts.cwd,
    env,
  })
  // ABI v6: hand the kernel the pid it persists for the post-restart reap (IM-4).
  session.attachProcess(child.pid)

  deps.logger.debug('driver launched', {
    family: 'zcode',
    command: commandLine.command,
    args: commandLine.args.length,
  })

  // The prompt travels in argv; nothing reads stdin. Close it instead of
  // leaving a pipe the child could block on.
  try {
    child.stdin.end()
  } catch {
    /* already gone */
  }

  function clearTimers(): void {
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    graceTimer = undefined
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
      sessionId: bridgeSessionId,
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

  /**
   * A lifecycle terminal IS the protocol boundary. The engine may or may not
   * exit afterwards [first live run: hung >120s after turn.failed, proven];
   * waiting on that is how a bridge slot dies. Flush grace → kill group.
   */
  function armTerminalBoundary(): void {
    if (boundaryArmed || terminalReason !== 'none') return
    boundaryArmed = true
    const settle = (): void => {
      if (session.result !== undefined) return
      const state = parser.finish()
      reader.stop()
      void child.terminate().catch(() => {})
      finishOnce({
        sessionId: bridgeSessionId,
        agentId: opts.agent,
        status: state.status,
        exitCode: null,
        // Failed runs report no text so a partial transcript cannot be
        // mistaken for an answer (openclaw doctrine).
        text: state.status === 'completed' ? state.output : '',
        ...(state.error === '' ? {} : { error: state.error }),
        durationMs: now() - startedAt,
        ...(state.backendSessionId === '' ? {} : { backendSessionId: state.backendSessionId }),
      })
    }
    const grace = zcodeTerminalGraceFromEnv(deps.env)
    if (grace <= 0) settle()
    else graceTimer = setTimeout(settle, grace)
  }

  const reader = readLines(
    child.stdout,
    (line) => {
      parser.handleLine(line)
      // ABI v6: publish the backend session id as soon as a frame names it (IM-5).
      session.pinBackendSessionId(parser.state.backendSessionId)
      if (parser.state.terminalSeen !== undefined) armTerminalBoundary()
    },
    {
      // A stream that never emits a newline would grow this reader's buffer in
      // the host process; fail loudly and kill the group instead (MI-4).
      onOverflow: (overflow) => requestTerminal('overflow', overflow.message),
    },
  )
  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    stderrTail.value = (stderrTail.value + text).slice(-8 * 1024)
  })
  child.stderr.on('error', () => {})
  child.stdin.on('error', () => {})

  const hardTimeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : 0
  if (hardTimeoutMs > 0) {
    hardTimer = setTimeout(() => {
      requestTerminal('timeout', `zcode timed out after ${hardTimeoutMs}ms`)
    }, hardTimeoutMs)
  }

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS.zcode
  const touchIdle = (): void => {
    if (idleTimeoutMs <= 0 || terminalReason !== 'none') return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      requestTerminal('idle', `zcode produced no output for ${idleTimeoutMs}ms`)
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

    if (state.terminalSeen !== undefined) {
      // Terminal arrived but the grace timer lost the race with exit; settle
      // from the same boundary logic.
      finishAtExitWithTerminal(state, exit)
      return
    }

    // No lifecycle terminal. A silent early exit — typically the startup
    // provider-config failure — must read as the configuration problem it is.
    if (state.sawAnyEvent) {
      status = 'failed'
      if (errMsg === '') errMsg = 'zcode stream ended without a terminal event (turn.completed/turn.failed)'
    } else {
      status = 'failed'
      const hint =
        `zcode produced no protocol events${exit.error !== undefined ? `: ${exit.error}` : ''}. ` +
        `If the engine did not launch, ensure ${ZCODE_BUILTIN_PROVIDER_CONFIG_ENV} points at the bundle's ` +
        'config/provider/zcode-builtin.json (docs/findings-zcode-headless.md §1)'
      errMsg = stderrTail.value.trim() === '' ? hint : `${hint}; stderr: ${stderrTail.value.trim()}`
    }

    finishOnce({
      sessionId: bridgeSessionId,
      agentId: opts.agent,
      status,
      exitCode: exit.code,
      // Every path reaching here is a failure (a real terminal was handled by
      // the boundary settle): a partial transcript never reports as an answer.
      text: '',
      ...(errMsg === '' ? {} : { error: errMsg }),
      durationMs: now() - startedAt,
      ...(state.backendSessionId === '' ? {} : { backendSessionId: state.backendSessionId }),
    })
  })()

  function finishAtExitWithTerminal(state: ZcodeParserState, exit: ProcessExit): void {
    finishOnce({
      sessionId: bridgeSessionId,
      agentId: opts.agent,
      status: state.status,
      exitCode: exit.code,
      text: state.status === 'completed' ? state.output : '',
      ...(state.error === '' ? {} : { error: state.error }),
      durationMs: now() - startedAt,
      ...(state.backendSessionId === '' ? {} : { backendSessionId: state.backendSessionId }),
    })
  }

  return session
}

export function createZcodeBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'zcode',
    run: (opts, runDeps, signal) => runZcode(opts, runDeps, signal, resolveRuntime(rt)),
  }
}
