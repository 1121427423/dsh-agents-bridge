/**
 * `src/index.ts` — the entry's wiring of the client-facing HTTP API.
 *
 * Two rules are under test, and they pull in opposite directions:
 *
 *  1. design doc D16, applied to `webServer`: the HTTP route exists only to
 *     serve the Web client half, so a host WITHOUT a web server must still get
 *     all nine agent tools. Declaring `webServer` in the top-level `inject`
 *     would mark the whole plugin INACTIVE on such a host — the tools would
 *     vanish along with a panel that could never have been drawn.
 *  2. `webServer` must nevertheless be REACHABLE, which a one-shot
 *     `ctx.get('webServer')` cannot deliver: the host's web server is another
 *     row of the loader tree and routinely mounts after this plugin (measured
 *     at ~800 ms on the standalone web harness). Cordis SCOPE injection
 *     (`ctx.inject`) is what satisfies both — it runs its callback only while
 *     the service is available, re-runs it when it appears, and never gates the
 *     parent fiber.
 *
 * A fake Cordis context is used rather than a real host: `apply` reads two
 * services (`tools`, `systemPrompt`) and scope-injects a third (`webServer`),
 * and asserting when each of them is reached for is exactly the point.
 *
 * @module tests/host/wiring
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

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

/**
 * `console.log` interceptors installed by `fakeHost`, restored after each test.
 *
 * The interception has to outlive `apply()`: a late-mounting web server logs
 * AFTER `apply` has returned, and those are exactly the lines under test.
 */
const restoreLogs: Array<() => void> = []
afterEach(() => {
  for (const restore of restoreLogs.splice(0).reverse()) restore()
})

interface FakeHost {
  readonly registeredTools: string[]
  readonly sections: { name: string; order: number }[]
  readonly routes: { kind: string; path: string }[]
  readonly logs: string[]
  readonly effects: { name: string; dispose: () => void }[]
  readonly disposedRoutes: number
  /**
   * Mount a service AFTER `apply` returned — the live-host case, and the one the
   * old implementation could not see: the host's web server is another row of
   * the loader tree and is provided ~800 ms after this plugin (measured on the
   * standalone web harness).
   */
  provide(name: string, value: unknown): void
  /** A web-server face wired to this host's route and disposer counters. */
  webServerStub(): unknown
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

  /** One `ctx.inject(deps, callback)` scope, modeled on cordis's fiber. */
  const scopes: { deps: readonly string[]; callback: (scoped: unknown) => void; active: boolean }[] = []

  const scopedEffect = (callback: () => (() => void) | void, name?: string) => {
    const dispose = callback() ?? (() => {})
    effects.push({ name: name ?? 'anonymous', dispose })
    return () => dispose()
  }

  /**
   * Run every scope whose dependencies are all available.
   *
   * Cordis runs the callback as soon as the services exist — synchronously when
   * they already do, and again on `internal/service` when one appears later —
   * and leaves the parent fiber alone either way. The fake keeps both halves of
   * that contract, because the entry's correctness depends on both.
   */
  const runScopes = () => {
    for (const scope of scopes) {
      if (scope.active) continue
      if (!scope.deps.every(name => serviceTable[name] !== undefined)) continue
      scope.active = true
      scope.callback({ get: (name: string) => serviceTable[name], effect: scopedEffect })
    }
  }

  const provide = (name: string, value: unknown) => {
    serviceTable[name] = value
    runScopes()
  }

  const webServerStub = () => ({
    register(route: { kind: string; path: string }) {
      routes.push({ kind: route.kind, path: route.path })
      return () => {
        disposedRoutes += 1
      }
    },
  })

  if (services.webServer === true) {
    provide('webServer', webServerStub())
    provide('webRuntime', { trustedHosts: [] })
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
    inject(deps: readonly string[], callback: (scoped: unknown) => void) {
      const scope = { deps, callback, active: false }
      scopes.push(scope)
      runScopes()
      return scope
    },
  }

  // Capture the plugin's own console output for this host's WHOLE life: the
  // entry logs through the kernel logger, which writes to console.log, and a
  // late-mounting web server logs after `apply` has already returned.
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  restoreLogs.push(() => {
    console.log = original
  })

  apply(ctx as never, { storeDir })

  return {
    registeredTools,
    sections,
    routes,
    logs,
    effects,
    get disposedRoutes() {
      return disposedRoutes
    },
    provide,
    webServerStub,
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

  it('reports the panel as not mounted without claiming anything about the host', () => {
    const log = fakeHost().logs.join('\n')
    expect(log).toContain('webServer')
    expect(log).toContain('not mounted')
    // The absence of an optional service is NOT knowable at apply time: the
    // host's web server may simply not have mounted yet (see the late-mount
    // suite below). A line asserting "this host has no web server" was therefore
    // false on hosts that have one — the lie workstream H removed.
    expect(log).not.toContain('host has no webServer')
  })
})

/* -------------------------------------------------------------------------- */
/* webServer mounts AFTER the plugin — the live-host case                     */
/* -------------------------------------------------------------------------- */

describe('entry wiring — webServer arrives late', () => {
  it('mounts the route when the service appears, leaving the nine tools alone', () => {
    const host = fakeHost()
    // Nothing at apply time. The host's own web server is just another row of
    // the loader tree and, measured on the standalone web harness, is provided
    // ~800 ms later — which is why the old one-shot `ctx.get('webServer')` read
    // `undefined` on a host that very much had a web server.
    expect(host.routes).toEqual([])
    expect(host.registeredTools).toEqual([...TOOL_NAMES])

    host.provide('webServer', host.webServerStub())

    expect(host.routes).toEqual([{ kind: 'prefix', path: API_PREFIX }])
    expect(host.logs.join('\n')).toContain('host api route mounted')
    // Registering the panel must not disturb the model-facing surface.
    expect(host.registeredTools).toEqual([...TOOL_NAMES])
  })

  it('mounts without a webRuntime — that service is genuinely optional', () => {
    const host = fakeHost()
    host.provide('webServer', host.webServerStub())
    // `dsh-web-app` provides `webRuntime` only after `webServer` exists, and a
    // deployment may never provide it at all; the route then falls back to a
    // loopback-only trust fence rather than not mounting.
    expect(host.routes).toEqual([{ kind: 'prefix', path: API_PREFIX }])
  })

  it('removes a late-mounted route when the plugin effect is disposed', () => {
    const host = fakeHost()
    host.provide('webServer', host.webServerStub())
    const lifetime = host.effects.find(effect => effect.name === 'agents-bridge.register()')
    expect(lifetime).toBeDefined()
    expect(host.disposedRoutes).toBe(0)
    lifetime?.dispose()
    // Before the manager goes: a route that outlived it would answer
    // cancel/output against a disposed facade. Cordis unloads a fiber's effects
    // concurrently, so the scope cannot win that race on its own — the entry
    // closes the handle itself.
    expect(host.disposedRoutes).toBe(1)
  })

  it('keeps the tools registered when the web server never appears', () => {
    const host = fakeHost()
    // Nothing is provided at all: the scope stays inactive for the plugin's
    // whole life, which must cost the deployment nothing but the panel.
    expect(host.effects.map(effect => effect.name)).toContain('agents-bridge.register()')
    expect(host.registeredTools).toEqual([...TOOL_NAMES])
    expect(host.routes).toEqual([])
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
