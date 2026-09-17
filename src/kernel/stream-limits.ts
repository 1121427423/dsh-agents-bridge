/**
 * The ONE set of output bounds for a protocol stream (MI-4).
 *
 * Why a shared module: the same stdout is read twice — the kernel's
 * `LineSplitter` in `spawn.ts` feeds a `PassThrough`, and each driver's
 * `readLines` in `drivers/argv.ts` parses it. A newline-less writer (a CLI that
 * prints one enormous line, or a tool result with no trailing newline) grows
 * whichever buffer is checked last, and the plugin runs inside the host
 * process, so that growth is the host's RSS. Two copies of the number would
 * drift; `src/kernel/**` may not import `src/drivers/**`, so the number lives
 * here and both readers import it.
 *
 * The bounds are ceilings on what is HELD or DELIVERED, not on what is
 * logically possible: crossing one means the stream is no longer something this
 * bridge can faithfully carry, and every reader must therefore FAIL LOUDLY
 * (report an overflow and terminate the process group) rather than truncate —
 * a truncated line looks exactly like a complete protocol frame to the parser
 * downstream.
 *
 * @module dsh-agents-bridge/kernel/stream-limits
 */

/**
 * Largest single line (un-newlined run) either reader will hold.
 *
 * 16 MiB is ~50x the largest line any real capture in `tests/fixtures`
 * produced, and comfortably above a `tool_result` carrying a big file dump,
 * while still bounding a runaway writer to a fixed, small allocation.
 */
export const MAX_STREAM_LINE_BYTES = 16 * 1024 * 1024

/**
 * Largest cumulative output either reader will accept from one stream.
 *
 * The per-line cap alone does not bound a stream made of millions of SHORT
 * lines, and the generic driver retains every line it reads (its contract is
 * "the whole stdout is the answer"), so a cumulative budget is what stops that
 * retention. 256 MiB is far above any plausible run's stdout and far below what
 * would take a host down.
 */
export const MAX_STREAM_TOTAL_BYTES = 256 * 1024 * 1024

export type StreamOverflowKind = 'line' | 'total'

/** Caller-supplied limits; omitted or unusable fields fall back to the defaults. */
export interface StreamLimits {
  readonly maxLineBytes?: number
  readonly maxTotalBytes?: number
}

export interface ResolvedStreamLimits {
  readonly maxLineBytes: number
  readonly maxTotalBytes: number
}

/**
 * Normalize limits.
 *
 * A non-finite or non-positive value is NOT "no limit" — silently disabling the
 * bound is the defect this module exists to fix — so it degrades to the
 * default. Tests use small positive values to exercise the path cheaply.
 */
export function resolveStreamLimits(limits?: StreamLimits): ResolvedStreamLimits {
  return {
    maxLineBytes: positiveLimit(limits?.maxLineBytes, MAX_STREAM_LINE_BYTES),
    maxTotalBytes: positiveLimit(limits?.maxTotalBytes, MAX_STREAM_TOTAL_BYTES),
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/**
 * What a reader reports when a stream crosses a bound.
 *
 * An Error subclass so a driver can hand `message` straight to the run result
 * (and a logger) without rewording it — the same sentence a test asserts on is
 * the sentence the model sees.
 */
export class StreamOverflowError extends Error {
  readonly kind: StreamOverflowKind
  readonly bytes: number
  readonly limitBytes: number

  constructor(kind: StreamOverflowKind, bytes: number, limitBytes: number) {
    super(
      kind === 'line'
        ? `stream produced a ${bytes}-byte line with no newline (limit ${limitBytes} bytes); ` +
          `the run is aborted rather than truncated`
        : `stream exceeded the total output budget of ${limitBytes} bytes (received ${bytes}); ` +
          `the run is aborted rather than truncated`,
    )
    this.name = 'StreamOverflowError'
    this.kind = kind
    this.bytes = bytes
    this.limitBytes = limitBytes
  }
}
