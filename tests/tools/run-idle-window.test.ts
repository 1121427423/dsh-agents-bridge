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

/**
 * RR-MI-9 — a run window the model supplies is refused before it reaches the
 * kernel when it is not a window at all.
 *
 * `0` is "no deadline" deep in the kernel, but on the MODEL-facing knob it is
 * the one value that cannot mean what it looks like: an idle window of 0 ms is
 * not "never fail on idle", it silently disables the idle watchdog, which is
 * the opposite of what a caller writing a small number meant. The same goes for
 * a negative value and for a fraction that floors to 0. So the tool refuses
 * them and says what to write instead, rather than forwarding a number whose
 * meaning nobody chose.
 *
 * A fraction that floors to a REAL window is not refused — it is normalized
 * (floored) like every other window, which is what the last test pins.
 */
describe('agents_run — a non-positive idle window is refused, not forwarded (RR-MI-9)', () => {
  it('refuses idleTimeoutMs 0 and never reaches the kernel', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    const refusal = callTool(tools, 'agents_run', {
      agent: 'fake-slow',
      prompt: 'never finishes on its own',
      idleTimeoutMs: 0,
    })
    await expect(refusal).rejects.toThrow(/idleTimeoutMs/)
    // A parameter refusal, not a run failure: it must not wear the
    // "nothing was started, check the concurrency cap" tail.
    await expect(refusal).rejects.not.toThrow(/Nothing was started/)

    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a negative idleTimeoutMs', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    await expect(
      callTool(tools, 'agents_run', {
        agent: 'fake-slow',
        prompt: 'never finishes on its own',
        idleTimeoutMs: -30_000,
      }),
    ).rejects.toThrow(/idleTimeoutMs/)

    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a fractional idleTimeoutMs that floors to 0', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    await expect(
      callTool(tools, 'agents_run', {
        agent: 'fake-slow',
        prompt: 'never finishes on its own',
        idleTimeoutMs: 0.5,
      }),
    ).rejects.toThrow(/idleTimeoutMs/)

    expect(run).not.toHaveBeenCalled()
  })

  it('negative control — the declared schema itself refuses a non-integer window', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)
    const run = vi.spyOn(manager, 'run')

    // `idleTimeoutMs` is declared `integer`, and the runtime enforces that
    // BEFORE `execute` runs — so a fraction never reaches the tool body. The
    // kernel-side normalizer still floors one (see the manager suite) because a
    // direct kernel caller is not validated here.
    await expect(
      callTool(tools, 'agents_run', {
        agent: 'fake-slow',
        prompt: 'never finishes on its own',
        idleTimeoutMs: 1500.7,
      }),
    ).rejects.toThrow(/integer/)

    expect(run).not.toHaveBeenCalled()
  })
})

describe('agents_run_many — one refused window does not take the batch down (RR-MI-9)', () => {
  it('refuses the offending entry and still starts the others', async () => {
    const manager = pool.create(SLOW, { extraDescriptors: [SLOW_IDENTITY] })
    const tools = toolsFor(manager)

    const value = await callTool<{ runs: Array<{ started: boolean; error?: string }> }>(
      tools,
      'agents_run_many',
      {
        runs: [
          { agent: 'fake-slow', prompt: 'a', idleTimeoutMs: 0 },
          { agent: 'fake-slow', prompt: 'b', idleTimeoutMs: 11_000 },
        ],
      },
    )

    expect(value.runs[0]?.started).toBe(false)
    expect(value.runs[0]?.error).toMatch(/idleTimeoutMs/)
    // Per-entry refusals do not borrow the whole-call failure copy either.
    expect(value.runs[0]?.error).not.toMatch(/Nothing was started/)
    expect(value.runs[1]?.started).toBe(true)
  })
})
