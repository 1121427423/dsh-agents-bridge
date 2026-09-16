/**
 * `agents_usage` — the bill.
 *
 * The one thing this suite must not let regress is the accounting rule:
 * `reasoningTokens` is a DISCLOSURE field (codex counts it inside
 * `output_tokens`), so it is reported and never added into the total. A test
 * that only checked "the numbers add up" would happily pass a double-count, so
 * the synthetic case below pins a value where double-counting is visible.
 *
 * @module tests/tools/usage
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ManagerPool, NODE, waitTerminal } from '../helpers/manager-harness.ts'
import { callTool, renderTool, toolsFor } from '../helpers/tool-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAST = path.join(here, '..', 'fixtures', 'fake-stream-json-cli.mjs')
const SLOW = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

const SLOW_IDENTITY = {
  id: 'fake-slow',
  track: 'cli' as const,
  family: 'claude' as const,
  displayName: 'Fake slow engine',
  command: { executable: NODE, argsPrefix: [SLOW] },
}

/** The usage the `fake-stream-json-cli` fixture reports (see pipeline.test.ts). */
const FIXTURE_USAGE = { input: 22408, output: 100, cacheRead: 11264, cacheWrite: 11144 }

interface UsageRow {
  readonly sessionId: string
  readonly agentId: string
  readonly status: string
  readonly terminal: boolean
  readonly durationMs: number
  readonly usageReported: boolean
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

interface UsageValue {
  readonly sessions: readonly UsageRow[]
  readonly summary: {
    readonly sessions: number
    readonly running: number
    readonly finished: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly totalTokens: number
    readonly reasoningTokens: number
    readonly totalDurationMs: number
  }
  readonly note: string
}

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

describe('agents_usage — totals', () => {
  it('totals the four exclusive buckets across a finished session', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const snapshot = await manager.run({ agent: 'claude', prompt: 'x' })
    await waitTerminal(manager, snapshot.sessionId)

    const value = await callTool<UsageValue>(tools, 'agents_usage', {})
    const row = value.sessions.find((session) => session.sessionId === snapshot.sessionId)
    expect(row).toBeDefined()
    expect(row?.usageReported).toBe(true)
    expect(row?.inputTokens).toBe(FIXTURE_USAGE.input)
    expect(row?.outputTokens).toBe(FIXTURE_USAGE.output)
    expect(row?.cacheReadTokens).toBe(FIXTURE_USAGE.cacheRead)
    expect(row?.cacheWriteTokens).toBe(FIXTURE_USAGE.cacheWrite)
    expect(row?.durationMs).toBeGreaterThanOrEqual(0)

    const expected =
      FIXTURE_USAGE.input + FIXTURE_USAGE.output + FIXTURE_USAGE.cacheRead + FIXTURE_USAGE.cacheWrite
    expect(value.summary.totalTokens).toBe(expected)
    // The total is exactly the four buckets: nothing else leaked into it.
    expect(value.summary.totalTokens).toBe(
      value.summary.inputTokens +
        value.summary.outputTokens +
        value.summary.cacheReadTokens +
        value.summary.cacheWriteTokens,
    )
    expect(value.summary.finished).toBe(1)
    expect(value.summary.running).toBe(0)
  })

  it('sums several sessions and counts the running ones', async () => {
    const manager = pool.create(FAST, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const done = await manager.run({ agent: 'claude', prompt: 'x' })
    await waitTerminal(manager, done.sessionId)
    await manager.run({ agent: 'fake-slow', prompt: 'y' })

    const value = await callTool<UsageValue>(tools, 'agents_usage', {})
    expect(value.summary.sessions).toBe(2)
    expect(value.summary.finished).toBe(1)
    expect(value.summary.running).toBe(1)
    // The still-running session reports zeros, but says so — zeros must never be
    // read as "this run was free".
    const running = value.sessions.find((session) => !session.terminal)
    expect(running?.usageReported).toBe(false)
    expect(running?.inputTokens).toBe(0)
    expect(value.summary.totalTokens).toBe(
      FIXTURE_USAGE.input + FIXTURE_USAGE.output + FIXTURE_USAGE.cacheRead + FIXTURE_USAGE.cacheWrite,
    )
  })
})

describe('agents_usage — reasoning is disclosure, not a bucket', () => {
  it('renders reasoning separately and keeps it OUT of the total', () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    // Synthetic on purpose: the fixture engines report no reasoning tokens, so
    // only a value like this can catch a total that folds them in.
    const value: UsageValue = {
      sessions: [
        {
          sessionId: 'sess_x',
          agentId: 'codex',
          status: 'completed',
          terminal: true,
          durationMs: 2_000,
          usageReported: true,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 7,
        },
      ],
      summary: {
        sessions: 1,
        running: 0,
        finished: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 18,
        reasoningTokens: 7,
        totalDurationMs: 2_000,
      },
      note: 'note',
    }
    const rendered = renderTool(tools, 'agents_usage', {}, value)
    expect(rendered).toContain('total        18 tokens')
    expect(rendered).toContain('reasoning    7 tokens')
    expect(rendered).toContain('INSIDE outputTokens')
    expect(rendered).toContain('NOT added to the total')
    // 25 would be the double-counted total (18 + 7).
    expect(rendered).not.toContain('25 tokens')
  })

  it('says the same thing in the machine-readable note', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const value = await callTool<UsageValue>(tools, 'agents_usage', {})
    expect(value.note).toContain('reasoningTokens')
    expect(value.note).toMatch(/double-count/)
  })
})

describe('agents_usage — selection', () => {
  it('defaults to every known session, finished ones included', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const snapshot = await manager.run({ agent: 'claude', prompt: 'x' })
    await waitTerminal(manager, snapshot.sessionId)

    const value = await callTool<UsageValue>(tools, 'agents_usage', {})
    expect(value.sessions.map((session) => session.sessionId)).toContain(snapshot.sessionId)
  })

  it('narrows to the running sessions when includeFinished is false', async () => {
    const manager = pool.create(FAST, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const done = await manager.run({ agent: 'claude', prompt: 'x' })
    await waitTerminal(manager, done.sessionId)
    const live = await manager.run({ agent: 'fake-slow', prompt: 'y' })

    const value = await callTool<UsageValue>(tools, 'agents_usage', { includeFinished: false })
    expect(value.sessions.map((session) => session.sessionId)).toEqual([live.sessionId])
  })

  it('accepts an explicit list, or a single id as a bare string', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const first = await manager.run({ agent: 'claude', prompt: 'x' })
    const second = await manager.run({ agent: 'claude', prompt: 'y' })

    const list = await callTool<UsageValue>(tools, 'agents_usage', {
      sessionIds: [first.sessionId, second.sessionId],
    })
    expect(list.summary.sessions).toBe(2)

    const single = await callTool<UsageValue>(tools, 'agents_usage', { sessionIds: first.sessionId })
    expect(single.summary.sessions).toBe(1)
    expect(single.sessions[0]?.sessionId).toBe(first.sessionId)
  })

  it('rejects an unknown session and lists the ones it knows', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const snapshot = await manager.run({ agent: 'claude', prompt: 'x' })

    const error = await callTool(tools, 'agents_usage', { sessionIds: ['sess_nope'] }).catch(
      (err: unknown) => err as Error,
    )
    expect(error.message).toContain('sess_nope')
    expect(error.message).toContain(snapshot.sessionId)
    expect(error.message).toContain('agents_status')
  })
})

describe('agents_usage — render', () => {
  it('tells the model to start a session when there is nothing to total', () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const rendered = renderTool(
      tools,
      'agents_usage',
      {},
      {
        sessions: [],
        summary: {
          sessions: 0,
          running: 0,
          finished: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          totalDurationMs: 0,
        },
        note: '',
      },
    )
    expect(rendered).toContain('No sessions to total')
    expect(rendered).toContain('agents_run')
  })

  it('marks a session that has not reported usage yet', () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const rendered = renderTool(
      tools,
      'agents_usage',
      {},
      {
        sessions: [
          {
            sessionId: 'sess_live',
            agentId: 'claude',
            status: 'running',
            terminal: false,
            durationMs: 1_500,
            usageReported: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        ],
        summary: {
          sessions: 1,
          running: 1,
          finished: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          totalDurationMs: 1_500,
        },
        note: 'note',
      },
    )
    expect(rendered).toContain('no usage reported yet')
    expect(rendered).toContain('sess_live')
  })
})
