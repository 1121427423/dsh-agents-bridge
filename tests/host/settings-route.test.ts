/**
 * The two settings routes — payload contract only.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/settings.ts` is tested directly, but the wire between the card and that
 * port is a place where a small mistake is invisible: the card sends `{ patch }`
 * for a save and `{ field }` for a reset, and a route that reads the wrong key
 * would simply refuse every save while looking implemented. These cases pin the
 * shape of the payload and the refusal when neither key is present.
 *
 * @module tests/host/settings-route
 */

import { describe, expect, it } from 'vitest'

import { createApiHandlers } from '../../src/host/api.ts'
import type { AgentManager, BridgeLogger } from '../../src/kernel/types.ts'
import type { SettingsPort, SettingsView } from '../../src/settings.ts'

const logger: BridgeLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const emptyManager = {
  probe: async () => [],
  run: async () => {
    throw new Error('not used')
  },
  status: () => undefined,
  list: () => [],
  output: () => undefined,
  cancel: async () => false,
  send: async () => {
    throw new Error('not used')
  },
  dispose: async () => {},
} as unknown as AgentManager

/** A port that records what the route asked it to do. */
function recordingPort() {
  const calls: { write?: Record<string, unknown>; reset?: string } = {}
  const view: SettingsView = { namespace: 'dsh-agents-bridge', writable: true, fields: [] }
  const port: SettingsPort = {
    namespace: 'dsh-agents-bridge',
    read: () => view,
    write: async patch => {
      calls.write = { ...patch }
      return { ok: true, value: view }
    },
    reset: async field => {
      calls.reset = field
      return { ok: true, value: view }
    },
  }
  return { port, calls, view }
}

function handlers(port?: SettingsPort) {
  return createApiHandlers({
    webServer: { register: () => () => {} } as never,
    manager: emptyManager,
    ...(port === undefined ? {} : { settings: port }),
    logger,
  })
}

describe('the settings routes', () => {
  it('serves the namespace view on `settings`', async () => {
    const { port, view } = recordingPort()
    await expect(handlers(port)['settings']?.({})).resolves.toEqual(view)
  })

  it('routes `{ patch }` to a write and `{ field }` to a reset', async () => {
    const { port, calls } = recordingPort()
    const table = handlers(port)

    await expect(table['settings-write']?.({ patch: { defaultCwd: '/x' } })).resolves.toMatchObject({ ok: true })
    expect(calls.write).toEqual({ defaultCwd: '/x' })

    await expect(table['settings-write']?.({ field: 'defaultCwd' })).resolves.toMatchObject({ ok: true })
    expect(calls.reset).toBe('defaultCwd')
  })

  it('refuses a payload that carries neither, instead of writing `undefined`', async () => {
    const { port, calls } = recordingPort()
    const result = await handlers(port)['settings-write']?.({})
    expect(result).toMatchObject({ ok: false })
    expect(calls.write).toBeUndefined()
    expect(calls.reset).toBeUndefined()
  })

  it('answers a read-only view when the host API was mounted without a settings port', async () => {
    // Not a 404: the client half always asks, and "this host has no settings
    // service" is a different (and actionable) story from "no such method".
    const view = (await handlers(undefined)['settings']?.({})) as SettingsView
    expect(view.writable).toBe(false)
    expect(view.reason).toBeTruthy()
    await expect(handlers(undefined)['settings-write']?.({ patch: { defaultCwd: '/x' } })).resolves.toMatchObject({
      ok: false,
    })
  })
})
