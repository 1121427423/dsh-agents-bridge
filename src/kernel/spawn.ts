/**
 * Detached process-group spawn with line-oriented output and three-stage
 * cancellation.
 *
 * Why a process group: agent CLIs fork helpers (node workers, MCP servers,
 * shell tool calls). Killing only the direct child orphans them and leaves the
 * machine with runaway descendants — multica pins this with
 * `TestRuntimeCommandCancellationKillsDescendants`. `detached: true` puts the
 * child in its own group whose pgid equals its pid, so `process.kill(-pid, …)`
 * reaches the whole tree.
 *
 * @module dsh-agents-bridge/kernel/spawn
 */

import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

import type { BridgeLogger, CommandSpec } from './types.ts'
import { redactArgs } from './logger.ts'

/** SIGTERM → grace → SIGKILL window (multica's `claudeTerminateGrace`). */
export const DEFAULT_GRACE_MS = 5_000
/** How long we wait for the group to die after SIGKILL before giving up. */
const KILL_CONFIRM_MS = 2_000

export interface SpawnRequest {
  readonly command: CommandSpec
  /** Per-run arguments appended after `argsPrefix`. */
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly logger?: BridgeLogger
  readonly onStdoutLine?: (line: string) => void
  readonly onStderrLine?: (line: string) => void
  /** Grace between SIGTERM and SIGKILL; default {@link DEFAULT_GRACE_MS}. */
  readonly graceMs?: number
  /** Keep stdin open so a driver can answer `control_request`s; default true. */
  readonly stdin?: boolean
  /** Abort ⇒ same three-stage cancel. */
  readonly signal?: AbortSignal
}

export interface SpawnExit {
  readonly code: number | null
  /** Non-null when the child died from a signal (`exitCode` is then null). */
  readonly signal: NodeJS.Signals | null
  /** Spawn failure (ENOENT, EACCES) — the process never ran. */
  readonly error?: Error
}

export interface SpawnHandle {
  readonly pid: number | undefined
  /** Writable stdin, or null when stdio was ignored / the spawn failed. */
  readonly stdin: NodeJS.WritableStream | null
  /** Settles exactly once, at the first terminal observation. */
  readonly exited: Promise<SpawnExit>
  /** Idempotent. SIGTERM → grace → SIGKILL on the whole process group. */
  cancel(reason?: string): Promise<void>
  /** Raw signal to the process group (no escalation). */
  signal(sig: NodeJS.Signals): void
  /** Terminal observation when already settled. */
  readonly exit: SpawnExit | undefined
}

/**
 * `[interpreter, executable, ...argsPrefix, ...args]`, or
 * `[executable, ...argsPrefix, ...args]` when no interpreter is needed.
 */
export function buildArgv(command: CommandSpec, args: readonly string[] = []): string[] {
  const head = command.interpreter ? [command.interpreter, command.executable] : [command.executable]
  return [...head, ...(command.argsPrefix ?? []), ...args]
}

/**
 * Incremental `\n` splitter. Implemented locally instead of with
 * `node:readline` so the trailing partial line and CRLF handling are explicit
 * and unit-testable without a stream.
 */
export class LineSplitter {
  #buffer = ''

  push(chunk: string | Buffer): string[] {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const lines: string[] = []
    for (;;) {
      const index = this.#buffer.indexOf('\n')
      if (index === -1) break
      lines.push(stripCr(this.#buffer.slice(0, index)))
      this.#buffer = this.#buffer.slice(index + 1)
    }
    return lines
  }

  /** Emit whatever is left after the stream ended (a last line without `\n`). */
  flush(): string[] {
    if (this.#buffer === '') return []
    const line = stripCr(this.#buffer)
    this.#buffer = ''
    return [line]
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Spawn one engine in its own process group.
 *
 * Never throws: a synchronous `spawn()` failure (bad argv, invalid cwd type) is
 * normalized into an already-settled handle whose `exited` carries the error,
 * so a driver only has to handle one failure shape.
 */
export function spawnDetached(request: SpawnRequest): SpawnHandle {
  const graceMs = request.graceMs ?? DEFAULT_GRACE_MS
  const command = request.command
  const argv = buildArgv(command, request.args ?? [])
  const logger = request.logger

  logger?.debug('spawning agent process', {
    argv: redactArgs(argv),
    cwd: request.cwd,
  })

  let child: ChildProcess | undefined
  let syncError: Error | undefined
  try {
    const options: SpawnOptions = {
      detached: true,
      // `env` is passed verbatim: the manager already merged host + descriptor env.
      env: { ...request.env },
      stdio: [request.stdin === false ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }
    if (request.cwd !== undefined) options.cwd = request.cwd
    child = nodeSpawn(argv[0] ?? '', argv.slice(1), options)
  } catch (err) {
    syncError = toError(err)
    logger?.error('spawn threw synchronously', { error: syncError.message })
  }

  let exit: SpawnExit | undefined
  let settle: (value: SpawnExit) => void = () => {}
  const exited = new Promise<SpawnExit>((resolve) => {
    settle = (value) => {
      if (exit !== undefined) return
      exit = value
      resolve(value)
    }
  })

  let cancelPromise: Promise<void> | undefined
  let abortListener: (() => void) | undefined

  if (syncError !== undefined) {
    settle({ code: null, signal: null, error: syncError })
  } else if (child) {
    const spawned = child
    let spawnError: Error | undefined

    pipeLines(spawned.stdout, request.onStdoutLine, logger, 'stdout')
    pipeLines(spawned.stderr, request.onStderrLine, logger, 'stderr')

    spawned.on('error', (err) => {
      spawnError = toError(err)
      logger?.error('agent process failed to start', { error: spawnError.message })
      // `close` may or may not follow an `error`; settle now so callers never hang.
      settle({ code: null, signal: null, error: spawnError })
    })
    spawned.on('close', (code, signal) => {
      const value: SpawnExit = {
        code,
        signal: signal ?? null,
        ...(spawnError !== undefined ? { error: spawnError } : {}),
      }
      if (code !== 0 && spawnError === undefined) {
        logger?.debug('agent process exited', { code, signal: signal ?? null })
      }
      settle(value)
    })

    if (request.signal) {
      const signal = request.signal
      if (signal.aborted) {
        void cancel('aborted before start')
      } else {
        abortListener = () => {
          void cancel('aborted')
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }
    }
  }

  function sendSignal(sig: NodeJS.Signals): void {
    if (syncError !== undefined) return
    const pid = child?.pid
    if (pid === undefined) return
    try {
      // Negative pid = the whole group (pid is its pgid because of detached).
      process.kill(-pid, sig)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return // already gone: nothing to signal
      // Not a process group we can address (e.g. Windows, or the group is gone
      // but the child lingers): fall back to the direct child.
      try {
        child?.kill(sig)
      } catch (fallbackErr) {
        const fallbackCode = (fallbackErr as NodeJS.ErrnoException).code
        if (fallbackCode !== 'ESRCH') {
          logger?.warn('failed to signal agent process', {
            pid,
            signal: sig,
            error: toError(fallbackErr).message,
          })
        }
      }
    }
  }

  async function cancel(reason?: string): Promise<void> {
    if (cancelPromise) return cancelPromise
    cancelPromise = (async () => {
      if (request.signal && abortListener) {
        request.signal.removeEventListener('abort', abortListener)
        abortListener = undefined
      }
      if (exit !== undefined) return
      const pid = child?.pid
      if (pid === undefined) {
        // Synchronous spawn failure, or the process never produced a pid.
        return
      }
      logger?.info('cancelling agent process group', { pid, reason })
      sendSignal('SIGTERM')
      if (await settledWithin(exited, graceMs)) return
      logger?.warn('grace window expired; killing process group', { pid, graceMs })
      sendSignal('SIGKILL')
      await settledWithin(exited, KILL_CONFIRM_MS)
    })()
    return cancelPromise
  }

  return {
    get pid() {
      return child?.pid
    },
    get stdin() {
      return (child?.stdin as NodeJS.WritableStream | null | undefined) ?? null
    },
    exited,
    cancel,
    signal: sendSignal,
    get exit() {
      return exit
    },
  }
}

/** Resolves true when `promise` settles before `ms` elapses. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (value: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    promise.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

function pipeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  emit: ((line: string) => void) | undefined,
  logger: BridgeLogger | undefined,
  label: 'stdout' | 'stderr',
): void {
  if (!stream || !emit) return
  const splitter = new LineSplitter()
  const deliver = (lines: readonly string[]): void => {
    for (const line of lines) {
      try {
        emit(line)
      } catch (err) {
        // A driver parse bug must not take down the bridge process.
        logger?.error('line handler threw', { stream: label, error: toError(err).message })
      }
    }
  }
  stream.on('data', (chunk: Buffer | string) => deliver(splitter.push(chunk)))
  stream.on('end', () => deliver(splitter.flush()))
  stream.on('error', () => deliver(splitter.flush()))
}
