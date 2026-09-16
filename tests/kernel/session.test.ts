import { describe, expect, it, vi } from 'vitest'

import { createAgentSession } from '../../src/kernel/session.ts'

describe('createAgentSession', () => {
  it('buffers pushed events and timestamps them', () => {
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude' })
    session.push({ type: 'text', content: 'hello' })
    session.push({ type: 'status', level: 'info', content: 'working', at: 1234 })

    expect(session.messages).toHaveLength(2)
    expect(typeof session.messages[0]?.at).toBe('number')
    expect(session.messages[1]?.at).toBe(1234)
    const snapshot = session.snapshot()
    expect(snapshot.messageCount).toBe(2)
    expect(snapshot.lastMessage?.content).toBe('working')
    expect(snapshot.terminal).toBe(false)
    expect(snapshot.status).toBe('running')
  })

  it('copies only new events from a driver buffer', () => {
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude' })
    const source = [
      { type: 'text' as const, content: 'a', at: 1 },
      { type: 'text' as const, content: 'b', at: 2 },
    ]
    expect(session.sync(source)).toBe(2)
    expect(session.sync(source)).toBe(0)
    source.push({ type: 'text', content: 'c', at: 3 })
    expect(session.sync(source)).toBe(1)
    expect(session.messages.map((m) => m.content)).toEqual(['a', 'b', 'c'])
  })

  it('re-reads a swapped driver buffer instead of losing events', () => {
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude' })
    session.sync([
      { type: 'text', content: 'a', at: 1 },
      { type: 'text', content: 'b', at: 2 },
    ])
    expect(session.sync([{ type: 'text', content: 'fresh', at: 3 }])).toBe(1)
    expect(session.messages.map((m) => m.content)).toEqual(['a', 'b', 'fresh'])
  })

  it('settles done exactly once and freezes the transcript', async () => {
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude', startedAt: 1_000 })
    session.push({ type: 'text', content: 'before' })
    const first = session.complete({
      status: 'completed',
      exitCode: 0,
      text: 'done',
      backendSessionId: 'backend-1',
      endedAt: 1_500,
    })
    const second = session.complete({ status: 'failed', exitCode: 1, text: 'ignored' })

    expect(second).toBe(first)
    expect(first.durationMs).toBe(500)
    expect(first.backendSessionId).toBe('backend-1')
    await expect(session.done).resolves.toBe(first)

    session.push({ type: 'text', content: 'after' })
    expect(session.messages).toHaveLength(1)

    const snapshot = session.snapshot()
    expect(snapshot.terminal).toBe(true)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.endedAt).toBe(1_500)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.result)).toBe(true)
  })

  it('calls the cancel handler once and stays idempotent', async () => {
    const handler = vi.fn(async () => {
      session.complete({ status: 'cancelled', exitCode: null, text: '' })
    })
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude', onCancel: handler })

    await session.cancel('user asked')
    await session.cancel('again')
    session.setCancelHandler(handler)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('user asked')
    expect(session.cancelRequested).toBe(true)
    expect(session.cancelReason).toBe('user asked')
    expect(session.snapshot().status).toBe('cancelled')
    expect(session.snapshot().terminal).toBe(true)
  })

  it('is a no-op when cancelled after the terminal state', async () => {
    const handler = vi.fn()
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude', onCancel: handler })
    session.complete({ status: 'completed', exitCode: 0, text: 'ok' })
    await session.cancel('too late')
    expect(handler).not.toHaveBeenCalled()
    expect(session.cancelRequested).toBe(false)
    expect(session.snapshot().status).toBe('completed')
  })

  it('lets a timeout override whatever the driver reports', () => {
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude' })
    session.markTimedOut('idle')
    session.markTimedOut('timeout') // first marker wins
    expect(session.timeoutKind).toBe('idle')
    expect(session.terminalOverride()).toBe('timeout')
    const result = session.complete({ status: 'completed', exitCode: 0, text: 'late' })
    expect(result.status).toBe('timeout')
    expect(session.snapshot().status).toBe('timeout')
  })

  it('resolves done when the driver never settles after a cancel', async () => {
    const session = createAgentSession({ sessionId: 's1', agentId: 'claude', onCancel: () => {} })
    await session.cancel('wedged')
    expect(session.snapshot().terminal).toBe(false)
    session.complete({ status: 'cancelled', exitCode: null, text: '' })
    await expect(session.done).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('swallows a throwing cancel handler', async () => {
    const session = createAgentSession({
      sessionId: 's1',
      agentId: 'claude',
      onCancel: () => {
        throw new Error('handler exploded')
      },
    })
    await expect(session.cancel('boom')).resolves.toBeUndefined()
    expect(session.cancelRequested).toBe(true)
  })
})
