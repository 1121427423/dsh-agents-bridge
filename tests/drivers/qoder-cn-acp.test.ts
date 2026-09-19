/**
 * The `qoder-cn` identity — Qoder CN's DESKTOP app, driven over ACP.
 *
 * Why a file of its own: the tempting way to add this identity is to copy the
 * `codebuddy-code-acp` capability row (`resume/model/effort/mcpConfig` all
 * true), and here that would put claims on the record that NO frame supports.
 * The captures are real ones — `node <bundled
 * qoder-worker-runtime.obf.mjs> --yolo --acp` driven over real stdio on this
 * host, 2026-09-19 (provenance: docs/findings-qoder-cn-desktop.md; raw bytes:
 * the two fixtures below).
 *
 * There are TWO captures because this identity has two states, and they
 * evidence DIFFERENT things:
 *
 *  - `qoder-cn-acp-handshake.ndjson` — PRE-LOGIN. `session/new` is an AUTH
 *    WALL: a JSON-RPC ERROR (-32000 "Authentication required"), so there is no
 *    sessionId, no `models`, no `configOptions`. Nothing session-derived can be
 *    claimed from it. It is kept because it is a real branch the driver must
 *    keep handling, and because it is where `resume`'s ONLY basis lives:
 *    `initialize` (which DID answer) advertises `loadSession` +
 *    `sessionCapabilities.resume`.
 *  - `qoder-cn-acp-authed-session.ndjson` — POST-LOGIN, after the operator ran
 *    `qoderclicn login` out of band. `session/new` answers a real session with
 *    `models` AND `configOptions`, and a prompt runs to `end_turn`.
 *
 * The assertions parse the captures with the driver's OWN extractors, so they
 * check bytes rather than a re-typed expectation, and they fail if a future
 * editor promotes a capability this engine never demonstrated.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  extractAuthMethods,
  extractCurrentModelId,
  extractEffortOption,
  extractModelOption,
} from '../../src/drivers/acp.ts'
import { DESKTOP_TRACK_DESCRIPTORS } from '../../src/tracks/desktop/catalog.ts'

interface RpcError {
  readonly code: number
  readonly message: string
}

interface Frame {
  readonly id?: number
  readonly method?: string
  readonly params?: { readonly update?: { readonly sessionUpdate?: string; readonly content?: { readonly text?: string } } }
  readonly result?: unknown
  readonly error?: RpcError
}

function loadFixture(name: string): readonly Frame[] {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Frame)
}

const HANDSHAKE = loadFixture('qoder-cn-acp-handshake.ndjson')
const AUTHED = loadFixture('qoder-cn-acp-authed-session.ndjson')

const INITIALIZE = HANDSHAKE.find((frame) => frame.id === 1)?.result
const WALL = HANDSHAKE.find((frame) => frame.id === 2)
const AUTHED_SESSION_NEW = AUTHED.find((frame) => frame.id === 2)?.result
const AUTHED_PROMPT = AUTHED.find((frame) => frame.id === 3)?.result

const descriptor = DESKTOP_TRACK_DESCRIPTORS.find((entry) => entry.id === 'qoder-cn')

/** A field of the `initialize` result's `agentInfo` block. */
function agentInfo(field: string): string | undefined {
  const info = (INITIALIZE as { agentInfo?: Record<string, unknown> } | undefined)?.agentInfo
  const value = info?.[field]
  return typeof value === 'string' ? value : undefined
}

/** `loadSession` (transport-level) + `sessionCapabilities.resume` (ACP-level). */
function resumeAdvertised(): boolean {
  const caps = (INITIALIZE as { agentCapabilities?: Record<string, unknown> } | undefined)?.agentCapabilities
  if (caps === undefined) return false
  const sessionCaps = caps['sessionCapabilities'] as Record<string, unknown> | undefined
  return caps['loadSession'] === true && sessionCaps?.['resume'] !== undefined
}

/** The `models.availableModels` pairs the engine advertises for a session. */
function availableModels(): readonly { readonly modelId: string; readonly name: string }[] {
  const models = (AUTHED_SESSION_NEW as { models?: { availableModels?: unknown } } | undefined)?.models
  const list = models?.availableModels
  return Array.isArray(list) ? (list as { modelId: string; name: string }[]) : []
}

describe('the qoder-cn PRE-LOGIN handshake capture (real bytes, not derived)', () => {
  it('is the initialize + session/new pair, in order', () => {
    expect(HANDSHAKE.map((frame) => frame.id)).toEqual([1, 2])
    expect(INITIALIZE).toBeDefined()
    expect(WALL).toBeDefined()
  })

  it('names the engine that actually answered', () => {
    // The desktop app ships no `qodercli` on PATH; the bytes below are the
    // proof that the bundle path in the descriptor is the real engine.
    expect(agentInfo('name')).toBe('qoder-cli-cn')
    expect(agentInfo('title')).toBe('Qoder CLI CN')
    expect(agentInfo('version')).toBe('1.1.53')
    expect(extractAuthMethods(INITIALIZE)).toEqual(['qoderclicn-login'])
  })

  it('stops at the auth wall: session/new is an ERROR frame, not a session', () => {
    // An unpopulated credential store must stay a distinguishable branch: a
    // reader who "fixes" the descriptor by copying codebuddy-code-acp has to
    // break this assertion too.
    expect(WALL?.error).toBeDefined()
    expect(WALL?.error?.code).toBe(-32000)
    expect(WALL?.error?.message).toContain('Authentication required')
    // …and the frame really carries no result half, so nothing was hidden.
    expect(WALL?.result).toBeUndefined()
  })
})

describe('the qoder-cn AUTHENTICATED session capture (real bytes, not derived)', () => {
  it('is a real session, a streamed turn, and an end_turn — not an error', () => {
    // Three RESPONSES (the notifications in between carry no `id`, which is
    // exactly the framing the driver must not confuse with a reply).
    expect(AUTHED.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual([1, 2, 3])
    expect(AUTHED.filter((frame) => frame.method === 'session/update').length).toBe(2)
    expect(AUTHED_SESSION_NEW).toBeDefined()
    expect(AUTHED_PROMPT).toBeDefined()
    // The counterpart of the wall assertion above: same engine, same flags,
    // different credential state — and the difference is visible in the bytes.
    expect((AUTHED_SESSION_NEW as { sessionId?: string }).sessionId).toBeTruthy()
    expect((AUTHED_PROMPT as { stopReason?: string }).stopReason).toBe('end_turn')
  })

  it('carries the assistant text the turn actually produced', () => {
    // A `completed` with no output is the failure mode record 9 describes; this
    // capture is the opposite, and it is why `text` is asserted, not just status.
    const chunks = AUTHED.filter((frame) => frame.params?.update?.sessionUpdate === 'agent_message_chunk')
    expect(chunks.map((frame) => frame.params?.update?.content?.text).join('')).toBe('OK')
  })

  it('names a current model and a reasoning-effort dial the driver can read', () => {
    // Both extractors are the driver's own, run against captured bytes.
    expect(extractCurrentModelId(AUTHED_SESSION_NEW)).toBe('qfmodel')
    expect(extractEffortOption(AUTHED_SESSION_NEW)).toEqual({
      configId: 'reasoning_effort',
      currentValue: 'xhigh',
      values: ['xhigh', 'low', 'medium', 'none'],
    })
  })

  it('advertises the model catalogue, including the Flash tier the operator asked for', () => {
    // Pins the CORRECTED model table in findings §5.6. An earlier revision
    // transcribed this list from a stale local cache and got the names wrong —
    // `qmodel` is Qwen3.7-Plus (not 3.6), `gmodel` is GLM-5.3 (not GLM-5), and
    // the Flash tier does exist (`qfmodel` = Qwen3.8-Flash). The live frame is
    // the authority; a cache is not.
    const models = availableModels()
    expect(models.length).toBe(14)
    expect(models.find((m) => m.modelId === 'qfmodel')?.name).toBe('Qwen3.8-Flash')
    expect(models.find((m) => m.modelId === 'qmodel')?.name).toBe('Qwen3.7-Plus')
    expect(models.find((m) => m.modelId === 'gmodel')?.name).toBe('GLM-5.3')
  })
})

describe('the qoder-cn descriptor agrees with its captures', () => {
  it('is a desktop-track ACP identity of the bundled runtime', () => {
    expect(descriptor).toBeDefined()
    if (descriptor === undefined) return
    expect(descriptor.track).toBe('desktop')
    expect(descriptor.family).toBe('acp')
    // Absolute bundle path: this engine is never on PATH, so the desktop track
    // is the only half that can reach it.
    expect(descriptor.command.executable.startsWith('/')).toBe(true)
    expect(descriptor.command.executable).toContain('/Applications/Qoder CN.app/')
    // 33 MB ESM bundle with NO shebang — an interpreter is mandatory, and a
    // launch without one dies with `env: node: No such file or directory`.
    expect(descriptor.command.interpreter).toBeDefined()
    // The wire selector is identity data: `--acp` is a HIDDEN option (absent
    // from --help) and `--yolo` is the headless permission switch multica uses.
    expect(descriptor.command.protocolArgs).toEqual(['--yolo', '--acp'])
    expect(descriptor.envPrefix).toBe('QODER_CN')
  })

  it('derives `resume` from the initialize frame, not from the codebuddy row', () => {
    expect(resumeAdvertised()).toBe(true)
    expect(descriptor?.capabilities?.resume).toBe(resumeAdvertised())
  })

  it('claims `effort` exactly when the captured session advertises a dial', () => {
    // The hermes pattern (D39): the capability must EQUAL what the bytes
    // support, so the assertion fails from either side — a descriptor that
    // under-claims a working dial, and one that claims a dial this engine never
    // offered. MEASURED end to end: `session/set_config_option
    // {configId:"reasoning_effort", value:"low"}` is accepted and the engine
    // confirms it with a `config_option_update` notification carrying
    // `reasoning_effort = "low"`.
    expect(extractEffortOption(AUTHED_SESSION_NEW)).toBeDefined()
    expect(descriptor?.capabilities?.effort).toBe(extractEffortOption(AUTHED_SESSION_NEW) !== undefined)
  })

  it('claims `model` exactly when the session advertises an ADDRESSABLE selector', () => {
    // This assertion used to pin `false`, on the reasoning that the driver's
    // only model lever was `session/new` params.model and this engine ignores
    // that parameter. The premise was right and the conclusion was wrong: the
    // engine advertises a `model` CONFIG OPTION, addressable through
    // `session/set_model` — the same call the reference implementation
    // (multica `qoder.go`) uses — and the driver now drives it. So the honest
    // bit is `true` — and the assertion is written as
    // `extractModelOption(...) !== undefined` rather than a bare `true` so it
    // fails from BOTH sides: a descriptor that under-claims a selector the
    // bytes advertise, and one that claims a selector this engine never
    // offered.
    //
    // The measurements behind the engine half, with controls, on 2026-09-19
    // (both Qoder builds, 1.1.53 desktop and 1.1.56 CLI, identical):
    //   session/set_model {modelId:"qmodel"}          → ACCEPTED, confirmed
    //   session/set_model {modelId:"bogus-model-xyz"} → -32602 Invalid model
    //   session/set_model {modelId:"Qwen3.8-Flash"}   → -32602 Invalid model
    //   a real turn after the switch → `_meta.quota.model_usage[0].model`
    //                                  reads "qmodel" (it was "qfmodel")
    // The last line is what separates a working dial from a label. Contrast
    // `session/new` params.model, where a BOGUS id is accepted in silence — the
    // silence is specific to that parameter, not a general laxity.
    expect(extractCurrentModelId(AUTHED_SESSION_NEW)).toBe('qfmodel')
    expect(extractModelOption(AUTHED_SESSION_NEW)).toBeDefined()
    expect(descriptor?.capabilities?.model).toBe(extractModelOption(AUTHED_SESSION_NEW) !== undefined)
  })

  it('reads the model selector by ID, because this engine tags effort `category:"model"`', () => {
    // The trap that decides the reader's shape, and it is in THIS capture rather
    // than hypothetical: `reasoning_effort` carries `category: "model"`. So a
    // reader matching on category would hand the effort dial back as the model
    // dial — and the driver would then address a model id to `reasoning_effort`
    // and take a guaranteed -32602. `extractModelOption` matches the id only.
    const opts = (AUTHED_SESSION_NEW as { configOptions?: { id: string; category?: string }[] })
      .configOptions ?? []
    const effort = opts.find((o) => o.id === 'reasoning_effort')
    expect(effort?.category).toBe('model')

    const model = extractModelOption(AUTHED_SESSION_NEW)
    expect(model?.configId).toBe('model')
    // The negative control that makes the line above mean something: the effort
    // dial IS present and IS readable, so `model` did not win by default.
    expect(extractEffortOption(AUTHED_SESSION_NEW)?.configId).toBe('reasoning_effort')
    // And the reader does not accept the effort entry as a model entry even when
    // it is the only one on offer — the shape a category match would get wrong.
    expect(
      extractModelOption({
        configOptions: [
          { id: 'reasoning_effort', category: 'model', currentValue: 'none', options: [{ value: 'none' }] },
        ],
      }),
    ).toBeUndefined()
  })

  it('still claims nothing it never exercised', () => {
    // Neither capture contains a `fs/*` or `terminal/*` callback, and no
    // `mcpServers` entry was ever sent. `false` here means "never demonstrated".
    expect(descriptor?.capabilities?.mcpConfig).toBe(false)
    expect(descriptor?.capabilities?.clientTools).toBe(false)
  })

  it('tells the model what to do about the wall, in its own notes', () => {
    // Hard constraint 4: an error the model cannot act on is not an error
    // message. The wall is a credential problem, so the notes must name both
    // the failure and the way out.
    const notes = descriptor?.notes ?? ''
    expect(notes).toContain('Authentication required')
    expect(notes).toContain('qoderclicn login')
    expect(notes).toContain('QODER_SDK_AUTH_PAYLOAD_FILE')
  })
})
