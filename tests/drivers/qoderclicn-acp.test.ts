/**
 * The `qoderclicn` identity — the STANDALONE Qoder CLI, driven over ACP (D41).
 *
 * Why a file of its own, when `qoder-cn-acp.test.ts` already covers "Qoder over
 * ACP": because these are two different BINARIES of the same product, and the
 * one thing a reader will assume — that the capability rows were copied from one
 * to the other — is exactly what must be checkable. They were measured
 * separately, and they happen to agree; this file is what makes "they agree" a
 * fact rather than a coincidence.
 *
 * The three ways the two Qoder captures differ, each of which a copy would have
 * flattened:
 *
 *  1. VERSION. `agentInfo.version` is `1.1.56` here and `1.1.53` in the desktop
 *     capture. Asserted explicitly, so a fixture accidentally overwritten with
 *     the other one fails instead of passing.
 *  2. MODE. This capture is `--acp` only, so `currentModeId` is `"default"`. The
 *     desktop row pins `--yolo`, so its capture reads `"yolo"`. The difference
 *     is deliberate (see the descriptor) and is visible in the bytes.
 *  3. NO AUTH WALL. `session/new` succeeds outright — this CLI writes the very
 *     credential store the desktop engine only READS, so there is no -32000
 *     branch to keep handling here.
 *
 * The assertions parse the capture with the driver's OWN extractors, so they
 * check bytes rather than re-typed expectations.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  extractAuthMethods,
  extractCurrentModelId,
  extractEffortOption,
  extractSessionId,
} from '../../src/drivers/acp.ts'
import { CLI_TRACK_DESCRIPTORS } from '../../src/tracks/cli/catalog.ts'
import { CLI_SEARCH_PATH } from '../../src/tracks/cli/index.ts'
import { DESKTOP_TRACK_DESCRIPTORS } from '../../src/tracks/desktop/catalog.ts'

interface Frame {
  readonly id?: number
  readonly method?: string
  readonly params?: { readonly update?: { readonly sessionUpdate?: string } }
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

function loadFixture(name: string): readonly Frame[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Frame)
}

const FRAMES = loadFixture('qoderclicn-acp-handshake.ndjson')
const INITIALIZE = FRAMES.find((frame) => frame.id === 1)?.result
const SESSION_NEW = FRAMES.find((frame) => frame.id === 2)?.result
const PROMPT = FRAMES.find((frame) => frame.id === 3)?.result

const descriptor = CLI_TRACK_DESCRIPTORS.find((entry) => entry.id === 'qoderclicn')
const desktopSibling = DESKTOP_TRACK_DESCRIPTORS.find((entry) => entry.id === 'qoder-cn')

function agentInfo(field: string): string | undefined {
  const info = (INITIALIZE as { agentInfo?: Record<string, unknown> } | undefined)?.agentInfo
  const value = info?.[field]
  return typeof value === 'string' ? value : undefined
}

function sessionNewField(field: string): unknown {
  return (SESSION_NEW as Record<string, unknown> | undefined)?.[field]
}

function currentModeId(): unknown {
  const modes = sessionNewField('modes') as { currentModeId?: unknown } | undefined
  return modes?.currentModeId
}

function availableModels(): readonly { readonly modelId: string; readonly name: string }[] {
  const models = sessionNewField('models') as { availableModels?: unknown } | undefined
  const list = models?.availableModels
  return Array.isArray(list) ? (list as { modelId: string; name: string }[]) : []
}

/** `loadSession` (transport-level) + `sessionCapabilities.resume` (ACP-level). */
function resumeAdvertised(): boolean {
  const caps = (INITIALIZE as { agentCapabilities?: Record<string, unknown> } | undefined)
    ?.agentCapabilities
  if (caps === undefined) return false
  const sessionCaps = caps['sessionCapabilities'] as Record<string, unknown> | undefined
  return caps['loadSession'] === true && sessionCaps?.['resume'] !== undefined
}

describe('the qoderclicn handshake capture (real bytes, not derived)', () => {
  it('is a full turn: initialize, session/new, two updates, prompt result', () => {
    expect(FRAMES.map((frame) => frame.id).filter((id) => id !== undefined)).toEqual([1, 2, 3])
    expect(FRAMES.filter((frame) => frame.method === 'session/update')).toHaveLength(2)
    // Guard against a fixture that silently lost its content.
    expect(INITIALIZE).toBeDefined()
    expect(SESSION_NEW).toBeDefined()
    expect(PROMPT).toBeDefined()
  })

  it('has NO auth wall — this engine answers session/new outright', () => {
    // The desktop sibling's PRE-LOGIN capture is an ERROR frame here. That
    // branch exists for `qoder-cn`; it must NOT be asserted for this identity,
    // whose whole point is that the CLI writes the store itself.
    const sessionFrame = FRAMES.find((frame) => frame.id === 2)
    expect(sessionFrame?.error).toBeUndefined()
    expect(extractSessionId(SESSION_NEW)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('parses with the driver\'s own extractors', () => {
    expect(extractAuthMethods(INITIALIZE)).toEqual(['qoderclicn-login'])
    expect(extractCurrentModelId(SESSION_NEW)).toBe('qfmodel')
    expect(extractEffortOption(SESSION_NEW)).toEqual({
      configId: 'reasoning_effort',
      currentValue: 'xhigh',
      values: ['xhigh', 'low', 'medium', 'none'],
    })
  })

  it('reports the CLI version, so a fixture swapped for the desktop one fails', () => {
    // The ONLY field that distinguishes the two Qoder captures. 1.1.53 is the
    // app's bundled engine; this is the npm CLI.
    expect(agentInfo('version')).toBe('1.1.56')
    expect(agentInfo('name')).toBe('qoder-cli-cn')
    expect(agentInfo('version')).not.toBe('1.1.53')
  })

  it('was captured with the descriptor\'s argv: mode is `default`, not `yolo`', () => {
    // A capture that does not match the pinned argv is not evidence for the
    // identity. The desktop row pins --yolo and its capture reads `yolo`.
    expect(currentModeId()).toBe('default')
    expect(descriptor?.command.protocolArgs).not.toContain('--yolo')
  })

  it('advertises 14 models and names the default one', () => {
    const models = availableModels()
    expect(models).toHaveLength(14)
    expect(models.find((m) => m.modelId === 'qfmodel')?.name).toBe('Qwen3.8-Flash')
    // The id/name mapping is the thing a reader gets wrong by assuming; the
    // names are not derivable from the ids.
    expect(models.find((m) => m.modelId === 'qmodel')?.name).toBe('Qwen3.7-Plus')
  })

  it('advertises mcpCapabilities but the capture never exercises them', () => {
    const caps = (INITIALIZE as { agentCapabilities?: Record<string, unknown> } | undefined)
      ?.agentCapabilities
    expect(caps?.['mcpCapabilities']).toEqual({ http: true, sse: true })
    // Advertising is not obeying: `mcpServers` was only ever sent as `[]`.
    expect(descriptor?.capabilities?.mcpConfig).toBe(false)
  })
})

describe('the qoderclicn descriptor agrees with its capture', () => {
  it('is registered on the CLI track as an ACP identity of the standalone CLI', () => {
    expect(descriptor).toBeDefined()
    if (descriptor === undefined) return
    expect(descriptor.track).toBe('cli')
    expect(descriptor.family).toBe('acp')
    expect(descriptor.command.executable).toBe('qoderclicn')
    // The wire selector is identity data, never inferred from the binary name.
    expect(descriptor.command.protocolArgs).toEqual(['--acp'])
    expect(descriptor.envPrefix).toBe('QODERCLICN')
  })

  it('pins NO permission bypass: the in-band handshake is sufficient', () => {
    // Measured, not assumed. With `--acp` alone in mode `default`, a
    // file-creating task emitted exactly one `session/request_permission`
    // offering [allow_always, allow_once, reject_once]; the driver's own
    // `selectPermissionOption` picked `allow_once`; the turn reached
    // `end_turn` and the file was written. So `--yolo` would bake a permission
    // bypass into an IDENTITY for no functional gain, contradicting the
    // principle `ACP_BLOCKED_ARGS` states: the mode is the run's choice.
    expect(descriptor?.command.protocolArgs).toEqual(['--acp'])
    expect(descriptor?.command.protocolArgs).not.toContain('--yolo')
    // …and the escape hatch is genuinely left open, so this is a default and
    // not a prohibition.
    expect(descriptor?.command.protocolArgs).not.toContain('--permission-mode')
  })

  it('needs no descriptor searchPath: nvm\'s bin dir is already on the track path', () => {
    expect(descriptor?.command.searchPath).toBeUndefined()
    expect(CLI_SEARCH_PATH).toContain('~/.nvm/versions/node/*/bin')
  })

  it('pins no interpreter: it is a `#!/usr/bin/env node` shim the track repairs', () => {
    // Unlike the desktop sibling — a 33 MB ESM bundle with NO shebang, where
    // `interpreter` is mandatory — this one declares its own interpreter, so
    // pinning one would override the shim's own choice.
    expect(descriptor?.command.interpreter).toBeUndefined()
    expect(desktopSibling?.command.interpreter).toBeDefined()
  })

  it('is a DIFFERENT identity from the desktop `qoder-cn`, not a duplicate row', () => {
    expect(desktopSibling).toBeDefined()
    expect(descriptor?.id).not.toBe(desktopSibling?.id)
    expect(descriptor?.track).not.toBe(desktopSibling?.track)
    // Different executable, different env namespace: pinning one moves nothing
    // else.
    expect(descriptor?.command.executable).not.toBe(desktopSibling?.command.executable)
    expect(descriptor?.envPrefix).not.toBe(desktopSibling?.envPrefix)
    // …and the two argv vectors are allowed to differ, which is why the mode
    // difference in the captures is not a contradiction.
    expect(descriptor?.command.protocolArgs).not.toEqual(desktopSibling?.command.protocolArgs)
  })

  it('derives `resume` from the capture, not from the codebuddy row', () => {
    expect(resumeAdvertised()).toBe(true)
    expect(descriptor?.capabilities?.resume).toBe(resumeAdvertised())
  })

  it('ties `effort` to the capture: reasoning_effort present ⇒ true', () => {
    expect(descriptor?.capabilities?.effort).toBe(extractEffortOption(SESSION_NEW) !== undefined)
    expect(descriptor?.capabilities?.effort).toBe(true)
    // The extractor is not vacuously returning true: an engine with no dial
    // gives undefined. (Hermes is the real negative control; this is the
    // in-file one.)
    expect(extractEffortOption({ configOptions: [] })).toBeUndefined()
  })

  it('declares `model: false` — a bridge-side gap, not an engine-side denial', () => {
    // Two separate facts, and conflating them is the mistake this repo already
    // made once and corrected (docs/plan.md D40 item ⑤):
    //   * the engine HAS a working, validated model dial — `set_config_option
    //     {configId:"model"}` accepts a real id, confirms via
    //     `config_option_update`, and rejects a bogus one with -32602;
    //   * the DRIVER has no lever for it, because the only model it ever sends
    //     travels in `session/new` params, which this engine ignores in silence.
    // `capabilities` describes the bridge, so `false` is right — but the reason
    // must not be recorded as "the engine cannot".
    expect(descriptor?.capabilities?.model).toBe(false)
    // The catalogue is real, so a reader must not conclude there are no models.
    expect(availableModels().length).toBeGreaterThan(1)
    expect(extractCurrentModelId(SESSION_NEW)).not.toBe('')
    // …and the dial IS advertised, which is what makes the gap a bridge gap.
    const configIds = ((sessionNewField('configOptions') ?? []) as { id: string }[]).map((o) => o.id)
    expect(configIds).toContain('model')
  })

  it('claims neither clientTools on this evidence', () => {
    // No fs/*|terminal/* callback appears in the capture.
    expect(descriptor?.capabilities?.clientTools).toBe(false)
  })

  it('keeps the notes honest: version, the hidden flag, the shared store', () => {
    const notes = descriptor?.notes ?? ''
    expect(notes).toContain('1.1.56')
    expect(notes).toContain('--acp')
    expect(notes).toContain('HIDDEN')
    expect(notes).toContain('~/.qoder-cn/.auth')
    expect(notes).toContain('qoderclicn login')
    // The measured negative that keeps `model` honest is stated, not implied.
    // Case-insensitive on purpose: the notes emphasise it in caps, and pinning
    // the case would make the assertion about typography rather than content.
    expect(notes.toLowerCase()).toContain('ignores')
    // …and it is attributed to the right side of the wire.
    expect(notes).toContain('BRIDGE gap')
    // The effort vocabulary trap is spelled out.
    expect(notes).toContain('xhigh')
    expect(notes).toContain('no `high`')
  })
})
