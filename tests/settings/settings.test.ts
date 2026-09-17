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
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete user[key]
        else user[key] = value
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
})
