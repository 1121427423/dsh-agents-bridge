/**
 * A run deadline above 2^31 ms must not become an IMMEDIATE timeout.
 *
 * `timeoutMs` is unbounded in the schema because 0 means "no deadline", so a
 * caller expressing "this may take a very long time" naturally writes a very
 * large number. Node rewrites any `setTimeout` delay above 2147483647 ms to
 * **1 ms** (and emits `TimeoutOverflowWarning`), so the raw value would kill the
 * child right after spawn and report the run as `timeout` — the opposite of "no
 * deadline". The cap therefore lives at the tool boundary, where the value
 * enters, and again inside the watchdog (see tests/kernel/watchdog.test.ts).
 *
 * The spy assertion pins the capped value; the liveness assertion pins the
 * consequence (a real child, still running). Both are needed: without the cap
 * the run is reported terminal within milliseconds, which is exactly what these
 * tests observe as red.
 *
 * @module tests/tools/run-timeout
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_TIMER_DELAY_MS } from '../../src/kernel/watchdog.ts'
import { ManagerPool, NODE, sleep } from '../helpers/manager-harness.ts'
import { callTool, toolsFor } from '../helpers/tool-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SLOW = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

/** A `claude`-family identity that never finishes, so "still running" is real. */
const SLOW_IDENTITY = {
  id: 'fake-slow',
  track: 'cli' as const,
  family: 'claude' as const,
  displayName: 'Fake slow engine',
  command: { executable: NODE, argsPrefix: [SLOW] },
}

/** Exactly one above the runtime's timer ceiling. */
const HUGE = 2_147_483_648

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

describe('agents_run — a huge timeoutMs is capped, not collapsed', () => {
  it('caps the value at the timer ceiling before it reaches the kernel', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    await callTool(tools, 'agents_run', {
      agent: 'fake-slow',
      prompt: 'never finishes on its own',
      timeoutMs: HUGE,
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: MAX_TIMER_DELAY_MS })
  })

  it('leaves the session running instead of reporting an immediate timeout', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)

    const value = await callTool<{ sessionId: string; status: string }>(tools, 'agents_run', {
      agent: 'fake-slow',
      prompt: 'never finishes on its own',
      timeoutMs: HUGE,
    })
    expect(value.status).toBe('running')

    // Long enough for an overflowing 1 ms deadline to have fired several times.
    await sleep(150)
    const snapshot = manager.status(value.sessionId)
    expect(snapshot?.terminal).toBe(false)
    expect(snapshot?.status).toBe('running')
  })
})

describe('agents_run_many — the same cap per entry', () => {
  it('caps each entry and leaves the batch running', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    const value = await callTool<{ runs: Array<{ started: boolean; sessionId?: string }> }>(
      tools,
      'agents_run_many',
      { runs: [{ agent: 'fake-slow', prompt: 'never finishes on its own', timeoutMs: HUGE }] },
    )

    expect(value.runs[0]?.started).toBe(true)
    expect(run.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: MAX_TIMER_DELAY_MS })

    await sleep(150)
    const snapshot = manager.status(value.runs[0]?.sessionId ?? '')
    expect(snapshot?.terminal).toBe(false)
    expect(snapshot?.status).toBe('running')
  })
})
