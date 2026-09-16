/**
 * dsh-agents-bridge client half — the persistent header indicator.
 *
 * Mounted in `conversation.session.header.utilities`, which the host renders
 * with NO props. It answers one question at a glance — "is anything of mine
 * running right now?" — and is DELIBERATELY independent of the sidebar panel:
 *
 *  - it reads the same store, so it works when `sidebar.right.pane.tab` is
 *    unavailable (that slot is provided by an OPTIONAL peer package —
 *    `@deepseek-ai/dsh-client-ui-sidebar-right`);
 *  - it renders nothing at all when the plugin has no sessions AND no engine is
 *    drivable, rather than parking a permanent "0 running" chip in the session
 *    header of every conversation, including ones that never delegate.
 *
 * @module dsh-agents-bridge/client/indicator
 */

import type { ReactElement } from 'react'
import { createElement } from 'react'
import type { SupervisorStore } from './store.ts'
import type { Translator } from './i18n.ts'
import { useSupervisor } from './panel.ts'

/** Props the indicator render receives. */
export interface IndicatorProps {
  readonly store: SupervisorStore
  readonly translator: Translator
  /** Reported by the host; unused beyond a tooltip, kept for parity with the panel. */
  readonly sessionId?: string | undefined
}

/**
 * The chip. Three states, in priority order:
 *
 *  1. any unseen failure → red, with the count. This is the only state that
 *     demands a human's attention, so it wins over "running".
 *  2. any running session → green with a slow pulse, so "still working" reads
 *     from across the room without reading the number.
 *  3. nothing at all → the chip is NOT rendered (see the module note).
 */
export function Indicator({ store, translator, sessionId }: IndicatorProps): ReactElement | null {
  const snapshot = useSupervisor(store)
  const { running, unseenFailures } = snapshot.counts

  if (unseenFailures > 0) {
    return createElement(
      'button',
      {
        type: 'button',
        className: 'abg-indicator',
        'data-status': 'failed',
        title: translator.t('indicatorFailedTitle', { n: unseenFailures }),
        onClick: () => void store.openSession(snapshot.sessions.find(session => session.status === 'failed')?.sessionId ?? ''),
      },
      createElement('span', { className: 'abg-indicator__dot' }),
      createElement('span', null, translator.t('indicatorFailed', { n: unseenFailures })),
    )
  }

  if (running > 0) {
    return createElement(
      'button',
      {
        type: 'button',
        className: 'abg-indicator',
        'data-status': 'running',
        title: translator.t('indicatorRunningTitle', { n: running }),
        onClick: () => void store.refresh(),
      },
      createElement('span', { className: 'abg-indicator__dot' }),
      createElement('span', null, translator.t('indicatorRunning', { n: running })),
    )
  }

  // Loaded, idle, and the deployment has nothing drivable: stay out of the way.
  if (snapshot.loaded && snapshot.sessions.length === 0 && !snapshot.engines.available) return null

  // Loaded and idle but the feature IS in use (or could be): a quiet marker
  // beats an empty corner, and it is the affordance that teaches the panel exists.
  if (snapshot.loaded) {
    return createElement(
      'button',
      {
        type: 'button',
        className: 'abg-indicator',
        'data-status': 'idle',
        title: translator.t('indicatorIdleTitle'),
        onClick: () => void store.refresh(),
      },
      createElement('span', { className: 'abg-indicator__dot' }),
      createElement('span', null, translator.t('indicatorIdle')),
    )
  }

  // Not loaded yet (first poll in flight): render nothing rather than a
  // placeholder that would flash on every session switch.
  if (sessionId === '__never__') return null
  return null
}
