/**
 * `agents_wait` — the bounded wait.
 *
 * The point of this tool is that a ten-minute task should cost ONE tool call
 * rather than dozens of `agents_output` polls, while the run itself stays
 * fire-and-forget. So the suite has to prove three separate things:
 *
 *   1. it really waits (returns terminal state without the caller polling);
 *   2. it really stops (a timeout is a normal return value, never an error, and
 *      never longer than the caller asked for);
 *   3. it changed nothing — `agents_run` still returns before the session is
 *      terminal (design doc D5), and a timed-out wait cancels nothing.
 *
 * No test sleeps for its timeout: the success paths use a fake CLI that exits
 * in ~100ms, and the timeout paths use a single-digit-to-30ms budget.
 *
 * @module tests/tools/wait
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { MAX_WAIT_TIMEOUT_MS } from '../../src/tools/definitions.ts'
import { ManagerPool, NODE, waitTerminal } from '../helpers/manager-harness.ts'
import { callTool, renderTool, toolsFor } from '../helpers/tool-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAST = path.join(here, '..', 'fixtures', 'fake-stream-json-cli.mjs')
const SLOW = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

/**
 * A second `claude`-family identity pointed at the never-finishing fixture.
 *
 * The built-in `workbuddy`/`autoclaw` descriptors carry an `interpreter`, and a
 * per-field command override keeps it — so pointing one of those at a node
 * script would launch `node <node> <script>`. A fresh descriptor with the same
 * family is the honest way to get a second, differently-behaving identity.
 */
const SLOW_IDENTITY = {
  id: 'fake-slow',
  track: 'cli' as const,
  family: 'claude' as const,
  displayName: 'Fake slow engine',
  command: { executable: NODE, argsPrefix: [SLOW] },
}

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

/** Starts one session and returns its id. Never waits for it. */
async function start(
  manager: ReturnType<ManagerPool['create']>,
  agent = 'claude',
): Promise<string> {
  const snapshot = await manager.run({ agent, prompt: 'do the thing' })
  return snapshot.sessionId
}

interface WaitSession {
  readonly sessionId: string
  readonly agentId: string
  readonly status: string
  readonly terminal: boolean
  readonly waitedMs: number
  readonly nextIndex: number
  readonly result?: { readonly status: string; readonly text: string }
  readonly events?: readonly { readonly index: number; readonly type: string; readonly text?: string }[]
}

interface WaitValue {
  readonly waitedMs: number
  readonly timedOut: boolean
  readonly until: string
  readonly timeoutMs: number
  readonly sessions: readonly WaitSession[]
  readonly hint: string
}

describe('agents_wait — waiting', () => {
  it('returns once every named session is terminal, with its result', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const first = await start(manager)
    const second = await start(manager)

    const value = await callTool<WaitValue>(tools, 'agents_wait', {
      sessionIds: [first, second],
      timeoutMs: 5_000,
    })

    expect(value.timedOut).toBe(false)
    expect(value.until).toBe('all')
    expect(value.sessions).toHaveLength(2)
    for (const session of value.sessions) {
      expect(session.terminal).toBe(true)
      expect(session.status).toBe('completed')
      // The result travels with the wait, so a model that only wanted the
      // outcome never needs a second call.
      expect(session.result?.status).toBe('completed')
    }
    expect(value.sessions.map((session) => session.sessionId).sort()).toEqual([first, second].sort())
    expect(value.waitedMs).toBeGreaterThanOrEqual(0)
    expect(value.waitedMs).toBeLessThan(5_000)
  })

  it('accepts a bare string as well as an array', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)
    const value = await callTool<WaitValue>(tools, 'agents_wait', { sessionIds: id, timeoutMs: 5_000 })
    expect(value.sessions).toHaveLength(1)
    expect(value.sessions[0]?.terminal).toBe(true)
  })

  it('returns immediately for a session that is already terminal', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)
    await waitTerminal(manager, id)

    const startedAt = Date.now()
    const value = await callTool<WaitValue>(tools, 'agents_wait', { sessionIds: [id], timeoutMs: 30_000 })
    expect(value.timedOut).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('reports how long THIS wait spent on each session', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)
    const value = await callTool<WaitValue>(tools, 'agents_wait', { sessionIds: [id], timeoutMs: 5_000 })
    const session = value.sessions[0]
    expect(session?.waitedMs).toBeGreaterThanOrEqual(0)
    expect(session?.waitedMs).toBeLessThanOrEqual(value.waitedMs)
  })
})

describe('agents_wait — until:"any"', () => {
  it('returns as soon as one session is terminal and leaves the others running', async () => {
    // One fast identity, one that never finishes: exactly the fan-out shape
    // where a model wants the first answer without abandoning the rest.
    const manager = pool.create(FAST, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const fast = await start(manager, 'claude')
    const slow = await start(manager, 'fake-slow')

    const value = await callTool<WaitValue>(tools, 'agents_wait', {
      sessionIds: [slow, fast],
      until: 'any',
      timeoutMs: 5_000,
    })

    expect(value.timedOut).toBe(false)
    expect(value.until).toBe('any')
    const byId = new Map(value.sessions.map((session) => [session.sessionId, session]))
    expect(byId.get(fast)?.terminal).toBe(true)
    expect(byId.get(slow)?.terminal).toBe(false)
    expect(byId.get(slow)?.status).toBe('running')
    // The still-running session was NOT cancelled — that is agents_cancel's job.
    expect(manager.status(slow)?.status).toBe('running')
  })
})

describe('agents_wait — timeout is a normal result', () => {
  it('returns timedOut=true with the still-running sessions and a way forward', async () => {
    const manager = pool.create(SLOW)
    const tools = toolsFor(manager)
    const id = await start(manager)

    const startedAt = Date.now()
    const value = await callTool<WaitValue>(tools, 'agents_wait', { sessionIds: [id], timeoutMs: 30 })

    expect(value.timedOut).toBe(true)
    expect(value.timeoutMs).toBe(30)
    expect(value.sessions[0]?.terminal).toBe(false)
    expect(value.sessions[0]?.status).toBe('running')
    // Bounded by the caller's budget, not by the poll interval.
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(value.hint).toMatch(/normal result/i)
    expect(value.hint).toMatch(/agents_wait again|agents_output/)

    // Nothing was cancelled by a timeout.
    expect(manager.status(id)?.status).toBe('running')

    const rendered = renderTool(tools, 'agents_wait', { sessionIds: [id], timeoutMs: 30 }, value)
    expect(rendered).toContain('timed out')
    expect(rendered).toContain('not an error')
    expect(rendered).toContain('agents_output')
  })

  it('clamps timeoutMs above the hard cap and says so in the render', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)
    await waitTerminal(manager, id)

    const args = { sessionIds: [id], timeoutMs: 999_999 }
    const value = await callTool<WaitValue>(tools, 'agents_wait', args)
    expect(value.timeoutMs).toBe(MAX_WAIT_TIMEOUT_MS)

    const rendered = renderTool(tools, 'agents_wait', args, value)
    expect(rendered).toContain('capped at')
  })

  it('rejects a non-positive timeoutMs with the legal range', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)
    await expect(callTool(tools, 'agents_wait', { sessionIds: [id], timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs must be a positive number of milliseconds \(1\.\.60000\)/,
    )
  })
})

describe('agents_wait — argument validation', () => {
  it('rejects an empty session list with a next step', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    await expect(callTool(tools, 'agents_wait', { sessionIds: [] })).rejects.toThrow(
      /sessionIds must name at least one session/,
    )
    await expect(callTool(tools, 'agents_wait', { sessionIds: [] })).rejects.toThrow(/agents_status/)
  })

  it('rejects an unknown session id and lists what it knows', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)

    const error = await callTool(tools, 'agents_wait', { sessionIds: ['sess_typo'] }).catch(
      (err: unknown) => err as Error,
    )
    expect(error.message).toContain('sess_typo')
    expect(error.message).toContain(id)
    expect(error.message).toContain('agents_status')
  })
})

describe('agents_wait — incremental events', () => {
  it('returns no events without sinceIndex, but still reports the cursor', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)
    await waitTerminal(manager, id)

    const value = await callTool<WaitValue>(tools, 'agents_wait', { sessionIds: [id], timeoutMs: 1_000 })
    const session = value.sessions[0]
    expect(session?.events).toBeUndefined()
    expect(session?.nextIndex).toBe(manager.status(id)?.messageCount)
    expect(session?.nextIndex).toBeGreaterThan(0)
  })

  it('returns events from sinceIndex and advances the cursor so a re-read is empty', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const id = await start(manager)
    await waitTerminal(manager, id)

    const first = await callTool<WaitValue>(tools, 'agents_wait', {
      sessionIds: [id],
      sinceIndex: 0,
      timeoutMs: 1_000,
    })
    const events = first.sessions[0]?.events ?? []
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.index).toBe(0)
    expect(first.sessions[0]?.nextIndex).toBe(events.length)

    const second = await callTool<WaitValue>(tools, 'agents_wait', {
      sessionIds: [id],
      sinceIndex: first.sessions[0]?.nextIndex ?? 0,
      timeoutMs: 1_000,
    })
    expect(second.sessions[0]?.events ?? []).toHaveLength(0)
    expect(second.sessions[0]?.nextIndex).toBe(first.sessions[0]?.nextIndex)
  })
})

describe('agents_wait does not change the fire-and-forget contract', () => {
  it('leaves agents_run returning while the session is still running (D5)', async () => {
    const manager = pool.create(SLOW)
    const tools = toolsFor(manager)
    const startedAt = Date.now()
    const value = await callTool<{ sessionId: string; status: string }>(tools, 'agents_run', {
      agent: 'claude',
      prompt: 'long job',
    })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(value.status).toBe('running')
    expect(manager.status(value.sessionId)?.terminal).toBe(false)
  })

  it('is a separate tool: the wait lives in agents_wait, not in agents_run', () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    // `parameters` is the raw JSON Schema object; the property map is inside.
    const properties = (name: string): string[] => {
      const parameters = (tools.get(name)?.parameters ?? {}) as { properties?: Record<string, unknown> }
      return Object.keys(parameters.properties ?? {}).sort()
    }
    // agents_run's published surface is unchanged apart from `idleTimeoutMs`,
    // the per-run no-output window IM-8 requires — no wait knob was smuggled
    // into it (that would be the D5 violation this tool exists to avoid).
    expect(properties('agents_run')).toEqual(
      ['agent', 'cwd', 'effort', 'idleTimeoutMs', 'mode', 'model', 'prompt', 'timeoutMs'],
    )
    expect(properties('agents_wait')).toEqual(['sessionIds', 'sinceIndex', 'timeoutMs', 'until'])
  })
})
