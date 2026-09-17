/**
 * The seat, wired: a real `agents_run` over a real manager, with a registrar in
 * the seat — the join between `src/tools/definitions.ts` and `src/host/jobs.ts`.
 *
 * `tests/host/jobs.test.ts` proves the adapter's own contract with a fake
 * registry. What is left, and what this file covers, is the WIRING, where the
 * silent failure modes live:
 *
 *   - the calling agent (`exec.agent`) is what becomes the job's owner, and it
 *     comes from the execution context rather than from the session;
 *   - with no agent behind the call, no job is created — a job nobody owns is a
 *     notice nobody receives;
 *   - with no registrar in the seat (no job registry on this host), the run
 *     still starts and comes back without a `jobId` — the nine tools are never
 *     gated on this feature;
 *   - the waiter the seat hands the runtime actually settles on the session it
 *     was registered for, which is the only thing that makes a notice possible.
 *
 * @module tests/tools/job-seat
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ManagerPool } from '../helpers/manager-harness.ts'
import { callTool, renderTool, toolsFor } from '../helpers/tool-harness.ts'
import type { JobRegistrar, JobSeat, SessionJobInput } from '../../src/host/jobs.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAST = path.join(here, '..', 'fixtures', 'fake-stream-json-cli.mjs')

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

/** A registrar that records every registration and hands back a stable id. */
function recordingRegistrar(): { readonly seat: JobSeat; readonly seen: SessionJobInput[] } {
  const seen: SessionJobInput[] = []
  const registrar: JobRegistrar = {
    register(input) {
      seen.push(input)
      return `agents-${seen.length}`
    },
    dispose: () => {},
  }
  return { seat: { registrar }, seen }
}

const CALLER = { sessionId: 'sess_caller', id: 'caller-agent' }

describe('the job seat is wired into agents_run', () => {
  it('registers the session under the CALLING agent and returns the job id', async () => {
    const manager = pool.create(FAST, { scan: false })
    const { seat, seen } = recordingRegistrar()
    const tools = toolsFor(manager, seat)

    const value = await callTool<{ sessionId: string; jobId?: string }>(
      tools,
      'agents_run',
      { agent: 'claude', prompt: 'do the thing' },
      { agent: CALLER },
    )

    expect(value.jobId).toBe('agents-1')
    expect(seen).toHaveLength(1)
    // The OWNER is the caller, not the started session: the notice has to land
    // in the conversation that asked for the work.
    expect(seen[0]?.owner).toBe(CALLER)
    expect(seen[0]?.sessionId).toBe(value.sessionId)
    expect(seen[0]?.agentId).toBe('claude')
    expect(seen[0]?.label).toBe('do the thing')

    const text = renderTool(tools, 'agents_run', { agent: 'claude', prompt: 'do the thing' }, value)
    expect(text).toContain('agents-1')
  })

  it('creates no job when the call has no agent behind it (negative control)', async () => {
    const manager = pool.create(FAST, { scan: false })
    const { seat, seen } = recordingRegistrar()
    const tools = toolsFor(manager, seat)

    const value = await callTool<{ sessionId: string; jobId?: string }>(
      tools,
      'agents_run',
      { agent: 'claude', prompt: 'unowned' },
      {}, // no agent — the harness default
    )

    expect(value.jobId).toBeUndefined()
    expect(seen).toHaveLength(0)
    expect(value.sessionId).toMatch(/^sess_/) // the RUN still happened
  })

  it('starts the run and drops the job id when the host has no registry (degradation)', async () => {
    const manager = pool.create(FAST, { scan: false })
    const tools = toolsFor(manager) // empty seat: no jobs service on this host

    const value = await callTool<{ sessionId: string; jobId?: string }>(
      tools,
      'agents_run',
      { agent: 'claude', prompt: 'still works' },
      { agent: CALLER },
    )

    expect(value.jobId).toBeUndefined()
    expect(value.sessionId).toMatch(/^sess_/)
    const text = renderTool(tools, 'agents_run', { agent: 'claude', prompt: 'still works' }, value)
    expect(text).not.toContain('host job')
  })

  it('registers every entry of a fan-out separately', async () => {
    const manager = pool.create(FAST, { scan: false })
    const { seat, seen } = recordingRegistrar()
    const tools = toolsFor(manager, seat)

    const value = await callTool<{ runs: { jobId?: string; sessionId?: string }[] }>(
      tools,
      'agents_run_many',
      { runs: [
        { agent: 'claude', prompt: 'one' },
        { agent: 'claude', prompt: 'two' },
      ] },
      { agent: CALLER },
    )

    expect(seen).toHaveLength(2)
    expect(value.runs.map(entry => entry.jobId)).toEqual(['agents-1', 'agents-2'])
    expect(new Set(value.runs.map(entry => entry.sessionId)).size).toBe(2)
  })

  it('hands the runtime a waiter that really settles on ITS session', async () => {
    const manager = pool.create(FAST, { scan: false })
    const { seat, seen } = recordingRegistrar()
    const tools = toolsFor(manager, seat)

    await callTool(tools, 'agents_run', { agent: 'claude', prompt: 'waits' }, { agent: CALLER })
    const waiter = seen[0]?.waitTerminal
    expect(waiter).toBeDefined()

    const snapshot = await waiter?.()
    expect(snapshot?.terminal).toBe(true)
    expect(snapshot?.sessionId).toBe(seen[0]?.sessionId)

    // …and the tail the notice quotes is drawn from that same session.
    const tail = seen[0]?.tail()
    expect(tail === undefined || typeof tail === 'string').toBe(true)
  })
})
