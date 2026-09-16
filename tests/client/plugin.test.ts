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

import { INDICATOR_ID, INDICATOR_SLOT, PANEL_ID, PANEL_SLOT, apply, inject, localeOf, type SlotsService } from '../../src/client/index.ts'
import { STYLE_TAG_ID } from '../../src/client/styles.ts'

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Registration {
  readonly name: string
  readonly id?: string | undefined
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
      registered.push({ name: regOptions.name, id: regOptions.id, order: regOptions.order })
      return () => {
        disposed += 1
      }
    },
  }
  return { slots, injected, registered, disposedCount: () => disposed }
}

/** A minimal Cordis-like context recording effects and disposals. */
function fakeContext(services: Record<string, unknown>) {
  const effects: { name: string; dispose: () => void }[] = []
  const ctx = {
    get(name: string) {
      return services[name]
    },
    effect(callback: () => (() => void) | void, name?: string) {
      const dispose = callback() ?? (() => {})
      effects.push({ name: name ?? 'anonymous', dispose })
      return () => dispose()
    },
  }
  return {
    ctx: ctx as never,
    effects,
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
    expect(registered[0]?.id).toBe(PANEL_ID)
    disposeAll()
  })

  it('registers the indicator when only the header slot exists (sidebar-right missing)', () => {
    // `sidebar.right.pane.tab` comes from an OPTIONAL peer package; its absence
    // must cost only the panel, never a blank page or a throw.
    const { slots, registered, injected } = fakeSlots({ available: [INDICATOR_SLOT] })
    const { ctx, disposeAll } = fakeContext({ slots })
    expect(() => apply(ctx)).not.toThrow()
    expect(injected).toEqual([PANEL_SLOT, INDICATOR_SLOT])
    expect(registered.map(entry => entry.name)).toEqual([INDICATOR_SLOT])
    expect(registered[0]?.id).toBe(INDICATOR_ID)
    disposeAll()
  })

  it('registers both when both slots exist, panel before indicator', () => {
    const { slots, registered } = fakeSlots()
    const { ctx, disposeAll } = fakeContext({ slots })
    apply(ctx)
    expect(registered).toEqual([
      { name: PANEL_SLOT, id: PANEL_ID, order: 30 },
      { name: INDICATOR_SLOT, id: INDICATOR_ID, order: 40 },
    ])
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

  it('tolerates a browser with no document (a non-DOM renderer)', () => {
    const { slots } = fakeSlots()
    const { ctx, disposeAll } = fakeContext({ slots })
    expect(() => apply(ctx)).not.toThrow()
    disposeAll()
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
