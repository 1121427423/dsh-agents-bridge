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
import { callTool, toolsFor } from '../helpers/tool-harness.ts'

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
