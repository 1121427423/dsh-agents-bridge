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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apply,
  buildPromptSection,
  decideQoderTransport,
  QODER_TRANSPORT_ENV,
  qoderTransportOverrides,
  resolveQoderTransport,
  type Config,
} from '../src/index.ts'
import type { ToolDefinitions } from '../src/tools/definitions.ts'
import { AgentRunRejectedError } from '../src/kernel/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SLOW_CLI = path.join(here, 'fixtures', 'fake-slow-cli.mjs')

/**
 * One entry of the tool table.
 *
 * The export is `ToolDefinitions` (the whole table, `TOOL_NAMES`-ordered); this
 * alias is the element the fake registry stores. It used to import a
 * `ToolDefinition` that never existed — a name that only survived because no
 * typecheck ever compiled the tests (IM-14).
 */
type ToolDefinition = ToolDefinitions[number]

interface Registered {
  readonly tools: Map<string, ToolDefinition>
  readonly sections: Array<{ name: string; text: string }>
  readonly disposers: Array<() => void>
}

/**
 * A `ctx` just real enough to run `apply()`.
 *
 * `effect` runs its body immediately and records the returned disposer, which is
 * exactly what cordis does on a fresh (non-reloading) fiber. `inject` is the
 * scope-injection seam the entry uses for the optional `webServer` service: this
 * host has none, so the callback is simply never run — which is the whole point
 * (the nine tools must not depend on it).
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
    inject: () => undefined,
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

/**
 * D46: one CLI binary, two wires, one switch.
 *
 * Observed through `agents_probe` rather than by reaching into the registry, so
 * these tests prove the plumbing a model actually sees: the row that is NOT
 * selected must report WHY (a reason naming the switch), and the desktop row
 * must be untouched by any of it.
 */
describe('the Qoder CLI transport switch', () => {
  /**
   * Start every case from a NEUTRAL environment.
   *
   * `vi.unstubAllEnvs()` restores whatever the process had — it does not make
   * the variable absent — so most cases in here (all of which assume the switch
   * is unset) used to fail for anyone who had exported the variable to try the
   * feature out: `DSH_AGENTS_BRIDGE_QODER_TRANSPORT=acp pnpm test` reddened four
   * of the five, including the regression guards. An empty string is "unset" to
   * the resolver (`value !== ''` is what makes a candidate usable), so stubbing
   * it is enough to make the suite hermetic.
   */
  beforeEach(() => {
    vi.stubEnv(QODER_TRANSPORT_ENV, '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  interface Probed {
    readonly id: string
    readonly available: boolean
    readonly reason?: string
  }

  async function probeRows(config: Partial<Config> = {}): Promise<readonly Probed[]> {
    const registered = boot(config)
    const probed = (await call(registered, 'agents_probe', {})) as readonly Probed[]
    return probed
  }

  it('defaults to stream-json, and disables the ACP row by NAME', async () => {
    const rows = await probeRows()
    const acp = rows.find((row) => row.id === 'qoderclicn')
    const print = rows.find((row) => row.id === 'qoderclicn-print')
    expect(print).toBeDefined()
    // The unselected row is not deleted — it reports the switch.
    expect(acp?.reason).toContain('qoderTransport=stream-json')
    expect(acp?.available).toBe(false)
    // and the selected one is not disabled by the switch at all (whether it
    // resolves on THIS host's PATH is a separate question the reason answers).
    expect(print?.reason ?? '').not.toContain('qoderTransport')
  })

  it('flips to ACP on request, naming the setting in the reason', async () => {
    const rows = await probeRows({ qoderTransport: 'acp' })
    const acp = rows.find((row) => row.id === 'qoderclicn')
    const print = rows.find((row) => row.id === 'qoderclicn-print')
    expect(print?.reason).toContain('qoderTransport=acp')
    expect(print?.available).toBe(false)
    expect(acp?.reason ?? '').not.toContain('qoderTransport')
  })

  it('never touches the desktop row, whichever transport is selected', async () => {
    for (const transport of ['stream-json', 'acp'] as const) {
      const rows = await probeRows({ qoderTransport: transport })
      const desktop = rows.find((row) => row.id === 'qoder-cn')
      expect(desktop).toBeDefined()
      expect(desktop?.reason ?? '').not.toContain('qoderTransport')
    }
    // Two full boots + probes: each one resolves versions for every identity, so
    // this legitimately exceeds the 5s default on a loaded machine.
  }, 30_000)

  it('resolves config first, then the environment, then stream-json', () => {
    expect(resolveQoderTransport(undefined)).toBe('stream-json')
    expect(resolveQoderTransport('acp')).toBe('acp')
    expect(resolveQoderTransport('stream-json')).toBe('stream-json')
    // Config beats a contradictory env value.
    vi.stubEnv(QODER_TRANSPORT_ENV, 'acp')
    expect(resolveQoderTransport('stream-json')).toBe('stream-json')
    // …and with no config, the env decides.
    expect(resolveQoderTransport(undefined)).toBe('acp')
    // An unusable env value falls back to the default instead of guessing.
    vi.stubEnv(QODER_TRANSPORT_ENV, 'nonsense')
    expect(resolveQoderTransport(undefined)).toBe('stream-json')
  })

  it('normalises the CONFIG value too, and warns instead of guessing', () => {
    // Same leniency as the env path: a YAML row writing `ACP` means ACP, not
    // "fall back to the default because of the case".
    expect(resolveQoderTransport('ACP' as never)).toBe('acp')
    expect(resolveQoderTransport(' stream-json ' as never)).toBe('stream-json')
    // A typo still lands on the default…
    expect(resolveQoderTransport('streamjson' as never)).toBe('stream-json')
    // …and `apply()` says so out loud, instead of letting the operator believe
    // they selected something. A misconfigured switch that looks like success is
    // exactly the failure mode this asserts against.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    boot({ qoderTransport: 'streamjson' as never })
    const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n')
    warn.mockRestore()
    expect(warnings).toContain('qoderTransport value not recognised')
    expect(warnings).toContain('streamjson')
  })

  it('warns for an unusable ENV value too (the documented quick-switch)', () => {
    // The env var is what README §5 tells operators to use. A typo there used to
    // select the default in complete silence, because the warning only inspected
    // the config field — the same class of failure the config case already
    // covers, just through the other door.
    vi.stubEnv(QODER_TRANSPORT_ENV, 'acpp')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    boot()
    const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n')
    warn.mockRestore()
    expect(warnings).toContain('qoderTransport value not recognised')
    expect(warnings).toContain('acpp')
  })

  it('stays QUIET when a usable value is merely shadowed by precedence', () => {
    // `qoderTransport: 'acp'` + `…=stream-json` is not a misconfiguration: config
    // wins and its value is valid. Warning here would be noise, and noise is how
    // a real warning gets ignored.
    vi.stubEnv(QODER_TRANSPORT_ENV, 'stream-json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    boot({ qoderTransport: 'acp' })
    const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n')
    warn.mockRestore()
    expect(warnings).not.toContain('qoderTransport value not recognised')
  })

  it('still warns when a typo in CONFIG is overridden by a usable env value', () => {
    // The round-2 case, kept as a regression guard while the warning moves to a
    // source-aware decision: the effective transport comes from the env, but the
    // config value was ignored and the operator must hear about it.
    vi.stubEnv(QODER_TRANSPORT_ENV, 'acp')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    boot({ qoderTransport: 'streem-json' as never })
    const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n')
    warn.mockRestore()
    expect(warnings).toContain('qoderTransport value not recognised')
    expect(warnings).toContain('streem-json')
  })

  it('reports a NON-STRING config value instead of silently ignoring it', () => {
    // A YAML type slip (`qoderTransport: 1`) used to fall through the
    // `typeof === 'string'` gate BEFORE the "unusable" scan could see it — the
    // same silent-default class as the two doors above, one gate further out.
    const decision = decideQoderTransport(1 as never)
    expect(decision.transport).toBe('stream-json')
    expect(decision.ignored).toEqual({ source: 'config', value: '1' })
    // …and it reaches the log through `apply()` too, not just the resolver.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    boot({ qoderTransport: 1 as never })
    const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n')
    warn.mockRestore()
    expect(warnings).toContain('qoderTransport value not recognised')
  })

  it('marks exactly the unselected descriptor, and nothing else', () => {
    expect(Object.keys(qoderTransportOverrides('stream-json'))).toEqual(['qoderclicn'])
    expect(Object.keys(qoderTransportOverrides('acp'))).toEqual(['qoderclicn-print'])
  })

  it('survives a USER override on the same identity (the switch owns `unsupported`)', async () => {
    // Pinning an executable per identity is a documented use of `overrides` — this
    // suite's own `boot()` does it for four identities. It must not be able to
    // DELETE the switch's marking by replacing that identity's patch object
    // wholesale: the row would come back available and the default would be
    // silently defeated. The switch owns exactly one FIELD; the caller owns the
    // rest.
    const rows = await probeRows({
      overrides: { qoderclicn: { command: { executable: process.execPath } } },
    })
    const acp = rows.find((row) => row.id === 'qoderclicn')
    expect(acp?.reason).toContain('qoderTransport=stream-json')
    expect(acp?.available).toBe(false)
  }, 30_000)
})
