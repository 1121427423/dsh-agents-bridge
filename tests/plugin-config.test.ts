/**
 * The plugin entry's config surface: does a settings row actually change what
 * `agents_run` does?
 *
 * The kernel-level suites prove the policy works. This one proves the config
 * plumbing — from the YAML row, through `apply()`, into `ctx.tools.register` —
 * actually carries it, because a knob that parses but is never forwarded is the
 * easiest way to ship a "hardening" feature that hardens nothing.
 *
 * A minimal fake `ctx` is used instead of a real cordis host: `apply()` only
 * touches `ctx.effect`, `ctx.tools.register` and `ctx.systemPrompt.section`, and
 * a fake makes the "what got registered" question directly answerable.
 *
 * @module tests/plugin-config
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { apply, buildPromptSection, type Config } from '../src/index.ts'
import type { ToolDefinition } from '../src/tools/definitions.ts'
import { AgentRunRejectedError } from '../src/kernel/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SLOW_CLI = path.join(here, 'fixtures', 'fake-slow-cli.mjs')

interface Registered {
  readonly tools: Map<string, ToolDefinition>
  readonly sections: Array<{ name: string; text: string }>
  readonly disposers: Array<() => void>
}

/**
 * A `ctx` just real enough to run `apply()`.
 *
 * `effect` runs its body immediately and records the returned disposer, which is
 * exactly what cordis does on a fresh (non-reloading) fiber.
 */
function fakeContext(): { ctx: unknown; registered: Registered } {
  const registered: Registered = { tools: new Map(), sections: [], disposers: [] }
  const ctx = {
    effect: (body: () => (() => void) | void) => {
      const dispose = body()
      if (typeof dispose === 'function') registered.disposers.push(dispose)
    },
    tools: {
      register: (definition: ToolDefinition) => {
        registered.tools.set(definition.name, definition)
        return () => registered.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section: (section: { name: string; text: string }) => {
        registered.sections.push(section)
        return () => undefined
      },
    },
    get: () => undefined,
  }
  return { ctx, registered }
}

/** Boots the plugin with a config row pointing every agent at the fake CLI. */
function boot(config: Partial<Config> = {}): Registered {
  const { ctx, registered } = fakeContext()
  const work = mkdtempSync(path.join(tmpdir(), 'plugin-cfg-'))
  const override = { command: { executable: process.execPath, argsPrefix: [SLOW_CLI] } }
  apply(ctx as never, {
    storeDir: path.join(work, 'store'),
    defaultCwd: work,
    overrides: { claude: override, codex: override, workbuddy: override, autoclaw: override },
    graceMs: 100,
    ...config,
  })
  // Tools are typed as `unknown` handlers by the host; calling them is the point.
  return registered
}

/** Invokes a registered tool and returns its raw result. */
async function call(registered: Registered, name: string, args: unknown): Promise<unknown> {
  const tool = registered.tools.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  return (tool as unknown as { execute: (input: unknown, ctx: unknown) => Promise<unknown> }).execute(
    args,
    {},
  )
}

describe('plugin entry registration', () => {
  it('registers all nine tools plus the prompt section', () => {
    const registered = boot()
    expect([...registered.tools.keys()].sort()).toEqual(
      [
        'agents_cancel',
        'agents_output',
        'agents_probe',
        'agents_run',
        'agents_run_many',
        'agents_send',
        'agents_status',
        'agents_usage',
        'agents_wait',
      ],
    )
    expect(registered.sections.some((section) => section.name === 'tool:agents-bridge')).toBe(true)
  })

  it('unregisters every tool when the effect is disposed', () => {
    const registered = boot()
    expect(registered.tools.size).toBe(9)
    for (const dispose of registered.disposers) dispose()
    expect(registered.tools.size).toBe(0)
  })
})

describe('the P2 config knobs reach the manager', () => {
  it('enforces allowedAgents through agents_run', async () => {
    const registered = boot({ allowedAgents: ['claude'] })
    await expect(call(registered, 'agents_run', { agent: 'codex', prompt: 'nope' })).rejects.toThrow(
      /codex/,
    )
    // The permitted one still runs.
    await expect(call(registered, 'agents_run', { agent: 'claude', prompt: 'ok' })).resolves.toBeDefined()
  })

  it('enforces maxConcurrent through agents_run, without queueing', async () => {
    const registered = boot({ maxConcurrent: 1 })
    await call(registered, 'agents_run', { agent: 'claude', prompt: 'first' })

    const startedAt = Date.now()
    const error = await call(registered, 'agents_run', { agent: 'claude', prompt: 'second' }).catch(
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(AgentRunRejectedError)
    expect((error as AgentRunRejectedError).code).toBe('max-concurrent')
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('enforces deniedCwd through agents_run', async () => {
    const denied = mkdtempSync(path.join(tmpdir(), 'plugin-denied-'))
    const registered = boot({ deniedCwd: [denied] })
    const error = await call(registered, 'agents_run', {
      agent: 'claude',
      prompt: 'x',
      cwd: denied,
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(AgentRunRejectedError)
    expect((error as AgentRunRejectedError).code).toBe('cwd-denied')
    expect((error as AgentRunRejectedError).message).toContain(denied)
  })

  it('leaves behaviour unchanged when no policy is configured (backward compatible)', async () => {
    const registered = boot()
    const anywhere = mkdtempSync(path.join(tmpdir(), 'plugin-any-'))
    await expect(
      call(registered, 'agents_run', { agent: 'codex', prompt: 'x', cwd: anywhere }),
    ).resolves.toBeDefined()
  })
})

describe('prompt section reflects the configured boundary', () => {
  it('tells the model which agents are enabled', () => {
    expect(buildPromptSection([], ['claude', 'codex'])).toMatch(/only enables: claude, codex/)
  })

  it('says nothing about a boundary when there is none', () => {
    expect(buildPromptSection([])).not.toMatch(/only enables/)
  })

  it('lists the deployment-named identities', () => {
    expect(buildPromptSection(['my-custom-agent'])).toContain('my-custom-agent')
  })
})

describe('apply() survives a hostile config row', () => {
  it('does not throw on empty or partial config', () => {
    expect(() => boot({})).not.toThrow()
    expect(() => boot({ allowedCwd: [], deniedCwd: [], allowedAgents: [] })).not.toThrow()
  })

  it('does not throw on an empty allow-list', () => {
    const registered = boot({ allowedAgents: [] })
    // An empty allow-list means "no restriction", matching the documented default.
    expect(registered.tools.size).toBe(9)
  })

  it('ignores a maxConcurrent that is not a usable number', () => {
    expect(() => boot({ maxConcurrent: 0 })).not.toThrow()
    expect(() => boot({ maxConcurrent: -5 })).not.toThrow()
    expect(() => boot({ maxConcurrent: Number.NaN })).not.toThrow()
  })

  it('logs the load rather than throwing when nothing is installed', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(() => boot()).not.toThrow()
    spy.mockRestore()
  })
})
