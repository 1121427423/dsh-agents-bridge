/**
 * Integration seam between the kernel's process factory and the driver-facing
 * `DriverRuntime` contract.
 *
 * Why this file exists: the two parallel workstreams settled on shapes that do
 * not line up one-to-one.
 *
 * | kernel `spawnDetached`                     | drivers `SpawnFn`                        |
 * | ------------------------------------------ | ---------------------------------------- |
 * | takes `CommandSpec` + `args`                | takes a flat `{ command, args }`         |
 * | reports output through line **callbacks**   | reads from `stdout` / `stderr` streams   |
 * | `cancel(reason)`                            | `terminate()`                            |
 * | `SpawnExit{ signal: NodeJS.Signals\|null, error?: Error }` | `ProcessExit{ signal: string\|null, error?: string }` |
 *
 * Rather than bend either frozen interface, this module adapts once. It is the
 * only file that imports both sides, which is what keeps `src/kernel/**` free
 * of `src/drivers/**` imports and lets each side be unit-tested alone.
 *
 * @module dsh-agents-bridge/integrate
 */

import { PassThrough, Writable, type Readable } from 'node:stream'

import {
  setDriverRuntime,
  type ProcessExit,
  type SpawnFn,
  type SpawnSpec,
  type SpawnedProcess,
} from './drivers/argv.ts'
import { spawnDetached } from './kernel/spawn.ts'
import type { CommandSpec } from './kernel/types.ts'

/**
 * Sink used when the child died before stdin existed (ENOENT/EACCES). Drivers
 * always attach a stdin writer; throwing here would turn a readable spawn
 * failure into an unrelated stream error, so writes are accepted and dropped —
 * the real error still surfaces through `exited`.
 */
class DiscardingWritable extends Writable {
  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback()
  }
}

/**
 * Adapt one `SpawnSpec` to the kernel process factory.
 *
 * `buildCommandLine()` (drivers) has already folded `interpreter` and
 * `argsPrefix` into a flat command line, so the whole thing is expressible as a
 * bare `CommandSpec` with no interpreter and no prefix.
 */
export const kernelSpawn: SpawnFn = (spec: SpawnSpec): SpawnedProcess => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  const command: CommandSpec = { executable: spec.command }

  const handle = spawnDetached({
    command,
    args: spec.args,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    env: spec.env,
    // Keep stdin open: the stream-json family answers `control_request` frames
    // through it (see docs/multica-reference.md §2).
    stdin: true,
    onStdoutLine: (line) => {
      stdout.write(`${line}\n`)
    },
    onStderrLine: (line) => {
      stderr.write(`${line}\n`)
    },
  })

  const exited: Promise<ProcessExit> = handle.exited.then((exit) => {
    // End both streams so the driver's `readLines` flushes its tail buffer
    // instead of waiting for an EOF that already happened.
    stdout.end()
    stderr.end()
    return {
      code: exit.code,
      signal: exit.signal ?? null,
      ...(exit.error === undefined ? {} : { error: exit.error.message }),
    }
  })

  return {
    ...(handle.pid === undefined ? {} : { pid: handle.pid }),
    stdin: (handle.stdin ?? new DiscardingWritable()) as unknown as Writable,
    stdout: stdout as Readable,
    stderr: stderr as Readable,
    exited,
    terminate: (): Promise<void> => handle.cancel('driver requested terminate'),
  }
}

/**
 * Install the adapter into the drivers' module-level seam.
 *
 * MUST be called before the first `agents_run`: drivers resolve the runtime
 * lazily on each run and throw a readable error naming this call if it is
 * missing (see `getDriverRuntime` in `src/drivers/argv.ts`). Idempotent, and
 * safe to call again after a settings change.
 */
export function installDriverRuntime(): void {
  setDriverRuntime({ spawn: kernelSpawn })
}
