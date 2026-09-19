/**
 * `agents_send` — the input contract of a follow-up.
 *
 * `agents_run` and every `agents_run_many` entry refuse a whitespace-only
 * prompt at the tool boundary instead of handing it to a driver, which would
 * otherwise shift it into an option or a stdin slot. The resume path takes the
 * same kind of free text, so it owes the same refusal; this suite is the
 * assertion that it does.
 *
 * @module tests/tools/send
 */

import { describe, expect, it } from 'vitest'

import type { AgentManager } from '../../src/kernel/types.ts'
import { callTool, renderTool, toolsFor } from '../helpers/tool-harness.ts'

describe('agents_send — input contract', () => {
  it('refuses a whitespace-only prompt instead of resuming with it', async () => {
    // Deliberately no pool and no real manager: `send` throws if it is ever
    // reached, so the assertion is that the refusal happens at the boundary —
    // nothing is resumed and no session is created.
    const manager = {
      send: () => {
        throw new Error('send must not be reached for a blank prompt')
      },
      list: () => [],
    } as unknown as AgentManager
    const tools = toolsFor(manager)

    await expect(callTool(tools, 'agents_send', { sessionId: 'sess_absent', prompt: '  \n\t  ' })).rejects.toThrow(
      /prompt is required and must be non-empty/,
    )
  })
})

describe('agents_send — honest resume semantics (D43 / audit L4)', () => {
  it('reports the NEW bridge session id and the one it continues via resumedFrom', async () => {
    const manager = {
      send: async (sessionId: string, prompt: string) => {
        expect(sessionId).toBe('sess_prior')
        expect(prompt).toBe('follow up')
        return {
          sessionId: 'sess_followup',
          agentId: 'claude',
          status: 'running',
          startedAt: 0,
          messageCount: 4,
          terminal: false,
        }
      },
      list: () => [],
    } as unknown as AgentManager
    const tools = toolsFor(manager)

    const value = await callTool<{ sessionId: string; resumed: boolean; resumedFrom: string }>(
      tools,
      'agents_send',
      { sessionId: 'sess_prior', prompt: 'follow up' },
    )
    // The kernel always mints a fresh bridge session for a follow-up, so
    // `sessionId === args.sessionId` can NEVER hold; the honest facts are
    // resumed=true (the backend conversation IS being continued) plus
    // resumedFrom naming which one.
    expect(value.sessionId).toBe('sess_followup')
    expect(value.resumed).toBe(true)
    expect(value.resumedFrom).toBe('sess_prior')
  })

  it('render names both ids so the model can quote the follow-up id back', async () => {
    const manager = {
      send: async () => ({
        sessionId: 'sess_followup',
        agentId: 'claude',
        status: 'running',
        startedAt: 0,
        messageCount: 4,
        terminal: false,
      }),
      list: () => [],
    } as unknown as AgentManager
    const tools = toolsFor(manager)
    const args = { sessionId: 'sess_prior', prompt: 'go' }
    const value = await callTool(tools, 'agents_send', args)
    const rendered = renderTool(tools, 'agents_send', args, value)
    expect(rendered).toContain('sess_followup')
    expect(rendered).toContain('sess_prior')
  })
})
