/**
 * dsh-agents-bridge client half — the settings card.
 *
 * Mounted in `settings.plugin.item` under the key `dsh-agents-bridge` (the
 * settings namespace — NOT `agents-bridge`, which an earlier comment here said
 * and which is exactly the kind of drift the card's own identifier line now
 * prevents a reader from having to guess). WHY a card and not "just register the
 * namespace":
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
import { SETTINGS_NAMESPACE } from '../namespace.ts'

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
  qoderTransport: 'settingsFieldQoderTransport',
}

/** Draft text for one field, as the user typed it. */
function toDraft(field: ClientSettingField): string {
  if (field.value === undefined) return ''
  return Array.isArray(field.value) ? field.value.join('\n') : String(field.value)
}

/**
 * The card's chrome, mirroring the first-party cards in this slot: one `<li>`
 * with a full-width header button that expands the body.
 *
 * WHY NOT the host's own components: `PluginCard`'s look comes from that
 * package's private CSS module, which a third-party half cannot address. The
 * shared `@deepseek-ai/dsh-client-ui-primitives` kit therefore buys only an icon
 * and a pill (its `IconChevronDownOutline14` / `Tag`) while adding a hard module
 * dependency to this whole client half — so the chevron is an inline SVG and the
 * marker a span, and this file stays self-contained apart from `react`.
 *
 * The parent renders a `<ul>`, so an `<li>` is the only correct root.
 */
const card: Readonly<Record<string, string>> = {
  listStyle: 'none',
  margin: '0 0 8px',
  border: '1px solid rgba(127, 127, 127, 0.28)',
  borderRadius: '10px',
  overflow: 'hidden',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '13px',
  lineHeight: '1.5',
}

const header: Readonly<Record<string, string>> = {
  display: 'flex',
  gap: '10px',
  alignItems: 'center',
  width: '100%',
  padding: '10px 12px',
  background: 'transparent',
  border: '0',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

const headText: Readonly<Record<string, string>> = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  flex: '1 1 auto',
  minWidth: '0',
}

const nameStyle: Readonly<Record<string, string>> = { fontWeight: '600' }

/** The plugin's identity, in the header so it is visible while COLLAPSED. */
const identityStyle: Readonly<Record<string, string | number>> = {
  opacity: 0.65,
  fontSize: '12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const pill: Readonly<Record<string, string>> = {
  border: '1px solid rgba(127, 127, 127, 0.4)',
  borderRadius: '999px',
  padding: '1px 8px',
  fontSize: '11px',
  whiteSpace: 'nowrap',
}

const body: Readonly<Record<string, string>> = {
  padding: '2px 12px 12px',
  borderTop: '1px solid rgba(127, 127, 127, 0.2)',
}

const footer: Readonly<Record<string, string>> = { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '4px' }

const hint: Readonly<Record<string, string | number>> = { display: 'block', opacity: 0.65, fontSize: '12px', marginTop: '2px' }

const fieldRow: Readonly<Record<string, string>> = { display: 'block', marginBottom: '14px' }

const fieldHead: Readonly<Record<string, string>> = {
  display: 'flex',
  gap: '8px',
  alignItems: 'baseline',
  marginBottom: '4px',
}

const control: Readonly<Record<string, string>> = { width: '100%', font: 'inherit', padding: '6px', boxSizing: 'border-box' }

/** A chevron that rotates when the card opens — no icon dependency. */
function chevron(open: boolean): ReactElement {
  return createElement(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      style: { flex: '0 0 auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' },
    },
    createElement('path', {
      d: 'M4 6l4 4 4-4',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/** Props of one field row, so the body is testable without a renderer. */
export interface SettingsFieldsProps {
  readonly view: ClientSettingsView
  readonly drafts: Readonly<Record<string, string>>
  readonly busy: boolean
  readonly translator: Translator
  readonly onEdit: (key: string, value: string) => void
  readonly onReset: (field: ClientSettingField) => void
}

/**
 * The form body: one row per field, each stating when it takes effect.
 *
 * Exported because the card only renders it once EXPANDED, and the stub
 * renderer used by this repo's tests has no state — so testing the fields
 * through the card would be impossible, and shipping them untested because of a
 * test-harness limitation is how a form quietly loses a field.
 */
export function SettingsFields({ view, drafts, busy, translator, onEdit, onReset }: SettingsFieldsProps): ReactElement {
  const { t } = translator
  return createElement(
    'div',
    null,
    ...view.fields.map((field) => {
      const labelKey = LABELS[field.key]
      return createElement(
        'label',
        { key: field.key, style: fieldRow },
        createElement(
          'span',
          { style: fieldHead },
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
              style: control,
              onChange: (event: { target: { value: string } }) => {
                onEdit(field.key, event.target.value)
              },
            })
          : field.kind === 'choice'
            ? // A CLOSED value set renders as a select, never as free text: the
              // node half refuses values outside the option list, so a text box
              // here would only be a way to type a save that fails. The empty
              // option means "unset" — save coerces it to a key removal, which
              // hands the decision back to the deployment config / kernel.
              createElement(
                'select',
                {
                  value: drafts[field.key] ?? '',
                  disabled: !view.writable || busy,
                  style: control,
                  onChange: (event: { target: { value: string } }) => {
                    onEdit(field.key, event.target.value)
                  },
                },
                createElement('option', { value: '' }, t('settingsChoiceUnset')),
                ...(field.options ?? []).map((option) =>
                  createElement('option', { key: option, value: option }, option),
                ),
              )
            : createElement('input', {
                type: field.kind === 'natural' ? 'number' : 'text',
                value: drafts[field.key] ?? '',
                disabled: !view.writable || busy,
                style: control,
                onChange: (event: { target: { value: string } }) => {
                  onEdit(field.key, event.target.value)
                },
              }),
        createElement(
          'span',
          { style: hint },
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
                onClick: () => onReset(field),
              },
              t('settingsReset'),
            )
          : null,
      )
    }),
  )
}

/**
 * The card.
 *
 * Collapsed by default and expanded by clicking the header, matching every other
 * card in 设置 → 插件 — the operator asked for exactly that after finding this one
 * laid out as a permanently-open form. It auto-opens when the read FAILS (an
 * error nobody can see is not an error state) and closes again once a save has
 * landed with nothing left to send.
 */
export function SettingsCard({ api, translator }: SettingsCardProps): ReactElement {
  const { t } = translator
  const [view, setView] = useState<ClientSettingsView | undefined>(undefined)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

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
        if (live) {
          setFailed(true)
          setOpen(true)
        }
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

  const edit = useCallback((key: string, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }))
  }, [])

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
        // Nothing left to send, so the card folds away by itself — same
        // behaviour as every other card in this section.
        setOpen(false)
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

  return createElement(
    'li',
    { style: card },
    createElement(
      'button',
      {
        type: 'button',
        style: header,
        'aria-expanded': open,
        'aria-label': `${t(open ? 'settingsCollapse' : 'settingsExpand')}: ${t('settingsTitle')}`,
        onClick: () => setOpen(!open),
      },
      createElement(
        'span',
        { style: headText },
        createElement('span', { style: nameStyle }, t('settingsTitle')),
        // The identity sits in the HEADER so it is readable while collapsed, and
        // it comes from the shared constant, so it survives a failed read too.
        createElement('span', { style: identityStyle }, `${t('settingsNamespaceLabel')} ${SETTINGS_NAMESPACE}`),
      ),
      dirty.length > 0 ? createElement('span', { style: pill }, t('settingsUnsaved')) : null,
      chevron(open),
    ),
    open
      ? createElement(
          'div',
          { style: body },
          failed
            ? createElement('p', { role: 'status' }, t('settingsLoadFailed'))
            : view === undefined
              ? createElement('p', { role: 'status' }, t('settingsLoading'))
              : createElement(
                  'div',
                  null,
                  createElement('p', { style: { margin: '0 0 12px', opacity: 0.75 } }, t('settingsIntro')),
                  view.writable
                    ? null
                    : createElement('p', { role: 'status', style: { margin: '0 0 12px', color: '#c26' } }, view.reason ?? t('settingsReadOnly')),
                  createElement(SettingsFields, {
                    view,
                    drafts,
                    busy,
                    translator,
                    onEdit: edit,
                    onReset: (field: ClientSettingField) => void reset(field),
                  }),
                  view.writable
                    ? createElement(
                        'div',
                        { style: footer },
                        createElement(
                          'button',
                          {
                            type: 'button',
                            disabled: busy || dirty.length === 0,
                            style: { font: 'inherit', padding: '4px 14px' },
                            onClick: () => setDrafts(Object.fromEntries((view as ClientSettingsView).fields.map((field) => [field.key, toDraft(field)]))),
                          },
                          t('settingsDiscard'),
                        ),
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
                        status === undefined ? null : createElement('span', { style: { opacity: 0.8 } }, status),
                      )
                    : null,
                ),
        )
      : null,
  )
}
