/**
 * `src/index.ts` — the entry's wiring of the client-facing HTTP API.
 *
 * The rule under test is design doc D16, applied to `webServer`: the HTTP route
 * exists only to serve the Web client half, so a host WITHOUT a web server must
 * still get all nine agent tools. Declaring `webServer` in `inject` would mark
 * the whole plugin INACTIVE on such a host — the tools would vanish along with a
 * panel that could never have been drawn.
 *
 * A fake Cordis context is used rather than a real host: `apply` reads four
 * services (`tools`, `systemPrompt`, and optionally `webServer` / `webRuntime`),
 * and asserting which of them it reached for is exactly the point.
 *
 * @module tests/host/wiring
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { apply, inject, buildPromptSection } from '../../src/index.ts'
import { TOOL_NAMES } from '../../src/tools/definitions.ts'
import { API_PREFIX } from '../../src/host/api.ts'

/* -------------------------------------------------------------------------- */
/* Fake host                                                                  */
/* -------------------------------------------------------------------------- */

const stores: string[] = []
afterAll(() => {
  for (const store of stores) rmSync(store, { recursive: true, force: true })
})

interface FakeHost {
  readonly registeredTools: string[]
  readonly sections: { name: string; order: number }[]
  readonly routes: { kind: string; path: string }[]
  readonly logs: string[]
  readonly effects: { name: string; dispose: () => void }[]
  readonly disposedRoutes: number
  ctx: never
}

/** A Cordis-like context with only the surface `apply` touches. */
function fakeHost(services: { readonly webServer?: boolean; readonly commands?: boolean } = {}): FakeHost {
  const registeredTools: string[] = []
  const sections: { name: string; order: number }[] = []
  const routes: { kind: string; path: string }[] = []
  const logs: string[] = []
  const effects: { name: string; dispose: () => void }[] = []
  let disposedRoutes = 0

  const storeDir = mkdtempSync(path.join(tmpdir(), 'bridge-wiring-'))
  stores.push(storeDir)

  const toolTable = {
    register(definition: { name: string }) {
      registeredTools.push(definition.name)
      return () => {}
    },
  }
  const promptTable = {
    section(section: { name: string; order: number }) {
      sections.push({ name: section.name, order: section.order })
      return () => {}
    },
  }
  const serviceTable: Record<string, unknown> = {
    tools: toolTable,
    // `ctx.tools` / `ctx.systemPrompt` are reached as PROPERTIES (cordis
    // services are accessors), while optional services go through `ctx.get`.
    systemPrompt: promptTable,
  }
  if (services.commands === true) serviceTable['commands'] = { register: () => () => {} }
  if (services.webServer === true) {
    serviceTable['webServer'] = {
      register(route: { kind: string; path: string }) {
        routes.push({ kind: route.kind, path: route.path })
        return () => {
          disposedRoutes += 1
        }
      },
    }
    serviceTable['webRuntime'] = { trustedHosts: [] }
  }

  const ctx = {
    tools: toolTable,
    systemPrompt: promptTable,
    get(name: string) {
      return serviceTable[name]
    },
    effect(callback: () => (() => void) | void, name?: string) {
      const dispose = callback() ?? (() => {})
      effects.push({ name: name ?? 'anonymous', dispose })
      return () => dispose()
    },
  }

  // Silence the plugin's own console output (it logs the missing-webServer case).
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  try {
    // The entry logs through the kernel logger, which writes to console.log.
    apply(ctx as never, { storeDir })
  } finally {
    console.log = original
  }

  return {
    registeredTools,
    sections,
    routes,
    logs,
    effects,
    get disposedRoutes() {
      return disposedRoutes
    },
    ctx: ctx as never,
  }
}

/* -------------------------------------------------------------------------- */
/* The D16 rule                                                               */
/* -------------------------------------------------------------------------- */

describe('entry wiring — webServer is optional (D16)', () => {
  it('registers every tool when the host HAS no web server', () => {
    const host = fakeHost()
    // The nine tools are the plugin's reason to exist; a host that cannot draw a
    // panel must still get all of them.
    expect(host.registeredTools).toEqual([...TOOL_NAMES])
    expect(host.routes).toEqual([])
  })

  it('never declares webServer in its inject list', () => {
    // Declaring it would mark the plugin INACTIVE on a headless host and take
    // the nine tools down with it.
    expect([...inject]).toEqual(['tools', 'systemPrompt'])
    expect([...inject]).not.toContain('webServer')
    expect([...inject]).not.toContain('commands')
  })

  it('still registers the prompt section and the smoke-command path', () => {
    const host = fakeHost()
    expect(host.sections).toEqual([{ name: 'tool:agents-bridge', order: 108 }])
  })
})

describe('entry wiring — webServer present', () => {
  it('mounts the API route at the agreed prefix', () => {
    const host = fakeHost({ webServer: true })
    expect(host.routes).toEqual([{ kind: 'prefix', path: API_PREFIX }])
    // ...and the tools are unaffected by the extra registration.
    expect(host.registeredTools).toEqual([...TOOL_NAMES])
  })

  it('removes the route when the plugin effect is disposed', () => {
    const host = fakeHost({ webServer: true })
    const lifetime = host.effects.find(effect => effect.name === 'agents-bridge.register()')
    expect(lifetime).toBeDefined()
    expect(host.disposedRoutes).toBe(0)
    lifetime?.dispose()
    // A route that outlived the manager would answer cancel/output against a
    // disposed facade.
    expect(host.disposedRoutes).toBe(1)
  })

  it('logs why the panel is unavailable instead of failing silently', () => {
    // A missing panel must be diagnosable from the host log.
    const without = fakeHost()
    expect(without.logs.join('\n')).toContain('webServer')
    const withServer = fakeHost({ webServer: true })
    expect(withServer.logs.join('\n')).not.toContain('host has no webServer')
  })
})

/* -------------------------------------------------------------------------- */
/* The prompt section is unchanged by this workstream                          */
/* -------------------------------------------------------------------------- */

describe('buildPromptSection', () => {
  it('still names the nine tools and the async-polling contract', () => {
    const section = buildPromptSection()
    for (const name of TOOL_NAMES) expect(section).toContain(name)
    // D5's promise is in the prompt, not only in the code: the model must not
    // expect agents_run to wait.
    expect(section).toContain('returns a sessionId IMMEDIATELY')
  })

  it('names the deployment-configured identities when there are any', () => {
    expect(buildPromptSection(['workbuddy', 'claude'])).toContain('workbuddy, claude')
    expect(buildPromptSection(['workbuddy', 'claude'])).toContain("deployment's config")
    expect(buildPromptSection([])).not.toContain("deployment's config")
  })
})
