/**
 * dsh-agents-bridge client half — the host-provided CSS tokens the panel uses.
 *
 * Every colour/typography decision resolves through a `--dsw-*` design token
 * published by the DSH client shell (the names are the real ones, extracted
 * from `dsh-better-sidebar`'s compiled stylesheet — see
 * `docs/client-half-slots.md` §4). Nothing here hardcodes a light background:
 * a hardcoded `#fff` is unreadable in dark mode, and the whole point of the
 * panel is that a human can glance at it in whatever theme they run.
 *
 * Every `var()` carries a fallback, so a host that renames a token degrades to
 * a readable default rather than to black-on-black.
 *
 * The stylesheet is injected once per document (tagged with
 * `data-plugin-css` so an HMR reload does not stack copies) and removed by the
 * effect that added it.
 *
 * @module dsh-agents-bridge/client/styles
 */

/** The style tag id, also used as the dedupe key. */
export const STYLE_TAG_ID = 'dsh-agents-bridge/panel.css'

/** Root class prefix — every selector is namespaced, never a bare element. */
export const ROOT_CLASS = 'abg-root'

const CSS = `
.${ROOT_CLASS} {
  --abg-gap: 8px;
  --abg-radius: 6px;
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  line-height: 1.45;
  color: var(--dsw-alias-label-primary, inherit);
  display: flex;
  flex-direction: column;
  gap: var(--abg-gap);
  height: 100%;
  min-height: 0;
  padding: 10px 12px;
  box-sizing: border-box;
  overflow: hidden;
}

/* ---- header ------------------------------------------------------------ */
.${ROOT_CLASS}__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.${ROOT_CLASS}__title {
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${ROOT_CLASS}__poll {
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-secondary, inherit));
  flex: none;
}
.${ROOT_CLASS}__poll[data-mode='running'] { color: var(--dsw-alias-state-success-primary, inherit); }
.${ROOT_CLASS}__poll[data-mode='idle'] { color: var(--dsw-alias-label-dimmed, inherit); }
.${ROOT_CLASS}__poll[data-mode='hidden'] { color: var(--dsw-alias-state-warn-primary, inherit); }
.${ROOT_CLASS}__poll[data-mode='paused'] { color: var(--dsw-alias-label-dimmed, inherit); }

/* ---- buttons ----------------------------------------------------------- */
.${ROOT_CLASS}__btn {
  flex: none;
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: var(--abg-radius);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  padding: 2px 8px;
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast, 120ms) var(--ds-ease-in-out, ease);
}
.${ROOT_CLASS}__btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.${ROOT_CLASS}__btn:disabled { opacity: 0.5; cursor: default; }
.${ROOT_CLASS}__btn--danger {
  color: var(--dsw-alias-state-error-primary, inherit);
  border-color: var(--dsw-alias-state-error-primary, currentColor);
}
.${ROOT_CLASS}__btn--danger:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-state-error-primary, inherit);
}

/* ---- engine strip ------------------------------------------------------ */
.${ROOT_CLASS}__engines {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: var(--abg-radius);
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.${ROOT_CLASS}__enginesSummary {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
}
.${ROOT_CLASS}__enginesSummary[data-ok='false'] { color: var(--dsw-alias-state-warn-primary, inherit); }
.${ROOT_CLASS}__engineList { display: flex; flex-direction: column; gap: 2px; }
.${ROOT_CLASS}__engine {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
  overflow: hidden;
}
.${ROOT_CLASS}__engineName {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  color: var(--dsw-alias-label-primary, inherit);
  white-space: nowrap;
}
.${ROOT_CLASS}__engineMeta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ---- session list ------------------------------------------------------ */
.${ROOT_CLASS}__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 2px;
}
.${ROOT_CLASS}__list::-webkit-scrollbar { width: 8px; }
.${ROOT_CLASS}__list::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, transparent);
  border-radius: 4px;
}

.${ROOT_CLASS}__row {
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: var(--abg-radius);
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.${ROOT_CLASS}__row[data-status='running'] {
  border-left: 2px solid var(--dsw-alias-state-success-primary, currentColor);
}
.${ROOT_CLASS}__row[data-status='failed'] {
  border-left: 2px solid var(--dsw-alias-state-error-primary, currentColor);
}
.${ROOT_CLASS}__row[data-status='cancelled'],
.${ROOT_CLASS}__row[data-status='timeout'] {
  border-left: 2px solid var(--dsw-alias-state-warn-primary, currentColor);
}
.${ROOT_CLASS}__rowHead {
  display: flex;
  align-items: center;
  gap: 6px;
}
.${ROOT_CLASS}__agent {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${ROOT_CLASS}__badge {
  flex: none;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  border-radius: 999px;
  padding: 0 6px;
  border: 1px solid currentColor;
}
.${ROOT_CLASS}__badge[data-status='running'] { color: var(--dsw-alias-state-success-primary, inherit); }
.${ROOT_CLASS}__badge[data-status='completed'] { color: var(--dsw-alias-label-secondary, inherit); }
.${ROOT_CLASS}__badge[data-status='failed'] { color: var(--dsw-alias-state-error-primary, inherit); }
.${ROOT_CLASS}__badge[data-status='cancelled'],
.${ROOT_CLASS}__badge[data-status='timeout'] { color: var(--dsw-alias-state-warn-primary, inherit); }
.${ROOT_CLASS}__spacer { flex: 1 1 auto; }
.${ROOT_CLASS}__exit {
  flex: none;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
}
.${ROOT_CLASS}__exit[data-exit='error'] { color: var(--dsw-alias-state-error-primary, inherit); }
.${ROOT_CLASS}__mono {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, inherit);
  flex: none;
}
.${ROOT_CLASS}__preview {
  color: var(--dsw-alias-label-secondary, inherit);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.${ROOT_CLASS}__preview--empty { color: var(--dsw-alias-label-dimmed, inherit); font-style: italic; }
.${ROOT_CLASS}__rowFoot {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
}
.${ROOT_CLASS}__actions {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

/* ---- transcript -------------------------------------------------------- */
.${ROOT_CLASS}__transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l1, currentColor);
  border-radius: var(--abg-radius);
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 6px 8px;
}
.${ROOT_CLASS}__event {
  display: flex;
  gap: 6px;
  align-items: baseline;
  border-bottom: 1px dashed var(--dsw-alias-border-l1, transparent);
  padding-bottom: 3px;
}
.${ROOT_CLASS}__event:last-child { border-bottom: none; }
.${ROOT_CLASS}__eventIdx {
  flex: none;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  color: var(--dsw-alias-label-dimmed, inherit);
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  min-width: 2.5em;
  text-align: right;
}
.${ROOT_CLASS}__eventBody {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--dsw-alias-label-primary, inherit);
}
.${ROOT_CLASS}__event[data-type='error'] .${ROOT_CLASS}__eventBody {
  color: var(--dsw-alias-state-error-primary, inherit);
}
.${ROOT_CLASS}__event[data-type='thinking'] .${ROOT_CLASS}__eventBody {
  color: var(--dsw-alias-label-dimmed, inherit);
  font-style: italic;
}
.${ROOT_CLASS}__event[data-type='tool_use'] .${ROOT_CLASS}__eventBody,
.${ROOT_CLASS}__event[data-type='tool_result'] .${ROOT_CLASS}__eventBody {
  color: var(--dsw-alias-label-secondary, inherit);
}

/* ---- empty / error states --------------------------------------------- */
.${ROOT_CLASS}__state {
  margin: auto;
  text-align: center;
  max-width: 34em;
  color: var(--dsw-alias-label-secondary, inherit);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  padding: 16px 4px;
}
.${ROOT_CLASS}__stateTitle { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.${ROOT_CLASS}__state[data-kind='error'] .${ROOT_CLASS}__stateTitle {
  color: var(--dsw-alias-state-error-primary, inherit);
}
.${ROOT_CLASS}__strip {
  flex: none;
  border: 1px solid var(--dsw-alias-state-error-primary, currentColor);
  border-radius: var(--abg-radius);
  color: var(--dsw-alias-state-error-primary, inherit);
  padding: 5px 8px;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  display: flex;
  gap: 6px;
  align-items: center;
}
.${ROOT_CLASS}__stripMsg { flex: 1 1 auto; min-width: 0; }

/* ---- confirmation sheet ------------------------------------------------ */
.${ROOT_CLASS}__confirm {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 5;
}
.${ROOT_CLASS}__confirmCard {
  background: var(--dsw-alias-bg-layer-2, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText);
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: var(--abg-radius);
  box-shadow: var(--dsw-shadow-lv2, 0 4px 16px rgba(0, 0, 0, 0.3));
  padding: 12px;
  max-width: 26em;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.${ROOT_CLASS}__confirmBody { color: var(--dsw-alias-label-secondary, inherit); }
.${ROOT_CLASS}__confirmActions { display: flex; gap: 6px; justify-content: flex-end; }
.${ROOT_CLASS}__toast {
  flex: none;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  color: var(--dsw-alias-label-secondary, inherit);
}

/* ---- header indicator -------------------------------------------------- */
.abg-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  padding: 1px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.abg-indicator:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.abg-indicator[data-status='running'] { color: var(--dsw-alias-state-success-primary, inherit); }
.abg-indicator[data-status='failed'] { color: var(--dsw-alias-state-error-primary, inherit); }
.abg-indicator__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  flex: none;
}
.abg-indicator[data-status='running'] .abg-indicator__dot {
  animation: abg-pulse 1.6s ease-in-out infinite;
}
@keyframes abg-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
@media (prefers-reduced-motion: reduce) {
  .abg-indicator[data-status='running'] .abg-indicator__dot { animation: none; }
}
`

/**
 * Insert the stylesheet once. Idempotent: an HMR reload re-runs `apply`, and a
 * second copy of the same rules is harmless but a second TAG is a leak.
 *
 * @returns the disposer that removes the tag this call created.
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-agents-bridge'
  tag.dataset['pluginCss'] = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}
