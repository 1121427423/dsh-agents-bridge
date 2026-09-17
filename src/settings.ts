/**
 * dsh-agents-bridge — the plugin's own settings namespace.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every knob this plugin reads comes from the composition entry (`cordis.yml` /
 * the profile config). Editing that means editing YAML and reloading. DSH has a
 * first-class seam for the other case: a *settings namespace* whose resolved
 * value is `schema ← composition base ← user layer`, persisted to
 * `$DSH_HOME/settings.yaml`, served to the settings UI, and written back
 * revision-gated (`@deepseek-ai/dsh-settings`, `ctx.settings`). This module is
 * that seam for `agents-bridge`; `src/client/settings.ts` is its face.
 *
 * WHY `register` AND NOT `installSection`
 * ---------------------------------------
 * `installSection(owner, ns, schema, entry, hooks)` is the read-only sugar: it
 * hands the consumer a getter through `hooks.setSource` and keeps the fallback
 * to the composition entry on unload. It deliberately does NOT return the scope.
 * A settings panel must also WRITE, and the only sanctioned write path is the
 * scope (`scope.update` / `scope.replace`) — so this module uses
 * `ctx.settings.register(ns, schema, { base })` directly and re-implements the
 * two things `installSection` was doing for us: fall back to the entry when the
 * provider goes away, and re-sync whenever the namespace changes.
 *
 * THE THREE RULES
 * ---------------
 *  1. **The kernel owns the defaults.** No `.default(...)` in the schema, every
 *     field optional. `maxConcurrent` unset means "the kernel decides"; a default
 *     duplicated here would drift from `DEFAULT_MAX_CONCURRENT`, and a settings
 *     panel that disagrees with the code is a lie told by the UI. A test asserts
 *     every field stays optional and default-free.
 *  2. **A deployment without a settings provider behaves exactly as before.**
 *     `ctx.settings` is optional: absent → the composition entry stays the only
 *     source, `writable` is `false`, and writes are REFUSED with a reason rather
 *     than silently accepted.
 *  3. **A field's effect is stated per field, never implied.** `defaultCwd` is
 *     read on every run (`src/kernel/manager.ts:401`) and changes behaviour the
 *     moment it is saved; the policy knobs are snapshotted when the manager is
 *     built (`manager.ts:160-168`) and therefore apply from the next plugin load.
 *     The port reports which is which and the card renders it — a switch that
 *     does nothing is worse than no switch.
 *
 * @module dsh-agents-bridge/settings
 */

import z from '@deepseek-ai/schemastery'

import type { ManagerOptions } from './kernel/types.ts'
import { SETTINGS_NAMESPACE } from './namespace.ts'

/**
 * The settings namespace. Lowercase, hyphenated; also the client card's slot key.
 *
 * Defined in `src/namespace.ts` (import-free) and re-exported here so the Node
 * half keeps one import path while the browser half can read the same string
 * without dragging a schema library into the bundle.
 */
export { SETTINGS_NAMESPACE }

/** When a saved value reaches the running plugin. */
export type SettingEffect = 'live' | 'reload'

/** One editable field — the single source of truth for schema, API and card. */
export interface SettingField {
  readonly key: SettingKey
  readonly kind: 'string' | 'natural' | 'strings'
  readonly effect: SettingEffect
  /** The `file:line` that decides the effect. Rendered as the field's hint. */
  readonly reason: string
}

/** The editable surface: the composition entry's own policy knobs, nothing new. */
export interface SettingsShape {
  readonly defaultCwd?: string
  readonly maxConcurrent?: number
  readonly allowedCwd?: readonly string[]
  readonly deniedCwd?: readonly string[]
  readonly allowedAgents?: readonly string[]
}

export type SettingKey = keyof SettingsShape

/** Field table, in card order. */
export const SETTINGS_FIELDS: readonly SettingField[] = [
  {
    key: 'defaultCwd',
    kind: 'string',
    effect: 'live',
    reason: "read on every run (src/kernel/manager.ts:401) — saving it changes the next run's cwd",
  },
  {
    key: 'maxConcurrent',
    kind: 'natural',
    effect: 'reload',
    reason: 'snapshotted into the run policy when the manager is built (src/kernel/manager.ts:160-168)',
  },
  {
    key: 'allowedCwd',
    kind: 'strings',
    effect: 'reload',
    reason: 'snapshotted into the run policy when the manager is built (src/kernel/manager.ts:160-168)',
  },
  {
    key: 'deniedCwd',
    kind: 'strings',
    effect: 'reload',
    reason: 'snapshotted into the run policy when the manager is built (src/kernel/manager.ts:160-168)',
  },
  {
    key: 'allowedAgents',
    kind: 'strings',
    effect: 'reload',
    reason: 'snapshotted into the run policy when the manager is built (src/kernel/manager.ts:160-168)',
  },
]

/**
 * The namespace schema — deliberately default-free (rule 1 in the module note).
 */
export const SETTINGS_SCHEMA = z.object({
  defaultCwd: z.string(),
  maxConcurrent: z.natural(),
  allowedCwd: z.array(z.string()),
  deniedCwd: z.array(z.string()),
  allowedAgents: z.array(z.string()),
})

/** One field as a form sees it. */
export interface SettingFieldState {
  readonly key: string
  readonly kind: SettingField['kind']
  readonly effect: SettingEffect
  readonly reason: string
  /** The value in force now; `undefined` means "the kernel decides". */
  readonly value: string | number | readonly string[] | undefined
  /** `true` when the USER layer carries this key — what `reset` clears. */
  readonly overridden: boolean
}

/** The whole namespace, as any surface needs it. */
export interface SettingsView {
  readonly namespace: string
  /** `false` when this deployment mounted no settings provider. */
  readonly writable: boolean
  /** Why it is not writable, when it is not. */
  readonly reason?: string
  readonly fields: readonly SettingFieldState[]
}

/** Answer to a save/reset: the new state, or a refusal that names the rule. */
export type SettingsWriteResult =
  | { readonly ok: true; readonly value: SettingsView }
  | { readonly ok: false; readonly error: string }

/** The port the host API and the entry use. The client never touches `ctx.settings`. */
export interface SettingsPort {
  readonly namespace: string
  read(): SettingsView
  write(patch: Readonly<Record<string, unknown>>): Promise<SettingsWriteResult>
  reset(field: string): Promise<SettingsWriteResult>
}

/** The scope `ctx.settings.register` hands back (structural subset). */
interface SettingsScopeFace {
  get(): SettingsShape
  update(patch: Record<string, unknown>): void
  replace?(section: Record<string, unknown>): void
  watch?(callback: () => void): () => void
}

/** The `ctx.settings` face this module uses (structural subset). */
interface SettingsServiceFace {
  register?(
    ns: string,
    schema: unknown,
    options?: { readonly base?: Readonly<Record<string, unknown>> },
  ): SettingsScopeFace
  installSection?(...args: unknown[]): unknown
  /**
   * `describe()` documents one descriptor per registered namespace. The key it
   * names the namespace with is read by TRYING the shapes below rather than by
   * assuming one: this module's first live run against the real provider found a
   * shape its own fake did not use, and the fallback path (see `overridden` in
   * `read`) is deliberately conservative as a result.
   */
  describe?(
    options?: unknown,
  ): readonly {
    readonly ns?: string
    readonly namespace?: string
    readonly name?: string
    readonly user?: Record<string, unknown>
  }[]
}

/** Structural equality for setting values, which are scalars or arrays of scalars. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => entry === right[index])
  }
  return Object.is(left, right)
}

/**
 * The smallest cordis face this module needs.
 *
 * The callback's argument is typed `unknown` and narrowed inside, on purpose:
 * this module must accept a real `Context` (whose `effect` expects a
 * `SyncEffect`) AND a five-line fake in a test, without either one having to
 * satisfy the other's type. Only `get` and an optional `effect` are ever used.
 */
export interface SettingsHostContext {
  inject(deps: readonly string[], callback: (scoped: unknown) => void): unknown
}

/** The scoped context as this module uses it. */
interface ScopedSettingsContext {
  get(name: string): unknown
  effect?(callback: () => (() => void) | void, name?: string): unknown
}

/** `ManagerOptions` with readonly lifted — a LOCAL widening, no ABI change. */
export type MutableManagerOptions = { -readonly [K in keyof ManagerOptions]: ManagerOptions[K] }

/**
 * Normalize one raw value from a form.
 *
 * Messages name the field and the rule, because they reach a human through the
 * card: "maxConcurrent must be a positive integer" is actionable, "invalid" is not.
 */
function coerceField(field: SettingField, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined
  switch (field.kind) {
    case 'natural': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${field.key} must be a positive integer (got ${JSON.stringify(raw)})`)
      }
      return value
    }
    case 'string': {
      const value = String(raw).trim()
      return value === '' ? undefined : value
    }
    case 'strings': {
      const list = (Array.isArray(raw) ? raw : [raw])
        .flatMap((entry) => String(entry).split(/[\n,]+/))
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      return list.length === 0 ? undefined : list
    }
  }
}

/** The composition entry: the subset of the manager options this namespace owns. */
export function settingsEntryFrom(options: Partial<SettingsShape>): SettingsShape {
  return {
    ...(options.defaultCwd === undefined ? {} : { defaultCwd: options.defaultCwd }),
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options.allowedCwd === undefined ? {} : { allowedCwd: [...options.allowedCwd] }),
    ...(options.deniedCwd === undefined ? {} : { deniedCwd: [...options.deniedCwd] }),
    ...(options.allowedAgents === undefined ? {} : { allowedAgents: [...options.allowedAgents] }),
  }
}

/**
 * Project a resolved snapshot onto the options object the manager already holds.
 *
 * Reference identity is the whole liveness story: the manager captured this
 * object at construction, and `manager.ts:401` reads `options.defaultCwd` per
 * run. An `undefined` value DELETES the key rather than assigning `undefined`,
 * because the manager's own idiom is `...(x === undefined ? {} : { x })`.
 */
function applyTo(options: MutableManagerOptions, values: SettingsShape): void {
  const mutable = options as Record<string, unknown>
  for (const field of SETTINGS_FIELDS) {
    const value = values[field.key]
    if (value === undefined) delete mutable[field.key]
    else mutable[field.key] = field.kind === 'strings' ? [...(value as readonly string[])] : value
  }
}

/**
 * Register the namespace and keep the manager's options in step with it.
 *
 * @param ctx - plugin context; `ctx.inject` is the only service access used.
 * @param options - the SAME object the entry hands to `createAgentManager`.
 * @param entry - the composition entry, used as the base layer and the fallback.
 * @returns a port that still works (read-only) when no provider is mounted.
 */
export function installSettings(
  ctx: SettingsHostContext,
  options: MutableManagerOptions,
  entry: SettingsShape,
): SettingsPort {
  let scope: SettingsScopeFace | undefined

  const resolved = (): SettingsShape => {
    if (scope === undefined) return entry
    try {
      return scope.get() ?? entry
    } catch {
      // The provider detached (or is mid-unload): the composition entry is the
      // documented fallback, and a settings read must never fail a run.
      return entry
    }
  }

  const sync = (): void => applyTo(options, resolved())

  /** Raw user layer for this namespace, when the service exposes `describe`. */
  const userLayer = (service: SettingsServiceFace): Record<string, unknown> | undefined => {
    if (typeof service.describe !== 'function') return undefined
    try {
      const described = service.describe({ redact: false }) ?? []
      const found = described.find((item) => {
        const name = item.ns ?? item.namespace ?? item.name
        return name === SETTINGS_NAMESPACE
      })
      // `undefined` means "this provider does not describe namespaces to us",
      // which puts `read()` on its conservative fallback — NOT "no overrides".
      return found?.user
    } catch {
      return undefined
    }
  }

  let service: SettingsServiceFace | undefined
  ctx.inject(['settings'], (rawScoped) => {
    const scoped = rawScoped as ScopedSettingsContext
    const settings = scoped.get('settings') as SettingsServiceFace | undefined
    if (settings === undefined || typeof settings.register !== 'function') return
    service = settings
    try {
      scope = settings.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { base: { ...entry } })
    } catch {
      // A host whose settings service refuses this namespace leaves the plugin on
      // its composition entry — rule 2. `read()` reports it as not writable.
      scope = undefined
      return
    }
    // Re-sync on every committed change, whoever made it (this card, another
    // surface, a hand-edited settings.yaml followed by a reload).
    scope.watch?.(() => {
      sync()
    })
    // Degrade with this plugin's fiber: when the plugin unloads, the port falls
    // back to the composition entry instead of reading through a scope whose
    // owner is gone. Mirrors `installSection`'s unload effect, which we gave up
    // by using `register` (see the module note).
    scoped.effect?.(() => () => {
      scope = undefined
      sync()
    }, 'agents-bridge.settings()')
    sync()
  })

  const read = (): SettingsView => {
    const current = resolved()
    const user = service === undefined ? undefined : userLayer(service)
    return {
      namespace: SETTINGS_NAMESPACE,
      writable: scope !== undefined,
      ...(scope === undefined
        ? {
            reason:
              'this deployment mounted no settings provider (or it refused the namespace), so the '
              + 'composition entry is the only source; the values below are what the environment configured',
          }
        : {}),
      fields: SETTINGS_FIELDS.map((field) => ({
        key: field.key,
        kind: field.kind,
        effect: field.effect,
        reason: field.reason,
        value: current[field.key],
        // Presence in the RAW user layer, not a value comparison: a user who saved
        // the same value the deployment had is still overridden, and must be able
        // to put it back. Providers that do not describe their namespaces fall back
        // to "differs from the composition entry" — compared STRUCTURALLY, because
        // `[] !== []` would otherwise report every list field as overridden (the
        // bug the first live run of this card found).
        overridden:
          user !== undefined
            ? Object.prototype.hasOwnProperty.call(user, field.key)
            : current[field.key] !== undefined && !sameValue(current[field.key], entry[field.key]),
      })),
    }
  }

  const validate = (patch: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const clean: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(patch)) {
      const field = SETTINGS_FIELDS.find((candidate) => candidate.key === key)
      if (field === undefined) throw new Error(`unknown setting "${key}"`)
      clean[key] = coerceField(field, raw)
    }
    if (Object.keys(clean).length === 0) throw new Error('nothing to save')
    return clean
  }

  const write = async (patch: Readonly<Record<string, unknown>>): Promise<SettingsWriteResult> => {
    if (scope === undefined) {
      return { ok: false, error: 'no settings provider is mounted in this deployment; nothing can be persisted' }
    }
    let clean: Record<string, unknown>
    try {
      clean = validate(patch)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    try {
      scope.update(clean)
    } catch (error) {
      return { ok: false, error: `could not persist: ${error instanceof Error ? error.message : String(error)}` }
    }
    sync()
    return { ok: true, value: read() }
  }

  const reset = async (field: string): Promise<SettingsWriteResult> => {
    const known = SETTINGS_FIELDS.find((candidate) => candidate.key === field)
    if (known === undefined) return { ok: false, error: `unknown setting "${field}"` }
    if (scope === undefined) {
      return { ok: false, error: 'no settings provider is mounted in this deployment; nothing can be persisted' }
    }
    const user = service === undefined ? undefined : userLayer(service)
    try {
      if (scope.replace !== undefined && user !== undefined) {
        // Dropping the key from the whole user layer is the only way to stop being
        // "overridden": writing `undefined` would leave the key present.
        const next: Record<string, unknown> = { ...user }
        delete next[field]
        scope.replace(next)
      } else {
        scope.update({ [field]: undefined })
      }
    } catch (error) {
      return { ok: false, error: `could not persist: ${error instanceof Error ? error.message : String(error)}` }
    }
    sync()
    return { ok: true, value: read() }
  }

  return { namespace: SETTINGS_NAMESPACE, read, write, reset }
}
