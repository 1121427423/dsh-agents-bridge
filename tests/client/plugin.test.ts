/**
 * `src/client/index.ts` — the client plugin body.
 *
 * React components are not rendered here (the host's rendering environment is
 * not worth simulating), but everything around them IS asserted, because these
 * are the rules that decide whether the plugin survives on a host it was not
 * written for:
 *
 *  - only `slots` is in `inject` (an inject-listed optional service would mark
 *    the whole client half INACTIVE — the same trap as design doc D16 on the
 *    Node side);
 *  - a missing slot service degrades silently instead of throwing;
 *  - both slots register INDEPENDENTLY, with the ids/orders the reference
 *    plugins use;
 *  - the effect disposer removes both registrations, the stylesheet and the
 *    poller.
 *
 * @module tests/client/plugin
 */

import { describe, expect, it } from 'vitest'

import {
  INDICATOR_ID,
  INDICATOR_SLOT,
  PANEL_ID,
  PANEL_KIND,
  PANEL_SLOT,
  SETTINGS_NAMESPACE,
  SETTINGS_SLOT,
  apply,
  indicatorNavigation,
  inject,
  localeOf,
  revealPanelTab,
  type SidebarTabsService,
  type SlotsService,
} from '../../src/client/index.ts'
import { DICTS, LOCALE_NS } from '../../src/client/i18n.ts'
import { STYLE_TAG_ID } from '../../src/client/styles.ts'

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Registration {
  readonly name: string
  readonly id?: string | undefined
  /** Present only on a KEYED slot (the panel, the settings card). */
  readonly key?: string | undefined
  readonly order?: number | undefined
}

/** A slot registry that records `inject`/`register` calls and can be disposed. */
function fakeSlots(options: { readonly available?: readonly string[] } = {}) {
  const injected: string[] = []
  const registered: Registration[] = []
  let disposed = 0
  const available = new Set(options.available ?? [PANEL_SLOT, INDICATOR_SLOT])
  const slots: SlotsService = {
    inject(name, callback) {
      injected.push(name)
      // The host only fires a slot's callback once the owning UI package has
      // declared it. An unavailable slot's callback simply never runs.
      const dispose = available.has(name) ? callback() : () => {}
      return () => {
        dispose()
      }
    },
    register(regOptions) {
      registered.push({
        name: regOptions.name,
        id: regOptions.id,
        ...(regOptions.key === undefined ? {} : { key: regOptions.key }),
        order: regOptions.order,
      })
      return () => {
        disposed += 1
      }
    },
  }
  return { slots, injected, registered, disposedCount: () => disposed }
}

/** The definition shape `sidebarRightTabs.register` takes, from the real face. */
type TabTypeDefinition = Parameters<SidebarTabsService['register']>[0]

/** A tab-type registry that records declarations and can be disposed. */
function fakeTabs() {
  const registered: TabTypeDefinition[] = []
  let disposed = 0
  const tabs: SidebarTabsService = {
    register(definition) {
      registered.push(definition)
      return () => {
        disposed += 1
      }
    },
  }
  return { tabs, registered, disposedCount: () => disposed }
}

/**
 * A minimal Cordis-like context recording effects and disposals.
 *
 * `inject` is modelled faithfully, because the whole point of the tab-type fix
 * lives there: cordis "starts a callback once the requested dependencies are
 * available". A dependency that already exists runs the callback at once; one
 * that never exists never runs it; and one that arrives LATER runs it then —
 * which `provide` reproduces.
 */
function fakeContext(services: Record<string, unknown>) {
  const effects: { name: string; dispose: () => void }[] = []
  const waiting: { deps: readonly string[]; run: (scoped: unknown) => void }[] = []

  const make = (): unknown => ({
    get: (name: string) => services[name],
    effect(callback: () => (() => void) | void, name?: string) {
      const dispose = callback() ?? (() => {})
      effects.push({ name: name ?? 'anonymous', dispose })
      return () => dispose()
    },
    inject(deps: readonly string[], callback: (scoped: unknown) => void) {
      const run = (scoped: unknown): void => callback(scoped)
      if (deps.every(dep => services[dep] !== undefined)) run(make())
      else waiting.push({ deps, run })
    },
  })

  return {
    ctx: make() as never,
    effects,
    /** Publish a service the way a later-activating plugin would. */
    provide(name: string, value: unknown) {
      services[name] = value
      for (const waiter of [...waiting]) {
        if (!waiter.deps.every(dep => services[dep] !== undefined)) continue
        waiting.splice(waiting.indexOf(waiter), 1)
        waiter.run(make())
      }
    },
    /** Tear down every effect, newest first — what cordis does on unload. */
    disposeAll() {
      for (const effect of [...effects].reverse()) effect.dispose()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Module contract                                                            */
/* -------------------------------------------------------------------------- */

describe('client half — module contract', () => {
  it('injects ONLY `slots`', () => {
    // Every other service (locale, sessions, the sidebar-right API) is reached
    // through `ctx.get`, because a host that lacks one must still get the half
    // it can render — and a host that lacks an inject-listed service marks this
    // plugin INACTIVE entirely.
    expect([...inject]).toEqual(['slots'])
  })

  it('names the slots it targets (docs/client-half-slots.md §2)', () => {
    expect(PANEL_SLOT).toBe('sidebar.right.pane.tab')
    expect(INDICATOR_SLOT).toBe('conversation.session.header.utilities')
  })
})

/* -------------------------------------------------------------------------- */
/* Degradation                                                                */
/* -------------------------------------------------------------------------- */

describe('client half — graceful degradation', () => {
  it('does nothing at all when there is no slot registry', () => {
    const { ctx, effects } = fakeContext({})
    expect(() => apply(ctx)).not.toThrow()
    // The stylesheet effect still ran (it is harmless without a UI), but no
    // slot lookup was attempted.
    expect(effects.map(effect => effect.name)).toEqual(['dsh-agents-bridge: stylesheet'])
  })

  it('registers the panel when only the sidebar-right slot exists', () => {
    const { slots, registered } = fakeSlots({ available: [PANEL_SLOT] })
    const { ctx, disposeAll } = fakeContext({ slots })
    apply(ctx)
    expect(registered.map(entry => entry.name)).toEqual([PANEL_SLOT])
    // `sidebar.right.pane.tab` is a KEYED slot, and the registry core refuses a
    // keyed registration with no `key` (`keyed slot "…" requires options.key`).
    // So `id` here was never a style choice — it was a panel that threw on
    // mount and never appeared, which is the failure this assertion exists for.
    expect(registered[0]?.key).toBe(PANEL_ID)
    expect(registered[0]?.id).toBeUndefined()
    disposeAll()
  })

  it('registers the indicator when only the header slot exists (sidebar-right missing)', () => {
    // `sidebar.right.pane.tab` comes from an OPTIONAL peer package; its absence
    // must cost only the panel, never a blank page or a throw.
    const { slots, registered, injected } = fakeSlots({ available: [INDICATOR_SLOT] })
    const { ctx, disposeAll } = fakeContext({ slots })
    expect(() => apply(ctx)).not.toThrow()
    expect(injected).toEqual([PANEL_SLOT, SETTINGS_SLOT, INDICATOR_SLOT])
    expect(registered.map(entry => entry.name)).toEqual([INDICATOR_SLOT])
    expect(registered[0]?.id).toBe(INDICATOR_ID)
    disposeAll()
  })

  it('registers both when both slots exist, panel before indicator', () => {
    const { slots, registered } = fakeSlots()
    const { ctx, disposeAll } = fakeContext({ slots })
    apply(ctx)
    expect(registered).toEqual([
      // Keyed: the panel tab is dispatched by `key`.
      { name: PANEL_SLOT, id: undefined, key: PANEL_ID, order: 30 },
      // A LIST slot: the indicator is dispatched by `id`.
      { name: INDICATOR_SLOT, id: INDICATOR_ID, order: 40 },
    ])
    disposeAll()
  })

  it('registers the settings card KEYED by the namespace the host dispatches by', () => {
    // A keyed slot is only dispatched for namespaces the host serves, so the key
    // must be the settings namespace — the same string the Node half registers
    // with the settings service. A card registered without it renders NOTHING,
    // silently, which is the failure this assertion exists for.
    const { slots, registered } = fakeSlots({ available: [SETTINGS_SLOT] })
    const { ctx, disposeAll } = fakeContext({ slots })
    apply(ctx)
    expect(registered).toEqual([{ name: SETTINGS_SLOT, id: undefined, key: SETTINGS_NAMESPACE, order: undefined }])
    disposeAll()
  })

  it('survives a slot service whose register() throws', () => {
    const slots: SlotsService = {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => {
        throw new Error('host refused the registration')
      },
    }
    const { ctx } = fakeContext({ slots })
    // The module table must not be taken down by one host difference.
    expect(() => apply(ctx)).not.toThrow()
  })

  it('survives a locale service that throws on register', () => {
    const { slots } = fakeSlots()
    const { ctx, disposeAll } = fakeContext({
      slots,
      locale: {
        register: () => {
          throw new Error('unsupported signature')
        },
      },
    })
    expect(() => apply(ctx)).not.toThrow()
    disposeAll()
  })

  it('waits for the locale service, then registers both dictionaries', () => {
    // Same root cause as the tab registry, and even quieter: `slots` is provided
    // by the shell CORE, so `apply` runs before the plugin entries that publish
    // the optional services — `locale` (from `@deepseek-ai/dsh-client-locale`)
    // among them. A one-shot `ctx.get` read `undefined` on every host, so these
    // two registrations never happened at all. Nothing looked broken, because
    // the panel resolves its own dictionary from `navigator.language`; what
    // silently did not work is a host-driven locale switch.
    const { slots } = fakeSlots()
    const registered: string[] = []
    const { ctx, provide, disposeAll } = fakeContext({ slots })
    apply(ctx)
    expect(registered).toEqual([])

    provide('locale', {
      register: (namespace: string, tag: string) => {
        registered.push(`${namespace}:${tag}`)
        return () => {}
      },
    })

    expect(registered).toEqual([`${LOCALE_NS}:zh`, `${LOCALE_NS}:en`])
    disposeAll()
  })

  it('tolerates a browser with no document (a non-DOM renderer)', () => {
    const { slots } = fakeSlots()
    const { ctx, disposeAll } = fakeContext({ slots })
    expect(() => apply(ctx)).not.toThrow()
    disposeAll()
  })
})

/* -------------------------------------------------------------------------- */
/* Right-sidebar tab type (phase 1 of the tab contract)                       */
/* -------------------------------------------------------------------------- */

describe('client half — right-sidebar tab type', () => {
  it('declares the type the panel body is KEYED by', () => {
    // A right-sidebar tab takes TWO registrations, and the sidebar dispatches
    // every tab as
    // `renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind })`.
    // The body's `key` (phase 2) must therefore equal this declaration's `id`
    // (phase 1). Half a pair is invisible — no throw, no console line — and
    // simply no panel, so the pairing is asserted rather than each half alone.
    const { slots, registered } = fakeSlots()
    const { tabs, registered: types } = fakeTabs()
    const { ctx, disposeAll } = fakeContext({ slots, sidebarRightTabs: tabs })
    apply(ctx)
    expect(types).toHaveLength(1)
    expect(types[0]?.id).toBe(PANEL_ID)
    expect(types[0]?.kind).toBe(PANEL_KIND)
    expect(registered[0]?.key).toBe(types[0]?.id)
    disposeAll()
  })

  it('labels the chip and the guide door from the live dictionary', () => {
    const { slots } = fakeSlots()
    const { tabs, registered: types } = fakeTabs()
    const { ctx, disposeAll } = fakeContext({ slots, sidebarRightTabs: tabs })
    apply(ctx)
    const type = types[0]
    // Functions, not strings: the sidebar calls them at render time, which is
    // what lets a locale change land without re-registering. Asserted against
    // the dictionary rather than a literal so the test survives either locale
    // (the translator starts from `navigator.language`, which Node also has).
    expect(typeof type?.title).toBe('function')
    expect([DICTS.zh.tabLabel, DICTS.en.tabLabel]).toContain(type?.title('sidebar://x'))
    expect(type?.guide).toHaveLength(1)
    expect([DICTS.zh.panelTitle, DICTS.en.panelTitle]).toContain(type?.guide?.[0]?.title())
    expect([DICTS.zh.emptyBody, DICTS.en.emptyBody]).toContain(type?.guide?.[0]?.description?.())
  })

  it('waits for a tab registry that activates AFTER this plugin', () => {
    // The regression that kept the panel off screen while every other half was
    // already correct. `slots` is in OUR `inject`, so `apply` runs the moment it
    // exists — while `@deepseek-ai/dsh-client-ui-sidebar-right`, which publishes
    // `sidebarRightTabs`, sits behind a deeper chain (session controller →
    // resources → conversation → layout → session) and routinely activates
    // later. The old one-shot `ctx.get` read `undefined`, returned, and NEVER
    // retried: no tab type, so no kind to open, so no panel — and nothing in the
    // console to say so.
    const { slots, registered } = fakeSlots()
    const { tabs, registered: types } = fakeTabs()
    const { ctx, provide, disposeAll } = fakeContext({ slots })

    apply(ctx)
    // Mounted, the other two surfaces up, and no type yet — correctly, because
    // there is no registry to declare it in.
    expect(registered.map(entry => entry.name)).toEqual([PANEL_SLOT, INDICATOR_SLOT])
    expect(types).toEqual([])

    provide('sidebarRightTabs', tabs)

    // The declaration lands as soon as the registry exists, and it is still
    // keyed to the body that was registered first.
    expect(types).toHaveLength(1)
    expect(types[0]?.id).toBe(PANEL_ID)
    expect(types[0]?.kind).toBe(PANEL_KIND)
    expect(registered[0]?.key).toBe(types[0]?.id)
    disposeAll()
  })

  it('is optional: a host with no tab registry loses only the panel', () => {
    // `sidebarRightTabs` comes from the same optional peer as the slot, and is
    // waited for through `ctx.inject` rather than declared in our own `inject`:
    // an inject-listed service a host does not provide would mark this plugin
    // INACTIVE and cost the nine tools too (D16). So the wait simply never
    // resolves — nothing is half-registered and nothing is logged as a failure.
    const { slots, registered } = fakeSlots()
    const { ctx, disposeAll } = fakeContext({ slots })
    expect(() => apply(ctx)).not.toThrow()
    expect(registered.map(entry => entry.name)).toEqual([PANEL_SLOT, INDICATOR_SLOT])
    disposeAll()
  })

  it('survives a tab registry whose register() throws', () => {
    // A duplicate type id throws inside the registry. The panel is one of three
    // surfaces; the other two must still mount.
    const { slots, registered } = fakeSlots()
    const { ctx, disposeAll } = fakeContext({
      slots,
      sidebarRightTabs: {
        register: () => {
          throw new Error('sidebarRight: tab type id is already registered')
        },
      },
    })
    expect(() => apply(ctx)).not.toThrow()
    expect(registered.map(entry => entry.name)).toEqual([PANEL_SLOT, INDICATOR_SLOT])
    disposeAll()
  })

  it('disposes the type through its own effect', () => {
    // The type lives in the child fiber `mountPanelTabType` opens, so it must be
    // removed by ITS effect — and the supervisor-slots effect must not be the
    // thing that carries it.
    const { slots } = fakeSlots()
    const { tabs, disposedCount } = fakeTabs()
    const { ctx, effects } = fakeContext({ slots, sidebarRightTabs: tabs })
    apply(ctx)
    const typeEffect = effects.find(effect => effect.name === 'dsh-agents-bridge: right-sidebar tab type')
    expect(typeEffect).toBeDefined()
    expect(disposedCount()).toBe(0)
    typeEffect?.dispose()
    expect(disposedCount()).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Revealing the panel tab (what the indicator's click does)                  */
/* -------------------------------------------------------------------------- */

describe('client half — revealing the panel tab', () => {
  /** A navigation controller recording `openTab`, optionally refusing. */
  function fakeSidebar(behaviour: 'ok' | 'throw' = 'ok') {
    const opened: string[] = []
    return {
      opened,
      sidebar: {
        openTab(kind: string) {
          // The real controller requires a mounted session docking surface and
          // throws otherwise; it never silently no-ops.
          if (behaviour === 'throw') throw new Error('sidebarRight: no session docking surface is mounted')
          opened.push(kind)
        },
      },
    }
  }

  it('opens the tab under the SAME kind the type declared', () => {
    // The type registration and this navigation are two halves of one wiring.
    // A kind mismatch throws inside the controller (an unregistered kind) and
    // the click does nothing visible — which is exactly the dead affordance the
    // chip was: a tooltip promising "click to view" over a handler that only
    // refreshed a store the collapsed sidebar never showed.
    const { slots } = fakeSlots()
    const { tabs, registered: types } = fakeTabs()
    const { opened, sidebar } = fakeSidebar()
    const { ctx, disposeAll } = fakeContext({ slots, sidebarRightTabs: tabs, sidebarRight: sidebar })
    apply(ctx)

    expect(revealPanelTab(ctx)).toBe(true)
    expect(opened).toEqual([PANEL_KIND])
    expect(opened[0]).toBe(types[0]?.kind)
    disposeAll()
  })

  it('reports false when the host publishes no controller', () => {
    // The right Sidebar is an optional peer: no controller must cost only the
    // navigation, never a throw out of a click handler.
    const { ctx } = fakeContext({})
    expect(revealPanelTab(ctx)).toBe(false)
  })

  it('reports false instead of throwing when the controller refuses', () => {
    const { sidebar } = fakeSidebar('throw')
    const { ctx } = fakeContext({ sidebarRight: sidebar })
    expect(() => revealPanelTab(ctx)).not.toThrow()
    expect(revealPanelTab(ctx)).toBe(false)
  })

  it('hands the chip a callback that reaches the controller', () => {
    // The WIRING, which the two tests above cannot see: the chip and the
    // controller can each be correct while the props the registration builds
    // never carry the callback — and that is exactly how this shipped (a
    // tooltip promising "click to view" over a handler that only refreshed).
    const { opened, sidebar } = fakeSidebar()
    const { ctx } = fakeContext({ sidebarRight: sidebar })
    indicatorNavigation(ctx).onOpenPanel?.()
    expect(opened).toEqual([PANEL_KIND])
  })

  it('resolves the controller per click, not at mount', () => {
    // The controller is published by an optional peer that may mount AFTER this
    // plugin, so a callback that captured `ctx.get(...)` once would stay dead
    // for the rest of the session.
    const { opened, sidebar } = fakeSidebar()
    const services: Record<string, unknown> = {}
    const { ctx } = fakeContext(services)
    const onOpenPanel = indicatorNavigation(ctx).onOpenPanel
    services['sidebarRight'] = sidebar
    onOpenPanel?.()
    expect(opened).toEqual([PANEL_KIND])
  })
})

/* -------------------------------------------------------------------------- */
/* Lifetime                                                                   */
/* -------------------------------------------------------------------------- */

describe('client half — lifetime', () => {
  it('removes both registrations when its effect is disposed', () => {
    const { slots, disposedCount } = fakeSlots()
    const { ctx, effects } = fakeContext({ slots })
    apply(ctx)
    const lifetime = effects.find(effect => effect.name === 'dsh-agents-bridge: supervisor slots')
    expect(lifetime).toBeDefined()
    expect(disposedCount()).toBe(0)
    lifetime?.dispose()
    expect(disposedCount()).toBe(2)
  })

  it('registers the stylesheet under its own effect with a tagged id', () => {
    const { slots } = fakeSlots()
    const { ctx, effects } = fakeContext({ slots })
    apply(ctx)
    expect(effects[0]?.name).toBe('dsh-agents-bridge: stylesheet')
    expect(STYLE_TAG_ID).toBe('dsh-agents-bridge/panel.css')
  })
})

/* -------------------------------------------------------------------------- */
/* Locale                                                                     */
/* -------------------------------------------------------------------------- */

describe('localeOf', () => {
  it('reads whichever face the host version publishes', () => {
    expect(localeOf(undefined)).toBeUndefined()
    expect(localeOf({ current: () => 'zh-CN' })).toBe('zh-CN')
    expect(localeOf({ current: 'zh' })).toBe('zh')
    expect(localeOf({ get: () => 'en-US' })).toBe('en-US')
    expect(localeOf({ get: 'en' })).toBe('en')
    expect(localeOf({})).toBeUndefined()
  })

  it('does not throw when the service itself throws', () => {
    expect(localeOf({
      current: () => {
        throw new Error('no locale yet')
      },
    })).toBeUndefined()
  })
})
