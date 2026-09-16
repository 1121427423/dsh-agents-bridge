/**
 * Error copy — the "what do I change next?" contract.
 *
 * Every message in this file is read by a model that has just failed and has to
 * decide its next call. "unknown agent" alone costs another turn of guessing;
 * "unknown agent \"ghost\"; call agents_probe for the ids this bridge can drive"
 * does not. These assertions are deliberately substring-level: they are a
 * regression fence around the *advice*, not around the prose.
 *
 * @module tests/tools/error-copy
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ManagerPool, NODE } from '../helpers/manager-harness.ts'
import { callTool, toolsFor } from '../helpers/tool-harness.ts'

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

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

/** Runs a call and returns the thrown message (failing if it did not throw). */
async function failure(tools: ReturnType<typeof toolsFor>, name: string, args: unknown): Promise<string> {
  const error = await callTool(tools, name, args).then(
    () => undefined,
    (err: unknown) => err as Error,
  )
  expect(error, `${name} was expected to refuse`).toBeInstanceOf(Error)
  return error?.message ?? ''
}

describe('error copy — unknown agent', () => {
  it('names the offending id, lists the known identities, and points at agents_probe', async () => {
    // `scan: false` keeps this suite off the host's installed applications.
    const manager = pool.create(FAST, { scan: false })
    const tools = toolsFor(manager)
    const message = await failure(tools, 'agents_run', { agent: 'ghost', prompt: 'x' })
    expect(message).toContain('ghost')
    expect(message).toContain('agents_probe')
    expect(message).toContain('Known identities:')
    expect(message).toContain('claude')
  })

  it('gives the same advice through agents_run_many, prefixed with the entry', async () => {
    const manager = pool.create(FAST, { scan: false })
    const tools = toolsFor(manager)
    const value = await callTool<{ runs: readonly { error?: string }[] }>(tools, 'agents_run_many', {
      runs: [{ agent: 'ghost', prompt: 'x' }],
    })
    expect(value.runs[0]?.error).toContain('runs[0]')
    expect(value.runs[0]?.error).toContain('agents_probe')
  })
})

describe('error copy — cwd outside the allow-list', () => {
  it('names the rejected value and the allowed range', async () => {
    const allowed = path.join(here, '..', 'fixtures')
    const outside = path.join(here, '..', '..')
    const manager = pool.create(FAST, { allowedCwd: [allowed] })
    const tools = toolsFor(manager)
    const message = await failure(tools, 'agents_run', { agent: 'claude', prompt: 'x', cwd: outside })
    expect(message).toContain('outside every allowed path')
    expect(message).toContain(allowed)
    expect(message).toContain('cwd')
  })

  it('names a cwd that does not exist instead of leaving it to the child process', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const message = await failure(tools, 'agents_run', {
      agent: 'claude',
      prompt: 'x',
      cwd: '/definitely/not/here',
    })
    expect(message).toContain('/definitely/not/here')
    expect(message).toContain('does not exist')
    expect(message).toContain('absolute path')
  })
})

describe('error copy — unknown session', () => {
  it('lists the sessions it knows and names agents_status', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const snapshot = await manager.run({ agent: 'claude', prompt: 'x' })

    for (const tool of ['agents_status', 'agents_output', 'agents_cancel', 'agents_wait', 'agents_usage']) {
      const message = await failure(tools, tool, { sessionId: 'sess_nope', sessionIds: ['sess_nope'] })
      expect(message, tool).toContain('sess_nope')
      expect(message, tool).toContain(snapshot.sessionId)
      expect(message, tool).toContain('agents_status')
    }
  })

  it('says what exists when there is nothing yet', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const message = await failure(tools, 'agents_output', { sessionId: 'sess_nope' })
    expect(message).toContain('no sessions yet')
    expect(message).toContain('agents_run')
  })
})

describe('error copy — the concurrency cap', () => {
  it('says how many are running, what the limit is, and how to get out', async () => {
    const manager = pool.create(FAST, { maxConcurrent: 1, extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    await callTool(tools, 'agents_run', { agent: 'fake-slow', prompt: 'first' })

    const message = await failure(tools, 'agents_run', { agent: 'fake-slow', prompt: 'second' })
    expect(message).toContain('1 session(s) are already running')
    expect(message).toContain('limit is 1')
    expect(message).toContain('agents_status')
    expect(message).toContain('agents_cancel')
    expect(message).toContain('maxConcurrent')
  })
})

describe('error copy — agents_send', () => {
  it('tells the model to wait or start over when the session is still running', async () => {
    const manager = pool.create(FAST, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const snapshot = await manager.run({ agent: 'fake-slow', prompt: 'first' })

    const message = await failure(tools, 'agents_send', { sessionId: snapshot.sessionId, prompt: 'more' })
    expect(message).toContain('still running')
    expect(message).toContain('agents_status')
    expect(message).toContain('agents_run')
  })

  it('tells the model what to do for a session it has never heard of', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const message = await failure(tools, 'agents_send', { sessionId: 'sess_nope', prompt: 'more' })
    expect(message).toContain('sess_nope')
    expect(message).toContain('agents_status')
    expect(message).toContain('agents_run')
  })
})

describe('error copy — an identity that exists but cannot be driven', () => {
  it('reports the boundary and points at agents_probe', async () => {
    const manager = pool.create(FAST, { scan: false })
    const tools = toolsFor(manager)
    const message = await failure(tools, 'agents_run', { agent: 'mimo', prompt: 'x' })
    expect(message).toContain('mimo')
    expect(message).toContain('cannot be driven')
    expect(message).toContain('agents_probe')
  })
})

describe('error copy — agents_cancel on a session that is already done', () => {
  it('says the session is terminal and that new work needs agents_run', async () => {
    const manager = pool.create(FAST)
    const tools = toolsFor(manager)
    const snapshot = await manager.run({ agent: 'claude', prompt: 'x' })
    // Wait for it to settle so the cancel has nothing to do.
    for (let i = 0; i < 200 && manager.status(snapshot.sessionId)?.terminal !== true; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const value = await callTool<{ cancelled: boolean; note: string }>(tools, 'agents_cancel', {
      sessionId: snapshot.sessionId,
    })
    expect(value.cancelled).toBe(false)
    expect(value.note).toContain('already')
    expect(value.note).toContain('agents_run')
  })
})
