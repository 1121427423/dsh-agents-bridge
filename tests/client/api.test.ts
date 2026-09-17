/**
 * `src/client/api.ts` — the browser-side fetch wrapper and its envelope parsing.
 *
 * `parseEnvelope` is pure, so the whole failure taxonomy is driven with two
 * literals per case. `createBridgeApi` takes an injectable `fetch`, so the
 * request shape (POST, JSON body, method in the path) is asserted without a
 * server — which matters here, because a GET would be cacheable AND reachable
 * from a plain link, exactly what the host's fence exists to prevent.
 *
 * @module tests/client/api
 */

import { describe, expect, it, vi } from 'vitest'

import { API_BASE, ApiError, createBridgeApi, normalizeProbe, normalizeSession, parseEnvelope } from '../../src/client/api.ts'
import { API_PREFIX } from '../../src/host/api.ts'

/** One recorded request. */
interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A `fetch` that replays a scripted response and records what it was asked. */
function fakeFetch(
  responder: (url: string) => { readonly status: number; readonly body: unknown },
  recorded: Recorded[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    recorded.push({ url, init })
    const { status, body } = responder(url)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response
  }) as typeof fetch
}

/* -------------------------------------------------------------------------- */
/* Envelope parsing                                                           */
/* -------------------------------------------------------------------------- */

describe('parseEnvelope', () => {
  it('unwraps a success envelope', () => {
    expect(parseEnvelope(200, { ok: true, value: { sessions: [] } })).toEqual({ sessions: [] })
  })

  it('turns a 403 into a forbidden failure carrying the host code', () => {
    try {
      parseEnvelope(403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.kind).toBe('forbidden')
      expect(apiError.code).toBe('forbidden')
      expect(apiError.status).toBe(403)
    }
  })

  it('maps a 404 to "missing" — the plugin-is-not-installed case', () => {
    try {
      parseEnvelope(404, { ok: false, error: {} })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ApiError).kind).toBe('missing')
      // No code in the body: fall back to the HTTP status rather than to
      // `undefined` (the UI switches on this string).
      expect((error as ApiError).code).toBe('http-404')
    }
  })

  it('maps a 400 to bad-request and anything else non-2xx to internal', () => {
    expect(() => parseEnvelope(400, { ok: false, error: {} })).toThrow(ApiError)
    try {
      parseEnvelope(400, { ok: false, error: {} })
    } catch (error) {
      expect((error as ApiError).kind).toBe('bad-request')
    }
    try {
      parseEnvelope(500, { ok: false, error: { code: 'internal', message: 'boom' } })
    } catch (error) {
      expect((error as ApiError).kind).toBe('internal')
      expect((error as ApiError).message).toBe('boom')
    }
  })

  it('refuses a 2xx that is not our envelope (something else answered)', () => {
    // A proxy or a stale route returning a bare 200 must not be mistaken for a
    // successful read of an empty session list.
    try {
      parseEnvelope(200, { hello: 'world' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ApiError).code).toBe('bad-envelope')
    }
    expect(() => parseEnvelope(200, null)).toThrow(ApiError)
    expect(() => parseEnvelope(204, null)).toThrow(ApiError)
  })
})

/* -------------------------------------------------------------------------- */
/* Row normalization                                                          */
/* -------------------------------------------------------------------------- */

describe('normalizeSession', () => {
  it('fills in a defined fallback for every field of a partial row', () => {
    // A session restored from disk has no `lastMessage`; an older host may omit
    // `endedAt`. None of those may reach a template literal as `undefined`.
    const normalized = normalizeSession({ sessionId: 's1' })
    expect(normalized).toEqual({
      sessionId: 's1',
      agentId: 'unknown',
      status: 'failed',
      startedAt: 0,
      messageCount: 0,
      terminal: true,
    })
  })

  it('derives `terminal` from the status when the host does not say', () => {
    expect(normalizeSession({ sessionId: 's1', status: 'running' })?.terminal).toBe(false)
    expect(normalizeSession({ sessionId: 's1', status: 'timeout' })?.terminal).toBe(true)
  })

  it('drops a row with no usable id instead of rendering an unclickable ghost', () => {
    expect(normalizeSession(null)).toBeUndefined()
    expect(normalizeSession({})).toBeUndefined()
    expect(normalizeSession({ sessionId: '' })).toBeUndefined()
    expect(normalizeSession('s1')).toBeUndefined()
  })

  it('keeps an unknown status addressable rather than crashing on it', () => {
    expect(normalizeSession({ sessionId: 's1', status: 'quarantined' })?.status).toBe('failed')
  })

  it('normalizes a last message, defaulting its type to log', () => {
    const normalized = normalizeSession({ sessionId: 's1', lastMessage: { text: 'hi' } })
    expect(normalized?.lastMessage).toEqual({ index: 0, type: 'log', text: 'hi', at: 0 })
  })
})

describe('normalizeProbe', () => {
  it('keeps a well-formed row and drops a nameless one', () => {
    expect(normalizeProbe({ id: 'claude', available: true })).toEqual({ id: 'claude', available: true })
    expect(normalizeProbe({ available: true })).toBeUndefined()
    expect(normalizeProbe(undefined)).toBeUndefined()
  })

  it('filters a non-string model id out of the catalog', () => {
    expect(normalizeProbe({ id: 'x', models: ['a', 3, null, 'b'] })?.models).toEqual(['a', 'b'])
  })
})

/* -------------------------------------------------------------------------- */
/* The request shape                                                          */
/* -------------------------------------------------------------------------- */

describe('createBridgeApi', () => {
  it('POSTs JSON with the method name as the path suffix', async () => {
    const recorded: Recorded[] = []
    const api = createBridgeApi(fakeFetch(() => ({ status: 200, body: { ok: true, value: { sessions: [], concurrency: { running: 0, limit: 1 }, now: 7 } } }), recorded), API_BASE)
    const result = await api.status()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.url).toBe(`${API_BASE}/status`)
    expect(recorded[0]?.init?.method).toBe('POST')
    expect((recorded[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(recorded[0]?.init?.body).toBe('{}')
    expect(result.now).toBe(7)
  })

  it('sends sinceIndex on an incremental output read', async () => {
    const recorded: Recorded[] = []
    const api = createBridgeApi(
      fakeFetch(() => ({ status: 200, body: { ok: true, value: { sessionId: 's1', status: 'running', nextIndex: 9, terminal: false, messages: [] } } }), recorded),
      API_BASE,
    )
    const result = await api.output('s1', 7)
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({ sessionId: 's1', sinceIndex: 7 })
    expect(result.nextIndex).toBe(9)
  })

  it('passes `refresh` only when explicitly asked — the cheap path stays cheap', async () => {
    const recorded: Recorded[] = []
    const api = createBridgeApi(fakeFetch(() => ({ status: 200, body: { ok: true, value: { available: true, results: [], at: 1, cached: false } } }), recorded), API_BASE)
    await api.probe()
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({})
    await api.probe(true)
    expect(JSON.parse(String(recorded[1]?.init?.body))).toEqual({ refresh: true })
  })

  it('surfaces a network-level rejection as the "host is gone" case', async () => {
    const api = createBridgeApi((async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch, API_BASE)
    await expect(api.status()).rejects.toMatchObject({ kind: 'network', status: 0 })
  })

  it('surfaces a non-JSON body as an internal failure, never a parse crash', async () => {
    const api = createBridgeApi((async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })) as unknown as typeof fetch, API_BASE)
    await expect(api.status()).rejects.toBeInstanceOf(ApiError)
  })

  it('aborts a STALLED response body, not just a stalled header (MI-12)', async () => {
    // The 20s watchdog used to be cleared as soon as the headers arrived, so a
    // host that answered and then stalled the body left the panel loading
    // forever with no error. The watchdog must cover the whole exchange.
    vi.useFakeTimers()
    try {
      const api = createBridgeApi((async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal
        return {
          ok: true,
          status: 200,
          // A real fetch's body stream rejects when the request is aborted;
          // this mirrors the stalled body the watchdog exists to catch.
          json: () => new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted mid-body')))
          }),
        } as unknown as Response
      }) as typeof fetch, API_BASE)

      const outcome = api.status().then(
        () => 'resolved' as const,
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(20_000)
      // `race` against a sentinel so an unfixed build fails on the assertion
      // rather than on a test timeout.
      const settled = await Promise.race([outcome, Promise.resolve('pending' as const)])
      expect(settled).toBeInstanceOf(ApiError)
      expect((settled as ApiError).kind).toBe('network')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the route prefix in sync with the host half', () => {
    // The two halves agree on the path by convention, not by an import (the
    // client bundle must not pull in the Node module). This is the guard.
    expect(API_BASE).toBe(API_PREFIX)
  })
})
