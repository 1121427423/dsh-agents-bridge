/**
 * `lib/client.js` — the CLIENT HALF AS THE HOST ACTUALLY LOADS IT.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other client test imports `src/client/**` as modules and exercises pure
 * functions. None of them can see the failure this suite is built for: the host
 * does NOT `import()` the bundle and read its exports. At startup it registers
 * plugin factories through `window.__ModuleLoader__.load({ id, factory })`, and
 * the body stays lazy until something materialises it. A bare esbuild CJS
 * artifact (what this repo shipped before workstream G) evaluates fine as a
 * plain script, registers nothing, and produces a SILENTLY missing UI — no
 * error anywhere, because nothing ever looks for it.
 *
 * So this suite plays the host:
 *
 *   1. a fake `window.__ModuleLoader__` that records the `load()` calls;
 *   2. the BUILD ARTIFACT (`lib/client.js`) evaluated in an isolated realm
 *      (`node:vm`) — deliberately NOT `import`ed, because importing it would
 *      bypass the wrapper this suite is about;
 *   3. assertions on the registration, on the factory's exports, and on the
 *      slot registrations `apply()` makes.
 *
 * IT DEPENDS ON `pnpm run build`
 * ------------------------------
 * The artifact is the subject, so a missing artifact is a FAILURE, never a
 * skip (`clientBundleSource()` throws with the exact command to run). `pnpm
 * test` pre-builds via the `pretest` script; a bare `pnpm exec vitest run`
 * needs a prior `pnpm run build`.
 *
 * The package name is read from `package.json` everywhere — a hardcoded
 * `'dsh-agents-bridge'` would make this suite agree with a renamed package that
 * the host can no longer load, which is the exact defect being guarded.
 *
 * @module tests/integration/client-bundle
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string }
const BUNDLE = path.join(root, 'lib', 'client.js')

const PANEL_SLOT = 'sidebar.right.pane.tab'
const INDICATOR_SLOT = 'conversation.session.header.utilities'

/** The shape the host's module table hands `load()`. */
interface ModuleLoaderEntry {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => ClientModule
}

/**
 * What the factory is expected to return (the reference plugins' shape).
 *
 * `SETTINGS_SLOT` / `SETTINGS_NAMESPACE` are part of it because
 * `src/client/index.ts` exports them (`:64`, `:72`) and this suite asserts the
 * CARD's key against the namespace — the fields were simply missing from this
 * local interface, which is four of the TS2339s that accumulated while tests sat
 * outside every typecheck (IM-14).
 */
interface ClientModule {
  readonly inject: readonly string[]
  readonly PANEL_ID: string
  readonly INDICATOR_ID: string
  readonly SETTINGS_SLOT: string
  readonly SETTINGS_NAMESPACE: string
  apply(ctx: unknown): void
}

/**
 * The artifact, or a loud failure.
 *
 * A skip here would restore the blindness this suite exists to remove.
 */
function clientBundleSource(): string {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `lib/client.js is missing — this suite asserts on the BUILD ARTIFACT, not on src/. ` +
        `Run \`pnpm run build\` first (or \`pnpm test\`, whose pretest builds it). Looked for: ${BUNDLE}`,
    )
  }
  return readFileSync(BUNDLE, 'utf8')
}

/** A stand-in for the host's `window.__ModuleLoader__`. */
function fakeModuleLoader() {
  const entries: ModuleLoaderEntry[] = []
  const window = {
    __ModuleLoader__: {
      load(entry: ModuleLoaderEntry) {
        entries.push(entry)
      },
    },
  }
  return { window, entries }
}

/**
 * Evaluate the artifact in its own realm, exactly as a browser would: a
 * `window` with a module loader, plus the two host APIs the client half
 * reaches for once mounted (`store.start()` polls, and the poll goes through
 * `fetch`). Stubbed so the mount path runs with no network and no real timer.
 */
function evaluateBundle() {
  const loader = fakeModuleLoader()
  const sandbox = {
    window: loader.window,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => ({
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessions: [],
          concurrency: { running: 0, limit: 0 },
          now: 0,
          available: false,
          results: [],
          at: 0,
          cached: false,
        },
      }),
    }),
  }
  runInNewContext(clientBundleSource(), sandbox, { filename: BUNDLE })
  return loader
}

/** The registered factory, plus the loader call count it was found in. */
function registeredFactory(): { factory: ModuleLoaderEntry['factory']; entries: ModuleLoaderEntry[] } {
  const { entries } = evaluateBundle()
  const entry = entries[0]
  if (entry === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load()')
  return { factory: entry.factory, entries }
}

/**
 * The host's `require`, as handed to the factory.
 *
 * Returns a minimal React face: the bundle's module body calls
 * `require('react')` at the top level, and `createElement` is the only member
 * `apply()` can reach without rendering. `calls` records what the factory
 * asked for, which is how the "react stays external" assertion is made.
 */
function hostRequire() {
  const calls: string[] = []
  const react: Record<string, unknown> = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    Fragment: Symbol('react.fragment'),
    useCallback: (fn: unknown) => fn,
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useState: (initial: unknown) => [initial, () => {}],
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }
  const require = (id: string): unknown => {
    calls.push(id)
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') {
      return { jsx: react['createElement'], jsxs: react['createElement'], Fragment: react['Fragment'] }
    }
    // Anything else means the bundle is asking the host for a module the host
    // does not provide — i.e. it should have been bundled, or declared.
    throw new Error(`the host does not provide '${id}' to this plugin`)
  }
  return { require, calls }
}

/** A slot registry recording exactly what `apply()` registers. */
interface Registration {
  readonly name: string
  /** Keyed slots (the panel tab, the settings card) dispatch on `key`. */
  readonly key?: string | undefined
  readonly id?: string | undefined
  readonly order?: number | undefined
  readonly registrant?: string | undefined
}

function recordingSlots(available: readonly string[]) {
  const injected: string[] = []
  const registered: Registration[] = []
  const slots = {
    inject(name: string, callback: () => () => void) {
      injected.push(name)
      const dispose = available.includes(name) ? callback() : () => {}
      return () => dispose()
    },
    register(options: Registration) {
      registered.push(options)
      return () => {}
    },
  }
  return { slots, injected, registered }
}

/**
 * A minimal Cordis-like context: `get` for services, `effect` for lifetimes,
 * `inject` for the reactive wait cordis gives a callback once its dependencies
 * are available.
 *
 * `inject` is modelled rather than stubbed out because the built bundle depends
 * on it: the right-sidebar tab TYPE is declared through `ctx.inject`, since the
 * registry is published by an optional peer that activates later than this
 * plugin. A fake without it makes `apply` throw into its own catch-all, and
 * every assertion below then sees zero registrations.
 */
function fakeContext(services: Record<string, unknown>) {
  const effects: { name: string; dispose: () => void }[] = []
  const ctx = {
    get: (name: string) => services[name],
    effect(callback: () => (() => void) | void, name?: string) {
      const dispose = callback() ?? (() => {})
      effects.push({ name: name ?? 'anonymous', dispose })
      return () => dispose()
    },
    inject(deps: readonly string[], callback: (scoped: unknown) => void) {
      // A dependency that never appears never runs the callback — the optional
      // half of the contract, and why a host with no right Sidebar still gets
      // the other two surfaces.
      if (!deps.every(dep => services[dep] !== undefined)) return
      callback(ctx)
    },
  }
  return {
    ctx,
    effects,
    disposeAll() {
      for (const effect of [...effects].reverse()) effect.dispose()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The module-table contract                                                  */
/* -------------------------------------------------------------------------- */

describe('lib/client.js — host module-table contract', () => {
  it('registers exactly one factory with the module loader', () => {
    const { entries } = evaluateBundle()
    expect(entries).toHaveLength(1)
  })

  it('registers under the package name (never a literal that can drift)', () => {
    const { entries } = evaluateBundle()
    expect(entries[0]?.id).toBe(pkg.name)
  })

  it('registers a factory function rather than an evaluated module body', () => {
    // The whole point of the contract: startup only REGISTERS; the body runs
    // when something materialises it.
    const { entries } = evaluateBundle()
    expect(typeof entries[0]?.factory).toBe('function')
  })

  it('exposes apply + inject through the host-provided require', () => {
    const { factory } = registeredFactory()
    const host = hostRequire()
    const module = factory(host.require)
    expect(typeof module.apply).toBe('function')
    expect(Array.isArray(module.inject)).toBe(true)
    expect([...module.inject]).toEqual(['slots'])
  })

  it('keeps react external — the factory asks the host for it', () => {
    const { factory } = registeredFactory()
    const host = hostRequire()
    factory(host.require)
    expect(host.calls).toContain('react')

    // And the artifact itself must not carry a React implementation: a second
    // copy means a second hooks dispatcher. This marker only exists in one.
    expect(clientBundleSource()).not.toContain('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED')
  })

  it('asks the host for react and for NO other module', () => {
    // `CLIENT_EXTERNALS` keeps `@deepseek-ai/*` out of the bundle, which is
    // right for the Node half and a HAZARD here: a client bundle that left
    // `require("@deepseek-ai/dsh-client-ui-slots")` behind would reach the
    // module system's LAST resolution branch — "anything else → throw (loud,
    // the runtime mirror of the build-time bundle purity gate)" — at
    // materialization, taking the whole client half down. Every library this
    // half is written against is reached as a SERVICE (`ctx.get`) or as a
    // cordis `inject` in the source, never imported.
    //
    // It is also the fact that settles `dsh.client.inject`: that field preloads
    // other BROWSER MODULES (`if (dependency !== void 0) await arriveGraphRow`)
    // and this bundle has no module dependency at all, so no entry in it can be
    // load-bearing. Asserted here so a new externalised import has to be
    // deliberate rather than silent.
    const requires = [...clientBundleSource().matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
    expect(new Set(requires)).toEqual(new Set(['react']))
  })

  it('derives its slot ids from the package name', () => {
    const { factory } = registeredFactory()
    const module = factory(hostRequire().require)
    expect(module.PANEL_ID).toBe(pkg.name)
    expect(module.INDICATOR_ID).toBe(`${pkg.name}:indicator`)
  })
})

/* -------------------------------------------------------------------------- */
/* The registrations `apply()` makes                                          */
/* -------------------------------------------------------------------------- */

describe('lib/client.js — slot registrations carry the package name', () => {
  it('registers every slot with this package as id/registrant', () => {
    const { factory } = registeredFactory()
    const module = factory(hostRequire().require)
    const settingsSlot = module.SETTINGS_SLOT as string
    const { slots, registered } = recordingSlots([PANEL_SLOT, settingsSlot, INDICATOR_SLOT])
    const { ctx, disposeAll } = fakeContext({ slots })

    module.apply(ctx)
    disposeAll()

    expect(registered.map(entry => entry.name)).toEqual([PANEL_SLOT, settingsSlot, INDICATOR_SLOT])

    // The settings card is the ONE registration that must be keyed, and keyed by
    // the settings namespace: the first-party tab enumerates the namespaces the
    // host serves and dispatches `settings.plugin.item` per namespace, so a card
    // registered without a key (or under a drifted string) renders NOTHING while
    // every other assertion here still passes. That is the silent-missing-UI
    // failure this file exists for.
    const settings = registered.find(entry => entry.name === settingsSlot)
    expect(settings?.key).toBe(module.SETTINGS_NAMESPACE)
    expect(settings?.key).toBe(pkg.name)
    expect(settings?.id).toBeUndefined()

    // The host attributes a slot to the plugin named by `registrant`, and
    // dedupes on `id`; both must be the package name, not a stale literal.
    for (const entry of registered) expect(entry.registrant).toBe(pkg.name)

    // The PANEL is KEYED by the package name. Checked on the BUILT bundle
    // because a keyed slot registered without a `key` throws inside the slot
    // registry core (`keyed slot "…" requires options.key`) and takes the panel
    // with it — the same silent-missing-UI class as the settings card above,
    // and what the panel did for its whole life while it carried `id`.
    expect(registered[0]?.key).toBe(pkg.name)
    expect(registered[0]?.id).toBeUndefined()

    // The INDICATOR's slot is a LIST slot: it dispatches on `id`, not `key`.
    expect(registered[2]?.id).toBe(`${pkg.name}:indicator`)
  })

  it('degrades to nothing (no throw) when the host has no slot registry', () => {
    const { factory } = registeredFactory()
    const module = factory(hostRequire().require)
    const { ctx } = fakeContext({})
    expect(() => module.apply(ctx)).not.toThrow()
  })
})
