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

/**
 * A backend whose handle stays RUNNING and whose event buffer the TEST drives.
 *
 * `output()` syncs from the handle on every read, so "the cursor was already
 * past the cap when more events arrived" is a deterministic step rather than a
 * race against the manager's poll interval (RR-IM-1).
 */
function streamingBackend(): {
  backend: AgentBackend
  push: (content: string) => void
  finish: () => void
} {
  const messages: AgentMessage[] = []
  let resolveDone: (result: AgentResult) => void = () => {}
  let sessionId = ''
  let agentId = 'claude'
  const done = new Promise<AgentResult>((resolve) => {
    resolveDone = resolve
  })
  const backend: AgentBackend = {
    family: 'claude',
    async run(opts) {
      sessionId = `stream_${opts.agent}`
      agentId = opts.agent
      const startedAt = Date.now()
      return {
        sessionId,
        agentId: opts.agent,
        startedAt,
        get messages() {
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
    },
  }
  return {
    backend,
    push: (content) => {
      messages.push({ type: 'text', content, at: messages.length })
    },
    finish: () => {
      resolveDone({
        sessionId,
        agentId,
        status: 'completed',
        exitCode: 0,
        text: 'ok',
        durationMs: 1,
      })
    },
  }
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
    // The count is ABSOLUTE (events ever seen), so it stays a valid cursor even
    // though the ring only retains MAX positions (RR-IM-1).
    expect(snapshot?.messageCount).toBe(MAX_TRANSCRIPT_MESSAGES + 250)

    const output = manager.output(started.sessionId)
    expect(output?.messages.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_MESSAGES)
    // The truncation is DATA on the read (`dropped` + `firstIndex`), not a
    // synthetic event squatting on an index inside the window: a reader that
    // fell behind is told how much it lost, and the first event it does get
    // still carries its true absolute position.
    expect(output?.messages[0]?.type).toBe('text')
    expect(output?.messages[0]?.content).not.toContain('transcript truncated')
    expect(output?.dropped).toBe(250)
    expect(output?.firstIndex).toBe(250)
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

describe('RR-IM-1: agents_output cursors are absolute and never wedge', () => {
  it('drains a capped transcript with no gap, no duplicate, and keeps delivering past the cap', async () => {
    const { backend, push, finish } = streamingBackend()
    const manager = managerFor(backend)
    const started = await manager.run({ agent: 'claude', prompt: 'flood', timeoutMs: 0 })
    await sleep(50)
    const id = started.sessionId

    // The transcript is ALREADY capped when the reader first looks: this is the
    // lagging reader, and the read must say what it lost instead of silently
    // starting from a position that looks like 0.
    const total = 700
    for (let index = 0; index < total; index += 1) push(`event-${index}`)

    let cursor = 0
    let droppedSeen = 0
    const seen: string[] = []
    const cursors: number[] = []
    for (let guard = 0; guard < 100; guard += 1) {
      const read = manager.output(id, { sinceIndex: cursor, limit: 80 })
      if (read === undefined) throw new Error('output() stopped answering for a live session')
      cursors.push(read.nextIndex)
      droppedSeen = Math.max(droppedSeen, read.dropped ?? 0)
      for (const message of read.messages) seen.push(message.content ?? '')
      if (read.nextIndex === cursor) break
      cursor = read.nextIndex
    }

    // (c) the loss is explicit, not a silent skip.
    expect(droppedSeen).toBe(total - MAX_TRANSCRIPT_MESSAGES)
    // (a) every RETAINED event exactly once, in absolute order, no duplicates,
    // and no synthetic marker occupying an index slot.
    expect(seen).toHaveLength(MAX_TRANSCRIPT_MESSAGES)
    expect(seen[0]).toBe(`event-${total - MAX_TRANSCRIPT_MESSAGES}`)
    expect(seen[seen.length - 1]).toBe(`event-${total - 1}`)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toEqual(
      Array.from({ length: seen.length }, (_, offset) => `event-${total - MAX_TRANSCRIPT_MESSAGES + offset}`),
    )
    // (b) the cursor advanced to the ABSOLUTE end and never moved backwards.
    // Every read that returned events moved it STRICTLY forward; the last read
    // returned nothing (it was already at the end) and reported the same index.
    expect(cursor).toBe(total)
    expect(cursors.length).toBeGreaterThan(2)
    const advances = cursors.slice(0, -1)
    for (let index = 1; index < advances.length; index += 1) {
      expect(advances[index]!).toBeGreaterThan(advances[index - 1]!)
    }
    expect(cursors[cursors.length - 1]).toBe(cursors[cursors.length - 2])

    // The wedge this finding is about: the cursor is now at the absolute end
    // while the ring holds only MAX array positions. A caught-up reader must
    // still receive new events (the old array-position cursor sat at 500 here
    // and returned nothing forever).
    for (let index = total; index < total + 40; index += 1) push(`event-${index}`)
    const resumed = manager.output(id, { sinceIndex: cursor, limit: 80 })
    expect(resumed?.messages.map((message) => message.content)).toEqual(
      Array.from({ length: 40 }, (_, offset) => `event-${total + offset}`),
    )
    expect(resumed?.nextIndex).toBe(total + 40)
    expect(resumed?.dropped).toBe(0)

    finish()
    await waitTerminal(manager, id)
  })
})
