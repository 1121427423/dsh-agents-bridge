/**
 * The settings namespace — the guardrails that make the card honest.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A settings surface fails in ways code review does not catch: a default that
 * silently disagrees with the kernel, a save that persists but changes nothing, a
 * write that is accepted on a deployment which has nowhere to put it. Each of
 * those is asserted here against the REAL port (no re-implementation of its
 * rules in the test), because the thing that must hold is the thing that ships.
 *
 * @module tests/settings/settings
 */

import { describe, expect, it } from 'vitest'

import {
  SETTINGS_FIELDS,
  SETTINGS_NAMESPACE,
  SETTINGS_SCHEMA,
  installSettings,
  settingsEntryFrom,
  type SettingsHostContext,
  type SettingsPort,
} from '../../src/settings.ts'
import type { BridgeLogger } from '../../src/kernel/types.ts'

const logger: BridgeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * A fake `ctx.settings` that behaves like the real provider in the two ways this
 * module depends on: a resolved snapshot over `base ← user layer`, and a
 * `register` that hands back the scope used for writes.
 */
function fakeService(initial: { user?: Record<string, unknown>; exposeDescribe?: boolean } = {}) {
  const user: Record<string, unknown> = { ...(initial.user ?? {}) }
  const watchers: (() => void)[] = []
  const registered: { ns: string; base: Record<string, unknown> }[] = []
  const scope = {
    get: () => ({ ...registered[0]?.base, ...user }),
    update: (patch: Record<string, unknown>) => {
      // `undefined` values are DROPPED from the patch, exactly as the real
      // provider's `cloneJsonShaped` does — an `update({ k: undefined })` is a
      // silent no-op in production, so a fake that deletes the key here would
      // make a fake save look real (see the IM-16 test below).
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) user[key] = value
      }
      for (const watcher of watchers) watcher()
    },
    replace: (section: Record<string, unknown>) => {
      for (const key of Object.keys(user)) delete user[key]
      Object.assign(user, section)
      for (const watcher of watchers) watcher()
    },
    watch: (callback: () => void) => {
      watchers.push(callback)
      return () => {
        const index = watchers.indexOf(callback)
        if (index >= 0) watchers.splice(index, 1)
      }
    },
  }
  const service = {
    register(ns: string, _schema: unknown, options?: { base?: Record<string, unknown> }) {
      registered.push({ ns, base: options?.base ?? {} })
      return scope
    },
    ...(initial.exposeDescribe === false
      ? {}
      : { describe: () => [{ ns: SETTINGS_NAMESPACE, user: { ...user } }] }),
  }
  return { service, user, registered, scope }
}

/**
 * A fake that copies the REAL provider's two observable behaviours, both read
 * from `@deepseek-ai/dsh-settings`'s own `lib/index.js`:
 *
 *  1. `describe()` OMITS `user` for a namespace whose stored section is absent
 *     (`...detachedUser === void 0 ? {} : { user: detachedUser }`);
 *  2. the resolved snapshot is `schema(mergeLayers(base, section))`, so an
 *     absent `z.array()` key materializes `[]` instead of staying `undefined`;
 *  3. `update()` DROPS `undefined` entries from the patch (`cloneJsonShaped`)
 *     instead of deleting the stored key, while `replace()` swaps the whole
 *     section. Run together, those two are what make
 *     `update({ key: undefined })` a silently fake save — and the fake has to
 *     reproduce that or the IM-16 guard below cannot fail.
 *
 * `fakeService` above does neither, and that divergence is exactly how the first
 * live run of this card marked three list fields as "overridden by user" while
 * the operator's `settings.yaml` held no section for this namespace at all. A
 * fake that cannot reproduce the provider's shape cannot guard the rule.
 */
function fileProviderFake(initial: { user?: Record<string, unknown>; exposeDescribe?: boolean } = {}) {
  let section: Record<string, unknown> | undefined =
    initial.user === undefined ? undefined : { ...initial.user }
  const registered: { ns: string; base: Record<string, unknown> }[] = []
  const describedWith: unknown[] = []
  const scope = {
    get: () => SETTINGS_SCHEMA({ ...(registered[0]?.base ?? {}), ...(section ?? {}) }) as Record<string, unknown>,
    update: (patch: Record<string, unknown>) => {
      section = { ...(section ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        // Real-provider semantics (see behaviour 3 in the note above): an
        // undefined entry never reaches the stored section, so it cannot delete
        // anything — it is dropped from the patch.
        if (value !== undefined) section[key] = value
      }
    },
    replace: (next: Record<string, unknown>) => {
      section = { ...next }
    },
  }
  const service = {
    register(ns: string, _schema: unknown, options?: { base?: Record<string, unknown> }) {
      registered.push({ ns, base: options?.base ?? {} })
      return scope
    },
    ...(initial.exposeDescribe === false
      ? {}
      : {
          describe: (options?: unknown) => {
            describedWith.push(options)
            return [{ ns: SETTINGS_NAMESPACE, ...(section === undefined ? {} : { user: { ...section } }) }]
          },
        }),
  }
  return { service, describedWith, section: () => section }
}

/** A `ctx` whose `inject` fires immediately, as it does on a real host. */
function wiredContext(service: unknown): SettingsHostContext {
  return {
    inject: (_deps, callback) => {
      callback({ get: (name: string) => (name === 'settings' ? service : undefined), effect: () => {} })
      return undefined
    },
  }
}

/** A `ctx` for a deployment that never mounts a settings service. */
const unwiredContext: SettingsHostContext = { inject: () => undefined }

/** The options object a manager would be constructed with. */
function managerOptions(entry: Partial<Record<string, unknown>> = {}) {
  return { logger, createBackend: () => ({}) as never, ...entry } as never as Parameters<typeof installSettings>[1]
}

describe('the settings namespace', () => {
  it('owns exactly the fields it documents, with no schema default of its own', () => {
    // The kernel owns the defaults (rule 1 in the module note). A schema default
    // here would be a second source of truth; the observable proof is that an
    // empty base + empty user layer resolves to "unset" for EVERY field.
    const { service } = fakeService()
    const port = installSettings(wiredContext(service), managerOptions(), {})
    for (const field of SETTINGS_FIELDS) {
      const state = port.read().fields.find(candidate => candidate.key === field.key)
      expect(state?.value, `${field.key} must stay unset, not defaulted`).toBeUndefined()
    }
    // And the schema covers the same keys the field table declares — no more (a
    // field the card cannot render) and no fewer (a field nobody can set).
    // Read through schemastery's own object reflection (`dict`): calling the
    // schema would only list the keys that resolved to a value, which is exactly
    // the set this assertion must NOT be limited to.
    const dict = (SETTINGS_SCHEMA as unknown as { dict?: Record<string, unknown> }).dict
    expect(dict, 'the schema must be an object schema with a `dict`').toBeTruthy()
    expect(Object.keys(dict ?? {}).sort()).toEqual(SETTINGS_FIELDS.map(field => field.key).sort())
  })

  it('states a file:line for every field effect, so the claim is checkable', () => {
    for (const field of SETTINGS_FIELDS) {
      expect(field.reason, `${field.key} must cite the code that decides its effect`).toMatch(/src\/[a-z/]+\.ts:\d+/)
    }
    expect(SETTINGS_FIELDS.find(field => field.key === 'defaultCwd')?.effect).toBe('live')
  })

  it('without a settings provider: composition values only, and writes refused with a reason', async () => {
    const options = managerOptions({ defaultCwd: '/from/composition', maxConcurrent: 3 })
    const port = installSettings(unwiredContext, options, settingsEntryFrom({ defaultCwd: '/from/composition', maxConcurrent: 3 }))

    const view = port.read()
    expect(view.writable).toBe(false)
    expect(view.reason).toBeTruthy()
    expect(view.fields.find(field => field.key === 'defaultCwd')?.value).toBe('/from/composition')

    const refused = await port.write({ defaultCwd: '/somewhere/else' })
    expect(refused.ok).toBe(false)
    // Rule 2: nothing changes, and the caller is told why instead of being told
    // "saved" by a deployment that cannot persist anything.
    expect((options as { defaultCwd?: string }).defaultCwd).toBe('/from/composition')
    expect(await port.reset('defaultCwd')).toMatchObject({ ok: false })
  })

  it('a save lands on the VERY object the manager holds (that is the liveness story)', async () => {
    const entry = settingsEntryFrom({ defaultCwd: '/from/composition' })
    const options = managerOptions({ defaultCwd: '/from/composition', storeDir: '/keep/me' })
    const { service, user } = fakeService()
    const port = installSettings(wiredContext(service), options, entry)

    expect(port.read().writable).toBe(true)
    const result = await port.write({ defaultCwd: '/from/user' })

    expect(result.ok).toBe(true)
    // Same object identity, new value: `manager.ts:401` reads `options.defaultCwd`
    // per run, which is why a `live` field needs no restart.
    expect((options as { defaultCwd?: string }).defaultCwd).toBe('/from/user')
    expect(user['defaultCwd']).toBe('/from/user')
    // And it touches nothing it does not own.
    expect((options as { storeDir?: string }).storeDir).toBe('/keep/me')
    expect((options as { logger?: unknown }).logger).toBe(logger)
  })

  it('refuses a bad value by naming the rule, and refuses unknown fields', async () => {
    const { service } = fakeService()
    const options = managerOptions()
    const port = installSettings(wiredContext(service), options, {})

    expect(await port.write({ maxConcurrent: 0 })).toMatchObject({ ok: false })
    expect((await port.write({ maxConcurrent: 0 })).ok).toBe(false)
    expect(await port.write({ maxConcurrent: 'lots' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('positive integer'),
    })
    expect(await port.write({ nope: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('unknown setting') })
    expect(await port.write({})).toMatchObject({ ok: false })
    // A refusal must not have written anything.
    expect((options as { maxConcurrent?: number }).maxConcurrent).toBeUndefined()
  })

  it('normalizes list and string fields instead of storing raw form text', async () => {
    const { service, user } = fakeService()
    const options = managerOptions()
    const port = installSettings(wiredContext(service), options, {})

    await port.write({ allowedCwd: '  /a , /b\n/c  ', defaultCwd: '  /trimmed  ' })
    expect(user['allowedCwd']).toEqual(['/a', '/b', '/c'])
    expect(user['defaultCwd']).toBe('/trimmed')
    expect((options as { allowedCwd?: readonly string[] }).allowedCwd).toEqual(['/a', '/b', '/c'])
  })

  it('accepts only the closed value set of the choice field, and names the set in the refusal', async () => {
    const { service, user } = fakeService()
    const options = managerOptions()
    const port = installSettings(wiredContext(service), options, {})

    // The accepted pair lands verbatim in the user layer…
    expect(await port.write({ qoderTransport: 'acp' })).toMatchObject({ ok: true })
    expect(user['qoderTransport']).toBe('acp')
    // …case is normalised exactly like the config/env doors do it…
    expect(await port.write({ qoderTransport: ' STREAM-json ' })).toMatchObject({ ok: true })
    expect(user['qoderTransport']).toBe('stream-json')
    // …while anything outside the set is refused by naming the whole set — the
    // next plugin load must never meet a stored value the switch does not know.
    const refused = await port.write({ qoderTransport: 'websocket' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error).toContain('stream-json')
      expect(refused.error).toContain('acp')
    }
    expect(user['qoderTransport']).toBe('stream-json')
  })

  it('keeps the transport knob OUT of the manager options: its effect is the next load, not this object', async () => {
    const { service, user } = fakeService()
    const options = managerOptions()
    const port = installSettings(wiredContext(service), options, {})

    expect(await port.write({ qoderTransport: 'acp' })).toMatchObject({ ok: true })
    // The save persisted…
    expect(user['qoderTransport']).toBe('acp')
    // …but nothing was planted on the options object the manager holds: the
    // switch is decided from the plugin CONFIG at apply() time, and a key here
    // would read as if the kernel consumed it live (it does not).
    expect(Object.prototype.hasOwnProperty.call(options, 'qoderTransport')).toBe(false)
    // The card still sees the resolved value and its effect claim.
    const state = port.read().fields.find(field => field.key === 'qoderTransport')
    expect(state?.value).toBe('acp')
    expect(state?.effect).toBe('reload')
    expect(state?.overridden).toBe(true)
  })

  it('carries the composition transport into the settings base, and a reset returns to it', async () => {
    const { service } = fakeService({ user: {} })
    const entry = settingsEntryFrom({ qoderTransport: 'acp' })
    const port = installSettings(wiredContext(service), managerOptions(), entry)

    // Deployment config is what the field shows before any user layer exists.
    expect(port.read().fields.find(field => field.key === 'qoderTransport')?.value).toBe('acp')

    const written = await port.write({ qoderTransport: 'stream-json' })
    expect(written.ok).toBe(true)
    // A clear goes through the removal path and falls back to the composition
    // value rather than to silence.
    const cleared = await port.write({ qoderTransport: '' })
    expect(cleared.ok).toBe(true)
    expect(port.read().fields.find(field => field.key === 'qoderTransport')?.value).toBe('acp')
  })

  it('a reset clears the key from the user layer and flips `overridden` back', async () => {
    const { service, user } = fakeService({ user: { defaultCwd: '/from/user' } })
    const entry = settingsEntryFrom({ defaultCwd: '/from/composition' })
    const options = managerOptions({ defaultCwd: '/from/composition' })
    const port = installSettings(wiredContext(service), options, entry)

    expect(port.read().fields.find(field => field.key === 'defaultCwd')?.overridden).toBe(true)
    const result = await port.reset('defaultCwd')

    expect(result.ok).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(user, 'defaultCwd')).toBe(false)
    expect((options as { defaultCwd?: string }).defaultCwd).toBe('/from/composition')
    expect(port.read().fields.find(field => field.key === 'defaultCwd')?.overridden).toBe(false)
    expect(await port.reset('nosuchfield')).toMatchObject({ ok: false })
  })

  it('a deployment with no settings service keeps `available` semantics: read works, nothing throws', () => {
    const options = managerOptions({ maxConcurrent: 2 })
    const port: SettingsPort = installSettings(unwiredContext, options, settingsEntryFrom({ maxConcurrent: 2 }))
    expect(() => port.read()).not.toThrow()
    expect(port.read().fields.find(field => field.key === 'maxConcurrent')?.value).toBe(2)
  })

  it('without `describe`, a LIST field equal to the composition value is NOT called overridden', () => {
    // Regression: the first live run of the card hit this path (a provider whose
    // description did not name the namespace the way the fake did) and reported
    // every list field as "overridden by user" because `[] !== []`.
    const { service } = fakeService({ exposeDescribe: false })
    const entry = settingsEntryFrom({ allowedCwd: ['/work'], deniedCwd: [] })
    const options = managerOptions({ allowedCwd: ['/work'], deniedCwd: [] })
    const port = installSettings(wiredContext(service), options, entry)

    const fields = port.read().fields
    expect(fields.find(field => field.key === 'allowedCwd')).toMatchObject({ overridden: false })
    expect(fields.find(field => field.key === 'deniedCwd')).toMatchObject({ overridden: false })
    // …while a value that genuinely differs from the composition entry (which,
    // without `describe`, is the only evidence a user layer exists at all) is
    // still flagged.
    const withUser = fakeService({ exposeDescribe: false, user: { allowedCwd: ['/elsewhere'] } })
    const other = installSettings(wiredContext(withUser.service), managerOptions(), entry)
    expect(other.read().fields.find(field => field.key === 'allowedCwd')).toMatchObject({ overridden: true })
  })

  it('accepts a provider that names namespaces with `name` instead of `ns`', () => {
    // The descriptor key is not contractual across provider versions, so the
    // module tries the shapes; a provider using `name` must still yield the raw
    // user layer, otherwise `reset` silently degrades to writing `undefined`.
    const user: Record<string, unknown> = { defaultCwd: '/from/user' }
    const scope = {
      get: () => ({ ...user }),
      update: (patch: Record<string, unknown>) => Object.assign(user, patch),
      replace: (section: Record<string, unknown>) => {
        for (const key of Object.keys(user)) delete user[key]
        Object.assign(user, section)
      },
    }
    const service = {
      register: () => scope,
      describe: () => [{ name: SETTINGS_NAMESPACE, user: { ...user } }],
    }
    const port = installSettings(wiredContext(service), managerOptions(), {})
    expect(port.read().fields.find(field => field.key === 'defaultCwd')?.overridden).toBe(true)
  })

  it('against the REAL provider shape: an absent section means NOTHING is overridden', () => {
    // The live defect this guards: the provider omits `user` for a namespace with
    // no stored section, and resolves absent `z.array()` keys to `[]`. Reading
    // "no `user` key" as "cannot tell" put `read()` on its fallback, which then
    // compared a materialized `[]` against an unset composition entry and
    // reported three fields as "you changed this" on an untouched settings.yaml.
    const { service } = fileProviderFake()
    const port = installSettings(wiredContext(service), managerOptions(), {})

    const fields = port.read().fields
    for (const field of SETTINGS_FIELDS) {
      expect(fields.find(candidate => candidate.key === field.key)?.overridden, field.key).toBe(false)
    }
    // The materialized `[]` is real and is what every surface receives; it is
    // documented here so nobody "fixes" it by accident.
    expect(fields.find(candidate => candidate.key === 'allowedCwd')?.value).toEqual([])
  })

  it('against the REAL provider shape: only the field actually written is overridden', async () => {
    const fake = fileProviderFake()
    const port = installSettings(wiredContext(fake.service), managerOptions(), {})

    expect((await port.write({ maxConcurrent: 2 })).ok).toBe(true)
    expect(port.read().fields.filter(field => field.overridden).map(field => field.key)).toEqual(['maxConcurrent'])

    // A reset must DROP the key (the provider's `replace`), because writing
    // `undefined` leaves the key present and the card stuck on "overridden".
    expect((await port.reset('maxConcurrent')).ok).toBe(true)
    expect(port.read().fields.filter(field => field.overridden)).toEqual([])
    expect(fake.section()).toEqual({})
  })

  it('clearing a field REMOVES the user-layer key instead of faking a save (IM-16)', async () => {
    // The live defect: the card sends `drafts[k] ?? ''` for every dirty field
    // (`client/settings.ts:308-310`), so an emptied input is a write of `''`.
    // `coerceField` turns it into `undefined`, `clean` keeps the KEY, and
    // `scope.update({ key: undefined })` reaches the real provider, whose
    // `cloneJsonShaped` drops undefined entries and re-persists the OLD section
    // — while `write()` returns `{ok: true}`. The card says saved, folds, and
    // the old value plus its `overridden` badge come straight back.
    const fake = fileProviderFake({ user: { defaultCwd: '/from/user', maxConcurrent: 3 } })
    const entry = settingsEntryFrom({ defaultCwd: '/from/composition' })
    const options = managerOptions({ defaultCwd: '/from/composition' })
    const port = installSettings(wiredContext(fake.service), options, entry)

    expect(port.read().fields.find(field => field.key === 'defaultCwd')).toMatchObject({
      value: '/from/user',
      overridden: true,
    })

    const cleared = await port.write({ defaultCwd: '' })

    expect(cleared.ok).toBe(true)
    // The key is GONE from the user layer — the only honest meaning of "clear".
    expect(Object.prototype.hasOwnProperty.call(fake.section() ?? {}, 'defaultCwd')).toBe(false)
    expect(cleared.ok ? cleared.value.fields.find(field => field.key === 'defaultCwd') : undefined).toMatchObject({
      value: '/from/composition',
      overridden: false,
    })
    // …and the removal did not disturb a sibling key.
    expect(fake.section()?.maxConcurrent).toBe(3)

    // Negative control 1: a real value still goes through `update` and flips the
    // badge — the clearing path must not have replaced the ordinary one.
    expect((await port.write({ maxConcurrent: 4 })).ok).toBe(true)
    expect(port.read().fields.find(field => field.key === 'maxConcurrent')).toMatchObject({
      value: 4,
      overridden: true,
    })
    expect(fake.section()).toEqual({ maxConcurrent: 4 })

    // Negative control 2: `reset` is unchanged — same `replace`, same result.
    expect((await port.reset('maxConcurrent')).ok).toBe(true)
    expect(port.read().fields.filter(field => field.overridden)).toEqual([])
    expect(fake.section()).toEqual({})
  })

  it('one patch may both set and clear in a single write', async () => {
    // Reachable from the card: two dirty fields, one emptied, one given a value.
    // The `replace` payload carries both (the set value must survive the same
    // section swap the clear forces).
    const fake = fileProviderFake({ user: { defaultCwd: '/from/user' } })
    const entry = settingsEntryFrom({ defaultCwd: '/from/composition' })
    const port = installSettings(wiredContext(fake.service), managerOptions({ defaultCwd: '/from/composition' }), entry)

    const result = await port.write({ defaultCwd: '', maxConcurrent: 5 })

    expect(result.ok).toBe(true)
    expect(fake.section()).toEqual({ maxConcurrent: 5 })
    const fields = result.ok ? result.value.fields : []
    expect(fields.find(field => field.key === 'defaultCwd')).toMatchObject({
      value: '/from/composition',
      overridden: false,
    })
    expect(fields.find(field => field.key === 'maxConcurrent')).toMatchObject({ value: 5, overridden: true })
  })

  it('refuses to fake a clear on a provider that cannot remove a key', async () => {
    // A provider with no `replace()` (or one that does not describe namespaces)
    // cannot express "this key is gone". `update({ key: undefined })` would look
    // like a save and store nothing, so the only honest answer is a refusal that
    // names the field — the ledger's documented alternative to replacing.
    const user: Record<string, unknown> = { defaultCwd: '/from/user' }
    const scope = {
      get: () => ({ ...user }),
      // Mirrors the real provider: undefined is dropped, never deleted.
      update: (patch: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(patch)) if (value !== undefined) user[key] = value
      },
    }
    const service = { register: () => scope, describe: () => [{ ns: SETTINGS_NAMESPACE, user: { ...user } }] }
    const port = installSettings(wiredContext(service), managerOptions(), {})

    const refused = await port.write({ defaultCwd: '' })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('defaultCwd') })
    expect(user['defaultCwd']).toBe('/from/user')
    expect(await port.reset('defaultCwd')).toMatchObject({ ok: false, error: expect.stringContaining('defaultCwd') })
  })

  it('without `describe`, a provider-materialized `[]` is not mistaken for an override', () => {
    // The fallback's only evidence is value comparison, so it must compare
    // against what the schema resolves with NO user layer — not against the raw
    // composition entry, where an absent list key is `undefined` while the
    // resolved value is `[]`.
    const { service } = fileProviderFake({ exposeDescribe: false })
    const port = installSettings(wiredContext(service), managerOptions(), {})

    for (const field of SETTINGS_FIELDS) {
      expect(port.read().fields.find(candidate => candidate.key === field.key)?.overridden, field.key).toBe(false)
    }
    // …while a value that genuinely differs from the resolved baseline is still
    // flagged, which is the whole point of keeping the fallback at all.
    const withUser = fileProviderFake({ exposeDescribe: false, user: { allowedCwd: ['/elsewhere'] } })
    const other = installSettings(wiredContext(withUser.service), managerOptions(), {})
    expect(other.read().fields.find(field => field.key === 'allowedCwd')?.overridden).toBe(true)
  })

  it('asks `describe` in the provider\'s own option vocabulary', () => {
    // `@deepseek-ai/dsh-settings` reads `options?.redactSecrets`, and defaults to
    // NOT redacting. Asking with a key it does not read (`redact`) would silently
    // become a request for whatever that provider's default happens to be.
    const { service, describedWith } = fileProviderFake()
    const port = installSettings(wiredContext(service), managerOptions(), {})
    port.read()
    expect(describedWith[0]).toEqual({ redactSecrets: false })
  })

  it('awaits the provider write: a REJECTED persist is reported, never called saved', async () => {
    // The real scope's `update`/`replace` are `async`
    // (`@deepseek-ai/dsh-settings` `lib/index.js:410,424`). Dropping the returned
    // promise does two things: a refusal is reported as `ok: true` (the module's
    // own promise is the opposite), and the rejection is unhandled — which on
    // Node's default `--unhandled-rejections=throw` takes the HOST PROCESS down.
    const scope = {
      get: () => ({}),
      update: async () => {
        throw new Error('settings document is read-only')
      },
      replace: async () => {
        throw new Error('settings document is read-only')
      },
    }
    const service = { register: () => scope, describe: () => [{ ns: SETTINGS_NAMESPACE }] }
    const port = installSettings(wiredContext(service), managerOptions(), {})

    expect(await port.write({ defaultCwd: '/x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('read-only'),
    })
    expect(await port.reset('defaultCwd')).toMatchObject({
      ok: false,
      error: expect.stringContaining('read-only'),
    })
  })

  it('reads back AFTER the provider commits, so the card is never shown pre-write state', async () => {
    // A `read()` issued before an async write settles renders the OLD value and
    // the OLD `overridden` badge — the card would look like the save did nothing.
    let user: Record<string, unknown> = {}
    const scope = {
      get: () => ({ ...user }),
      update: async (patch: Record<string, unknown>) => {
        await Promise.resolve()
        user = { ...user, ...patch }
      },
      replace: async (next: Record<string, unknown>) => {
        await Promise.resolve()
        user = { ...next }
      },
    }
    const service = { register: () => scope, describe: () => [{ ns: SETTINGS_NAMESPACE, user: { ...user } }] }
    const port = installSettings(wiredContext(service), managerOptions(), {})

    const written = await port.write({ defaultCwd: '/from/user' })
    expect(written.ok).toBe(true)
    const field = written.ok ? written.value.fields.find(candidate => candidate.key === 'defaultCwd') : undefined
    expect(field).toMatchObject({ value: '/from/user', overridden: true })

    const cleared = await port.reset('defaultCwd')
    expect(cleared.ok).toBe(true)
    expect(cleared.ok ? cleared.value.fields.filter(candidate => candidate.overridden) : 'write failed').toEqual([])
  })
})
