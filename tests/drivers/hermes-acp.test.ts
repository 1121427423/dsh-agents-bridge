/**
 * The `hermes` identity (D39) — a SECOND engine reached over the SAME ACP wire.
 *
 * Why this file exists: the tempting way to add an ACP identity is to copy the
 * `codebuddy-code-acp` capability row, and for this engine that would be WRONG.
 * The fixture is a REAL capture — `hermes acp` (hermes-agent 0.21.3) driven
 * through `initialize` → `session/new` over real stdio on this host
 * (2026-09-17; raw provenance in tests/fixtures/ACP-PROVENANCE.md, file
 * `hermes-acp-handshake.ndjson`).
 *
 * The capture answers two things the copied row would have gotten wrong:
 *
 *  1. `session/new` refuses to select a model. It ADVERTISES a 252-entry
 *     `models.availableModels` list + `currentModelId` — which looks exactly
 *     like CodeBuddy's — but a model passed in `session/new` params (both the
 *     `model` and the `modelId` spelling) is accepted and silently ignored
 *     (currentModelId never moved; measured with /tmp/hermes-acp-model-probe.mjs
 *     and /tmp/hermes-acp-probe3.mjs). The driver's ONLY model lever on this
 *     family is that param, so the descriptor declares `model: false`.
 *  2. There is NO `configOptions` in the answer at all, so the driver's effort
 *     selector (id/category `effort` | `thought_level` | `reasoning_effort`)
 *     cannot resolve → `effort: false`.
 *
 * The assertions below parse the capture with the driver's OWN extractors, so
 * they check the bytes rather than a re-typed expectation, and they fail if a
 * future editor copies a capability the engine never demonstrated.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  extractAuthMethods,
  extractCurrentModelId,
  extractEffortOption,
  extractModelOption,
  extractSessionId,
} from '../../src/drivers/acp.ts'
import { CLI_SEARCH_PATH, CLI_TRACK_DESCRIPTORS } from '../../src/tracks/index.ts'

interface Frame {
  readonly id: number
  readonly result: unknown
}

const FRAMES: readonly Frame[] = readFileSync(
  new URL('../fixtures/hermes-acp-handshake.ndjson', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Frame)

const INITIALIZE = FRAMES.find((frame) => frame.id === 1)?.result
const SESSION_NEW = FRAMES.find((frame) => frame.id === 2)?.result

const descriptor = CLI_TRACK_DESCRIPTORS.find((entry) => entry.id === 'hermes')

/** The engine's own model catalogue, straight out of the capture. */
function advertisedModels(): readonly unknown[] {
  const models = (SESSION_NEW as { models?: { availableModels?: unknown[] } } | undefined)?.models
  return models?.availableModels ?? []
}

function resumeAdvertised(): boolean {
  const caps = (INITIALIZE as { agentCapabilities?: Record<string, unknown> } | undefined)
    ?.agentCapabilities
  const sessionCaps = caps?.['sessionCapabilities'] as Record<string, unknown> | undefined
  return sessionCaps?.['resume'] !== undefined
}

describe('the hermes handshake capture (real bytes, not derived)', () => {
  it('is the initialize + session/new pair, in order', () => {
    expect(FRAMES.map((frame) => frame.id)).toEqual([1, 2])
    // Guard against a fixture that silently lost its content.
    expect(INITIALIZE).toBeDefined()
    expect(SESSION_NEW).toBeDefined()
  })

  it('parses with the driver\'s own extractors', () => {
    expect(extractAuthMethods(INITIALIZE)).toEqual(['openrouter', 'hermes-setup'])
    // Shape, not a frozen value: a re-capture on another host must not fail.
    expect(extractSessionId(SESSION_NEW)).toMatch(/^[0-9a-f-]{36}$/)
    expect(extractCurrentModelId(SESSION_NEW)).toBe('openrouter:minimax/minimax-m3:free')
  })

  it('says why `effort` is NOT claimed: the session answers no configOptions', () => {
    expect(extractEffortOption(SESSION_NEW)).toBeUndefined()
    // …and the assertion above is not vacuous: the extractor really does find a
    // dial when one is present. (CodeBuddy's capture is the positive control.)
    expect(
      extractEffortOption({
        configOptions: [
          {
            type: 'select',
            id: 'thought_level',
            category: 'thought_level',
            currentValue: 'high',
            options: [{ value: 'low' }, { value: 'high' }],
          },
        ],
      }),
    ).toEqual({ configId: 'thought_level', currentValue: 'high', values: ['low', 'high'] })
  })

  it('advertises a model catalogue even though selection is not honoured', () => {
    // Both halves matter: the LIST is real (so a reader must not conclude the
    // engine has no models), and the SELECTION is not (measured separately —
    // passing model/modelId in session/new params left currentModelId alone).
    expect(advertisedModels().length).toBeGreaterThan(1)
    expect(extractCurrentModelId(SESSION_NEW)).not.toBe('')
  })
})

describe('the hermes descriptor agrees with its capture', () => {
  it('is registered on the CLI track as an ACP identity of `hermes acp`', () => {
    expect(descriptor).toBeDefined()
    if (descriptor === undefined) return
    expect(descriptor.track).toBe('cli')
    expect(descriptor.family).toBe('acp')
    expect(descriptor.command.executable).toBe('hermes')
    // The wire selector is identity data, never inferred from the binary name.
    expect(descriptor.command.protocolArgs).toEqual(['acp'])
    expect(descriptor.envPrefix).toBe('HERMES')
  })

  it('does not declare a searchPath: ~/.local/bin is already on the track path', () => {
    // The install resolves through the SHARED search path (`hermes` is a
    // `#!/bin/sh` shim in ~/.local/bin), so a per-descriptor path would be a
    // second, silently divergent copy of the same fact.
    expect(descriptor?.command.searchPath).toBeUndefined()
    expect(CLI_SEARCH_PATH).toContain('~/.local/bin')
  })

  it('derives `resume` from the capture, not from the codebuddy row', () => {
    // `initialize` advertises agentCapabilities.loadSession +
    // sessionCapabilities.resume, and a live `session/resume` returned a normal
    // result — see ACP-PROVENANCE.md.
    expect(resumeAdvertised()).toBe(true)
    expect(descriptor?.capabilities?.resume).toBe(resumeAdvertised())
  })

  it('ties `effort` to the capture: no configOptions ⇒ false', () => {
    expect(descriptor?.capabilities?.effort).toBe(extractEffortOption(SESSION_NEW) !== undefined)
    expect(descriptor?.capabilities?.effort).toBe(false)
  })

  it('declares `model: false` — the list is advertised, the selection is ignored', () => {
    // This is the assertion that would have been wrong had the codebuddy row
    // been copied. The evidence is the separate param probe (provenance §"A
    // SECOND engine on the same wire"), not the capture alone.
    expect(descriptor?.capabilities?.model).toBe(false)
    expect(advertisedModels().length).toBeGreaterThan(1)
  })

  it('stays `model: false` even with the driver\'s second lever, and here is why', () => {
    // The driver grew a second model lever (`session/set_config_option` on the
    // session's advertised selector), which flipped `model` to true for the two
    // Qoder identities. It does NOT help here, and the reason is in these bytes:
    // there is no `configOptions` at all, so there is no selector to address.
    // `model: false` therefore survives the driver change — and this test is the
    // negative control for that, not a restatement of the row above.
    expect(extractModelOption(SESSION_NEW)).toBeUndefined()
    expect(descriptor?.capabilities?.model).toBe(extractModelOption(SESSION_NEW) !== undefined)
    // The two statements together are the point: a real catalogue AND no
    // addressable selector. A reader who sees 252 models and flips the bit has
    // to get past both.
    expect(advertisedModels().length).toBeGreaterThan(1)
    // And the extractor is not vacuously undefined: hand it the shape a session
    // WOULD advertise and it finds it.
    expect(
      extractModelOption({
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'a', options: [{ value: 'a' }, { value: 'b' }] },
        ],
      }),
    ).toEqual({ configId: 'model', currentValue: 'a', values: ['a', 'b'] })
  })

  it('claims neither mcpConfig nor clientTools on this evidence', () => {
    // mcpServers: [] was accepted but never exercised with a real server → no
    // claim either way. No fs/*|terminal/* callback was observed.
    expect(descriptor?.capabilities?.mcpConfig).toBeUndefined()
    expect(descriptor?.capabilities?.clientTools).toBe(false)
  })

  it('keeps the notes honest: version, the measured negatives, and the acceptance truth', () => {
    const notes = descriptor?.notes ?? ''
    expect(notes).toContain('0.21.3')
    expect(notes).toContain('session/new')
    expect(notes).toContain('configOptions')
    expect(notes).toContain('ignored')
    // The acceptance really ran and its misleading shape is stated, not hidden.
    expect(notes).toContain('ACCEPTANCE')
    expect(notes).toContain('NOT a working turn')
    expect(notes).toContain('HTTP 404')
    // The unprobed risk is declared as a risk, not asserted away.
    expect(notes).toContain('UNPROBED')
    expect(notes).toContain('oneshot')
  })
})
