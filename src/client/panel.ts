/**
 * dsh-agents-bridge client half — the supervisor panel component.
 *
 * Mounted in `sidebar.right.pane.tab`: the full, human-facing view of "what
 * delegated agents exist right now". It renders, in order:
 *
 *   1. an engine strip (`probe`): how many engines are drivable, and which of
 *      them have a credential problem — the answer to "why did nothing start?";
 *   2. a session list: identity, status, elapsed time, last-event preview and
 *      token spend per row, running first;
 *   3. a transcript view opened per row, pulled INCREMENTALLY with
 *      `sinceIndex` (never a full re-read);
 *   4. a cancel affordance on running rows, behind a confirmation.
 *
 * Two rules shape every branch below:
 *
 *  - the panel must never blank. Loading, empty, unreachable-host and
 *    no-engines are four DIFFERENT states with their own copy, each with a way
 *    out (Retry / Refresh), and none of them is a raw code or a stack.
 *  - the transcript view is a VIEW, not a re-read: a finished session's
 *    transcript cannot change, so nothing polls it (see `store.ts`).
 *
 * @module dsh-agents-bridge/client/panel
 */

import type { ReactElement } from 'react'
import { createElement, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SupervisorSnapshot, SupervisorStore } from './store.ts'
import type { Translator } from './i18n.ts'
import { ROOT_CLASS } from './styles.ts'
import type { ClientProbeResult, ClientSession } from './util.ts'
import {
  credentialLabel,
  formatDuration,
  formatTokenSummary,
  isDisplayable,
  pollDecision,
  previewText,
  sessionElapsed,
  sessionPreview,
  statusLabel,
  summarizeEngines,
} from './util.ts'

/** Subscription hook shared by both slots (kept here: `store.ts` is React-free). */
export function useSupervisor(store: SupervisorStore): SupervisorSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** Props every panel render receives. */
export interface PanelProps {
  readonly store: SupervisorStore
  readonly translator: Translator
  /** The pane's session id, when the host supplies one. Display-only. */
  readonly sessionId?: string | undefined
}

/** A one-shot, auto-dismissing status line (cancel feedback). */
function useToast(timeoutMs = 5_000): readonly [string | undefined, (message: string | undefined) => void, () => void] {
  const [message, setMessage] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (message === undefined) return
    const handle = setTimeout(() => setMessage(undefined), timeoutMs)
    return () => clearTimeout(handle)
  }, [message, timeoutMs])
  return [message, setMessage, useCallback(() => setMessage(undefined), [])]
}

/** One engine row: `id · track · credential · models`. */
function engineRow(result: ClientProbeResult, translator: Translator): ReactElement {
  const parts: string[] = []
  parts.push(result.track === 'desktop' ? translator.t('enginesTrackDesktop') : translator.t('enginesTrackCli'))
  if (result.available) {
    const credential = credentialLabel(result.health?.credential)
    parts.push(credential === 'ok' || credential === 'n/a' ? translator.t('enginesCredentialOk') : `${translator.t('enginesCredentialProblem')}: ${credential}`)
    if ((result.models?.length ?? 0) > 0) parts.push(`${result.models?.length ?? 0} models`)
  } else {
    parts.push(result.reason === undefined || result.reason === '' ? 'unavailable' : previewText(result.reason, 90))
  }
  return createElement(
    'div',
    { className: `${ROOT_CLASS}__engine`, key: result.id },
    createElement('span', { className: `${ROOT_CLASS}__engineName` }, result.available ? '✓' : '✗', ' ', result.id),
    createElement('span', { className: `${ROOT_CLASS}__engineMeta` }, parts.join(' · ')),
  )
}

/** The engine availability strip. */
function EngineStrip({ snapshot, translator, onRefresh, onRescan }: {
  readonly snapshot: SupervisorSnapshot
  readonly translator: Translator
  readonly onRefresh: () => void
  readonly onRescan: () => void
}): ReactElement {
  const summary = useMemo(() => summarizeEngines(snapshot.engines.results), [snapshot.engines.results])
  const ok = summary.total > 0 && summary.available > 0
  const headline = snapshot.engines.loading && summary.total === 0
    ? translator.t('loadingTitle')
    : summary.available === 0
      ? translator.t('enginesNone')
      : translator.t('enginesAvailable', { n: summary.available, total: summary.total })

  return createElement(
    'div',
    { className: `${ROOT_CLASS}__engines` },
    createElement(
      'div',
      { className: `${ROOT_CLASS}__enginesSummary`, 'data-ok': String(ok) },
      createElement('span', null, `${translator.t('enginesTitle')} · ${headline}`),
      summary.withModels > 0 ? createElement('span', null, ` · ${translator.t('enginesModels', { n: summary.withModels })}`) : null,
      createElement('span', { className: `${ROOT_CLASS}__spacer` }),
      // TWO verbs, deliberately not one button. Re-probing versions is the
      // cheap half (and the expensive-looking path: `refresh` re-resolves
      // executables), while RE-WALKING the bundle roots is a synchronous
      // filesystem sweep whose only purpose is to notice an app installed since
      // the host started. Folding them together would either tax every refresh
      // with the walk (MI-8) or leave the walk undiscoverable (RR-MI-1b), so
      // the walk gets its own labelled button and its reason in the tooltip.
      createElement('button', { type: 'button', className: `${ROOT_CLASS}__btn`, onClick: onRefresh }, translator.t('refresh')),
      createElement(
        'button',
        {
          type: 'button',
          className: `${ROOT_CLASS}__btn`,
          title: translator.t('rescanInstallsTitle'),
          onClick: onRescan,
        },
        translator.t('rescanInstalls'),
      ),
    ),
    snapshot.engines.error === undefined
      ? null
      : createElement('div', { className: `${ROOT_CLASS}__engineMeta` }, snapshot.engines.error),
    snapshot.engines.results.length === 0
      ? null
      : createElement('div', { className: `${ROOT_CLASS}__engineList` }, ...snapshot.engines.results.map(result => engineRow(result, translator))),
  )
}

/** One session row. */
function SessionRow({
  session,
  now,
  translator,
  onOpen,
  onCancel,
  busy,
}: {
  readonly session: ClientSession
  readonly now: number
  readonly translator: Translator
  readonly onOpen: (sessionId: string) => void
  readonly onCancel: (sessionId: string) => void
  readonly busy: boolean
}): ReactElement {
  const elapsed = formatDuration(sessionElapsed(session, now))
  const preview = sessionPreview(session)
  // The exit status is the outcome of the run, so it sits next to the status
  // badge rather than in the metadata foot. A running row has no result yet,
  // and `null` (the ABI's "no exit status": a cancel, a restored row) renders
  // nothing at all — never a fabricated 0.
  const exitCode = session.status === 'running' ? undefined : session.result?.exitCode
  return createElement(
    'div',
    { className: `${ROOT_CLASS}__row`, 'data-status': session.status },
    createElement(
      'div',
      { className: `${ROOT_CLASS}__rowHead` },
      createElement('span', { className: `${ROOT_CLASS}__agent`, title: session.sessionId }, session.agentId),
      createElement('span', { className: `${ROOT_CLASS}__badge`, 'data-status': session.status }, statusLabel(session.status, translator.current())),
      exitCode === undefined
        ? null
        : createElement(
            'span',
            { className: `${ROOT_CLASS}__exit`, 'data-exit': exitCode === 0 ? 'ok' : 'error' },
            translator.t('exitCode', { code: exitCode }),
          ),
      createElement('span', { className: `${ROOT_CLASS}__spacer` }),
      createElement('span', { className: `${ROOT_CLASS}__mono`, title: `${translator.t('started')} ${new Date(session.startedAt).toLocaleString()}` }, elapsed),
    ),
    createElement(
      'div',
      { className: `${ROOT_CLASS}__preview${preview === '' ? ` ${ROOT_CLASS}__preview--empty` : ''}` },
      preview === ''
        ? (session.status === 'running' ? translator.t('waitingForAgent') : translator.t('noOutputKept'))
        : preview,
    ),
    createElement(
      'div',
      { className: `${ROOT_CLASS}__rowFoot` },
      createElement('span', { className: `${ROOT_CLASS}__mono` }, `${session.messageCount} ${translator.t('messages')}`),
      createElement('span', { className: `${ROOT_CLASS}__mono` }, formatTokenSummary(session, translator.current())),
    ),
    createElement(
      'div',
      { className: `${ROOT_CLASS}__actions` },
      createElement(
        'button',
        { type: 'button', className: `${ROOT_CLASS}__btn`, onClick: () => onOpen(session.sessionId) },
        translator.t('openOutput'),
      ),
      session.status === 'running'
        ? createElement(
            'button',
            {
              type: 'button',
              className: `${ROOT_CLASS}__btn ${ROOT_CLASS}__btn--danger`,
              disabled: busy,
              onClick: () => onCancel(session.sessionId),
            },
            busy ? translator.t('cancelling') : translator.t('cancel'),
          )
        : null,
    ),
  )
}

/** The incremental transcript view. */
function TranscriptView({
  snapshot,
  translator,
  onBack,
}: {
  readonly snapshot: SupervisorSnapshot
  readonly translator: Translator
  readonly onBack: () => void
}): ReactElement {
  const visible = snapshot.transcript.filter(isDisplayable)
  const session = snapshot.sessions.find(entry => entry.sessionId === snapshot.selectedId)
  return createElement(
    'div',
    { className: `${ROOT_CLASS}__list` },
    createElement(
      'div',
      { className: `${ROOT_CLASS}__bar` },
      createElement('button', { type: 'button', className: `${ROOT_CLASS}__btn`, onClick: onBack }, `‹ ${translator.t('back')}`),
      createElement('span', { className: `${ROOT_CLASS}__agent` }, session?.agentId ?? snapshot.selectedId ?? ''),
      session === undefined
        ? null
        : createElement('span', { className: `${ROOT_CLASS}__badge`, 'data-status': session.status }, statusLabel(session.status, translator.current())),
      createElement('span', { className: `${ROOT_CLASS}__spacer` }),
      createElement('span', { className: `${ROOT_CLASS}__mono` }, `${visible.length}`),
    ),
    // A trimmed transcript is not an empty one: the events existed, the retained
    // window just no longer starts at #0. Without this the panel opens at
    // `#200, #201, …` and the missing head reads as a bug in the agent. It gets
    // its own strip rather than `__state`: `__state` is the CENTRED empty-state
    // placeholder (`margin: auto`), which would push the rows out of place.
    snapshot.transcriptDropped > 0
      ? createElement(
          'div',
          { className: `${ROOT_CLASS}__notice` },
          translator.t('transcriptDropped', { n: snapshot.transcriptDropped }),
        )
      : null,
    visible.length === 0
      ? createElement(
          'div',
          { className: `${ROOT_CLASS}__state` },
          // Same rule as the list row: a FINISHED session with nothing retained
          // (a restarted host, a spilled transcript) must not be described as
          // an agent that is still working.
          createElement(
            'div',
            { className: `${ROOT_CLASS}__stateTitle` },
            session?.terminal === true ? translator.t('noOutputKept') : translator.t('noEventsYet'),
          ),
          session?.terminal === true ? null : createElement('div', null, translator.t('waitingForAgent')),
        )
      : createElement(
          'div',
          { className: `${ROOT_CLASS}__transcript` },
          ...visible.map(message =>
            createElement(
              'div',
              { className: `${ROOT_CLASS}__event`, 'data-type': message.type, key: message.index },
              createElement('span', { className: `${ROOT_CLASS}__eventIdx` }, `#${message.index}`),
              createElement(
                'span',
                { className: `${ROOT_CLASS}__eventBody` },
                `[${message.type}] ${message.type === 'tool_use' || message.type === 'tool_result' ? (message.tool ?? '') : (message.text ?? '')}`,
              ),
            ),
          ),
        ),
  )
}

/** The panel. */
export function SupervisorPanel({ store, translator }: PanelProps): ReactElement {
  const snapshot = useSupervisor(store)
  const [now, setNow] = useState(() => Date.now())
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [cancelling, setCancelling] = useState<string | undefined>(undefined)
  const [toast, setToast] = useToast()

  useEffect(() => {
    store.start()
    return () => {
      // The store is shared by both slots; stopping it here would kill the
      // header indicator when the sidebar pane unmounts. The plugin body owns
      // the lifetime instead (see index.tsx).
    }
  }, [store])

  // A 1s ticker drives the "elapsed" column of RUNNING rows only. It is not a
  // data poll: no request leaves the browser, and it stops as soon as nothing
  // is running.
  useEffect(() => {
    if (snapshot.counts.running === 0) return
    const handle = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(handle)
  }, [snapshot.counts.running])

  const onCancel = useCallback(
    async (sessionId: string) => {
      setConfirming(undefined)
      setCancelling(sessionId)
      const result = await store.cancelSession(sessionId)
      setCancelling(undefined)
      setToast(result.message)
    },
    [store, setToast],
  )

  const decision = pollDecision({
    running: snapshot.counts.running,
    hidden: typeof document === 'undefined' ? false : document.hidden,
    paused: !store.getOptions().autoRefresh || snapshot.selectedId !== undefined,
    ...(store.getOptions().policy === undefined ? {} : { policy: store.getOptions().policy }),
  })

  const pollLabel = decision.mode === 'running'
    ? translator.t('pollLive')
    : decision.mode === 'idle'
      ? translator.t('pollIdle')
      : decision.mode === 'hidden'
        ? translator.t('pollHidden')
        : translator.t('pollPaused')

  const body: ReactElement = snapshot.selectedId !== undefined
    ? createElement(TranscriptView, { snapshot, translator, onBack: () => store.closeSession() })
    : snapshot.error !== undefined && !snapshot.loaded
      ? createElement(
          'div',
          { className: `${ROOT_CLASS}__state`, 'data-kind': 'error' },
          createElement('div', { className: `${ROOT_CLASS}__stateTitle` }, translator.t('errorUnavailableTitle')),
          createElement('div', null, snapshot.error),
          createElement('button', { type: 'button', className: `${ROOT_CLASS}__btn`, onClick: () => void store.refresh() }, translator.t('retry')),
        )
      : !snapshot.loaded
        ? createElement('div', { className: `${ROOT_CLASS}__state` }, createElement('div', null, translator.t('loadingTitle')))
        : snapshot.sessions.length === 0
          ? createElement(
              'div',
              { className: `${ROOT_CLASS}__state` },
              createElement('div', { className: `${ROOT_CLASS}__stateTitle` }, translator.t('emptyTitle')),
              createElement('div', null, translator.t('emptyBody')),
              createElement('div', null, translator.t('emptyNoSessions')),
            )
          : createElement(
              'div',
              { className: `${ROOT_CLASS}__list` },
              ...snapshot.sessions.map(session =>
                createElement(SessionRow, {
                  key: session.sessionId,
                  session,
                  now,
                  translator,
                  onOpen: (sessionId: string) => void store.openSession(sessionId),
                  onCancel: (sessionId: string) => setConfirming(sessionId),
                  busy: cancelling === session.sessionId,
                }),
              ),
            )

  return createElement(
    'div',
    { className: ROOT_CLASS, style: { position: 'relative' } },
    createElement(
      'div',
      { className: `${ROOT_CLASS}__bar` },
      createElement('span', { className: `${ROOT_CLASS}__title` }, translator.t('panelTitle')),
      snapshot.counts.running > 0
        ? createElement('span', { className: `${ROOT_CLASS}__badge`, 'data-status': 'running' }, translator.t('indicatorRunning', { n: snapshot.counts.running }))
        : null,
      snapshot.counts.unseenFailures > 0
        ? createElement('span', { className: `${ROOT_CLASS}__badge`, 'data-status': 'failed' }, translator.t('indicatorFailed', { n: snapshot.counts.unseenFailures }))
        : null,
      createElement('span', { className: `${ROOT_CLASS}__poll`, 'data-mode': decision.mode }, pollLabel),
      createElement(
        'button',
        {
          type: 'button',
          className: `${ROOT_CLASS}__btn`,
          disabled: snapshot.loading,
          onClick: () => void store.refresh(),
        },
        snapshot.loading ? translator.t('refreshing') : translator.t('refresh'),
      ),
    ),
    createElement(EngineStrip, {
      snapshot,
      translator,
      onRefresh: () => void store.refreshEngines(),
      onRescan: () => void store.rescanEngines(),
    }),
    snapshot.error !== undefined && snapshot.loaded
      ? createElement(
          'div',
          { className: `${ROOT_CLASS}__strip` },
          createElement('span', { className: `${ROOT_CLASS}__stripMsg` }, snapshot.error),
          createElement('button', { type: 'button', className: `${ROOT_CLASS}__btn`, onClick: () => void store.refresh() }, translator.t('retry')),
        )
      : null,
    toast === undefined ? null : createElement('div', { className: `${ROOT_CLASS}__toast` }, toast),
    body,
    confirming === undefined
      ? null
      : createElement(
          'div',
          { className: `${ROOT_CLASS}__confirm`, role: 'dialog', 'aria-modal': 'true' },
          createElement(
            'div',
            { className: `${ROOT_CLASS}__confirmCard` },
            createElement('div', { className: `${ROOT_CLASS}__stateTitle` }, translator.t('cancelConfirmTitle')),
            createElement('div', { className: `${ROOT_CLASS}__confirmBody` }, translator.t('cancelConfirmBody')),
            createElement(
              'div',
              { className: `${ROOT_CLASS}__confirmActions` },
              createElement('button', { type: 'button', className: `${ROOT_CLASS}__btn`, onClick: () => setConfirming(undefined) }, translator.t('cancelConfirmNo')),
              createElement(
                'button',
                { type: 'button', className: `${ROOT_CLASS}__btn ${ROOT_CLASS}__btn--danger`, onClick: () => void onCancel(confirming) },
                translator.t('cancelConfirmYes'),
              ),
            ),
          ),
        ),
  )
}
