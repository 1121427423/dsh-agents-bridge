/**
 * `src/host/api.ts` — the fenced HTTP API behind the supervisor panel.
 *
 * No real server is started. The handler takes a native Node `req`/`res` pair,
 * so a fake with the four facts the handler reads (method, url, headers, an
 * async-iterable body) plus a recorder for the response is both simpler and
 * stricter than a socket: it makes the ORDER of judgements observable.
 *
 * The four things the task names are covered explicitly, because each of them
 * is a security or failure-mode decision rather than a routing detail:
 *   - an unknown method → 404 (not a crash, not a hang)
 *   - a non-POST → 405 BEFORE the body is touched
 *   - an untrusted origin → 403 with the same envelope shape as better-sidebar
 *   - a thrown handler → 500 with a JSON body (never an HTML error page)
 *
 * @module tests/host/api
 */

import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import {
  API_PREFIX,
  ApiError,
  attachHostApi,
  createApiRouteHandler,
  isTrustedApiRequest,
  type HostApiDeps,
  type WebServerFace,
} from '../../src/host/api.ts'
import { createLogger } from '../../src/kernel/logger.ts'
import type { AgentManager, AgentMessage, ProbeResult, SessionSnapshot } from '../../src/kernel/types.ts'

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** A `req` built from a plain description of the request. */
function fakeRequest(input: {
  readonly method?: string
  readonly url?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}): IncomingMessage {
  const body = input.body ?? ''
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)])
  return Object.assign(stream, {
    method: input.method ?? 'POST',
    url: input.url ?? `${API_PREFIX}/status`,
    headers: input.headers ?? { host: '127.0.0.1:5173' },
  }) as unknown as IncomingMessage
}

/** A `res` that records what the handler wrote. */
function fakeResponse(): { readonly res: ServerResponse; readonly status: () => number; readonly body: () => unknown; readonly headers: () => Record<string, unknown> } {
  let status = 0
  let headers: Record<string, unknown> = {}
  let payload = ''
  const res = {
    writeHead(code: number, next?: Record<string, unknown>) {
      status = code
      headers = next ?? {}
      return res
    },
    end(chunk?: string) {
      payload = chunk ?? ''
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => (payload === '' ? undefined : JSON.parse(payload)) as unknown,
    headers: () => headers,
  }
}

/** A session row with sane defaults; each test overrides only what it asserts. */
function session(overrides: Partial<SessionSnapshot> & { readonly sessionId: string }): SessionSnapshot {
  return {
    agentId: 'claude',
    status: 'running',
    startedAt: 1_000,
    messageCount: 0,
    terminal: false,
    ...overrides,
  } as SessionSnapshot
}

/** A manager stub: only the four methods the route layer is allowed to call. */
function fakeManager(overrides: Partial<AgentManager> = {}): AgentManager {
  return {
    probe: async (): Promise<readonly ProbeResult[]> => [],
    run: async () => session({ sessionId: 'unused' }),
    status: () => undefined,
    list: () => [],
    output: () => undefined,
    cancel: async () => false,
    send: async () => session({ sessionId: 'unused' }),
    dispose: async () => {},
    ...overrides,
  }
}

/** Build the handler under test with a controllable clock. */
function makeHandler(manager: AgentManager, options: { readonly trustedHosts?: readonly string[]; readonly now?: () => number } = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const deps: HostApiDeps = {
    webServer: { register: () => () => {} },
    ...(options.trustedHosts === undefined ? {} : { webRuntime: { trustedHosts: options.trustedHosts } }),
    manager,
    logger: createLogger('test', { sink: () => {} }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }
  return createApiRouteHandler(deps)
}

/** One request/response round trip. */
async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  input: Parameters<typeof fakeRequest>[0],
): Promise<{ readonly status: number; readonly body: unknown; readonly headers: Record<string, unknown> }> {
  const capture = fakeResponse()
  await handler(fakeRequest(input), capture.res)
  return { status: capture.status(), body: capture.body(), headers: capture.headers() }
}

/* -------------------------------------------------------------------------- */
/* Happy paths                                                                */
/* -------------------------------------------------------------------------- */

describe('host API — method dispatch', () => {
  it('answers status with a running-first ordering and a concurrency figure', async () => {
    const manager = fakeManager({
      list: () => [
        session({ sessionId: 'done-1', status: 'completed', startedAt: 5_000, terminal: true }),
        session({ sessionId: 'live-old', startedAt: 1_000 }),
        session({ sessionId: 'live-new', startedAt: 9_000 }),
      ],
    })
    const result = await call(makeHandler(manager, { now: () => 42 }), { body: '{}' })

    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8')
    const value = (result.body as { value: { sessions: { sessionId: string }[]; concurrency: { running: number }; now: number } }).value
    // Same order as `agents_status`: live rows first, most recently started
    // first. The panel does its own finer ordering on top (see
    // `tests/client/util.test.ts`), so the two surfaces never disagree.
    expect(value.sessions.map(row => row.sessionId)).toEqual(['live-new', 'live-old', 'done-1'])
    expect(value.concurrency.running).toBe(2)
    expect(value.now).toBe(42)
  })

  it('answers output incrementally, echoing nextIndex and the terminal flag', async () => {
    const messages: readonly AgentMessage[] = [
      { type: 'text', content: 'hello', at: 1 },
      { type: 'tool_use', tool: 'Bash', at: 2 },
    ]
    const manager = fakeManager({
      output: (_sessionId, opts) => ({
        sessionId: 's1',
        status: 'completed',
        messages: opts?.sinceIndex === 0 ? messages : [],
        nextIndex: (opts?.sinceIndex ?? 0) + messages.length,
      }),
      status: () => session({ sessionId: 's1', status: 'completed', terminal: true, result: { sessionId: 's1', agentId: 'claude', status: 'completed', exitCode: 0, text: 'ok', durationMs: 10, usage: { inputTokens: 5, outputTokens: 7, reasoningTokens: 2 } } } as Partial<SessionSnapshot> & { sessionId: string }),
    })

    const first = await call(makeHandler(manager), { url: `${API_PREFIX}/output`, body: JSON.stringify({ sessionId: 's1', sinceIndex: 0 }) })
    const firstValue = (first.body as { value: { messages: { index: number; text?: string }[]; nextIndex: number; terminal: boolean; result: { inputTokens?: number } } }).value
    expect(firstValue.messages.map(m => m.index)).toEqual([0, 1])
    expect(firstValue.nextIndex).toBe(2)
    expect(firstValue.terminal).toBe(true)
    expect(firstValue.result.inputTokens).toBe(5)

    // The second read passes the returned nextIndex back — the panel's whole
    // reason for existing is that it never re-pulls the transcript.
    const second = await call(makeHandler(manager), { url: `${API_PREFIX}/output`, body: JSON.stringify({ sessionId: 's1', sinceIndex: 2 }) })
    expect((second.body as { value: { messages: unknown[]; nextIndex: number } }).value.messages).toEqual([])
  })

  it('404s an unknown session on output, naming it', async () => {
    const result = await call(makeHandler(fakeManager()), { url: `${API_PREFIX}/output`, body: JSON.stringify({ sessionId: 'nope' }) })
    expect(result.status).toBe(404)
    expect(result.body).toEqual({ ok: false, error: { code: 'not-found', message: 'unknown session "nope"' } })
  })

  it('answers cancel with the settled status and a note', async () => {
    const manager = fakeManager({
      cancel: async () => true,
      status: () => session({ sessionId: 's1' }),
    })
    const result = await call(makeHandler(manager), { url: `${API_PREFIX}/cancel`, body: JSON.stringify({ sessionId: 's1', reason: 'user' }) })
    const value = (result.body as { value: { cancelled: boolean; status: string; note: string } }).value
    expect(value.cancelled).toBe(true)
    expect(value.status).toBe('running')
    expect(value.note).toContain('Cancellation requested')
  })

  it('reports cancelled=false for an already-terminal session without changing it', async () => {
    const manager = fakeManager({ cancel: async () => false, status: () => session({ sessionId: 's1', status: 'completed', terminal: true }) })
    const result = await call(makeHandler(manager), { url: `${API_PREFIX}/cancel`, body: JSON.stringify({ sessionId: 's1' }) })
    const value = (result.body as { value: { cancelled: boolean; note: string } }).value
    expect(value.cancelled).toBe(false)
    expect(value.note).toContain('Nothing to cancel')
  })

  it('answers probe and serves the cached path without re-probing', async () => {
    let probes = 0
    let refreshes = 0
    let clock = 1_000
    const manager = fakeManager({
      probe: async (opts) => {
        probes += 1
        if (opts?.refresh === true) refreshes += 1
        return [{ id: 'claude', displayName: 'Claude Code', track: 'cli', family: 'claude', available: true }] as readonly ProbeResult[]
      },
    })
    const handler = makeHandler(manager, { now: () => clock })

    const cold = await call(handler, { url: `${API_PREFIX}/probe`, body: '{}' })
    expect((cold.body as { value: { available: boolean; cached: boolean } }).value).toMatchObject({ available: true, cached: false })
    expect(probes).toBe(1)

    // Within the cache window a second read costs the host NOTHING — this is
    // the requirement that `probe` must have a cheap non-refresh path.
    const warm = await call(handler, { url: `${API_PREFIX}/probe`, body: '{}' })
    expect((warm.body as { value: { cached: boolean } }).value.cached).toBe(true)
    expect(probes).toBe(1)

    clock += 60_000
    await call(handler, { url: `${API_PREFIX}/probe`, body: '{}' })
    expect(probes).toBe(2)

    await call(handler, { url: `${API_PREFIX}/probe`, body: JSON.stringify({ refresh: true }) })
    expect(probes).toBe(3)
    expect(refreshes).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

describe('host API — guards', () => {
  it('404s an unknown method by name', async () => {
    const result = await call(makeHandler(fakeManager()), { url: `${API_PREFIX}/nope`, body: '{}' })
    expect(result.status).toBe(404)
    expect(result.body).toEqual({ ok: false, error: { code: 'not-found', message: 'unknown agents-bridge API method "nope"' } })
  })

  it('404s a bare prefix and a nested path', async () => {
    for (const url of [API_PREFIX, `${API_PREFIX}/`, `${API_PREFIX}/a/b`]) {
      const result = await call(makeHandler(fakeManager()), { url, body: '{}' })
      expect(result.status).toBe(404)
    }
  })

  it('405s a non-POST before reading the body', async () => {
    const result = await call(makeHandler(fakeManager()), { method: 'GET', body: '{}' })
    expect(result.status).toBe(405)
    expect(result.body).toEqual({ ok: false, error: { code: 'method-error', message: 'method not allowed' } })
  })

  it('403s a cross-site request from a loopback host', async () => {
    const result = await call(makeHandler(fakeManager()), {
      headers: { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })
    expect(result.status).toBe(403)
    // Exactly the shape better-sidebar writes, so one client-side reader
    // handles both plugins' failures.
    expect(result.body).toEqual({ ok: false, error: { code: 'forbidden', message: 'forbidden' } })
  })

  it('403s a foreign Origin on a loopback host', async () => {
    const result = await call(makeHandler(fakeManager()), {
      headers: { host: '127.0.0.1:5173', origin: 'https://evil.example' },
      body: '{}',
    })
    expect(result.status).toBe(403)
  })

  it('403s a non-loopback host that the web runtime does not trust', async () => {
    const result = await call(makeHandler(fakeManager()), { headers: { host: '10.0.0.5:5173' }, body: '{}' })
    expect(result.status).toBe(403)
  })

  it('allows a non-loopback host that the web runtime DOES trust', async () => {
    const result = await call(makeHandler(fakeManager(), { trustedHosts: ['dsh.internal:5173'] }), {
      headers: { host: 'dsh.internal:5173' },
      body: '{}',
    })
    expect(result.status).toBe(200)
  })

  it('allows a same-origin request and one with no Origin at all', async () => {
    const sameOrigin = await call(makeHandler(fakeManager()), {
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
      body: '{}',
    })
    expect(sameOrigin.status).toBe(200)
    const noOrigin = await call(makeHandler(fakeManager()), { headers: { host: '[::1]:5173' }, body: '{}' })
    expect(noOrigin.status).toBe(200)
  })

  it('400s a malformed JSON body rather than 500ing', async () => {
    const result = await call(makeHandler(fakeManager()), { url: `${API_PREFIX}/cancel`, body: '{not json' })
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ ok: false, error: { code: 'bad-request', message: 'request body is not valid JSON' } })
  })

  it('400s a missing required field, naming it', async () => {
    const result = await call(makeHandler(fakeManager()), { url: `${API_PREFIX}/output`, body: '{}' })
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ ok: false, error: { code: 'bad-request', message: 'missing or invalid "sessionId"' } })
  })

  it('500s a thrown handler with a JSON body, never an HTML error page', async () => {
    const manager = fakeManager({
      list: () => {
        throw new Error('kernel exploded')
      },
    })
    const result = await call(makeHandler(manager), { body: '{}' })
    expect(result.status).toBe(500)
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(result.body).toEqual({ ok: false, error: { code: 'internal', message: 'kernel exploded' } })
  })

  it('never caches a response (a cached 403/500 would be actively harmful)', async () => {
    const ok = await call(makeHandler(fakeManager()), { body: '{}' })
    expect(ok.headers['cache-control']).toBe('no-store')
    const forbidden = await call(makeHandler(fakeManager()), { method: 'DELETE', body: '{}' })
    expect((forbidden.headers as Record<string, string>)['cache-control']).toBe('no-store')
  })
})

/* -------------------------------------------------------------------------- */
/* The fence itself, against better-sidebar's four judgements                  */
/* -------------------------------------------------------------------------- */

describe('isTrustedApiRequest — the same judgements as dsh-better-sidebar', () => {
  const trusted = ['dsh.example:5173'] as const

  it('rejects a missing or unparsable Host', () => {
    expect(isTrustedApiRequest({ headers: {} }, trusted)).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: 'http://[bad' } }, trusted)).toBe(false)
  })

  it('accepts every loopback spelling and nothing else local', () => {
    expect(isTrustedApiRequest({ headers: { host: 'localhost' } }, [])).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: 'localhost:5173' } }, [])).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: '[::1]:5173' } }, [])).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: '127.0.0.1' } }, [])).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: '127.255.0.9:80' } }, [])).toBe(true)
    // Not loopback: a public IP, a LAN IP, a lookalike name, and a malformed one.
    expect(isTrustedApiRequest({ headers: { host: '8.8.8.8' } }, [])).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: '192.168.1.10' } }, [])).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: '127.0.0.1.evil.example' } }, [])).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: '127.0.0.999' } }, [])).toBe(false)
  })

  it('refuses cross-site browser markers even from loopback', () => {
    expect(isTrustedApiRequest({ headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' } }, [])).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: 'localhost', 'sec-fetch-site': 'same-origin' } }, [])).toBe(true)
  })

  it('requires a present Origin to be same-host, but tolerates an absent one', () => {
    expect(isTrustedApiRequest({ headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } }, [])).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: 'localhost:5173', origin: 'http://localhost:9999' } }, [])).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: 'localhost:5173', origin: 'https://evil.example' } }, [])).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: 'localhost:5173', origin: 'not a url' } }, [])).toBe(false)
  })

  it('matches a trusted authority exactly, including its written port', () => {
    // Verified against dsh-better-sidebar's own `isTrustedApiRequest`: a
    // trusted entry WITH a port only matches a Host that writes that same port
    // (canonical form compares `host`, i.e. hostname:port). A port-less Host
    // is therefore NOT trusted by a port-bearing entry — replicating that
    // exactly matters, because "close enough" here is a fence with a gap.
    expect(isTrustedApiRequest({ headers: { host: 'dsh.example:5173' } }, trusted)).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: 'dsh.example' } }, trusted)).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: 'dsh.example:9999' } }, trusted)).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: 'other.example:5173' } }, trusted)).toBe(false)
    // A port-LESS trusted entry compares hostnames only.
    expect(isTrustedApiRequest({ headers: { host: 'dsh.example:5173' } }, ['dsh.example'])).toBe(true)
    expect(isTrustedApiRequest({ headers: { host: 'dsh.example' } }, ['dsh.example'])).toBe(true)
  })

  it('treats an omitted trustedHosts list as "no trusted hosts" instead of throwing', () => {
    // Regression: `isTrustedApiRequest` is exported, so callers outside
    // `attachHostApi` can reach it. It used to dereference the second argument
    // unconditionally, which threw a TypeError — not a refusal — as soon as a
    // non-loopback Host arrived. A trust fence must fail *closed* with `false`;
    // throwing leaks a stack trace instead of a decision.
    expect(isTrustedApiRequest({ headers: { host: 'dsh.example:5173' } })).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: 'localhost:5173' } })).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Registration lifetime                                                      */
/* -------------------------------------------------------------------------- */

describe('attachHostApi', () => {
  it('registers a prefix route at the agreed path and reports the disposer', () => {
    const registered: { kind: string; path: string }[] = []
    let disposed = 0
    const webServer: WebServerFace = {
      register(route) {
        registered.push({ kind: route.kind, path: route.path })
        return () => {
          disposed += 1
        }
      },
    }
    const dispose = attachHostApi({
      webServer,
      manager: fakeManager(),
      logger: createLogger('test', { sink: () => {} }),
    })
    expect(registered).toEqual([{ kind: 'prefix', path: API_PREFIX }])
    expect(disposed).toBe(0)
    // The effect disposer must actually remove the route, or an unload leaves a
    // handler pointing at a disposed manager.
    dispose()
    expect(disposed).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* ApiError                                                                   */
/* -------------------------------------------------------------------------- */

describe('ApiError', () => {
  it('carries its wire code, status and name', () => {
    const error = new ApiError('not-found', 'nope', 404)
    expect(error.code).toBe('not-found')
    expect(error.status).toBe(404)
    expect(error.name).toBe('ApiError')
    expect(error).toBeInstanceOf(Error)
  })
})
