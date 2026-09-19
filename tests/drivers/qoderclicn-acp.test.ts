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
 *  2. MODE. The FULL-TURN capture here was taken with `--acp` only, so its
 *     `currentModeId` is `"default"`. D45 aligned this row's launch with the
 *     desktop sibling and the reference implementation (`--yolo --acp`), and
 *     `qoderclicn-acp-yolo-session.ndjson` is the real re-capture under that
 *     argv (`currentModeId: "yolo"`). Both are kept: the first carries the
 *     prompt result, the second pins the launch.
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
  extractModelOption,
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

// D45: the real `--yolo --acp` re-capture. It holds `initialize` + `session/new`
// only, because the `session/prompt` frame could not be re-taken while the
// Qoder ACP backend was answering upstream 500s — and `session/new` is the frame
// that carries the mode, which is what this fixture exists to pin.
const YOLO_FRAMES = loadFixture('qoderclicn-acp-yolo-session.ndjson')
const YOLO_SESSION_NEW = YOLO_FRAMES.find((frame) => frame.id === 2)?.result

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

  it('was captured with the descriptor\'s argv: mode is `yolo`', () => {
    // A capture that does not match the pinned argv is not evidence for the
    // identity. D45 aligned this row with the desktop sibling and the reference
    // implementation, so the pinned launch is `--yolo --acp` and the session
    // starts in `yolo` — the `qoderclicn-acp-yolo-session.ndjson` capture, taken
    // under exactly that argv. The full-turn capture above predates the change
    // (mode `default`) and is kept for its prompt result and message chunks.
    const modes = (YOLO_SESSION_NEW as { modes?: { currentModeId?: unknown } } | undefined)?.modes
    expect(modes?.currentModeId).toBe('yolo')
    expect(descriptor?.command.protocolArgs).toContain('--yolo')
    // The full-turn capture is still the `--acp` one, so the two fixtures are
    // not the same bytes and this test is not vacuous.
    expect(currentModeId()).toBe('default')
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
    // Aligned with the reference implementation (multica `qoder.go`) and the
    // desktop sibling: `--yolo --acp`.
    expect(descriptor.command.protocolArgs).toEqual(['--yolo', '--acp'])
    expect(descriptor.envPrefix).toBe('QODERCLICN')
  })

  it('pins the reference implementation\'s `--yolo --acp` launch', () => {
    // Aligned with multica (`qodercli --yolo --acp`, `CLI_AND_DAEMON.md`): the
    // CLI track now launches the standalone binary with the same headless
    // bypass-permissions switch as the desktop sibling row, so a session starts
    // in `currentModeId: "yolo"` instead of `default` (which prompts for
    // approval on every tool). The in-band `session/request_permission`
    // handling remains as a fallback for runs that opt out.
    expect(descriptor?.command.protocolArgs).toEqual(['--yolo', '--acp'])
    expect(descriptor?.command.protocolArgs).toContain('--yolo')
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
    // …and the argv vectors are now IDENTICAL (`--yolo --acp`), because both
    // rows align with the reference implementation's launch. The identity
    // distinction lives in binary/version/credential source, not in argv.
    expect(descriptor?.command.protocolArgs).toEqual(desktopSibling?.command.protocolArgs)
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

  it('declares `model: true`, tied to an ADDRESSABLE selector in the capture', () => {
    // This test used to pin `false`, and the history is worth keeping because
    // the mistake was subtle: the ENGINE half was measured correctly (a working,
    // validated `session/set_model` dial — the same lever the reference
    // implementation uses), and the DRIVER half was measured correctly too (it
    // had no lever), but the conclusion — "so the capability is false" —
    // outlived its premise. The lever was a driver change away, and it has now
    // been made.
    //
    // Written as `extractModelOption(...) !== undefined` rather than a bare
    // `true` so it fails from BOTH sides: a descriptor that under-claims a
    // selector these bytes advertise, and one that claims a selector this
    // engine never offered.
    expect(descriptor?.capabilities?.model).toBe(true)
    // The catalogue is real, so a reader must not conclude there are no models.
    expect(availableModels().length).toBeGreaterThan(1)
    expect(extractCurrentModelId(SESSION_NEW)).not.toBe('')
    // …and the selector is ADVERTISED, which is what makes the dial reachable.
    expect(extractModelOption(SESSION_NEW)?.configId).toBe('model')
    expect(descriptor?.capabilities?.model).toBe(extractModelOption(SESSION_NEW) !== undefined)
    // The in-file negative control, mirroring the effort test above: an engine
    // that advertises no model selector yields undefined, so the assertion is
    // not vacuous.
    expect(extractModelOption({ configOptions: [] })).toBeUndefined()
  })

  it('reads the model selector by ID, because this capture tags effort `category:"model"`', () => {
    // The trap is IN these bytes, not hypothetical: `reasoning_effort` carries
    // `category: "model"`. A reader matching on category would return the effort
    // dial as the model dial, and the driver would address a model id to
    // `reasoning_effort` and take a guaranteed -32602. So: id only.
    const opts = (sessionNewField('configOptions') ?? []) as { id: string; category?: string }[]
    expect(opts.find((o) => o.id === 'reasoning_effort')?.category).toBe('model')
    expect(extractModelOption(SESSION_NEW)?.configId).toBe('model')
    // The control that makes that line mean something: the effort dial is
    // present and readable, so `model` did not win by default.
    expect(extractEffortOption(SESSION_NEW)?.configId).toBe('reasoning_effort')
    // And an effort-only session is NOT mistaken for a model session — the shape
    // a category match gets wrong.
    expect(
      extractModelOption({
        configOptions: [
          { id: 'reasoning_effort', category: 'model', currentValue: 'none', options: [{ value: 'none' }] },
        ],
      }),
    ).toBeUndefined()
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
    // The measured negative that keeps the model story honest is stated, not
    // implied. Case-insensitive on purpose: the notes emphasise it in caps, and
    // pinning the case would make the assertion about typography.
    expect(notes.toLowerCase()).toContain('ignores')
    // …and the two levers are distinguished, because the whole point is that
    // `set_model` VALIDATES what `session/new` params swallow.
    expect(notes).toContain('VALIDATES')
    // The effort vocabulary trap is spelled out, along with the ordering it
    // forces.
    expect(notes).toContain('xhigh')
    expect(notes).toContain('no `high`')
    expect(notes).toContain('BEFORE')
  })
})
