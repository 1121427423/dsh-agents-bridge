/**
 * `src/client/store.ts` — the shared state container and its scheduler.
 *
 * The store takes its `setTimeout`/`clearTimeout`/`hidden` from the caller, so
 * the whole poll cadence is driven by a fake clock: no test sleeps, and the
 * requirement that "an idle panel must stop polling" is asserted by counting
 * scheduled timers rather than by waiting to see.
 *
 * @module tests/client/store
 */

import { describe, expect, it } from 'vitest'

import type { BridgeApi } from '../../src/client/api.ts'
import { ApiError } from '../../src/client/api.ts'
import { createTranslator } from '../../src/client/i18n.ts'
import { createSupervisorStore, describeApiError, type SupervisorOptions } from '../../src/client/store.ts'
import { DEFAULT_POLL_POLICY, type ClientRunStatus, type ClientSession } from '../../src/client/util.ts'

/**
 * The settings trio `BridgeApi` requires (IM-14).
 *
 * `BridgeApi` grew `settings`/`settingsWrite`/`settingsReset` with the settings
 * card, and every fake below predates them — the store's poll suite never calls
 * them, and nothing typechecked tests, so the drift went unseen. LOUD stubs, not
 * a plausible empty shape: a caller arriving here should fail loudly.
 */
const noSettings: Pick<BridgeApi, 'settings' | 'settingsWrite' | 'settingsReset'> = {
  async settings() {
    throw new Error('settings() is not part of this fixture')
  },
  async settingsWrite() {
    throw new Error('settingsWrite() is not part of this fixture')
  },
  async settingsReset() {
    throw new Error('settingsReset() is not part of this fixture')
  },
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A controllable clock that records every scheduled callback.
 *
 * The returned object IS the store's `clock` seam (setTimeout / clearTimeout /
 * now / hidden / onVisibilityChange), so a test drives the whole scheduler.
 */
function fakeClock() {
  let nextId = 1
  let hidden = false
  const pending = new Map<number, { handler: () => void; ms: number }>()
  const scheduled: { id: number; ms: number }[] = []
  const listeners = new Set<() => void>()
  return {
    setTimeout(handler: () => void, ms: number) {
      const id = nextId
      nextId += 1
      pending.set(id, { handler, ms })
      scheduled.push({ id, ms })
      return id
    },
    clearTimeout(handle: unknown) {
      pending.delete(handle as number)
    },
    now: () => Date.now(),
    hidden: () => hidden,
    onVisibilityChange(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    scheduled,
    pendingCount: () => pending.size,
    /** Run every callback currently scheduled, once. */
    async flush() {
      const entries = [...pending.entries()]
      pending.clear()
      for (const [, entry] of entries) entry.handler()
      await settle()
    },
    setHidden(value: boolean) {
      hidden = value
      for (const listener of listeners) listener()
    },
  }
}

/** A session row. */
function session(sessionId: string, status: ClientRunStatus, startedAt = 0): ClientSession {
  return {
    sessionId,
    agentId: 'claude',
    status,
    startedAt,
    messageCount: 0,
    terminal: status !== 'running',
  }
}

/** A scripted API face; each call is counted and can be made to fail. */
function fakeApi(script: {
  readonly sessions?: () => readonly ClientSession[]
  readonly failStatus?: boolean
  readonly failOutput?: boolean
  readonly output?: (sessionId: string, sinceIndex: number) => { readonly nextIndex: number; readonly messages: readonly { index: number; type: string; text?: string; at: number }[]; readonly terminal?: boolean }
} = {}) {
  const calls = { status: 0, output: 0, cancel: 0, probe: 0 }
  const api: BridgeApi = {
    async status() {
      calls.status += 1
      if (script.failStatus === true) throw new ApiError('missing', 'not-found', 404, 'no route')
      const rows = script.sessions?.() ?? []
      return {
        sessions: rows,
        concurrency: { running: rows.filter(row => row.status === 'running').length, limit: 200 },
        now: 1_000,
      }
    },
    async output(sessionId, sinceIndex) {
      calls.output += 1
      if (script.failOutput === true) throw new ApiError('network', 'network', 0, 'offline')
      const next = script.output?.(sessionId, sinceIndex) ?? { nextIndex: sinceIndex, messages: [] }
      return { sessionId, status: 'running' as const, terminal: false, ...next }
    },
    async cancel() {
      calls.cancel += 1
      return { sessionId: 'x', cancelled: true, status: 'running' as const, note: 'Cancellation requested.' }
    },
    async probe() {
      calls.probe += 1
      return { available: true, results: [], at: 1_000, cached: true }
    },
    ...noSettings,
  }
  return { api, calls }
}

/**
 * Build a store over a controllable clock.
 *
 * The clock is passed through a thin wrapper so its extra test helpers
 * (`flush`, `scheduled`, …) are not part of the seam the store sees.
 */
function makeStore(api: BridgeApi, clock: ReturnType<typeof fakeClock>, options?: Partial<SupervisorOptions>) {
  return createSupervisorStore(
    api,
    createTranslator('en'),
    { policy: DEFAULT_POLL_POLICY, autoRefresh: true, ...options },
    {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      hidden: clock.hidden,
      onVisibilityChange: clock.onVisibilityChange,
    },
  )
}

/** Wait for the store's in-flight promises to settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve))
}

/* -------------------------------------------------------------------------- */
/* Loading and failure                                                        */
/* -------------------------------------------------------------------------- */

describe('supervisor store — loading', () => {
  it('publishes sessions, counts and concurrency after the first read', async () => {
    const clock = fakeClock()
    const { api } = fakeApi({ sessions: () => [session('a', 'running'), session('b', 'failed')] })
    const store = makeStore(api, clock)
    const seen: string[] = []
    store.subscribe(() => seen.push(store.getSnapshot().updatedAt > 0 ? 'loaded' : 'pending'))
    store.start()
    await settle()

    const snapshot = store.getSnapshot()
    expect(snapshot.loaded).toBe(true)
    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.counts).toEqual({ running: 1, failed: 1, unseenFailures: 1 })
    expect(snapshot.updatedAt).toBe(1_000)
    expect(snapshot.error).toBeUndefined()
    expect(seen.length).toBeGreaterThan(0)
    store.stop()
  })

  it('keeps the snapshot identity stable between changes (useSyncExternalStore)', async () => {
    const clock = fakeClock()
    const { api } = fakeApi({ sessions: () => [session('a', 'running')] })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    expect(store.getSnapshot()).toBe(store.getSnapshot())
    store.stop()
  })

  it('turns an unreachable host into a localized message, not a stack', async () => {
    const clock = fakeClock()
    const { api } = fakeApi({ failStatus: true })
    const store = makeStore(api, clock)
    store.start()
    await settle()

    const snapshot = store.getSnapshot()
    expect(snapshot.error).toBe(createTranslator('en').t('errorMissing'))
    expect(snapshot.error).not.toContain('not-found')
    expect(snapshot.loaded).toBe(false)
    store.stop()
  })

  it('KEEPS the last known rows after a failed refresh', async () => {
    const clock = fakeClock()
    let failing = false
    const calls: { rows: readonly ClientSession[] } = { rows: [session('a', 'running')] }
    const api = {
      async status() {
        if (failing) throw new ApiError('network', 'network', 0, 'offline')
        return { sessions: calls.rows, concurrency: { running: 1, limit: 200 }, now: 5 }
      },
      async output() {
        return { sessionId: 'a', status: 'running' as const, nextIndex: 0, terminal: false, messages: [] }
      },
      async cancel() {
        return { sessionId: 'a', cancelled: true, status: 'running' as const, note: '' }
      },
      async probe() {
        return { available: true, results: [], at: 0, cached: false }
      },
      ...noSettings,
    } satisfies BridgeApi

    const store = makeStore(api, clock)
    store.start()
    await settle()
    failing = true
    await store.refresh()

    const snapshot = store.getSnapshot()
    expect(snapshot.error).toBeDefined()
    // The last known state is still the best information the human has.
    expect(snapshot.sessions.map(row => row.sessionId)).toEqual(['a'])
    store.stop()
  })

  it('notifies every subscriber even when one of them throws', async () => {
    const clock = fakeClock()
    const { api } = fakeApi()
    const store = makeStore(api, clock)
    let seen = 0
    store.subscribe(() => {
      throw new Error('bad subscriber')
    })
    store.subscribe(() => {
      seen += 1
    })
    store.start()
    await settle()
    expect(seen).toBeGreaterThan(0)
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* Poll scheduling                                                            */
/* -------------------------------------------------------------------------- */

describe('supervisor store — polling', () => {
  it('schedules the next read while something is running', async () => {
    const clock = fakeClock()
    const { api, calls } = fakeApi({ sessions: () => [session('a', 'running')] })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    expect(clock.pendingCount()).toBe(1)
    expect(clock.scheduled[clock.scheduled.length - 1]?.ms).toBe(DEFAULT_POLL_POLICY.activeMs)

    await clock.flush()
    expect(calls.status).toBeGreaterThanOrEqual(2)
    store.stop()
  })

  it('STOPS polling once nothing is running — the "do not spin when idle" rule', async () => {
    const clock = fakeClock()
    let rows: readonly ClientSession[] = [session('a', 'running')]
    const { api, calls } = fakeApi({ sessions: () => rows })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    expect(clock.pendingCount()).toBe(1)

    // The run finishes; the very next refresh must not schedule another.
    rows = [session('a', 'completed')]
    await clock.flush()
    await settle()
    expect(store.getSnapshot().counts.running).toBe(0)
    expect(clock.pendingCount()).toBe(0)
    const settled = calls.status
    await clock.flush()
    expect(calls.status).toBe(settled)
    store.stop()
  })

  it('backs the interval off while the tab is hidden, and stops entirely if idle', async () => {
    const clock = fakeClock()
    let rows: readonly ClientSession[] = [session('a', 'running')]
    const { api } = fakeApi({ sessions: () => rows })
    const store = makeStore(api, clock)
    store.start()
    await settle()

    clock.setHidden(true)
    await settle()
    const last = clock.scheduled[clock.scheduled.length - 1]
    expect(last?.ms).toBe(DEFAULT_POLL_POLICY.activeMs * DEFAULT_POLL_POLICY.hiddenFactor)

    rows = [session('a', 'completed')]
    clock.setHidden(false)
    await settle()
    expect(clock.pendingCount()).toBe(0)
    store.stop()
  })

  it('stops when the human turns auto-refresh off, and resumes when it comes back', async () => {
    const clock = fakeClock()
    const { api } = fakeApi({ sessions: () => [session('a', 'running')] })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    expect(clock.pendingCount()).toBe(1)

    store.setOptions({ autoRefresh: false })
    expect(store.getSnapshot().pollMode).toBe('paused')
    expect(clock.pendingCount()).toBe(0)

    store.setOptions({ autoRefresh: true })
    expect(clock.pendingCount()).toBe(1)
    store.stop()
  })

  it('stops polling after stop() and never calls the API again', async () => {
    const clock = fakeClock()
    const { api, calls } = fakeApi({ sessions: () => [session('a', 'running')] })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    store.stop()
    const settled = calls.status
    await clock.flush()
    expect(clock.pendingCount()).toBe(0)
    expect(calls.status).toBe(settled)
  })

  it('start() is idempotent — a second call does not double the pollers', async () => {
    const clock = fakeClock()
    const { api, calls } = fakeApi({ sessions: () => [session('a', 'running')] })
    const store = makeStore(api, clock)
    store.start()
    store.start()
    await settle()
    expect(clock.pendingCount()).toBe(1)
    expect(calls.probe).toBe(1)
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* Transcript                                                                 */
/* -------------------------------------------------------------------------- */

describe('supervisor store — transcript', () => {
  it('merges incremental reads using the returned nextIndex', async () => {
    const clock = fakeClock()
    const transcript: { index: number; type: string; text?: string; at: number }[] = [
      { index: 0, type: 'text', text: 'one', at: 0 },
      { index: 1, type: 'tool_use', text: 'Bash', at: 1 },
    ]
    const requested: number[] = []
    const { api } = fakeApi({
      sessions: () => [session('a', 'running')],
      output: (_sessionId, sinceIndex) => {
        requested.push(sinceIndex)
        return { nextIndex: transcript.length, messages: transcript.filter(m => m.index >= sinceIndex) }
      },
    })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    await store.openSession('a')

    expect(requested).toEqual([0])
    expect(store.getSnapshot().transcript.map(m => m.index)).toEqual([0, 1])

    transcript.push({ index: 2, type: 'text', text: 'two', at: 2 })
    await store.refresh()
    // A second read passes the returned nextIndex back — the panel never
    // re-pulls the whole transcript.
    expect(requested[requested.length - 1]).toBe(2)
    expect(store.getSnapshot().transcript.map(m => m.index)).toEqual([0, 1, 2])
    store.stop()
  })

  it('clears the transcript when the human goes back to the list', async () => {
    const clock = fakeClock()
    const { api } = fakeApi({
      sessions: () => [session('a', 'running')],
      output: (_id, since) => ({ nextIndex: since + 1, messages: [{ index: since, type: 'text', text: 'x', at: 0 }] }),
    })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    await store.openSession('a')
    expect(store.getSnapshot().transcript).toHaveLength(1)

    store.closeSession()
    const snapshot = store.getSnapshot()
    expect(snapshot.selectedId).toBeUndefined()
    expect(snapshot.transcript).toEqual([])
    store.stop()
  })

  it('marks a session as seen the moment it is opened (unread failures clear)', async () => {
    const clock = fakeClock()
    const { api } = fakeApi({
      sessions: () => [session('bad', 'failed')],
      output: () => ({ nextIndex: 0, messages: [] }),
    })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    expect(store.getSnapshot().counts.unseenFailures).toBe(1)
    await store.openSession('bad')
    expect(store.getSnapshot().counts.unseenFailures).toBe(0)
    store.stop()
  })

  it('STOPS the transcript poll once the session reports terminal (MI-10)', async () => {
    // While a transcript is open the list poller is paused (`schedule()` sees
    // `selectedId !== undefined`), so the in-memory row keeps saying `running`
    // even after the session has finished. The output read is the only source
    // that knows, and `loadTranscript` used to drop `read.terminal`, leaving a
    // 1.2s poll running forever on a transcript that can no longer change.
    const clock = fakeClock()
    const { api, calls } = fakeApi({
      sessions: () => [session('a', 'running')],
      output: () => ({ nextIndex: 0, messages: [], terminal: true }),
    })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    await store.openSession('a')

    expect(calls.output).toBe(1)
    expect(clock.pendingCount()).toBe(0)
    store.stop()
  })

  it('reports a transcript failure inline without dropping the list', async () => {
    const clock = fakeClock()
    const { api } = fakeApi({ sessions: () => [session('a', 'running')], failOutput: true })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    await store.openSession('a')

    const snapshot = store.getSnapshot()
    expect(snapshot.transcript).toEqual([])
    expect(snapshot.error).toBeDefined()
    // The list is still there: the human can go back.
    expect(snapshot.sessions).toHaveLength(1)
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

describe('supervisor store — cancel', () => {
  it('reports the outcome and refreshes the list', async () => {
    const clock = fakeClock()
    const { api, calls } = fakeApi({ sessions: () => [session('a', 'running')] })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    const before = calls.status
    const result = await store.cancelSession('a')
    expect(calls.cancel).toBe(1)
    expect(calls.status).toBeGreaterThan(before)
    expect(result.ok).toBe(true)
    expect(result.message).toBe(createTranslator('en').t('cancelRequested'))
    store.stop()
  })

  it('turns a cancelled=false response into the host note, not a silent no-op', async () => {
    const clock = fakeClock()
    const api = {
      async status() {
        return { sessions: [], concurrency: { running: 0, limit: 1 }, now: 0 }
      },
      async output() {
        return { sessionId: 'a', status: 'completed' as const, nextIndex: 0, terminal: true, messages: [] }
      },
      async cancel() {
        return { sessionId: 'a', cancelled: false, status: 'completed' as const, note: 'Nothing to cancel: already terminal.' }
      },
      async probe() {
        return { available: false, results: [], at: 0, cached: false }
      },
      ...noSettings,
    } satisfies BridgeApi
    const store = makeStore(api, clock)
    store.start()
    await settle()
    const result = await store.cancelSession('a')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Nothing to cancel: already terminal.')
    store.stop()
  })

  it('turns a failed cancel into a readable message', async () => {
    const clock = fakeClock()
    const api = {
      async status() {
        return { sessions: [], concurrency: { running: 0, limit: 1 }, now: 0 }
      },
      async output() {
        return { sessionId: 'a', status: 'completed' as const, nextIndex: 0, terminal: true, messages: [] }
      },
      async cancel() {
        throw new ApiError('forbidden', 'forbidden', 403, 'forbidden')
      },
      async probe() {
        return { available: false, results: [], at: 0, cached: false }
      },
      ...noSettings,
    } satisfies BridgeApi
    const store = makeStore(api, clock)
    store.start()
    await settle()
    const result = await store.cancelSession('a')
    expect(result.ok).toBe(false)
    expect(result.message).toContain(createTranslator('en').t('errorForbidden'))
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* Engines                                                                    */
/* -------------------------------------------------------------------------- */

describe('supervisor store — engines', () => {
  it('probes once on start and only on an explicit refresh afterwards', async () => {
    const clock = fakeClock()
    const { api, calls } = fakeApi({ sessions: () => [session('a', 'running')] })
    const store = makeStore(api, clock)
    store.start()
    await settle()
    // Mount probes ONCE (the host's cached path); polling never re-probes.
    expect(calls.probe).toBe(1)
    await clock.flush()
    expect(calls.probe).toBe(1)

    await store.refreshEngines()
    expect(calls.probe).toBe(2)
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* Error copy                                                                 */
/* -------------------------------------------------------------------------- */

describe('describeApiError', () => {
  const translator = createTranslator('en')

  it('gives each kind its own actionable sentence', () => {
    expect(describeApiError(new ApiError('forbidden', 'forbidden', 403, 'x'), translator)).toBe(translator.t('errorForbidden'))
    expect(describeApiError(new ApiError('missing', 'not-found', 404, 'x'), translator)).toBe(translator.t('errorMissing'))
    expect(describeApiError(new ApiError('network', 'network', 0, 'x'), translator)).toBe(translator.t('errorNetwork'))
    expect(describeApiError(new ApiError('internal', 'internal', 500, 'boom'), translator)).toBe(translator.t('errorInternal', { detail: 'boom' }))
  })

  it('handles a non-ApiError throw (a bug in the client itself)', () => {
    expect(describeApiError(new Error('surprise'), translator)).toBe(translator.t('errorInternal', { detail: 'surprise' }))
    expect(describeApiError('a string', translator)).toBe(translator.t('errorInternal', { detail: 'a string' }))
  })
})
