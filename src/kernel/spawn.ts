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

import { spawn as nodeSpawn, execFileSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

import type { BridgeLogger, CommandSpec } from './types.ts'
import { buildCommandLine } from './command-line.ts'
import { redactArgs } from './logger.ts'

/** SIGTERM → grace → SIGKILL window (multica's `claudeTerminateGrace`). */
export const DEFAULT_GRACE_MS = 5_000
/** How long we wait for the group to die after SIGKILL before giving up. */
const KILL_CONFIRM_MS = 2_000
/**
 * How long `exited` keeps waiting for stdout/stderr to finish draining after the
 * child itself has exited.
 *
 * A descendant that inherited the pipe (a helper the agent CLI forked) keeps
 * Node's `close` event from firing even though the child we spawned is dead.
 * Waiting for `close` alone therefore deferred settlement indefinitely; the
 * bounded drain gives real trailing output a chance to arrive and then settles
 * on the `exit` observation rather than hanging. `close` still wins whenever it
 * arrives first, so the common case is unchanged.
 */
export const POST_EXIT_DRAIN_MS = 300
/**
 * Upper bound on the caller-supplied grace window.
 *
 * `graceMs` is model/host configuration, so it is validated rather than
 * trusted: a negative or non-finite value would make `setTimeout` fire
 * immediately (skipping the graceful attempt entirely) and an absurd value
 * would pin a cancel for hours. `0` is legal and means "skip straight to
 * SIGKILL" — useful in tests, pointless in production.
 */
const MAX_GRACE_MS = 60_000

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
 *
 * A delegate, deliberately: the rule has ONE implementation
 * (`kernel/command-line.ts`) and this is the kernel-side spelling of it, kept
 * because `tests/integration/argv-shape.test.ts` and `tests/kernel/spawn.test.ts`
 * assert on the vector the OS actually receives. If this body ever grows an
 * `if (command.interpreter)` again, the probe and the run path can drift apart —
 * which is exactly the bug in `docs/findings-node-shim.md`.
 */
export function buildArgv(command: CommandSpec, args: readonly string[] = []): string[] {
  const line = buildCommandLine(command, args)
  return [line.command, ...line.args]
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

function errorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** Normalized, bounded grace window (see {@link MAX_GRACE_MS}). */
function coerceGrace(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_GRACE_MS
  return Math.min(Math.floor(value), MAX_GRACE_MS)
}

/** True when no process (or group) with that pid exists any more. */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    // EPERM means "exists, owned by someone else" — alive for our purposes.
    return errorCode(err) === 'ESRCH'
  }
}

/**
 * Signal the whole process GROUP led by `pid`, falling back to the pid itself.
 *
 * `detached: true` makes the child a group leader, so `process.kill(-pid, sig)`
 * reaches its descendants. ESRCH means the group is already gone (not an error);
 * EPERM means "exists but the group is not addressable", where the direct pid is
 * still worth a try. Shared by the live cancel path and the orphan reaper so the
 * two cannot drift on which errors mean "gone".
 *
 * @returns true when a signal was delivered to something.
 */
export function signalProcessGroup(
  pid: number,
  sig: NodeJS.Signals,
  logger?: BridgeLogger,
): boolean {
  try {
    // Negative pid = the whole group (pid is its pgid because of detached).
    process.kill(-pid, sig)
    return true
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ESRCH') return false
    if (code !== 'EPERM') {
      logger?.debug('process-group signal rejected; falling back to the pid', {
        pid,
        signal: sig,
        code,
      })
    }
    try {
      process.kill(pid, sig)
      return true
    } catch (fallbackErr) {
      const fallbackCode = errorCode(fallbackErr)
      if (fallbackCode !== 'ESRCH') {
        logger?.warn('failed to signal agent process', {
          pid,
          signal: sig,
          error: toError(fallbackErr).message,
        })
      }
      return false
    }
  }
}

/**
 * Epoch ms when `pid` started, or `undefined` when it is gone or unreadable.
 *
 * Used to guard the post-restart reap against PID REUSE: a pid is only a stable
 * identity together with the moment its process started, so a recovered row is
 * killed only when the live process really is the one we spawned. `ps -o
 * lstart=` is the one spelling that works on both macOS and Linux (GNU's
 * `etimes` does not exist in the BSD userland macOS ships).
 */
export function processStartTimeMs(pid: number): number | undefined {
  let text: string
  try {
    text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // A vanished pid, a permission error, or a missing `ps` all mean "cannot
    // establish identity" — never kill on a guess.
    return undefined
  }
  if (text === '') return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * SIGKILL the process group led by `pid`. Best effort; never throws.
 *
 * @returns true when a signal was delivered.
 */
export function killProcessGroup(pid: number, logger?: BridgeLogger): boolean {
  return signalProcessGroup(pid, 'SIGKILL', logger)
}

/**
 * The two OS facts the post-restart orphan reap needs, behind one seam so a
 * manager test can observe the kill without a real orphan process.
 */
export interface ProcessReaper {
  /** Epoch ms when `pid` started, or `undefined` when it is gone/unreadable. */
  startTimeMs(pid: number): number | undefined
  /** SIGKILL the process group led by `pid`. Returns true when delivered. */
  killGroup(pid: number): boolean
}

/** The real OS reaper; see {@link processStartTimeMs} / {@link killProcessGroup}. */
export function createProcessReaper(logger?: BridgeLogger): ProcessReaper {
  return {
    startTimeMs: (pid) => processStartTimeMs(pid),
    killGroup: (pid) => killProcessGroup(pid, logger),
  }
}

/**
 * Spawn one engine in its own process group.
 *
 * Never throws: a synchronous `spawn()` failure (bad argv, invalid cwd type) is
 * normalized into an already-settled handle whose `exited` carries the error,
 * so a driver only has to handle one failure shape.
 */
export function spawnDetached(request: SpawnRequest): SpawnHandle {
  const graceMs = coerceGrace(request.graceMs)
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
  let settle: (value: SpawnExit, flush?: () => void) => void = () => {}
  const exited = new Promise<SpawnExit>((resolve) => {
    settle = (value, flush) => {
      if (exit !== undefined) return
      exit = value
      // Release the abort listener at settle. It used to be removed only inside
      // `cancel()`, so a run that ended on its own left the listener attached to
      // the AbortController — keeping the spawn closure (and the dead child)
      // reachable for as long as the session record lived (IM-7 lifecycle).
      if (abortListener !== undefined && request.signal !== undefined) {
        request.signal.removeEventListener('abort', abortListener)
        abortListener = undefined
      }
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer)
        drainTimer = undefined
      }
      try {
        flush?.()
      } catch (err) {
        logger?.error('failed to flush trailing output', { error: toError(err).message })
      }
      resolve(value)
    }
  })

  let cancelPromise: Promise<void> | undefined
  let abortListener: (() => void) | undefined
  let drainTimer: NodeJS.Timeout | undefined
  let exitObservation: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined

  if (syncError !== undefined) {
    settle({ code: null, signal: null, error: syncError })
  } else if (child) {
    const spawned = child
    let spawnError: Error | undefined

    const flushStdout = pipeLines(spawned.stdout, request.onStdoutLine, logger, 'stdout')
    const flushStderr = pipeLines(spawned.stderr, request.onStderrLine, logger, 'stderr')

    spawned.on('error', (err) => {
      spawnError = toError(err)
      logger?.error('agent process failed to start', { error: spawnError.message })
      // `close` may or may not follow an `error`; settle now so callers never hang.
      // No flush here: the streams have not ended, so flushing would split a line.
      settle({ code: null, signal: null, error: spawnError })
    })
    // `exit` fires when the CHILD is gone; `close` only after every stdio pipe it
    // created is closed. A descendant that inherited the pipe keeps `close` from
    // ever arriving, which used to defer `exited` for as long as that descendant
    // lived. Settle on whichever comes first: `close`, or `exit` plus a bounded
    // drain window for real trailing output.
    spawned.on('exit', (code, signal) => {
      exitObservation = { code, signal: signal ?? null }
      if (drainTimer !== undefined) return
      drainTimer = setTimeout(() => {
        drainTimer = undefined
        const observed = exitObservation ?? { code: null, signal: null }
        settle(
          {
            code: observed.code,
            signal: observed.signal,
            ...(spawnError !== undefined ? { error: spawnError } : {}),
          },
          () => {
            flushStdout()
            flushStderr()
          },
        )
      }, POST_EXIT_DRAIN_MS)
      // The drain window must not keep a plugin host alive on its own.
      drainTimer.unref?.()
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
      // On `close` the streams have definitely ended, so the splitters already
      // flushed; flushing again is a harmless no-op.
      settle(value, () => {
        flushStdout()
        flushStderr()
      })
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
    // One implementation of "signal the group, fall back to the pid, treat
    // ESRCH as gone" (shared with the orphan reaper).
    signalProcessGroup(pid, sig, logger)
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

/**
 * Attach the line splitter to one stream.
 *
 * @returns a flush function that emits any trailing partial line. `settle()`
 *   calls it so output that arrived just before the child died is delivered
 *   even when `close` never fires (a descendant holds the pipe) and the stream
 *   therefore never emits `end`.
 */
function pipeLines(
  stream: NodeJS.ReadableStream | null | undefined,
  emit: ((line: string) => void) | undefined,
  logger: BridgeLogger | undefined,
  label: 'stdout' | 'stderr',
): () => void {
  if (!stream || !emit) return () => {}
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
  return () => deliver(splitter.flush())
}
