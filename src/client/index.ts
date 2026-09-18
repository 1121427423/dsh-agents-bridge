/**
 * dsh-agents-bridge — CLIENT HALF entry (bundled to `lib/client.js`, loaded by
 * the DSH web client as a module-table consumer; `react` is provided by the
 * host).
 *
 * This is the other half of design decision D4 ("`bundle`, pure Node half; P4
 * adds the client half directly"): the nine tools make "agent calls agent"
 * possible, and this makes it VISIBLE — which delegated agents are alive, for
 * how long, what they last said, what they cost, and how to stop one.
 *
 * Module shape follows `dsh-history/lib/client.js` verbatim (the smallest
 * complete client-half example on this machine — see
 * `docs/client-half-slots.md` §1):
 *
 *   exports.inject = ['slots']
 *   function apply(ctx) { ctx.effect(...); const slots = ctx.get('slots') ... }
 *
 * THE ONE STRUCTURAL RULE
 * -----------------------
 * Only `slots` is in `inject`. Every other service — the host locale, the
 * sessions list, the sidebar-right API — is reached through `ctx.get` and
 * tolerated when absent, for the same reason `webServer` is not injected on the
 * Node half (design doc D16): an inject-listed service that a host does not
 * provide marks the plugin INACTIVE, and losing the tools because a panel
 * cannot be drawn is not a trade this plugin ever makes.
 *
 * The two slots degrade INDEPENDENTLY:
 *  - `sidebar.right.pane.tab` is provided by an optional peer package
 *    (`@deepseek-ai/dsh-client-ui-sidebar-right`). When it is absent,
 *    `slots.inject` simply never fires and only the header indicator exists.
 *  - the header indicator needs the conversation UI, always present in a
 *    conversation view.
 * Neither can blank the page: a rendering failure in the panel is caught by the
 * host's own boundary, and `apply` itself is wrapped so a client-runtime
 * surprise cannot break the module table.
 *
 * @module dsh-agents-bridge/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactElement } from 'react'
import { createElement } from 'react'
import { createBridgeApi } from './api.ts'
import { PACKAGE_NAME } from './identity.ts'
import { createTranslator, DICTS, detectLocaleTag, LOCALE_NS, localeTagOf, type Translator } from './i18n.ts'
import { Indicator, type IndicatorProps } from './indicator.ts'
import { SupervisorPanel } from './panel.ts'
import { SettingsCard } from './settings.ts'
import { createSupervisorStore, type SupervisorStore } from './store.ts'
import { DEFAULT_POLL_POLICY } from './util.ts'
import { injectStyles } from './styles.ts'
import { SETTINGS_NAMESPACE } from '../namespace.ts'

/** Slot names this half registers into. See `docs/client-half-slots.md` §2. */
export const PANEL_SLOT = 'sidebar.right.pane.tab'
/**
 * DSH's plugin-configuration card slot, KEYED by the settings namespace.
 *
 * The first-party tab enumerates the namespaces the host serves and dispatches
 * this slot once per namespace ("a served namespace no card claims renders
 * nothing"), so registering the namespace on the Node half is necessary but NOT
 * sufficient — this registration is what puts a card on screen.
 */
export const SETTINGS_SLOT = 'settings.plugin.item'

/**
 * Re-exported so the artifact carries the namespace as part of its public
 * surface: `tests/integration/client-bundle.test.ts` evaluates the BUILT bundle
 * and compares the card's slot key against this value, which is the only way to
 * assert the two halves agree without a second literal in the test.
 */
export { SETTINGS_NAMESPACE }
export const INDICATOR_SLOT = 'conversation.session.header.utilities'

/**
 * Registration ids (stable across reloads; the host dedupes on them).
 *
 * Derived from the package name (`./identity.ts`), never spelled out: the same
 * string is the ModuleLoader id of this bundle, and the host keys both the
 * module table and the slot registry on it.
 */
export const PANEL_ID = PACKAGE_NAME
export const INDICATOR_ID = `${PACKAGE_NAME}:indicator`

/**
 * The right Sidebar tab TYPE this panel registers as.
 *
 * A tab exists only when BOTH halves are registered, and they are keyed
 * together by {@link PANEL_ID}:
 *
 *  1. the TYPE — `ctx.get('sidebarRightTabs').register({ id, kind, title, guide })`,
 *     a static declaration naming the kind, labelling the chip, and putting a
 *     door on the sidebar's guide page; and
 *  2. the BODY — `slots.register({ name: PANEL_SLOT, key: <that id> }, Panel)`.
 *
 * The sidebar dispatches every tab as
 * `renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind })`, so the
 * body's `key` is the TYPE's `id`. It is not cosmetic: `sidebar.right.pane.tab`
 * is a KEYED slot, and the registry core refuses a keyed registration outright
 * (`keyed slot "…" requires options.key`). Registering only half the pair is
 * silent in the way that matters — nothing reaches the console and the panel
 * simply never appears.
 */
export const PANEL_KIND = PACKAGE_NAME

/**
 * Services required before mounting.
 *
 * ONLY `slots`. Everything else is lazy — see the module note. `slots` itself
 * is the client runtime's slot registry: without it there is no surface to
 * render into, so waiting for it is correct.
 */
export const inject = ['slots']

/** The client slot registry face (structural subset of the runtime service). */
export interface SlotsService {
  inject(name: string, callback: () => () => void): () => void
  register(
    options: { readonly name: string; readonly id?: string; readonly key?: string; readonly order?: number; readonly registrant?: string },
    component: (props: never) => ReactElement | null,
  ): () => void
}

/** One door out of the right Sidebar's guide page (the shipped shape). */
export interface SidebarGuideEntry {
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
}

/**
 * The right Sidebar's tab-type registry face (structural subset).
 *
 * Provided by `@deepseek-ai/dsh-client-ui-sidebar-right`, an OPTIONAL peer, and
 * reached through `ctx.get` for the reason in the module note: an inject-listed
 * service a host does not provide marks the plugin INACTIVE, and losing the
 * nine tools because a panel cannot be drawn is not a trade this plugin makes.
 * A host with no right Sidebar keeps the header indicator and the settings card.
 */
export interface SidebarTabsService {
  register(definition: {
    readonly id: string
    readonly kind: string
    readonly priority?: string
    readonly title: (address: string) => string
    readonly guide?: readonly SidebarGuideEntry[]
  }): (() => void) | undefined
}

/**
 * The right Sidebar's navigation controller face (structural subset).
 *
 * Same optional-peer reasoning as {@link SidebarTabsService}. `openTab` is the
 * one entry this half needs: it expands the column AND focuses (or opens) the
 * tab, which is exactly what a header chip promising "click to view" owes the
 * human. It carries no options on purpose — without `replaceTab` the tab lands
 * in the active cell and a page tab is de-duplicated within it, so a second
 * click focuses rather than closing whatever else the human had open.
 */
export interface SidebarRightService {
  openTab(kind: string, options?: unknown): void
}

/**
 * Reveal the supervisor panel: expand the right Sidebar on {@link PANEL_KIND}.
 *
 * Best-effort, and exported so the tolerance is testable on its own. The
 * controller THROWS — it requires a mounted session docking surface, and it
 * throws for a kind nothing registered — so every failure here has to become a
 * `false` rather than a broken click handler. Reached through `ctx.get` for the
 * module note's reason: the right Sidebar is an optional peer, and a host
 * without one keeps the indicator and the settings card.
 *
 * @param ctx - the client plugin context.
 * @returns whether the controller was asked to open the tab.
 */
export function revealPanelTab(ctx: Context): boolean {
  const sidebar = ctx.get('sidebarRight') as SidebarRightService | undefined
  if (sidebar?.openTab === undefined) return false
  try {
    sidebar.openTab(PANEL_KIND)
    return true
  } catch (error) {
    console.warn('[dsh-agents-bridge] cannot reveal the panel tab:', error instanceof Error ? error.message : String(error))
    return false
  }
}

/**
 * The navigation half of the indicator's props.
 *
 * Exported — and separated from the registration that spreads it — because the
 * WIRING is the part that rots. The chip and the controller can each pass their
 * own tests while the click between them does nothing, which is precisely the
 * state this plugin shipped in: a tooltip promising "click to view" over a
 * handler that only refreshed a store the collapsed sidebar never showed.
 * Same reasoning as {@link localeOf}.
 *
 * @param ctx - the client plugin context.
 * @returns the prop to spread into `Indicator`.
 */
export function indicatorNavigation(ctx: Context): Pick<IndicatorProps, 'onOpenPanel'> {
  return {
    // Resolved per CLICK, never captured at mount: the controller is published
    // by an optional peer that may mount after this plugin does.
    onOpenPanel: () => {
      revealPanelTab(ctx)
    },
  }
}

/** The host locale service face (structural subset; versions differ). */
export interface LocaleService {
  register?(namespace: string, tag: string, dict: unknown): () => void
  current?: (() => string) | string
  get?: (() => string) | string
}

/** The client session list face (structural subset used for locale/active id). */
export interface ClientSessionsService {
  list?: { getSnapshot(): { readonly current?: string | undefined } }
}

/** Read the host's current locale through whatever face its version publishes. */
export function localeOf(service: LocaleService | undefined): string | undefined {
  if (service === undefined) return undefined
  try {
    const current = service.current
    if (typeof current === 'function') return current()
    if (typeof current === 'string') return current
    const getter = service.get
    if (typeof getter === 'function') return getter()
    if (typeof getter === 'string') return getter
  } catch {
    /* a locale service that throws is not a reason to lose the panel */
  }
  return undefined
}

/**
 * Attach the translator to the host locale service, WHENEVER it appears.
 *
 * Reactive for the same reason {@link mountPanelTabType} is, and this one is
 * easy to miss because it fails so quietly: `slots` is provided by the shell
 * CORE, so `apply` runs before the plugin entries that publish the optional
 * services — `locale` (from `@deepseek-ai/dsh-client-locale`) among them. The
 * one-shot `ctx.get` therefore read `undefined` on every host, and the two
 * dictionary REGISTRATIONS never happened at all. Nothing looked broken,
 * because the panel still resolves its own dictionary from
 * `navigator.language`; what silently did not work is a host-driven locale
 * switch, which asks the locale service for a namespace nothing had registered.
 *
 * Best-effort by design: `locale.register`'s signature varies across host
 * versions, so a failure only costs the two registrations.
 *
 * @param ctx - the client plugin context.
 * @param translator - the shared translator to bind.
 */
function attachLocale(ctx: Context, translator: Translator): void {
  ctx.inject(['locale'], (scoped: Context) => {
    scoped.effect(
      () => registerLocaleDictionaries(scoped, translator) ?? (() => {}),
      'dsh-agents-bridge: locale dictionaries',
    )
  })
}

/**
 * Read the host's current locale and register both dictionaries with it.
 *
 * Returns the disposer, or `undefined` when the service publishes no
 * `register` face this version understands.
 *
 * @param ctx - a context where the `locale` service exists.
 * @param translator - the shared translator to bind.
 * @returns the disposer, or `undefined` when nothing was registered.
 */
function registerLocaleDictionaries(ctx: Context, translator: Translator): (() => void) | undefined {
  const service = ctx.get('locale') as LocaleService | undefined
  const detected = localeOf(service)
  if (detected !== undefined) translator.setTag(localeTagOf(detected))
  if (service?.register === undefined) return undefined
  try {
    const offZh = service.register(LOCALE_NS, 'zh', DICTS.zh)
    const offEn = service.register(LOCALE_NS, 'en', DICTS.en)
    return () => {
      offZh()
      offEn()
    }
  } catch (error) {
    console.warn('[dsh-agents-bridge] locale registration skipped:', error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/**
 * Declare the tab TYPE reactively, as soon as the registry exists.
 *
 * WHY NOT A ONE-SHOT `ctx.get` — this was the bug that kept the panel off
 * screen after every other half was correct. `slots` is in OUR `inject`, so
 * `apply` runs the moment it exists; `sidebarRightTabs` is published by
 * `@deepseek-ai/dsh-client-ui-sidebar-right`, which sits behind a deeper chain
 * (session controller → resources → conversation → layout → session) and
 * routinely activates LATER. The old code read `undefined` once, returned, and
 * never retried: no tab type, so no kind to open, so no panel — and nothing in
 * the console to say so.
 *
 * `ctx.inject` is the reactive form ("start a callback once the requested
 * dependencies are available"): it runs the callback when the service appears,
 * immediately when it is already there, and never when it never appears. It is
 * deliberately NOT a plugin-level `inject` entry — that would make the service
 * an ACTIVATION requirement, so a host with no right Sidebar would mark this
 * plugin INACTIVE and lose the header indicator and the settings card with it
 * (design doc D16).
 *
 * The callback runs in a child fiber of ours, so its effect is disposed with
 * this plugin; no manual bookkeeping is needed here.
 *
 * @param ctx - the client plugin context.
 * @param translator - the shared translator, read fresh on every call.
 */
function mountPanelTabType(ctx: Context, translator: Translator): void {
  ctx.inject(['sidebarRightTabs'], (scoped: Context) => {
    scoped.effect(
      () => registerPanelTabType(scoped, translator) ?? (() => {}),
      'dsh-agents-bridge: right-sidebar tab type',
    )
  })
}

/**
 * Phase 1 of the tab contract: declare the TYPE (see {@link PANEL_KIND}).
 *
 * Returns the disposer, or `undefined` when the registry rejects the
 * declaration. Never throws: the panel is one of three surfaces, and the header
 * indicator and settings card must survive its absence.
 *
 * `title` and the guide `title`/`description` are FUNCTIONS, not strings: the
 * sidebar calls them at render time, which is what lets a locale change land
 * without re-registering.
 *
 * @param ctx - the client plugin context (one where the registry exists).
 * @param translator - the shared translator, read fresh on every call.
 * @returns the disposer, or `undefined` when nothing was registered.
 */
function registerPanelTabType(ctx: Context, translator: Translator): (() => void) | undefined {
  const tabs = ctx.get('sidebarRightTabs') as SidebarTabsService | undefined
  if (tabs?.register === undefined) return undefined
  try {
    return tabs.register({
      id: PANEL_ID,
      kind: PANEL_KIND,
      // The chip's text. `tabLabel` is the short form — the strip also carries
      // the workspace file tree and the document preview.
      title: () => translator.t('tabLabel'),
      // This panel claims no resource address (it views sessions, not a file),
      // so the guide page is how a human opens it. `order` 30 sits behind the
      // workspace file tree's 10: the panel is a secondary surface.
      guide: [
        {
          order: 30,
          title: () => translator.t('panelTitle'),
          description: () => translator.t('emptyBody'),
        },
      ],
    })
  } catch (error) {
    console.warn('[dsh-agents-bridge] right-sidebar tab type skipped:', error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/**
 * Client plugin body.
 *
 * @param ctx - the client plugin context.
 */
export function apply(ctx: Context): void {
  try {
    ctx.effect(() => injectStyles(), 'dsh-agents-bridge: stylesheet')
  } catch (error) {
    console.warn('[dsh-agents-bridge] stylesheet injection skipped:', error instanceof Error ? error.message : String(error))
  }

  const slots = ctx.get('slots') as SlotsService | undefined
  if (slots === undefined) {
    // No slot registry: there is nowhere to render. Silent by design — a host
    // without a UI is a normal deployment for the Node half's nine tools.
    return
  }

  const translator = createTranslator(detectLocaleTag())
  // ONE api instance, shared by the panel's store and the settings card: two
  // instances would mean two request paths with two failure stories.
  const api = createBridgeApi()
  const store: SupervisorStore = createSupervisorStore(
    api,
    translator,
    { policy: DEFAULT_POLL_POLICY, autoRefresh: true },
    {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      hidden: () => (typeof document === 'undefined' ? false : document.hidden),
      onVisibilityChange: listener => {
        if (typeof document === 'undefined') return () => {}
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      },
    },
  )

  let previousHidden: boolean | undefined
  try {
    ctx.effect(() => {
      // Both of these wait for services the plugin entries publish LATER, so
      // they open child fibers of our own — see `attachLocale` and
      // `mountPanelTabType`. Their registrations are therefore disposed with
      // THIS plugin, not by this effect's cleanup.
      attachLocale(ctx, translator)
      const offVisibility = typeof document === 'undefined'
        ? () => {}
        : (() => {
            const listener = (): void => {
              const hidden = document.hidden
              // Re-render on every visibility flip so the poll indicator's copy
              // matches reality; the STORE handles the cadence change.
              if (hidden !== previousHidden) {
                previousHidden = hidden
                store.setOptions({})
              }
            }
            document.addEventListener('visibilitychange', listener)
            return () => document.removeEventListener('visibilitychange', listener)
          })()

      // One effect owns the whole client lifetime so unload (and an HMR reload)
      // stops the poller, removes both registrations and takes the stylesheet
      // tag with it — in reverse order, nothing left pointing at a dead store.
      store.start()

      // Phase 1 of the tab contract (see `PANEL_KIND`). It MUST precede the
      // body below: the body's `key` is the id this declares, and the sidebar
      // only dispatches a tab whose kind a type has claimed. Registered
      // reactively — see `mountPanelTabType` for why a one-shot lookup here
      // silently cost the panel.
      mountPanelTabType(ctx, translator)

      // Phase 2: the body, KEYED by the type's id. `key` — not `id` — is what
      // a keyed slot dispatches on, and `sidebar.right.pane.tab` is keyed; the
      // registry core throws on a keyed registration without one.
      const disposePanel = slots.inject(PANEL_SLOT, () =>
        slots.register(
          { name: PANEL_SLOT, key: PANEL_ID, order: 30, registrant: PACKAGE_NAME },
          ((props: { sessionId?: string | undefined }) =>
            createElement(SupervisorPanel, {
              store,
              translator,
              ...(props?.sessionId === undefined ? {} : { sessionId: props.sessionId }),
            })) as never,
        ),
      )

      // Registered under the settings NAMESPACE (no `id`): that key is what the
      // first-party tab dispatches by, and it is the same string the Node half
      // registered with the settings service (`src/namespace.ts`).
      const disposeSettings = slots.inject(SETTINGS_SLOT, () =>
        slots.register(
          { name: SETTINGS_SLOT, key: SETTINGS_NAMESPACE, registrant: PACKAGE_NAME },
          (() => createElement(SettingsCard, { api, translator })) as never,
        ),
      )

      const disposeIndicator = slots.inject(INDICATOR_SLOT, () =>
        slots.register(
          { name: INDICATOR_SLOT, id: INDICATOR_ID, order: 40, registrant: PACKAGE_NAME },
          ((props: { sessionId?: string | undefined }) =>
            createElement(Indicator, {
              store,
              translator,
              // The chip's tooltip says "click to view"; this is what makes that
              // true — the panel is a different surface, and the store cannot
              // reveal it. See `indicatorNavigation`.
              ...indicatorNavigation(ctx),
              ...(props?.sessionId === undefined ? {} : { sessionId: props.sessionId }),
            })) as never,
        ),
      )

      return () => {
        disposePanel()
        disposeSettings()
        disposeIndicator()
        // The tab type and the locale dictionaries are NOT disposed here: both
        // live in child fibers cordis tears down with ours.
        offVisibility()
        store.stop()
      }
    }, 'dsh-agents-bridge: supervisor slots')
  } catch (error) {
    // A client-runtime difference must not take the module table down with it.
    console.warn('[dsh-agents-bridge] client half failed to mount:', error instanceof Error ? error.message : String(error))
  }
}
