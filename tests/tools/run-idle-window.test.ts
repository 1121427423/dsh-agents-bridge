/**
 * `idleTimeoutMs` is part of the caller-facing run contract (IM-8).
 *
 * The drivers' own per-family windows are safety nets, not budgets, and the
 * claude/codebuddy stream is silent for the whole duration of a tool call. A
 * caller that knows its task fires a long tool therefore needs a way to widen
 * the window explicitly — which means the knob has to be in the tool schema and
 * has to reach `manager.run`, not just exist on the frozen ABI.
 *
 * The `agents_run_many` form carries it per entry, exactly like `timeoutMs`;
 * an omitted knob is absent rather than `undefined`, so the kernel's own
 * per-family default still applies.
 *
 * @module tests/tools/run-idle-window
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ManagerPool, NODE } from '../helpers/manager-harness.ts'
import { callTool, toolsFor } from '../helpers/tool-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SLOW = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

/** A `claude`-family identity that never finishes, so nothing races the assert. */
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

describe('agents_run — the idle window is callable', () => {
  it('forwards idleTimeoutMs to the kernel', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    await callTool(tools, 'agents_run', {
      agent: 'fake-slow',
      prompt: 'never finishes on its own',
      idleTimeoutMs: 7_000,
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({ idleTimeoutMs: 7_000 })
  })

  it('omits the knob entirely when the caller leaves it out', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    await callTool(tools, 'agents_run', { agent: 'fake-slow', prompt: 'x' })

    const options = run.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    // Absent, not `undefined`: the kernel distinguishes "unset" (family default)
    // from an explicit value, and `{ idleTimeoutMs: undefined }` would be
    // indistinguishable to a future `in`-based check.
    expect(options).not.toHaveProperty('idleTimeoutMs')
  })
})

describe('agents_run_many — the same knob per entry', () => {
  it('forwards each entry\'s idleTimeoutMs', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    const value = await callTool<{ runs: Array<{ started: boolean }> }>(tools, 'agents_run_many', {
      runs: [
        { agent: 'fake-slow', prompt: 'a', idleTimeoutMs: 11_000 },
        { agent: 'fake-slow', prompt: 'b' },
      ],
    })

    expect(value.runs[0]?.started).toBe(true)
    expect(run.mock.calls[0]?.[0]).toMatchObject({ idleTimeoutMs: 11_000 })
    expect(run.mock.calls[1]?.[0]).not.toHaveProperty('idleTimeoutMs')
  })
})
