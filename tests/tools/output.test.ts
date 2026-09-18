/**
 * `agents_output` — the incremental read the model trusts to be lossless.
 *
 * Two defects live in this one tool, and both are about the same thing: the
 * value the model is handed must describe the SAME events the render shows it.
 *
 *   - the cursor (`nextIndex`) must be `sinceIndex + rendered`, never the end of
 *     everything the manager happened to return, or a caller that follows the
 *     documented "pass nextIndex back" instruction silently skips the events the
 *     render dropped;
 *   - a text event must start its own block when it follows a tool block, or
 *     prose is glued onto tool output (and loses its own index/type).
 *
 * The manager is a stub rather than a real CLI run because the guardrails are
 * about the tool's projection: a 200-event transcript and a deliberate 80-event
 * render cap are the whole point, and a fake makes both exact.
 *
 * @module tests/tools/output
 */

import { describe, expect, it } from 'vitest'

import type { AgentManager, AgentMessage } from '../../src/kernel/types.ts'
import { callTool, renderTool, toolsFor } from '../helpers/tool-harness.ts'

/** The rendered-event budget `agents_output` documents but must also ENFORCE. */
const MAX_RENDERED_MESSAGES = 80

interface OutputValue {
  readonly sessionId: string
  readonly status: string
  readonly nextIndex: number
  readonly firstIndex?: number
  readonly dropped?: number
  readonly terminal: boolean
  readonly messages: readonly { readonly index: number; readonly type: string; readonly text?: string }[]
  readonly hint: string
}

/**
 * A manager whose `output` copies the real one's cursor contract
 * (`manager.ts:725-733`): `nextIndex` is `sinceIndex + messages.length` for the
 * slice it returns, where the slice is bounded by the caller's `limit`.
 *
 * That is exactly why the tool must SEND a limit: with no limit the manager
 * honestly reports the end of the transcript while the render shows only the
 * first 80 events, and the two disagree.
 */
function transcriptManager(messages: readonly AgentMessage[]): AgentManager {
  return {
    output: (sessionId: string, opts?: { readonly sinceIndex?: number; readonly limit?: number }) => {
      const start = Math.min(Math.max(opts?.sinceIndex ?? 0, 0), messages.length)
      const limit = opts?.limit
      const end = limit !== undefined && limit > 0 ? Math.min(messages.length, start + limit) : messages.length
      return {
        sessionId,
        status: 'running' as const,
        messages: messages.slice(start, end),
        nextIndex: end,
      }
    },
    status: () => ({
      sessionId: 'sess_long',
      agentId: 'claude',
      status: 'running' as const,
      startedAt: 0,
      messageCount: messages.length,
      terminal: false,
    }),
  } as unknown as AgentManager
}

/** `count` distinct log events, one per index — a gap is visible by its text. */
function events(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => ({ type: 'log', content: `event ${index}`, at: index }))
}

describe('agents_output — the cursor never skips an event (IM-17)', () => {
  it('caps the read AND reports a cursor the caller can resume from losslessly', async () => {
    const tools = toolsFor(transcriptManager(events(200)))

    const first = await callTool<OutputValue>(tools, 'agents_output', { sessionId: 'sess_long' })

    // The render shows only the first 80 events…
    expect(first.messages).toHaveLength(MAX_RENDERED_MESSAGES)
    expect(first.messages[0]?.text).toBe('event 0')
    expect(first.messages[MAX_RENDERED_MESSAGES - 1]?.text).toBe(`event ${MAX_RENDERED_MESSAGES - 1}`)
    // …so the cursor must point at the first event NOT shown. Handing back the
    // manager's `200` here is the defect: the documented next call
    // (`sinceIndex=nextIndex`) would skip events 80..199 forever.
    expect(first.nextIndex).toBe(MAX_RENDERED_MESSAGES)
    expect(first.hint).toContain(`sinceIndex=${MAX_RENDERED_MESSAGES}`)

    const second = await callTool<OutputValue>(tools, 'agents_output', {
      sessionId: 'sess_long',
      sinceIndex: first.nextIndex,
    })
    // No gap: the resumed read starts exactly where the previous render stopped.
    expect(second.messages[0]?.index).toBe(MAX_RENDERED_MESSAGES)
    expect(second.messages[0]?.text).toBe(`event ${MAX_RENDERED_MESSAGES}`)
    expect(second.nextIndex).toBe(MAX_RENDERED_MESSAGES * 2)
  })

  it('honours an explicit limit and keeps the cursor arithmetic', async () => {
    // Negative control: the cap rule must not swallow the caller's own budget.
    const tools = toolsFor(transcriptManager(events(200)))

    const value = await callTool<OutputValue>(tools, 'agents_output', {
      sessionId: 'sess_long',
      sinceIndex: 10,
      limit: 5,
    })

    expect(value.messages).toHaveLength(5)
    expect(value.messages.map((message) => message.index)).toEqual([10, 11, 12, 13, 14])
    expect(value.nextIndex).toBe(15)
  })

  it('clamps a limit larger than the render budget', async () => {
    const tools = toolsFor(transcriptManager(events(200)))

    const value = await callTool<OutputValue>(tools, 'agents_output', {
      sessionId: 'sess_long',
      limit: 10_000,
    })

    expect(value.messages).toHaveLength(MAX_RENDERED_MESSAGES)
    expect(value.nextIndex).toBe(MAX_RENDERED_MESSAGES)
  })

  it('a non-positive limit does not turn into "no limit"', async () => {
    // The manager reads `limit > 0` as the bound and anything else as "return
    // everything" (`manager.ts:727`), so forwarding a 0 would reopen the very
    // gap this fix closes. It is reachable: `limit` is a plain integer in the
    // published schema, with no minimum.
    const tools = toolsFor(transcriptManager(events(200)))

    const value = await callTool<OutputValue>(tools, 'agents_output', { sessionId: 'sess_long', limit: 0 })

    expect(value.messages).toHaveLength(1)
    expect(value.nextIndex).toBe(1)
  })

  it('keeps absolute indexes and discloses what the bounded transcript dropped', async () => {
    const messages: readonly AgentMessage[] = [
      { type: 'text', content: 'event 200', at: 200 },
      { type: 'text', content: 'event 201', at: 201 },
    ]
    const manager = {
      output: () => ({
        sessionId: 'sess_long',
        status: 'running' as const,
        messages,
        firstIndex: 200,
        nextIndex: 202,
        dropped: 200,
      }),
      status: () => ({
        sessionId: 'sess_long',
        agentId: 'claude',
        status: 'running' as const,
        startedAt: 0,
        messageCount: 202,
        terminal: false,
      }),
    } as unknown as AgentManager
    const tools = toolsFor(manager)
    const args = { sessionId: 'sess_long', sinceIndex: 0 }

    const value = await callTool<OutputValue>(tools, 'agents_output', args)

    expect(value.firstIndex).toBe(200)
    expect(value.dropped).toBe(200)
    expect(value.messages.map((message) => message.index)).toEqual([200, 201])
    const rendered = renderTool(tools, 'agents_output', args, value)
    expect(rendered).toContain('warning: 200 earlier event(s)')
    expect(rendered).toContain('#200 [text] event 200')
    expect(rendered).not.toContain('#0 [text] event 200')
  })
})

/** The block lines (`#<index> [<type>] …`) out of one rendered read. */
function blockLines(rendered: string): string[] {
  return rendered.split('\n').filter((line) => /^#\d+ \[/.test(line))
}

describe('agents_output — a text event after a tool block starts its own block (IM-19)', () => {
  it('does not glue prose onto tool output', async () => {
    // `textSeen` was set once and never reset, so ANY text event after the first
    // one was appended to whatever block came last — tool_use/tool_result/error
    // included. The prose lost its own index and type and the tool output gained
    // a sentence glued to it.
    const tools = toolsFor(transcriptManager([
      { type: 'text', content: 'a', at: 0 },
      { type: 'tool_use', tool: 'Bash', content: 'out', at: 1 },
      { type: 'text', content: 'b', at: 2 },
    ]))
    const args = { sessionId: 'sess_long' }
    const value = await callTool<OutputValue>(tools, 'agents_output', args)

    const blocks = blockLines(renderTool(tools, 'agents_output', args, value))

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toBe('#0 [text] a')
    expect(blocks[1]).toBe('#1 [tool_use] Bash → out')
    expect(blocks[2]).toBe('#2 [text] b')
  })

  it('still joins consecutive streamed text deltas (the documented join)', async () => {
    // Negative control: the fix must not undo the reason the join exists —
    // dialects that emit one event per streamed fragment.
    const tools = toolsFor(transcriptManager([
      { type: 'text', content: 'a', at: 0 },
      { type: 'text', content: 'b', at: 1 },
    ]))
    const args = { sessionId: 'sess_long' }
    const value = await callTool<OutputValue>(tools, 'agents_output', args)

    const blocks = blockLines(renderTool(tools, 'agents_output', args, value))

    expect(blocks).toEqual(['#0 [text] ab'])
  })
})
