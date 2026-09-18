/**
 * `agents_run_many` — the parallel fan-out form of `agents_run`.
 *
 * Two properties are worth more than the happy path and are what this suite is
 * really about:
 *
 *   1. **Partial failure is per entry.** One refused entry (bad id, denied cwd,
 *      concurrency cap) must leave the other entries started, because the
 *      realistic fan-out is "these 5 files, one agent each" and rolling the
 *      whole batch back over a typo in entry 4 wastes everything that worked.
 *   2. **It still never waits.** N entries cost ONE tool call, not N turns, and
 *      the call returns while every session is still running.
 *
 * @module tests/tools/run-many
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { MAX_PARALLEL_RUNS } from '../../src/tools/definitions.ts'
import { ManagerPool, NODE } from '../helpers/manager-harness.ts'
import { callTool, renderTool, toolsFor } from '../helpers/tool-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAST = path.join(here, '..', 'fixtures', 'fake-stream-json-cli.mjs')
const SLOW = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

/**
 * A `claude`-family identity that never finishes, so "the call returned while
 * the sessions were still running" is an assertion and not a race. (The
 * built-in desktop identities keep their `interpreter` through a command
 * override, so they cannot be repointed at a node script.)
 */
const SLOW_IDENTITY = {
  id: 'fake-slow',
  track: 'cli' as const,
  family: 'claude' as const,
  displayName: 'Fake slow engine',
  command: { executable: NODE, argsPrefix: [SLOW] },
}

interface RunEntry {
  readonly index: number
  readonly agent: string
  readonly started: boolean
  readonly sessionId?: string
  readonly status?: string
  readonly error?: string
}

interface RunManyValue {
  readonly requested: number
  readonly started: number
  readonly failed: number
  readonly runs: readonly RunEntry[]
  readonly hint: string
}

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

describe('agents_run — same input contract as each fan-out entry', () => {
  it('refuses a whitespace-only prompt before any session exists', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)

    await expect(callTool(tools, 'agents_run', { agent: 'claude', prompt: '  \n\t  ' })).rejects.toThrow(
      /prompt is required and must be non-empty/,
    )
    expect(manager.list()).toEqual([])
  })
})

describe('agents_run_many — fan-out', () => {
  it('starts every entry in one call and returns while they are still running', async () => {
    const manager = pool.create(FAST, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)

    const startedAt = Date.now()
    const value = await callTool<RunManyValue>(tools, 'agents_run_many', {
      runs: [
        { agent: 'fake-slow', prompt: 'task one' },
        { agent: 'fake-slow', prompt: 'task two' },
        { agent: 'fake-slow', prompt: 'task three' },
      ],
    })
    const elapsed = Date.now() - startedAt

    expect(value.requested).toBe(3)
    expect(value.started).toBe(3)
    expect(value.failed).toBe(0)
    expect(elapsed).toBeLessThan(1_000)

    const ids = value.runs.map((entry) => entry.sessionId)
    expect(new Set(ids).size).toBe(3)
    for (const entry of value.runs) {
      expect(entry.started).toBe(true)
      expect(entry.status).toBe('running')
      // ...and the kernel really has them: the call is not a dry run.
      expect(manager.status(entry.sessionId ?? '')?.terminal).toBe(false)
    }
  })

  it('keeps the caller\'s order and starts each entry on its own identity', async () => {
    const manager = pool.create(FAST, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const value = await callTool<RunManyValue>(tools, 'agents_run_many', {
      runs: [
        { agent: 'claude', prompt: 'fast one' },
        { agent: 'fake-slow', prompt: 'slow one' },
      ],
    })
    expect(value.runs.map((entry) => entry.index)).toEqual([0, 1])
    expect(value.runs.map((entry) => entry.agent)).toEqual(['claude', 'fake-slow'])
  })
})

describe('agents_run_many — partial failure', () => {
  it('starts the valid entries and reports the bad one, without failing the call', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)

    const value = await callTool<RunManyValue>(tools, 'agents_run_many', {
      runs: [
        { agent: 'claude', prompt: 'first' },
        { agent: 'no-such-agent', prompt: 'second' },
        { agent: 'claude', prompt: 'third' },
      ],
    })

    expect(value.requested).toBe(3)
    expect(value.started).toBe(2)
    expect(value.failed).toBe(1)
    expect(value.runs[0]?.started).toBe(true)
    expect(value.runs[2]?.started).toBe(true)

    const failure = value.runs[1]
    expect(failure?.started).toBe(false)
    // The error is indexable, names the offending value, and says what to do.
    expect(failure?.error).toContain('runs[1]')
    expect(failure?.error).toContain('no-such-agent')
    expect(failure?.error).toContain('agents_probe')
    expect(value.hint).toMatch(/re-send only those/)

    // The two that started are real, live sessions.
    expect(manager.status(value.runs[0]?.sessionId ?? '')).toBeDefined()
    expect(manager.status(value.runs[2]?.sessionId ?? '')).toBeDefined()
  })

  it('reports the concurrency cap per entry instead of queueing', async () => {
    const manager = pool.create(FAST, { maxConcurrent: 1, extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)

    const startedAt = Date.now()
    const value = await callTool<RunManyValue>(tools, 'agents_run_many', {
      runs: [
        { agent: 'fake-slow', prompt: 'one' },
        { agent: 'fake-slow', prompt: 'two' },
        { agent: 'fake-slow', prompt: 'three' },
      ],
    })

    expect(value.started).toBe(1)
    expect(value.failed).toBe(2)
    // Never queued: the refusal is immediate, so the caller's budget is intact.
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    for (const entry of [value.runs[1], value.runs[2]]) {
      expect(entry?.started).toBe(false)
      expect(entry?.error).toContain('limit is 1')
      expect(entry?.error).toContain('agents_cancel')
    }
  })

  it('fails only the entry whose own parameters are invalid', async () => {
    const manager = pool.create(FAST, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const value = await callTool<RunManyValue>(tools, 'agents_run_many', {
      runs: [
        { agent: 'claude', prompt: '   ' },
        { agent: 'fake-slow', prompt: 'fine' },
      ],
    })
    expect(value.started).toBe(1)
    expect(value.runs[0]?.error).toContain('runs[0].prompt')
    expect(value.runs[0]?.error).toContain('cannot see this conversation')
    expect(value.runs[1]?.started).toBe(true)
  })

  it('reports a refused cwd on its entry, naming the value and the allowed roots', async () => {
    const allowed = path.join(here, '..', 'fixtures')
    const manager = pool.create(FAST, { allowedCwd: [allowed] })
    const tools = toolsFor(manager)
    const outside = path.join(here, '..', '..')
    const value = await callTool<RunManyValue>(tools, 'agents_run_many', {
      runs: [{ agent: 'claude', prompt: 'x', cwd: outside }],
    })
    expect(value.failed).toBe(1)
    expect(value.runs[0]?.error).toContain('outside every allowed path')
    expect(value.runs[0]?.error).toContain(allowed)
  })
})

describe('agents_run_many — call-level validation', () => {
  it('rejects an empty batch and points at agents_run', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    await expect(callTool(tools, 'agents_run_many', { runs: [] })).rejects.toThrow(
      /runs must contain at least one entry; for a single task call agents_run instead/,
    )
  })

  it(`rejects more than ${MAX_PARALLEL_RUNS} entries and says how to batch`, async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const runs = Array.from({ length: MAX_PARALLEL_RUNS + 1 }, (_unused, index) => ({
      agent: 'claude',
      prompt: `task ${index}`,
    }))
    const error = await callTool(tools, 'agents_run_many', { runs }).catch((err: unknown) => err as Error)
    expect(error.message).toContain(String(MAX_PARALLEL_RUNS + 1))
    expect(error.message).toContain(`at most ${MAX_PARALLEL_RUNS}`)
    expect(error.message).toContain('batches')
  })

  it('does not start anything when the batch itself is rejected', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    await callTool(tools, 'agents_run_many', { runs: [] }).catch(() => undefined)
    expect(manager.list()).toHaveLength(0)
  })
})

describe('agents_run_many — render', () => {
  it('shows one line per entry plus the batch next step', () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const value: RunManyValue = {
      requested: 2,
      started: 1,
      failed: 1,
      runs: [
        { index: 0, agent: 'claude', started: true, sessionId: 'sess_a', status: 'running' },
        { index: 1, agent: 'ghost', started: false, error: 'runs[1] (ghost): unknown agent "ghost"' },
      ],
      hint: 'half',
    }
    const rendered = renderTool(tools, 'agents_run_many', { runs: [] }, value)
    expect(rendered).toContain('requested 2, started 1, failed 1')
    expect(rendered).toContain('✓ #0 claude → session sess_a')
    expect(rendered).toContain('✗ #1 ghost → runs[1] (ghost): unknown agent')
    expect(rendered).toContain('agents_wait')
    expect(rendered).toContain('"sess_a"')
  })

  it('says what to do when nothing started', () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const rendered = renderTool(
      tools,
      'agents_run_many',
      { runs: [] },
      { requested: 1, started: 0, failed: 1, runs: [{ index: 0, agent: 'ghost', started: false, error: 'nope' }], hint: '' },
    )
    expect(rendered).toContain('Nothing started')
    expect(rendered).toContain('agents_probe')
  })
})
