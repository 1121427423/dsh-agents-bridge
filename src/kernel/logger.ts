/**
 * Kernel logging seam.
 *
 * The bridge spawns third-party CLIs with whatever argv a run needs, and those
 * argv routinely carry credentials (`--api-key`, `Authorization: Bearer …`,
 * `--session-id` values copied from a sidecar token). multica solved this with
 * `redactAgentCommandArgs`; we keep the same contract at the only place logs
 * are produced — so a caller cannot forget to redact.
 *
 * @module dsh-agents-bridge/kernel/logger
 */

import type { BridgeLogger } from './types.ts'

/** Placeholder written instead of a suspected secret. */
export const REDACTED = '[redacted]'

/**
 * Field names that are never echoed. Deliberately word-based rather than a bare
 * `/auth|key/` match so ordinary fields like `author`, `keyspace` or
 * `keyCount` still survive in logs.
 */
const SENSITIVE_KEY =
  /(token|secret|passwd|password|credential|api[_-]?key|private[_-]?key|authorization|bearer|cookie|access[_-]?key)/i

/** Well-known token shapes that must be redacted even without a telling key. */
const SENSITIVE_VALUE = [
  /^sk-[A-Za-z0-9_-]{12,}$/,
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{8,}$/,
  /^AKIA[0-9A-Z]{12,}$/,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /^Bearer\s+\S{8,}$/i,
  // A header smuggled through `extraArgs` as one argv element.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/,
  /^authorization\s*[:=]\s*\S{8,}/i,
]

/** True when a field name looks like it holds a credential. */
export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY.test(key)) return true
  return /^(keys?|secret)$/i.test(key) || /[_-]keys?$/i.test(key) || /^keys?[_-]/i.test(key)
}

/** True when a free-form value looks like a token rather than prose. */
export function looksLikeSecret(value: string): boolean {
  return SENSITIVE_VALUE.some((re) => re.test(value.trim()))
}

/**
 * Redact one value: strings are pattern-checked, plain objects are walked
 * (bounded depth so a cyclic/huge driver payload cannot wedge a log call).
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return looksLikeSecret(value) ? REDACTED : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= 4) return '[object]'
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(entry, depth + 1)
  }
  return out
}

/** Redact a structured log payload. Returns a fresh object; never mutates input. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields) as Record<string, unknown>
}

/**
 * Redact a command line. Covers `--api-key VALUE`, `--api-key=VALUE` and bare
 * token-shaped arguments (which is how a leaked `Bearer` header usually looks
 * once a driver splices extra args in).
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      out.push(arg.includes('=') ? redactInline(arg) : REDACTED)
      redactNext = false
      continue
    }
    const inline = /^(--?[^=]+)=(.*)$/.exec(arg)
    if (inline) {
      const flag = inline[1] ?? ''
      out.push(isSensitiveKey(stripDashes(flag)) ? `${flag}=${REDACTED}` : arg)
      continue
    }
    if (arg.startsWith('-') && isSensitiveKey(stripDashes(arg))) {
      out.push(arg)
      redactNext = true
      continue
    }
    out.push(looksLikeSecret(arg) ? REDACTED : arg)
  }
  return out
}

function redactInline(arg: string): string {
  const eq = arg.indexOf('=')
  return eq === -1 ? REDACTED : `${arg.slice(0, eq)}=${REDACTED}`
}

function stripDashes(flag: string): string {
  return flag.replace(/^-+/, '')
}

function isDebugEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  const raw = process.env['DSH_AGENTS_BRIDGE_DEBUG'] ?? process.env['DSH_DEBUG']
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim())
}

export interface LoggerOptions {
  /**
   * Test/embedding seam: receive `(level, rendered)` instead of writing to the
   * console. Keeps kernel tests free of console noise.
   */
  readonly sink?: (level: 'debug' | 'info' | 'warn' | 'error', line: string) => void
  /** Force debug output on/off; defaults to `DSH_AGENTS_BRIDGE_DEBUG`. */
  readonly debugEnabled?: boolean
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}

/**
 * Console-backed `BridgeLogger`. `createLogger(scope)` is the required
 * constructor; the optional second argument is only used by tests.
 */
export function createLogger(scope: string, options: LoggerOptions = {}): BridgeLogger {
  const debugEnabled = isDebugEnabled(options.debugEnabled)

  const write = (
    level: 'debug' | 'info' | 'warn' | 'error',
    currentScope: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (level === 'debug' && !debugEnabled) return
    let line = currentScope ? `[dsh-agents-bridge:${currentScope}] ${message}` : `[dsh-agents-bridge] ${message}`
    if (fields !== undefined) {
      const safe = redactFields(fields)
      if (Object.keys(safe).length > 0) line += ` ${stringify(safe)}`
    }
    if (options.sink) {
      // A broken sink must not break the run it is describing.
      try {
        options.sink(level, line)
      } catch {
        /* ignore */
      }
      return
    }
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else if (level === 'debug') console.debug(line)
    else console.log(line)
  }

  return {
    debug: (message, fields) => write('debug', scope, message, fields),
    info: (message, fields) => write('info', scope, message, fields),
    warn: (message, fields) => write('warn', scope, message, fields),
    error: (message, fields) => write('error', scope, message, fields),
    child: (childScope: string) => createLogger(scope ? `${scope}:${childScope}` : childScope, options),
  }
}

/** Narrow a child logger helper: `logger.child` is optional in the ABI. */
export function childLogger(logger: BridgeLogger, scope: string): BridgeLogger {
  return typeof logger.child === 'function' ? logger.child(scope) : logger
}
