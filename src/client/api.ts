/**
 * dsh-agents-bridge client half — the typed fetch wrapper over the host's
 * fenced JSON API.
 *
 * The browser module cannot reach a Cordis service on the Node side, so this is
 * the client half's ONLY way to learn anything (see `src/host/api.ts`). Two
 * rules follow from that:
 *
 *  1. every failure mode must become a READABLE, LOCALIZABLE state — the panel
 *     is a human surface, so a 403, a 404 (plugin missing on the host), or a
 *     dropped connection each get their own message. A raw stack trace never
 *     reaches the DOM.
 *  2. envelope parsing is a PURE function so it is unit-testable without a
 *     server: {@link parseEnvelope} takes the two facts a `Response` offers and
 *     nothing else.
 *
 * @module dsh-agents-bridge/client/api
 */

import type { ClientOutputPayload, ClientProbeResult, ClientRunStatus, ClientSession } from './util.ts'

/** Path prefix, mirroring `API_PREFIX` on the host (kept in sync by a test). */
export const API_BASE = '/agents-bridge/api'

/** Machine-readable failure kinds the UI maps to localized copy. */
export type ApiFailureKind = 'forbidden' | 'missing' | 'bad-request' | 'not-found' | 'network' | 'internal'

/** One API failure, carrying both a code and a human-facing message. */
export class ApiError extends Error {
  readonly kind: ApiFailureKind
  readonly code: string
  readonly status: number

  constructor(kind: ApiFailureKind, code: string, status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.code = code
    this.status = status
  }
}

/** The host's envelopes. */
interface OkEnvelope {
  readonly ok: true
  readonly value: unknown
}
interface ErrEnvelope {
  readonly ok: false
  readonly error: { readonly code?: string; readonly message?: string }
}

/** HTTP status → failure kind (the panel's copy switches on this). */
function kindOfStatus(status: number): ApiFailureKind {
  if (status === 403) return 'forbidden'
  if (status === 404) return 'missing'
  if (status === 400) return 'bad-request'
  return 'internal'
}

/**
 * Turn one HTTP exchange into either the envelope's value or an `ApiError`.
 *
 * PURE, and throws synchronously: takes the status plus the already-parsed body.
 * Both the JSON route and any future route share it, and a test can drive every
 * branch with two literals.
 *
 * @param status - HTTP status code.
 * @param body - parsed JSON body, or `null` when the body was not JSON.
 */
export function parseEnvelope(status: number, body: unknown): unknown {
  const okStatus = status >= 200 && status < 300
  if (okStatus) {
    if (typeof body === 'object' && body !== null && (body as OkEnvelope).ok === true) {
      return (body as OkEnvelope).value
    }
    // A 2xx that is not our envelope means something ELSE answered on this
    // path (a proxy, a stale route). Never guess: the panel says so.
    throw new ApiError('internal', 'bad-envelope', status, 'the host returned an unexpected response shape')
  }
  const error = (body as ErrEnvelope | null)?.error
  // THROWN, not `Promise.reject`d: a synchronous throw means a caller can use
  // `try { parseEnvelope(...) }` directly, and — more importantly — an
  // un-awaited call cannot leave an unhandled rejection floating (which vitest,
  // and a browser's console, both report as a defect).
  throw new ApiError(
    kindOfStatus(status),
    typeof error?.code === 'string' ? error.code : `http-${status}`,
    status,
    typeof error?.message === 'string' ? error.message : `HTTP ${status}`,
  )
}

/** One session's raw shape as the host serializes it (loose on purpose). */
interface RawSession {
  readonly sessionId?: unknown
  readonly agentId?: unknown
  readonly status?: unknown
  readonly startedAt?: unknown
  readonly endedAt?: unknown
  readonly messageCount?: unknown
  readonly terminal?: unknown
  readonly lastMessage?: unknown
  readonly result?: unknown
}

const RUN_STATUSES: readonly ClientRunStatus[] = ['running', 'completed', 'failed', 'cancelled', 'timeout']

/** Narrow an unknown to a run status, defaulting to `failed` for an unknown one. */
function asStatus(value: unknown): ClientRunStatus {
  return RUN_STATUSES.includes(value as ClientRunStatus) ? (value as ClientRunStatus) : 'failed'
}

/** A finite, non-negative integer, or `undefined`. */
function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined
}

/**
 * Normalize the terminal result the `status` route forwards.
 *
 * The host serializes the kernel's whole `AgentResult` here, so this is where
 * the exit code a human needs to read a finished run finally becomes a typed,
 * validated field. It is WHITELISTED rather than cast, for the same reason
 * every other row field is: this object is handed to the renderer, and
 * `sessionPreview` calls `.replace` on `error`. An unchecked cast meant a host
 * (or a proxy) sending `error: 42` threw inside React's render and blanked the
 * panel — the one outcome this half exists to prevent.
 *
 * `usage` is kept only when BOTH token counts are real numbers: half a usage
 * figure renders as `↑0 ↓7`, which is a fabrication, whereas omitting it says
 * the honest "usage not reported".
 */
export function normalizeResult(raw: unknown): ClientSession['result'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const usage = typeof value['usage'] === 'object' && value['usage'] !== null
    ? (value['usage'] as Record<string, unknown>)
    : undefined
  const inputTokens = asCount(usage?.['inputTokens'])
  const outputTokens = asCount(usage?.['outputTokens'])
  const error = typeof value['error'] === 'string' && value['error'] !== '' ? value['error'] : undefined
  // `null` is the ABI's explicit "no exit status", so it collapses to absent
  // rather than to `0` (which would claim success).
  const exitCode = asCount(value['exitCode'])
  return {
    status: asStatus(value['status']),
    text: typeof value['text'] === 'string' ? value['text'] : '',
    ...(error === undefined ? {} : { error }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(inputTokens === undefined || outputTokens === undefined ? {} : { usage: { inputTokens, outputTokens } }),
  }
}

/**
 * Normalize one session row.
 *
 * The host is trusted to send its own shape, but a partially-written row (an
 * older host, a session restored from disk with no `lastMessage`) must not
 * produce `undefined` in a template literal, so every field gets a defined
 * fallback. Rows with no usable `sessionId` are dropped rather than rendered as
 * an unclickable ghost.
 */
export function normalizeSession(raw: unknown): ClientSession | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as RawSession
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return undefined
  const status = asStatus(value.status)
  const lastMessage = normalizeMessage(value.lastMessage)
  const result = normalizeResult(value.result)
  return {
    sessionId: value.sessionId,
    agentId: typeof value.agentId === 'string' ? value.agentId : 'unknown',
    status,
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    ...(typeof value.endedAt === 'number' ? { endedAt: value.endedAt } : {}),
    messageCount: typeof value.messageCount === 'number' ? value.messageCount : 0,
    ...(lastMessage === undefined ? {} : { lastMessage }),
    terminal: value.terminal === true || status !== 'running',
    ...(result === undefined ? {} : { result }),
  }
}

/** Narrow an unknown to a client message (never throws on a malformed one). */
function normalizeMessage(raw: unknown): ClientSession['lastMessage'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  return {
    index: typeof value['index'] === 'number' ? value['index'] : 0,
    type: typeof value['type'] === 'string' ? value['type'] : 'log',
    ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}),
    ...(typeof value['tool'] === 'string' ? { tool: value['tool'] } : {}),
    ...(typeof value['level'] === 'string' ? { level: value['level'] } : {}),
    at: typeof value['at'] === 'number' ? value['at'] : 0,
  }
}

/** Normalize one probe row. */
export function normalizeProbe(raw: unknown): ClientProbeResult | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value['id'] !== 'string' || value['id'] === '') return undefined
  return {
    id: value['id'],
    ...(typeof value['displayName'] === 'string' ? { displayName: value['displayName'] } : {}),
    ...(typeof value['track'] === 'string' ? { track: value['track'] } : {}),
    available: value['available'] === true,
    ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
    ...(typeof value['health'] === 'object' && value['health'] !== null
      ? { health: value['health'] as ClientProbeResult['health'] }
      : {}),
    ...(Array.isArray(value['models'])
      ? { models: value['models'].filter((model): model is string => typeof model === 'string') }
      : {}),
  }
}

/**
 * The client-side API face. Every method resolves or throws an {@link ApiError};
 * nothing here touches the DOM.
 */
/**
 * One settings field as the card renders it.
 *
 * `effect` is not decoration: `live` means saving changes the next run, `reload`
 * means the value is snapshotted when the manager is built and therefore applies
 * from the next plugin load. The card prints it; hiding it would make a
 * do-nothing switch look like a working one.
 */
export interface ClientSettingField {
  readonly key: string
  readonly kind: 'string' | 'natural' | 'strings' | 'choice'
  readonly effect: 'live' | 'reload'
  readonly reason: string
  readonly value: string | number | readonly string[] | undefined
  /** The accepted values of a `choice` field; absent for every other kind. */
  readonly options?: readonly string[]
  readonly overridden: boolean
}

/** The whole namespace as the card receives it. */
export interface ClientSettingsView {
  readonly namespace: string
  readonly writable: boolean
  readonly reason?: string
  readonly fields: readonly ClientSettingField[]
}

/** A save or reset either landed (with the new state) or was refused, with a reason. */
export type ClientSettingsWriteResult =
  | { readonly ok: true; readonly value: ClientSettingsView }
  | { readonly ok: false; readonly error: string }

/** Normalize one field off the wire; an unknown `kind` is dropped, never guessed. */
function normalizeSettingField(raw: unknown): ClientSettingField | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const key = value['key']
  const kind = value['kind']
  if (typeof key !== 'string') return undefined
  if (kind !== 'string' && kind !== 'natural' && kind !== 'strings' && kind !== 'choice') return undefined
  const rawValue = value['value']
  // A `choice` field with no usable options cannot be rendered as a select; the
  // row survives (its value and reason still display) but the card treats it as
  // option-less rather than inventing choices.
  const rawOptions = value['options']
  const options =
    kind === 'choice' && Array.isArray(rawOptions)
      ? rawOptions.filter((entry): entry is string => typeof entry === 'string')
      : undefined
  return {
    key,
    kind,
    effect: value['effect'] === 'reload' ? 'reload' : 'live',
    reason: typeof value['reason'] === 'string' ? value['reason'] : '',
    value: Array.isArray(rawValue)
      ? rawValue.filter((entry): entry is string => typeof entry === 'string')
      : typeof rawValue === 'string' || typeof rawValue === 'number'
        ? rawValue
        : undefined,
    ...(options === undefined ? {} : { options }),
    overridden: value['overridden'] === true,
  }
}

/** Normalize a settings view; a malformed body yields an empty, explained view. */
export function normalizeSettings(raw: unknown): ClientSettingsView {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const reason = value['reason']
  return {
    namespace: typeof value['namespace'] === 'string' ? value['namespace'] : 'agents-bridge',
    writable: value['writable'] === true,
    ...(typeof reason === 'string' ? { reason } : {}),
    fields: Array.isArray(value['fields'])
      ? value['fields'].map(normalizeSettingField).filter((field): field is ClientSettingField => field !== undefined)
      : [],
  }
}

export interface BridgeApi {
  status(): Promise<{ readonly sessions: readonly ClientSession[]; readonly concurrency: { readonly running: number; readonly limit: number }; readonly now: number }>
  output(sessionId: string, sinceIndex: number, limit?: number): Promise<ClientOutputPayload>
  cancel(sessionId: string, reason?: string): Promise<{ readonly sessionId: string; readonly cancelled: boolean; readonly status: ClientRunStatus; readonly note: string }>
  /**
   * Probe the engines.
   *
   * `refresh` re-resolves versions (the cheap-but-not-free half). `rescan` is
   * ADDITIVE and separately opt-in: it also re-walks the app-bundle roots, so a
   * bundle installed since the last scan becomes visible (RR-MI-1b). It implies
   * `refresh`. Kept as a second positional flag rather than an options object so
   * every existing `probe(true)` / `probe()` caller keeps working unchanged.
   */
  probe(refresh?: boolean, rescan?: boolean): Promise<{ readonly available: boolean; readonly results: readonly ClientProbeResult[]; readonly at: number; readonly cached: boolean }>
  /** The plugin's own settings namespace, as the settings card needs it. */
  settings(): Promise<ClientSettingsView>
  /** Persist a patch into the settings user layer (the only write path). */
  settingsWrite(patch: Readonly<Record<string, unknown>>): Promise<ClientSettingsWriteResult>
  /** Clear one field from the user layer so it falls back to the deployment value. */
  settingsReset(field: string): Promise<ClientSettingsWriteResult>
}

/** How long a request may hang before it is treated as a dead host. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Build the API face over `fetch`.
 *
 * Every call POSTs a JSON body to `<base>/<method>` — a GET would be
 * cacheable and, more importantly, reachable from a plain `<img>`/link, which
 * the host's fence exists to prevent.
 *
 * @param fetchImpl - the fetch implementation (injectable for tests).
 * @param base - route prefix; overridden only by tests.
 */
export function createBridgeApi(
  fetchImpl: typeof fetch = globalThis.fetch,
  base: string = API_BASE,
): BridgeApi {
  async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller === undefined
      ? undefined
      : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    // The watchdog covers the WHOLE exchange, headers AND body. Clearing it once
    // the headers arrived left a stalled body loading forever with no error
    // (MI-12), so a failed body read is treated like a failed fetch.
    try {
      let response: Response
      try {
        response = await fetchImpl(`${base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          ...(controller === undefined ? {} : { signal: controller.signal }),
        })
      } catch (error) {
        // A network-level rejection is the "plugin not installed on this host /
        // host restarted" case, which the panel renders as an empty state rather
        // than an error page.
        throw new ApiError('network', 'network', 0, error instanceof Error ? error.message : String(error))
      }
      let body: unknown = null
      try {
        body = await response.json()
      } catch (error) {
        // The watchdog fired, or the connection died mid-body: the same "host is
        // gone" case as a refused fetch, and it must not be mistaken for a
        // non-JSON body (which parses as an ordinary envelope failure below).
        if (controller?.signal.aborted === true) {
          throw new ApiError('network', 'network', 0, error instanceof Error ? error.message : String(error))
        }
        body = null
      }
      return parseEnvelope(response.status, body)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return {
    async status() {
      const value = (await call('status', {})) as Record<string, unknown>
      const sessions = Array.isArray(value['sessions'])
        ? value['sessions'].map(normalizeSession).filter((session): session is ClientSession => session !== undefined)
        : []
      const concurrency = typeof value['concurrency'] === 'object' && value['concurrency'] !== null
        ? (value['concurrency'] as Record<string, unknown>)
        : {}
      return {
        sessions,
        concurrency: {
          running: typeof concurrency['running'] === 'number' ? concurrency['running'] : 0,
          limit: typeof concurrency['limit'] === 'number' ? concurrency['limit'] : 0,
        },
        now: typeof value['now'] === 'number' ? value['now'] : Date.now(),
      }
    },

    async output(sessionId, sinceIndex, limit) {
      const value = (await call('output', {
        sessionId,
        sinceIndex,
        ...(limit === undefined ? {} : { limit }),
      })) as Record<string, unknown>
      return {
        sessionId: typeof value['sessionId'] === 'string' ? value['sessionId'] : sessionId,
        status: asStatus(value['status']),
        nextIndex: typeof value['nextIndex'] === 'number' ? value['nextIndex'] : sinceIndex,
        terminal: value['terminal'] === true,
        messages: Array.isArray(value['messages'])
          ? value['messages'].map(normalizeMessage).filter((message): message is NonNullable<typeof message> => message !== undefined)
          : [],
        ...(typeof value['result'] === 'object' && value['result'] !== null
          ? { result: value['result'] as ClientOutputPayload['result'] }
          : {}),
      }
    },

    async cancel(sessionId, reason) {
      const value = (await call('cancel', {
        sessionId,
        ...(reason === undefined ? {} : { reason }),
      })) as Record<string, unknown>
      return {
        sessionId,
        cancelled: value['cancelled'] === true,
        status: asStatus(value['status']),
        note: typeof value['note'] === 'string' ? value['note'] : '',
      }
    },

    async probe(refresh, rescan) {
      // A re-scan implies a version refresh: the host re-resolves anyway, and
      // sending the implication explicitly keeps the request self-describing
      // rather than depending on the reader knowing the host's rule.
      const value = (await call('probe', {
        ...(refresh === true || rescan === true ? { refresh: true } : {}),
        ...(rescan === true ? { rescan: true } : {}),
      })) as Record<string, unknown>
      return {
        available: value['available'] === true,
        results: Array.isArray(value['results'])
          ? value['results'].map(normalizeProbe).filter((result): result is ClientProbeResult => result !== undefined)
          : [],
        at: typeof value['at'] === 'number' ? value['at'] : Date.now(),
        cached: value['cached'] === true,
      }
    },

    async settings() {
      return normalizeSettings(await call('settings', {}))
    },

    async settingsWrite(patch) {
      // The envelope's `value` is the write ANSWER, not a settings view, so this
      // one reads the raw body rather than reusing `normalizeSettings`.
      const value = (await call('settings-write', { patch })) as Record<string, unknown>
      return value['ok'] === true
        ? { ok: true, value: normalizeSettings(value['value']) }
        : { ok: false, error: typeof value['error'] === 'string' ? value['error'] : 'the save was refused' }
    },

    async settingsReset(field) {
      const value = (await call('settings-write', { field })) as Record<string, unknown>
      return value['ok'] === true
        ? { ok: true, value: normalizeSettings(value['value']) }
        : { ok: false, error: typeof value['error'] === 'string' ? value['error'] : 'the reset was refused' }
    },
  }
}
