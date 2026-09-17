/**
 * Manager memory/lifecycle bounds.
 *
 *   - IM-7: terminal sessions used to stay in `live` with their whole transcript
 *     for the life of the host. They now move to a small finished-LRU (with the
 *     transcript) and spill to a compact row; the transcript itself is a capped
 *     drop-oldest ring.
 *   - MI-7: when `cancelInternal` FORCES a terminal state because the driver's
 *     `done` never settles, the poll has to stop and the run task has to finish —
 *     otherwise the record is pinned in `live` and the interval keeps reading a
 *     handle nobody will ever complete.
 *
 * Both use an injected backend, so no real process is needed and the assertions
 * are about the manager's own bookkeeping.
 *
 * @module tests/kernel/manager-lifecycle
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLogger } from '../../src/kernel/logger.ts'
import { createAgentManager } from '../../src/kernel/manager.ts'
import { MAX_TRANSCRIPT_MESSAGES } from '../../src/kernel/session.ts'
import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentSessionHandle,
} from '../../src/kernel/types.ts'
import { ManagerPool, sleep, waitTerminal } from '../helpers/manager-harness.ts'

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

function textMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'text' as const,
    content: `event-${index}`,
    at: index,
  }))
}

/**
 * A backend whose handle carries `events` pre-made messages and settles
 * `completed` on the next microtask. `reads` counts how often the manager polled
 * the handle's transcript.
 */
function quickBackend(events: number): { backend: AgentBackend; reads: () => number } {
  let reads = 0
  let counter = 0
  const backend: AgentBackend = {
    family: 'claude',
    async run(opts) {
      counter += 1
      const sessionId = `fake_${counter}`
      const startedAt = Date.now()
      const messages = textMessages(events)
      let resolveDone: (result: AgentResult) => void = () => {}
      const done = new Promise<AgentResult>((resolve) => {
        resolveDone = resolve
      })
      const result: AgentResult = {
        sessionId,
        agentId: opts.agent,
        status: 'completed',
        exitCode: 0,
        text: 'ok',
        durationMs: 1,
      }
      const handle: AgentSessionHandle = {
        sessionId,
        agentId: opts.agent,
        startedAt,
        get messages() {
          reads += 1
          return messages
        },
        done,
        async cancel() {},
        snapshot: () => ({
          sessionId,
          agentId: opts.agent,
          status: 'running',
          startedAt,
          messageCount: messages.length,
          terminal: false,
        }),
      }
      queueMicrotask(() => resolveDone(result))
      return handle
    },
  }
  return { backend, reads: () => reads }
}

/** A backend whose `done` NEVER settles, so only the manager can end the run. */
function wedgedBackend(): { backend: AgentBackend; reads: () => number } {
  let reads = 0
  let counter = 0
  const backend: AgentBackend = {
    family: 'claude',
    async run(opts) {
      counter += 1
      const sessionId = `wedged_${counter}`
      const startedAt = Date.now()
      const handle: AgentSessionHandle = {
        sessionId,
        agentId: opts.agent,
        startedAt,
        get messages() {
          reads += 1
          return []
        },
        done: new Promise<AgentResult>(() => {}), // never settles
        async cancel() {},
        snapshot: () => ({
          sessionId,
          agentId: opts.agent,
          status: 'running',
          startedAt,
          messageCount: 0,
          terminal: false,
        }),
      }
      return handle
    },
  }
  return { backend, reads: () => reads }
}

function managerFor(backend: AgentBackend) {
  return pool.add(
    createAgentManager({
      logger: createLogger('lifecycle-test'),
      storeDir: mkdtempSync(path.join(tmpdir(), 'bridge-lifecycle-')),
      defaultCwd: tmpdir(),
      createBackend: () => backend,
      scan: false,
    }),
  )
}

describe('IM-7: transcripts are capped and terminal sessions are evicted', () => {
  it('caps one session\'s transcript and says how much it dropped', async () => {
    const { backend } = quickBackend(MAX_TRANSCRIPT_MESSAGES + 250)
    const manager = managerFor(backend)

    const started = await manager.run({ agent: 'claude', prompt: 'flood', timeoutMs: 0 })
    await waitTerminal(manager, started.sessionId)

    const snapshot = manager.status(started.sessionId)
    expect(snapshot?.messageCount).toBeLessThanOrEqual(MAX_TRANSCRIPT_MESSAGES)

    const output = manager.output(started.sessionId)
    expect(output?.messages.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_MESSAGES)
    // The head is the synthetic marker, so a reader is told the transcript is a
    // tail rather than silently shown a shorter one.
    expect(output?.messages[0]?.type).toBe('status')
    expect(output?.messages[0]?.content).toContain('transcript truncated')
    // The newest events survive: drop-OLDEST, not drop-newest.
    expect(output?.messages[output.messages.length - 1]?.content).toBe(
      `event-${MAX_TRANSCRIPT_MESSAGES + 249}`,
    )
  })

  it('keeps only a small window of full transcripts, spilling the rest', async () => {
    const { backend } = quickBackend(3)
    const manager = managerFor(backend)

    const ids: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const started = await manager.run({ agent: 'claude', prompt: `run ${index}`, timeoutMs: 0 })
      ids.push(started.sessionId)
      await waitTerminal(manager, started.sessionId)
    }
    // Let the settle `finally` retire the last sessions.
    await sleep(50)

    // The oldest fell out of the finished-LRU: metadata survives, transcript does
    // not. A `live` that never shed terminal sessions would still return them.
    expect(manager.status(ids[0]!)?.terminal).toBe(true)
    expect(manager.output(ids[0]!)?.messages).toEqual([])

    // The newest session still has its transcript.
    expect(manager.output(ids[ids.length - 1]!)?.messages.length).toBe(3)

    // Every session is still listed exactly once.
    const listed = manager.list().filter((snapshot) => ids.includes(snapshot.sessionId))
    expect(listed).toHaveLength(ids.length)
  })
})

describe('MI-7: forcing a terminal state stops the poll and finishes the run', () => {
  it('stops reading the handle once a wedged driver is force-cancelled', async () => {
    const { backend, reads } = wedgedBackend()
    const manager = managerFor(backend)

    const started = await manager.run({ agent: 'claude', prompt: 'wedged', timeoutMs: 0 })
    await sleep(250)
    expect(manager.status(started.sessionId)?.status).toBe('running')

    // cancel() blocks through CANCEL_SETTLE_MS (the driver never settles), then
    // forces the terminal state.
    expect(await manager.cancel(started.sessionId, 'forced')).toBe(true)
    const terminal = manager.status(started.sessionId)
    expect(terminal?.terminal).toBe(true)
    expect(terminal?.status).toBe('cancelled')

    // Give the interval ample time to tick if it were still armed.
    const atTerminal = reads()
    await sleep(400)
    expect(reads()).toBe(atTerminal)
  })
})
