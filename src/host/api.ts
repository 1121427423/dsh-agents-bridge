/**
 * dsh-agents-bridge — the fenced HTTP API that gives the Web client half a
 * window into the bridge (workstream A, deliverable 1).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The nine model-facing tools are only visible to the model. A human running the
 * desktop client cannot see which delegated agents are alive, how long they
 * have been running, what they last said, or how many tokens they burned. The
 * client half (`src/client/**`) is a browser module and cannot reach a Cordis
 * service on the Node side, so the ONLY channel between the two halves is a
 * host HTTP route (this is the same channel `dsh-history` and
 * `dsh-better-sidebar` use — a third-party plugin resolves outside the DSH
 * monorepo and therefore has no `host.call`).
 *
 * LAYERING (design doc D3)
 * ------------------------
 * This module is ENTRY layer, a sibling of `src/index.ts` and `src/tools/**`,
 * not kernel. It may depend on the frozen `AgentManager` facade and on nothing
 * else: no `src/kernel/**` implementation, no drivers. Every route body is a
 * thin projection over an `AgentManager` method — deliberately no logic lives
 * here, so the same behaviour is reachable from the tool surface and testable
 * without a server.
 *
 * THE `webServer` TRAP (design doc D16)
 * -------------------------------------
 * `webServer` is NOT in the plugin's top-level `inject`. Cordis marks a plugin
 * INACTIVE while an inject-listed service is unmounted, so a host without a web
 * server would lose the plugin ENTIRELY — all nine tools included — just because
 * it cannot serve a panel. `attachHostApi` therefore takes the service as an
 * argument and the entry reaches it through cordis SCOPE injection
 * (`ctx.inject(['webServer'], ...)`), which waits for the service without gating
 * the parent fiber. A one-shot `ctx.get('webServer')` does NOT work here: the
 * host's web server is another row of the loader tree and is routinely provided
 * after this plugin applies (measured at ~800 ms on the standalone web harness),
 * so the read comes back `undefined` on a host that has one.
 *
 * @module dsh-agents-bridge/host/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentManager, AgentRunStatus, BridgeLogger, ProbeResult, SessionSnapshot } from '../kernel/types.ts'

/** Path prefix this plugin owns. Method names are the suffixes. */
export const API_PREFIX = '/agents-bridge/api'

/**
 * Route registration options, mirroring `@deepseek-ai/dsh-host-webserver`.
 *
 * Declared structurally rather than imported: the package is not a dependency
 * of this repo (D10 — the shared `node_modules` tree cannot be re-resolved), and
 * `ctx.webServer` is host-provided at runtime. `register` returns the Cordis
 * effect disposer, which is what makes the route removable on unload.
 */
export interface WebServerFace {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The web runtime face: bind-derived trusted authorities (see the fence below). */
export interface WebRuntimeFace {
  readonly trustedHosts: readonly string[]
}

/** Rows shown by the panel; capped so one busy deployment cannot flood the client. */
const MAX_LISTED_SESSIONS = 200
/** Body size bound of one JSON request (same defense as better-sidebar). */
const MAX_BODY_BYTES = 1 << 20
/** Transcript cap for one `output` read when the client sends no limit. */
const DEFAULT_OUTPUT_LIMIT = 200
/** Hard cap regardless of what the client asks for. */
const MAX_OUTPUT_LIMIT = 2_000

/** One API failure with its wire code and HTTP status. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/** Narrow an unknown value to a plain object, else `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Narrow an unknown payload field to a non-empty string, else `undefined`. */
function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Narrow an unknown payload field to a finite integer, else `undefined`. */
function optionalInteger(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/** Require a non-empty string field, else a 400 with the field named. */
function requireString(payload: Record<string, unknown>, key: string): string {
  const value = optionalString(payload, key)
  if (value === undefined) throw new ApiError('bad-request', `missing or invalid "${key}"`)
  return value
}

/* -------------------------------------------------------------------------- */
/* Browser-trust fence — replicated from dsh-better-sidebar's `isTrustedApiRequest` */
/* -------------------------------------------------------------------------- */

/** Read one header, tolerating Node's `string | string[] | undefined`. */
function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some(entry => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one bridge request may reach this plugin's routes.
 *
 * Replicated verbatim in spirit from `dsh-better-sidebar`'s
 * `isTrustedApiRequest` (its `src/trust-fence.ts`). The four judgements, in
 * order — deliberately NOT a weaker check of our own invention:
 *
 *  1. a `Host` header must be present and parse as an authority;
 *  2. the Host must be loopback (`localhost`, `[::1]`, or a well-formed
 *     `127.x.y.z`) OR match one of the web runtime's `trustedHosts`
 *     (the non-loopback authorities this deployment actually serves);
 *  3. `sec-fetch-site: cross-site` is refused — a cross-origin page must not
 *     be able to drive this plugin even from a browser that can reach the host;
 *  4. when an `Origin` header is present, its hostname must equal the Host's
 *     hostname. A missing Origin stays allowed (same-origin navigations and
 *     non-browser callers send none, and judgement 2/3 already gated them).
 *
 * @param request - node HTTP request facts (headers only).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours and the browser markers are same-origin.
 */
export function isTrustedApiRequest(
  request: { readonly headers: IncomingMessage['headers'] },
  trustedHosts: readonly string[] = [],
): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Wire helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Write a JSON response with the given status. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // The client polls this route; a cached 403/500 would be actively harmful.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Write the success envelope (`{ok: true, value}`). */
function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 500, {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

/** Read and parse the JSON body (bounded; malformed → bad-request). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return asRecord(JSON.parse(text))
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}

/* -------------------------------------------------------------------------- */
/* Payload shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Current concurrency: how many sessions are running against the bound the
 * host allows.
 *
 * The bridge does not itself cap concurrency (the kernel spawns whatever the
 * model asks for), so `limit` reports the value the client should treat as the
 * design ceiling rather than an enforced quota. It is exported as data instead
 * of hardcoded in the client so the number has one home.
 */
export interface ConcurrencySnapshot {
  readonly running: number
  readonly limit: number
}

/** The `status` route's value: every session, running first. */
export interface StatusPayload {
  readonly sessions: readonly SessionSnapshot[]
  readonly concurrency: ConcurrencySnapshot
  /** Epoch ms the host produced this payload (the client corrects clock skew with it). */
  readonly now: number
}

/** The `probe` route's value. */
export interface ProbePayload {
  /** True when at least one identity is drivable on this host. */
  readonly available: boolean
  readonly results: readonly ProbeResult[]
  /** Epoch ms this probe result was produced (a cached read reports the original time). */
  readonly at: number
  /** True when the host served its probe cache without re-resolving executables. */
  readonly cached: boolean
}

/** The `cancel` route's value. */
export interface CancelPayload {
  readonly sessionId: string
  readonly cancelled: boolean
  readonly status: AgentRunStatus
  readonly note: string
}

/** The `output` route's value: `agents_output`'s projection, plus usage. */
export interface OutputPayload {
  readonly sessionId: string
  readonly status: AgentRunStatus
  readonly nextIndex: number
  readonly terminal: boolean
  readonly messages: readonly {
    readonly index: number
    readonly type: string
    readonly text?: string
    readonly tool?: string
    readonly level?: string
    readonly at: number
  }[]
  readonly result?: {
    readonly status: AgentRunStatus
    readonly text: string
    readonly error?: string
    readonly exitCode?: number
    readonly durationMs: number
    readonly backendSessionId?: string
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly reasoningTokens?: number
  }
}

/* -------------------------------------------------------------------------- */
/* Host service face                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What `attachHostApi` needs from the host. Deliberately narrow: the route
 * layer must be constructible in a unit test from three literal objects.
 */
export interface HostApiDeps {
  readonly webServer: WebServerFace
  /** Absent when the host has no web runtime — the fence then trusts loopback only. */
  readonly webRuntime?: WebRuntimeFace | undefined
  readonly manager: AgentManager
  readonly logger: BridgeLogger
  /** Where the probe cache's freshness is decided; injectable for tests. */
  readonly now?: (() => number) | undefined
  /**
   * How long a `probe` response may be reused by a non-refreshing read.
   * `agents_probe` is called from a model-facing tool and must stay cheap, so
   * the panel's first paint must not re-run version discovery either.
   */
  readonly probeCacheMs?: number | undefined
}

/** Default probe-cache window for the panel (the tool has its own TTL). */
const DEFAULT_PROBE_CACHE_MS = 30_000

/**
 * The method table. Each entry is a THIN projection over `AgentManager` — no
 * business logic lives in a route body (task requirement: "API 层是薄壳").
 */
export function createApiHandlers(deps: HostApiDeps): Record<string, (payload: Record<string, unknown>) => Promise<unknown>> {
  const { manager } = deps
  const now = deps.now ?? (() => Date.now())
  const probeCacheMs = deps.probeCacheMs ?? DEFAULT_PROBE_CACHE_MS
  /** Last successful probe + when it was produced. Serves the non-refresh path. */
  let probeCache: { value: ProbePayload } | undefined

  /**
   * Running sessions first, then most recently started.
   *
   * Deliberately the SAME order `agents_status` uses: the two surfaces answer
   * the same question, and a human comparing the panel with the model's report
   * should not be looking at two different orderings. The panel applies its own
   * finer ordering (live rows oldest-first — the longest-running one is the
   * worry) in `src/client/util.ts:sortSessions`, which is a presentation
   * decision and therefore belongs on the presentation side.
   */
  const orderSessions = (sessions: readonly SessionSnapshot[]): SessionSnapshot[] =>
    [...sessions].sort((left, right) => {
      if (left.terminal !== right.terminal) return left.terminal ? 1 : -1
      return right.startedAt - left.startedAt
    })

  return {
    /** `status` — every session snapshot, running first, plus the concurrency figure. */
    async status(): Promise<StatusPayload> {
      const sessions = orderSessions(manager.list()).slice(0, MAX_LISTED_SESSIONS)
      return {
        sessions,
        concurrency: {
          running: sessions.filter(session => session.status === 'running').length,
          limit: MAX_LISTED_SESSIONS,
        },
        now: now(),
      }
    },

    /** `output` — incremental transcript read, identical semantics to `agents_output`. */
    async output(payload): Promise<OutputPayload> {
      const sessionId = requireString(payload, 'sessionId')
      const sinceIndex = Math.max(0, optionalInteger(payload, 'sinceIndex') ?? 0)
      const requested = optionalInteger(payload, 'limit') ?? DEFAULT_OUTPUT_LIMIT
      const limit = Math.min(MAX_OUTPUT_LIMIT, Math.max(1, requested))
      const read = manager.output(sessionId, { sinceIndex, limit })
      if (read === undefined) {
        throw new ApiError('not-found', `unknown session "${sessionId}"`, 404)
      }
      const snapshot = manager.status(sessionId)
      const result = snapshot?.result
      return {
        sessionId: read.sessionId,
        status: read.status,
        nextIndex: read.nextIndex,
        terminal: snapshot?.terminal ?? read.status !== 'running',
        messages: read.messages.map((message, offset) => ({
          index: sinceIndex + offset,
          type: message.type,
          ...(message.content === undefined ? {} : { text: message.content }),
          ...(message.tool === undefined ? {} : { tool: message.tool }),
          ...(message.level === undefined ? {} : { level: message.level }),
          at: message.at,
        })),
        ...(result === undefined
          ? {}
          : {
              result: {
                status: result.status,
                text: result.text,
                ...(result.error === undefined ? {} : { error: result.error }),
                ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
                durationMs: result.durationMs,
                ...(result.backendSessionId === undefined ? {} : { backendSessionId: result.backendSessionId }),
                ...(result.usage === undefined
                  ? {}
                  : {
                      inputTokens: result.usage.inputTokens,
                      outputTokens: result.usage.outputTokens,
                      ...(result.usage.reasoningTokens === undefined
                        ? {}
                        : { reasoningTokens: result.usage.reasoningTokens }),
                    }),
              },
            }),
      }
    },

    /** `cancel` — idempotent, same three-phase semantics as `agents_cancel`. */
    async cancel(payload): Promise<CancelPayload> {
      const sessionId = requireString(payload, 'sessionId')
      const reason = optionalString(payload, 'reason')
      const requested = await manager.cancel(sessionId, reason)
      const snapshot = manager.status(sessionId)
      const status = snapshot?.status ?? 'cancelled'
      const note = !requested
        ? 'Nothing to cancel: the session is unknown or already terminal.'
        : status === 'running'
          ? 'Cancellation requested. The child is being signalled and will be killed after its grace window.'
          : 'Cancellation settled. The transcript tail is available in the output view.'
      return { sessionId, cancelled: requested, status, note }
    },

    /**
     * `probe` — engine availability.
     *
     * This route MAY be slow: `refresh: true` re-resolves executables on PATH
     * and can spawn `--version`. The panel therefore polls `status` cheaply and
     * asks for this route only on mount / on an explicit refresh; without
     * `refresh` a recent result is served from the host's own cache so a page
     * reload cannot re-run discovery.
     */
    async probe(payload): Promise<ProbePayload> {
      const refresh = payload['refresh'] === true
      if (!refresh && probeCache !== undefined && now() - probeCache.value.at < probeCacheMs) {
        return { ...probeCache.value, cached: true }
      }
      const results = await manager.probe(refresh ? { refresh: true } : {})
      const value: ProbePayload = {
        available: results.some(result => result.available),
        results,
        at: now(),
        cached: false,
      }
      probeCache = { value }
      return value
    },
  }
}

/**
 * Build the `/agents-bridge/api` route handler.
 *
 * Order of judgements is the contract, not an implementation detail:
 * fence (403) → method (405) → method name (404) → body (400) → dispatch.
 * A wrong-origin request must be refused BEFORE the body is read, so a
 * cross-origin page cannot even make the host parse a payload.
 */
export function createApiRouteHandler(deps: HostApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handlers = createApiHandlers(deps)

  return async (req, res) => {
    // `trustedHosts` is read PER REQUEST, not snapshotted when the route mounts:
    // the same late-service trap that made `ctx.get('webServer')` useless applies
    // to `webRuntime`, which `dsh-web-app` provides only AFTER `webServer` exists
    // (measured on the standalone web harness: still absent at the moment the
    // entry's scope fires). A mount-time snapshot would therefore be empty on a
    // host that DOES have trusted authorities, and the fence would 403 every
    // non-loopback deployment — silently, since a 403 is a legitimate answer.
    if (!isTrustedApiRequest(req, deps.webRuntime?.trustedHosts ?? [])) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const remainder = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : undefined
    if (remainder === undefined || remainder === '' || remainder.includes('/')) {
      writeError(res, new ApiError('not-found', 'unknown agents-bridge API method', 404))
      return
    }
    try {
      const payload = await readJsonBody(req)
      const handler = handlers[remainder]
      if (handler === undefined) {
        throw new ApiError('not-found', `unknown agents-bridge API method "${remainder}"`, 404)
      }
      writeOk(res, await handler(payload))
    } catch (error) {
      // Logged with the session-scoped facts only; the wire body stays opaque
      // (a stack trace in a UI is exactly the "raw JSON / English stack" the
      // panel must never show).
      deps.logger.warn('host api method failed', {
        method: remainder,
        error: error instanceof Error ? error.message : String(error),
      })
      writeError(res, error)
    }
  }
}

/**
 * Register the fenced API route and tie it to the caller's fiber.
 *
 * Returns the disposer that actually removes the route: the entry composes it
 * into the plugin's single effect so unload (and HMR reload) never leaves a
 * handler pointing at a disposed manager.
 *
 * @param deps - host seams plus the live manager.
 * @returns the route disposer.
 */
export function attachHostApi(deps: HostApiDeps): () => void {
  const handler = createApiRouteHandler(deps)
  const dispose = deps.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler,
  })
  deps.logger.info('host api route mounted', { path: API_PREFIX })
  return () => {
    dispose()
    deps.logger.info('host api route unmounted', { path: API_PREFIX })
  }
}
