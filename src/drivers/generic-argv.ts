/**
 * dsh-agents-bridge / drivers — the one-shot argv fallback.
 *
 * Authoritative spec: multica `server/pkg/agent/qwen.go` — the canonical
 * "one-shot CLI, prompt on stdin" adapter. Its reasoning applies verbatim here
 * and is the reason this driver exists in this shape:
 *
 *   *The prompt is deliberately NOT part of argv. […] putting the (arbitrarily
 *   large, user-influenced) prompt text on the command line is not safe on
 *   Windows: PowerShell's own argument re-serialisation does not survive a value
 *   containing embedded double quotes (multica #6082/#5649).*
 *
 * So: fixed, content-free flags in argv, the prompt on stdin, `TestQwen-
 * BackendDeliversPromptOnStdin` as the contract (the prompt reaches the child
 * byte-for-byte, including quotes and em dashes).
 *
 * **This driver does not guess a dialect.** stdout is not JSON-decoded, not
 * line-classified, not searched for events: whatever the CLI printed becomes
 * the run's text, untouched apart from a surrounding-whitespace trim. A
 * long-tail CLI that speaks a real dialect deserves its own driver (or the ACP
 * driver in P4), not a heuristic here. That is also why there is no partial
 * streaming: with no protocol there is no honest event boundary, so the
 * transcript gets one terminal `text` event.
 *
 * Caller-supplied fixed flags belong in `CommandSpec.argsPrefix` (the identity
 * descriptor's job) — e.g. `['--output-format', 'stream-json', '--yolo']` for a
 * qwen-like CLI. They are filtered against the same blocked table as per-run
 * extra args, so a prefix cannot smuggle back a protocol flag the driver owns.
 *
 * `--resume` support is configurable because long-tail CLIs disagree on it:
 * set `DSH_AGENTS_BRIDGE_GENERIC_RESUME_FLAG` to the flag to use (default
 * `--resume`), or to the empty string to declare the CLI has no resume.
 *
 * @module dsh-agents-bridge/drivers/generic-argv
 */

import type {
  AgentBackend,
  AgentResult,
  AgentRunOptions,
  AgentSessionHandle,
  BridgeLogger,
  DriverDeps,
} from '../kernel/types.ts'

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DriverSession,
  buildCommandLine,
  errorText,
  event,
  filterCustomArgs,
  filterLaunchPrefix,
  readLines,
  resolveRuntime,
  type BlockedArgs,
  type DriverRuntime,
  type ProcessExit,
} from './argv.ts'

/**
 * `qwenBlockedArgs` (qwen.go:28), the authoritative one-shot blocklist: every
 * flag through which the caller could replace the prompt, the stream protocol,
 * the model/session selection, or the non-interactive permission mode.
 */
export const GENERIC_BLOCKED_ARGS: BlockedArgs = {
  '-p': 'withValue',
  '--prompt': 'withValue',
  '-i': 'withValue',
  '--prompt-interactive': 'withValue',
  '-o': 'withValue',
  '--output-format': 'withValue',
  '-m': 'withValue',
  '--model': 'withValue',
  '-r': 'withValue',
  '--resume': 'withValue',
  '-c': 'standalone',
  '--continue': 'standalone',
  '--chat-recording': 'withValue',
  '--mcp-config': 'withValue',
  '--safe-mode': 'standalone',
  '--yolo': 'standalone',
  '-y': 'standalone',
  '--approval-mode': 'withValue',
  '--core-tools': 'withValue',
}

/** Default resume flag; env-overridable per identity. */
export const DEFAULT_GENERIC_RESUME_FLAG = '--resume'

const STDERR_TAIL_BYTES = 8 * 1024

export interface GenericArgOptions {
  readonly model?: string
  readonly resumeSessionId?: string
  readonly extraArgs?: readonly string[]
  /** Fixed flags from `CommandSpec.argsPrefix`, filtered like the rest. */
  readonly argsPrefix?: readonly string[]
  readonly resumeFlag?: string
}

/**
 * Per-run argv. Deliberately tiny: the caller's `argsPrefix` supplies whatever
 * the specific CLI needs, the driver supplies only the flags it manages.
 */
export function buildGenericArgs(opts: GenericArgOptions, logger?: BridgeLogger): string[] {
  const args = filterLaunchPrefix(opts.argsPrefix, GENERIC_BLOCKED_ARGS, logger)
  if (opts.model !== undefined && opts.model !== '') {
    args.push('--model', opts.model)
  }
  const resumeFlag =
    opts.resumeFlag === undefined ? DEFAULT_GENERIC_RESUME_FLAG : opts.resumeFlag
  if (resumeFlag !== '' && opts.resumeSessionId !== undefined && opts.resumeSessionId !== '') {
    args.push(resumeFlag, opts.resumeSessionId)
  }
  args.push(...filterCustomArgs(opts.extraArgs, GENERIC_BLOCKED_ARGS, logger))
  return args
}

/** Resume flag for one identity, from the driver-owned env namespace. */
export function genericResumeFlagFromEnv(env: Readonly<Record<string, string>>): string {
  const raw = env['DSH_AGENTS_BRIDGE_GENERIC_RESUME_FLAG']
  return raw === undefined ? DEFAULT_GENERIC_RESUME_FLAG : raw
}

let sessionCounter = 0

function nextSessionId(at: number): string {
  sessionCounter = (sessionCounter + 1) % 1_000_000
  return `dsh-generic-${at.toString(36)}-${sessionCounter.toString(36)}`
}

/**
 * Run one one-shot CLI conversation. Returns as soon as the child is spawned;
 * the prompt is written to stdin in the background and stdout is buffered in
 * full, exactly like multica's qwen adapter.
 */
export async function runGeneric(
  opts: AgentRunOptions,
  deps: DriverDeps,
  signal: AbortSignal,
  rt: DriverRuntime,
): Promise<AgentSessionHandle> {
  const now = rt.now ?? Date.now
  const startedAt = now()
  const sessionId = nextSessionId(startedAt)

  const args = buildGenericArgs(
    {
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
      extraArgs: opts.extraArgs,
      argsPrefix: deps.command.argsPrefix,
      resumeFlag: genericResumeFlagFromEnv(deps.env),
    },
    deps.logger,
  )
  const commandLine = buildCommandLine({ ...deps.command, argsPrefix: [] }, args)

  let settleCancelled: (reason: string) => void = () => {}

  const session = new DriverSession({
    sessionId,
    agentId: opts.agent,
    startedAt,
    logger: deps.logger,
    onCancel: (reason) => settleCancelled(reason),
  })

  const chunks: string[] = []
  const stderrTail = { value: '' }
  let terminalReason: 'none' | 'cancelled' | 'timeout' | 'idle' = 'none'
  let writeError: unknown
  let hardTimer: NodeJS.Timeout | undefined
  let idleTimer: NodeJS.Timeout | undefined

  const child = rt.spawn({
    command: commandLine.command,
    args: commandLine.args,
    cwd: opts.cwd,
    env: deps.env,
  })

  deps.logger.debug('driver launched', {
    family: 'generic',
    command: commandLine.command,
    args: commandLine.args.length,
  })

  function clearTimers(): void {
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    hardTimer = undefined
    idleTimer = undefined
  }

  function finishOnce(result: AgentResult): void {
    if (session.result !== undefined) return
    clearTimers()
    session.finish(result)
  }

  function requestTerminal(reason: 'cancelled' | 'timeout' | 'idle', message: string): void {
    if (terminalReason !== 'none') return
    terminalReason = reason
    finishOnce({
      sessionId,
      agentId: opts.agent,
      status: reason === 'cancelled' ? 'cancelled' : 'timeout',
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

  // Attach the stdout reader before the prompt write, for the same reason as
  // the claude driver: a CLI that prints a banner first would otherwise block
  // on a full stdout pipe while we block writing stdin.
  const reader = readLines(child.stdout, (line) => {
    chunks.push(line)
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    stderrTail.value = (stderrTail.value + text).slice(-STDERR_TAIL_BYTES)
  })
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  child.stdin.on('error', () => {})

  // The prompt is written raw — not JSON-wrapped, not newline-terminated — so
  // the child receives exactly the bytes the caller supplied.
  void (async () => {
    try {
      if (child.stdin.write(opts.prompt) === false) {
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
      child.stdin.end()
    } catch (err) {
      writeError = err
    }
  })()

  const hardTimeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : 0
  if (hardTimeoutMs > 0) {
    hardTimer = setTimeout(() => {
      requestTerminal('timeout', `generic agent timed out after ${hardTimeoutMs}ms`)
    }, hardTimeoutMs)
  }

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS.generic
  const touchIdle = (): void => {
    if (idleTimeoutMs <= 0 || terminalReason !== 'none') return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      requestTerminal('idle', `generic agent produced no output for ${idleTimeoutMs}ms`)
    }, idleTimeoutMs)
  }
  child.stdout.on('data', touchIdle)
  touchIdle()

  const onAbort = (): void => requestTerminal('cancelled', 'execution cancelled')
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

    signal.removeEventListener('abort', onAbort)

    // stdout verbatim (trimmed), no dialect inference whatsoever.
    const text = chunks.join('\n').trim()

    let status: AgentResult['status'] = 'completed'
    let errMsg = ''
    if (exit.error !== undefined) {
      status = 'failed'
      errMsg = `generic agent failed to start: ${exit.error}`
    } else if ((exit.code ?? 0) !== 0) {
      status = 'failed'
      errMsg = `generic agent exited with error: exit status ${exit.code ?? 'null'}`
    } else if (writeError !== undefined && text === '') {
      status = 'failed'
      errMsg = `write generic agent input: ${errorText(writeError)}`
    }
    if (status === 'failed' && stderrTail.value.trim() !== '') {
      errMsg = `${errMsg}: ${stderrTail.value.trim()}`
    }

    if (status === 'completed' && text !== '') {
      // One terminal text event: with no protocol there is no honest
      // intermediate boundary to stream on.
      session.push(event(now, 'text', { content: text }))
    }

    finishOnce({
      sessionId,
      agentId: opts.agent,
      status,
      exitCode: exit.code,
      text: status === 'completed' ? text : '',
      ...(errMsg === '' ? {} : { error: errMsg }),
      durationMs: now() - startedAt,
      ...(opts.resumeSessionId === undefined || status === 'failed'
        ? {}
        : { backendSessionId: opts.resumeSessionId }),
    })
  })()

  return session
}

export function createGenericBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'generic',
    run: (opts, runDeps, signal) => runGeneric(opts, runDeps, signal, resolveRuntime(rt)),
  }
}
