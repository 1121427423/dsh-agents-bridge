/**
 * The `ctx.jobs` seam — session completion notices.
 *
 * RED-FIRST NOTE. These cases import `src/host/jobs.ts`, which does not exist
 * before this change, so running this file against the pre-change tree fails at
 * import time (that is the recorded RED). The BEHAVIOURAL red — a delegation
 * that finishes without ever announcing itself — is demonstrated end to end by
 * the headless smoke in §U of `docs/review-fixes.md`, not here.
 *
 * The registry itself is faked on purpose. What this file has to prove is the
 * SEAM's own contract, which is where the mistakes live:
 *
 *   - `attachController` before any `start` (the runtime refuses starts with no
 *     controller, and a missing notice is indistinguishable from a slow run);
 *   - an unowned job is NOT created (it would settle with no session to
 *     announce into, and clutter every caller's job list);
 *   - `cancel` is synchronous and idempotent, and a throw from the bridge's
 *     cancel does not escape into the runtime;
 *   - `done` NEVER rejects (the contract converts a rejection to `failed`, but
 *     a rejected producer promise is still a producer that lied about settling);
 *   - an absent, refusing, or throwing registry degrades to "no notice" without
 *     touching the tool result.
 *
 * @module tests/host/jobs
 */

import { describe, expect, it, vi } from 'vitest'

import {
  JOB_KIND,
  JOB_OUTPUT_LIMIT_BYTES,
  createJobRegistrar,
  type JobHooksFace,
  type JobStartFace,
  type JobsFace,
  type SessionJobInput,
} from '../../src/host/jobs.ts'
import { createLogger } from '../../src/kernel/logger.ts'
import type { SessionSnapshot } from '../../src/kernel/types.ts'

const logger = createLogger('test', { sink: () => {} })

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'sess_1',
    agentId: 'claude',
    status: 'completed',
    startedAt: 1_000,
    endedAt: 2_500,
    exitCode: 0,
    ...over,
  } as unknown as SessionSnapshot
}

/** A registry that records what it was asked to do. */
function fakeJobs(over: Partial<JobsFace> = {}): {
  readonly jobs: JobsFace
  readonly starts: JobStartFace[]
  readonly controllerNames: string[]
  readonly controllerDisposed: () => number
} {
  const starts: JobStartFace[] = []
  const controllerNames: string[] = []
  let disposals = 0
  const jobs: JobsFace = {
    start: spec => {
      starts.push(spec)
      return `agents-${starts.length}`
    },
    attachController: name => {
      controllerNames.push(name)
      return () => {
        disposals += 1
      }
    },
    ...over,
  }
  return { jobs, starts, controllerNames, controllerDisposed: () => disposals }
}

function input(over: Partial<SessionJobInput> = {}): SessionJobInput {
  return {
    sessionId: 'sess_1',
    agentId: 'claude',
    label: 'refactor the parser',
    owner: { fake: 'agent' },
    waitTerminal: async () => snapshot(),
    cancel: () => {},
    tail: () => 'done: 3 files changed',
    ...over,
  }
}

describe('createJobRegistrar', () => {
  it('attaches a controller before it can start anything, and releases it once', () => {
    const { jobs, controllerNames, controllerDisposed } = fakeJobs()
    const registrar = createJobRegistrar(jobs, logger)
    expect(controllerNames).toEqual(['agents-bridge'])
    registrar.dispose()
    registrar.dispose()
    expect(controllerDisposed()).toBe(1)
  })

  it('starts one job per session with the caller as owner and a bounded label', () => {
    const { jobs, starts } = fakeJobs()
    const registrar = createJobRegistrar(jobs, logger)
    const id = registrar.register(input({ label: 'line one\nline two '.repeat(40) }))
    expect(id).toBe('agents-1')
    expect(starts).toHaveLength(1)
    const spec = starts[0]!
    expect(spec.kind).toBe(JOB_KIND)
    expect(spec.owner).toEqual({ fake: 'agent' })
    expect(spec.outputLimitBytes).toBe(JOB_OUTPUT_LIMIT_BYTES)
    // One line, bounded — a notice is a notice, not the prompt again.
    expect(spec.label).not.toContain('\n')
    expect(spec.label.length).toBeLessThanOrEqual(120)
  })

  it('refuses an unowned call instead of creating a job nobody can be told about', () => {
    const { jobs, starts } = fakeJobs()
    const registrar = createJobRegistrar(jobs, logger)
    expect(registrar.register(input({ owner: undefined }))).toBeUndefined()
    expect(starts).toHaveLength(0)
  })

  it('cancels synchronously and at most once, and a throwing cancel stays inside', () => {
    const { jobs, starts } = fakeJobs()
    const cancel = vi.fn((_reason: string) => {
      throw new Error('stop failed')
    })
    const registrar = createJobRegistrar(jobs, logger)
    registrar.register(input({ cancel }))
    const hooks = starts[0]!.run() as JobHooksFace
    hooks.cancel()
    hooks.cancel('again')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]?.[0]).toBe('cancelled via the job registry')
  })

  it('announces the settlement: mapped status, the session id, and how to read it', async () => {
    const { jobs, starts } = fakeJobs()
    const registrar = createJobRegistrar(jobs, logger)
    registrar.register(input({ waitTerminal: async () => snapshot({ status: 'cancelled' }) }))
    const outcome = await starts[0]!.run().done
    expect(outcome.status).toBe('killed') // cancelled → killed, the registry's word
    expect(outcome.output).toContain('sess_1')
    expect(outcome.output).toContain('agents_output')
    expect(outcome.output).toContain('done: 3 files changed')
  })

  it('never rejects `done`, even when the wait itself fails', async () => {
    const { jobs, starts } = fakeJobs()
    const registrar = createJobRegistrar(jobs, logger)
    registrar.register(input({ waitTerminal: async () => Promise.reject(new Error('boom')) }))
    const outcome = await starts[0]!.run().done
    expect(outcome.status).toBe('failed')
    expect(outcome.output).toContain('boom')
  })

  it('maps every non-completed ending to a non-completed job, and a vanished session to failed', async () => {
    const { jobs, starts } = fakeJobs()
    const registrar = createJobRegistrar(jobs, logger)
    for (const status of ['failed', 'timeout', 'cancelled', 'completed'] as const) {
      registrar.register(input({ sessionId: `sess_${status}`, waitTerminal: async () => snapshot({ status }) }))
    }
    registrar.register(input({ sessionId: 'sess_gone', waitTerminal: async () => undefined }))
    const outcomes = []
    for (const spec of starts) outcomes.push((await spec.run().done).status)
    expect(outcomes).toEqual(['failed', 'failed', 'killed', 'completed', 'failed'])
  })

  it('degrades to no notice when the registry refuses a controller', () => {
    const { jobs, starts } = fakeJobs({
      attachController: () => {
        throw new Error('no controller for you')
      },
    })
    const registrar = createJobRegistrar(jobs, logger)
    expect(registrar.register(input())).toBeUndefined()
    expect(starts).toHaveLength(0)
    expect(() => registrar.dispose()).not.toThrow()
  })

  it('degrades to no notice when `start` throws, leaving the run itself untouched', () => {
    const { jobs } = fakeJobs({
      start: () => {
        throw new Error('registry full')
      },
    })
    const registrar = createJobRegistrar(jobs, logger)
    expect(registrar.register(input())).toBeUndefined()
  })
})
