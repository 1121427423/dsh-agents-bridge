/**
 * dsh-agents-bridge / tracks — host-file primitives shared by the two reader
 * modules (`./health.ts` answers "does a credential appear to exist", `./models.ts`
 * answers "which model ids will this engine accept").
 *
 * Both readers ask questions about files the BRIDGE DOES NOT OWN
 * (`~/.claude/settings.json`, `~/.codex/auth.json`,
 * `~/.workbuddy/cache/acc-product-config-v3.json`,
 * `~/.openclaw-autoclaw/openclaw.json`) and both obey the same three rules:
 *
 *  1. a missing, unreadable or malformed file is a NORMAL host fact, never an
 *     exception. `agents_probe` is called from a model-facing tool: it may not
 *     fail because a config file moved, and it must never perform a network call
 *     to find out more.
 *  2. nothing derived from those files may carry a secret. Redaction is enforced
 *     in code, not by review: `redactSecrets` is applied at the single point
 *     where a reader turns its findings into free text, so even a caller-supplied
 *     error message that embeds a token cannot leak it.
 *  3. every read is injectable. A reader takes the file path plus either the
 *     already-read contents (`contents`, keyed by ABSOLUTE path) or a `readFile`
 *     implementation, so tests are hermetic and never depend on this machine.
 *
 * This module exists so that `health.ts` and `models.ts` cannot disagree about
 * how a path is expanded, how ENOENT/EACCES is worded, or what a secret looks
 * like. It is not a track and holds no engine knowledge.
 *
 * @module dsh-agents-bridge/tracks/host-files
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* --------------------------------------------------------------- reading */

/**
 * Sync reader seam. Sync on purpose: the files are small, `agents_probe` is
 * cached, and a synchronous reader keeps every pure parser synchronous and
 * trivially testable.
 */
export type FileReader = (absolutePath: string) => string

/** Inputs every reader accepts, so a caller can pre-read the files it cares about. */
export interface HostFileOptions {
  /** Home directory used to expand a leading `~`; defaults to `os.homedir()`. */
  readonly home?: string
  /** Injectable reader; defaults to a synchronous `fs.readFileSync`. */
  readonly readFile?: FileReader
  /**
   * Already-read contents keyed by ABSOLUTE path. When a path is present here
   * the file is never touched, which is how the tests stay hermetic.
   */
  readonly contents?: Readonly<Record<string, string>>
}

/** Expand a leading `~` against an explicit home (no other `~` form is special). */
export function expandHome(raw: string, home: string): string {
  if (raw === '~') return home
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2))
  return raw
}

export const defaultFileReader: FileReader = (absolutePath) => fs.readFileSync(absolutePath, 'utf8')

/** Why a file could not be read. `missing` and `unreadable` are host facts, not bugs. */
export type FileReadFailure = 'missing' | 'unreadable' | 'error'

export type FileRead =
  | { readonly ok: true; readonly contents: string }
  | { readonly ok: false; readonly failure: FileReadFailure; readonly detail: string }

/**
 * Read one config file, never throwing.
 *
 * A `0o600` (or `0o000`) file the bridge is not allowed to read is reported as
 * `unreadable`, which both readers surface as a `missing` credential / absent
 * catalog with the permission fact in the detail line — it is never an error.
 */
export function readHostFile(absolutePath: string, options: HostFileOptions = {}): FileRead {
  const preloaded = options.contents?.[absolutePath]
  if (preloaded !== undefined) return { ok: true, contents: preloaded }
  const read = options.readFile ?? defaultFileReader
  try {
    return { ok: true, contents: read(absolutePath) }
  } catch (error) {
    return classifyReadError(error)
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function classifyReadError(error: unknown): FileRead {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, failure: 'missing', detail: 'not found' }
  if (code === 'EACCES' || code === 'EPERM') return { ok: false, failure: 'unreadable', detail: `not readable (${code})` }
  if (code === 'EISDIR') return { ok: false, failure: 'unreadable', detail: 'is a directory, not a file' }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, failure: 'error', detail: `could not be read (${redactSecrets(oneLine(message))})` }
}

/* ------------------------------------------------------------- redaction */

/**
 * Anything in this list is replaced by `[redacted]` before a reader's free text
 * leaves the module.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // An Authorization header value, scheme included, so a redacted line reads
  // "Authorization: [redacted]" instead of leaving a dangling "Bearer".
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // JWT: header.payload.signature (AutoClaw's real `openclaw.json` carries one
  // inside models.providers.*.models[].headers, which is exactly why this exists).
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{2,}/g,
  // Known credential prefixes (sk-, sk-ant-, ghp_, xoxb-, AKIA..., nvapi-, hf_...).
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|glpat|xox[baprs]|AKIA|ASIA|nvapi|hf_)[A-Za-z0-9_-]{8,}/g,
  // Defense in depth: any long opaque run with no spaces.
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

const REDACTED = '[redacted]'

/**
 * Mask credential-looking substrings in free text.
 *
 * The readers below never interpolate a file's *values* into a result, so this
 * is the second line of defence rather than the first: it protects the one
 * place where an unknown string can reach a detail line (an injected reader's
 * error message). It is deliberately applied to detail/reason text only, never
 * to a model id, because a legitimate id can be longer than 32 characters.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

/** Collapse to a single line and cap the length, so a detail stays one line. */
export function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed
}

/* ------------------------------------------------------------ json shapes */

export type JsonObjectParse =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string }

/**
 * Parse a JSON *object*. Arrays and scalars are rejected: every config file
 * these readers touch is an object at the top level, and accepting anything
 * else would only move the failure further away from its cause.
 *
 * The failure detail is built from the parse error's POSITION only, never from
 * its message: V8 quotes a snippet of the input in a `JSON.parse` SyntaxError
 * ("Unexpected token 'o', \"not json\" is not valid JSON"), and a truncated
 * `auth.json` would put the first bytes of a credential into that snippet.
 * Dropping the message makes "no file content ever reaches a result" a property
 * of the code rather than of the redaction patterns.
 */
export function parseJsonObject(contents: string): JsonObjectParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    return { ok: false, detail: `not valid JSON (${jsonErrorHint(error)})` }
  }
  const record = asRecord(parsed)
  if (record === undefined) return { ok: false, detail: 'the top level is not a JSON object' }
  return { ok: true, value: record }
}

/** "at position N" / "at line N column M" / "unparseable" — never the message. */
function jsonErrorHint(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const position = /\bposition\s+(\d+)/.exec(message)
  if (position?.[1] !== undefined) return `at position ${position[1]}`
  const place = /\bline\s+(\d+)\s+column\s+(\d+)/.exec(message)
  if (place?.[1] !== undefined && place[2] !== undefined) return `at line ${place[1]} column ${place[2]}`
  return 'unparseable'
}

/** Narrow to a plain JSON object (arrays and `null` are not objects here). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Narrow to an array without `Array.isArray` noise at every call site. */
export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined
}

/** True when `text` is a prefix of `absolute` on a path boundary; used to print `~/...`. */
export function homeRelative(absolute: string, home: string): string {
  if (absolute === home) return '~'
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`
  return absolute.startsWith(prefix) ? `~${path.sep}${absolute.slice(prefix.length)}` : absolute
}
