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
import { Indicator } from './indicator.ts'
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
 * Attach the translator to the host locale service when one is published.
 *
 * Best-effort by design: `locale.register`'s signature varies across host
 * versions (namespace + tag + dictionary here, a different shape elsewhere), so
 * a failure only costs the two dictionary REGISTRATIONS — the panel keeps the
 * dictionary it already resolved from `navigator.language`. Returns the
 * disposer, or `undefined` when nothing was registered.
 */
function attachLocale(ctx: Context, translator: Translator): (() => void) | undefined {
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
      const localeDisposer = attachLocale(ctx, translator)
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

      const disposePanel = slots.inject(PANEL_SLOT, () =>
        slots.register(
          { name: PANEL_SLOT, id: PANEL_ID, order: 30, registrant: PACKAGE_NAME },
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
              ...(props?.sessionId === undefined ? {} : { sessionId: props.sessionId }),
            })) as never,
        ),
      )

      return () => {
        disposePanel()
        disposeSettings()
        disposeIndicator()
        offVisibility()
        localeDisposer?.()
        store.stop()
      }
    }, 'dsh-agents-bridge: supervisor slots')
  } catch (error) {
    // A client-runtime difference must not take the module table down with it.
    console.warn('[dsh-agents-bridge] client half failed to mount:', error instanceof Error ? error.message : String(error))
  }
}
