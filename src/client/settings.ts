/**
 * dsh-agents-bridge client half — the settings card.
 *
 * Mounted in `settings.plugin.item` under the key `agents-bridge` (the settings
 * namespace). WHY a card and not "just register the namespace":
 *
 *   `ConfigurablePluginsTab` (first-party) ENUMERATES the namespaces the host
 *   serves and dispatches this slot per namespace — "a served namespace no card
 *   claims renders nothing". So a namespace alone produces no UI; the plugin that
 *   owns the namespace owns its card.
 *
 * Three deliberate properties:
 *
 *  - **It never invents a write path.** Saving calls `settings-write`, which calls
 *    the settings SCOPE on the Node half, which merges into the user layer and
 *    persists revision-gated. This component cannot touch `settings.yaml`.
 *  - **It states each field's effect.** `live` vs `reload` comes from the field
 *    table on the Node side and is rendered next to the input; a switch that
 *    silently needs a reload is the kind of lie this project keeps finding.
 *  - **It never blanks.** Loading, read-only-deployment, refusal and empty are
 *    four different states, each with its own copy and none of them a raw code.
 *
 * Inline styles on purpose: the host's settings CSS is not a contract we own, and
 * the plugin's own class-based stylesheet is scoped to the sidebar panel.
 *
 * @module dsh-agents-bridge/client/settings
 */

import type { ReactElement } from 'react'
import { createElement, useCallback, useEffect, useMemo, useState } from 'react'

import type { Dict, Translator } from './i18n.ts'
import type { BridgeApi, ClientSettingField, ClientSettingsView } from './api.ts'

/** Props the settings slot render receives. */
export interface SettingsCardProps {
  readonly api: BridgeApi
  readonly translator: Translator
}

/** Field key → dictionary key. Kept here so `i18n.ts` stays key-agnostic. */
const LABELS: Readonly<Record<string, keyof Dict>> = {
  defaultCwd: 'settingsFieldDefaultCwd',
  maxConcurrent: 'settingsFieldMaxConcurrent',
  allowedCwd: 'settingsFieldAllowedCwd',
  deniedCwd: 'settingsFieldDeniedCwd',
  allowedAgents: 'settingsFieldAllowedAgents',
}

/** Draft text for one field, as the user typed it. */
function toDraft(field: ClientSettingField): string {
  if (field.value === undefined) return ''
  return Array.isArray(field.value) ? field.value.join('\n') : String(field.value)
}

const box: Readonly<Record<string, string | number>> = {
  padding: '12px',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '13px',
  lineHeight: '1.5',
}

/**
 * The card.
 */
export function SettingsCard({ api, translator }: SettingsCardProps): ReactElement {
  const { t } = translator
  const [view, setView] = useState<ClientSettingsView | undefined>(undefined)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const adopt = useCallback((next: ClientSettingsView) => {
    setView(next)
    setDrafts(Object.fromEntries(next.fields.map((field) => [field.key, toDraft(field)])))
  }, [])

  useEffect(() => {
    let live = true
    void api
      .settings()
      .then((next) => {
        if (live) {
          adopt(next)
          setFailed(false)
        }
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [api, adopt])

  /** Fields the user actually changed, so a save never rewrites untouched values. */
  const dirty = useMemo(() => {
    if (view === undefined) return []
    return view.fields.filter((field) => drafts[field.key] !== toDraft(field))
  }, [view, drafts])

  const save = useCallback(async () => {
    if (dirty.length === 0) return
    setBusy(true)
    setStatus(t('settingsSaving'))
    try {
      const result = await api.settingsWrite(
        Object.fromEntries(dirty.map((field) => [field.key, drafts[field.key] ?? ''])),
      )
      if (result.ok) {
        adopt(result.value)
        setStatus(t('settingsSaved'))
      } else {
        // The refusal NAMES the rule ("maxConcurrent must be a positive integer"),
        // which is the only reason a form may show a raw string here.
        setStatus(result.error)
      }
    } catch {
      setStatus(t('settingsLoadFailed'))
    } finally {
      setBusy(false)
    }
  }, [api, adopt, dirty, drafts, t])

  const reset = useCallback(
    async (field: ClientSettingField) => {
      setBusy(true)
      try {
        const result = await api.settingsReset(field.key)
        if (result.ok) {
          adopt(result.value)
          setStatus(undefined)
        } else setStatus(result.error)
      } catch {
        setStatus(t('settingsLoadFailed'))
      } finally {
        setBusy(false)
      }
    },
    [api, adopt, t],
  )

  if (failed) {
    return createElement('div', { style: box }, createElement('p', null, t('settingsLoadFailed')))
  }
  if (view === undefined) {
    return createElement('div', { style: box }, createElement('p', null, t('settingsIntro')))
  }

  const rows = view.fields.map((field) => {
    const labelKey = LABELS[field.key]
    return createElement(
      'label',
      { key: field.key, style: { display: 'block', marginBottom: '14px' } },
      createElement(
        'span',
        { style: { display: 'flex', gap: '8px', alignItems: 'baseline', marginBottom: '4px' } },
        // An unknown field renders its own key rather than an empty label: the
        // Node half can add a field before this half ships its copy.
        createElement('strong', null, labelKey === undefined ? field.key : t(labelKey)),
        createElement(
          'span',
          { style: { opacity: 0.7, fontSize: '12px' } },
          field.effect === 'live' ? t('settingsEffectLive') : t('settingsEffectReload'),
          ' · ',
          field.overridden ? t('settingsOverridden') : t('settingsInherited'),
        ),
      ),
      field.kind === 'strings'
        ? createElement('textarea', {
            value: drafts[field.key] ?? '',
            disabled: !view.writable || busy,
            rows: 3,
            style: { width: '100%', font: 'inherit', padding: '6px' },
            onChange: (event: { target: { value: string } }) => {
              setDrafts((current) => ({ ...current, [field.key]: event.target.value }))
            },
          })
        : createElement('input', {
            type: field.kind === 'natural' ? 'number' : 'text',
            value: drafts[field.key] ?? '',
            disabled: !view.writable || busy,
            style: { width: '100%', font: 'inherit', padding: '6px' },
            onChange: (event: { target: { value: string } }) => {
              setDrafts((current) => ({ ...current, [field.key]: event.target.value }))
            },
          }),
      createElement(
        'span',
        { style: { display: 'block', opacity: 0.65, fontSize: '12px', marginTop: '2px' } },
        field.reason,
        field.kind === 'strings' ? ` — ${t('settingsListsHint')}` : '',
      ),
      field.overridden && view.writable
        ? createElement(
            'button',
            {
              type: 'button',
              disabled: busy,
              style: { marginTop: '4px', font: 'inherit' },
              onClick: () => void reset(field),
            },
            t('settingsReset'),
          )
        : null,
    )
  })

  return createElement(
    'div',
    { style: box },
    createElement('h3', { style: { margin: '0 0 6px', fontSize: '15px' } }, t('settingsTitle')),
    createElement('p', { style: { margin: '0 0 12px', opacity: 0.75 } }, t('settingsIntro')),
    view.writable
      ? null
      : createElement('p', { style: { margin: '0 0 12px', color: '#c26' } }, view.reason ?? t('settingsReadOnly')),
    ...rows,
    view.writable
      ? createElement(
          'div',
          { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
          createElement(
            'button',
            {
              type: 'button',
              disabled: busy || dirty.length === 0,
              style: { font: 'inherit', padding: '4px 14px' },
              onClick: () => void save(),
            },
            t('settingsSave'),
          ),
          status === undefined
            ? null
            : createElement('span', { style: { opacity: 0.8 } }, status),
        )
      : null,
  )
}
