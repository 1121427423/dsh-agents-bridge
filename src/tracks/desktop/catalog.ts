/**
 * dsh-agents-bridge / desktop track.
 *
 * The desktop track drives an engine that a desktop APPLICATION owns. The
 * differences from the CLI track are not cosmetic, and that is why this is a
 * separate implementation rather than a flag:
 *
 *  - the executable is an absolute path INSIDE the bundle; it is never
 *    searched for on PATH, and a missing bundle is a hard "unsupported",
 *  - auth is normally the app's own login (WorkBuddy reuses
 *    `copilot.tencent.com`; the user never pastes a key), so credential status
 *    is `not-applicable` for those and the bridge must not look for a token
 *    file — but "the app is signed in" is NOT the same as "a launch we spawn is
 *    signed in": Qoder CN mints a per-job token for its own workers and never
 *    hands it out, so a bare launch of the very same binary is uncredentialed
 *    and that identity is `unknown`, not `not-applicable`,
 *  - engines are frequently `#!/usr/bin/env node` scripts shipped WITHOUT node,
 *    so an explicit interpreter is mandatory (verified failure:
 *    `env: node: No such file or directory`),
 *  - a per-app PROFILE can change which config file the engine reads
 *    (AutoClaw: `--profile autoclaw` → `~/.openclaw-autoclaw/openclaw.json`;
 *    the default profile reads `~/.openclaw/openclaw.json` and fails
 *    validation), so fixed argv lives in the descriptor.
 *
 * @module dsh-agents-bridge/tracks/desktop
 */

import type { AgentDescriptor } from '../../kernel/types.ts'
import type { LaunchInput, TrackPolicy } from '../types.ts'

/**
 * WorkBuddy's CLI is a node script with no node beside it.
 *
 * There are TWO WorkBuddy desktop apps and they ship the SAME launcher: the two
 * `cli/bin/codebuddy` files are byte-identical (sha256 f8b141c3…, verified). What
 * differs is the `cli/product.json` sitting beside each one, which names the
 * product — and, crucially, `dataFolderName`:
 *
 *   WorkBuddy.app     applicationName=WorkBuddy     dataFolderName=.workbuddy
 *   WorkBuddy AI.app  applicationName=workbuddy-ai  dataFolderName=.workbuddy-ai
 *
 * The launcher reads that file, so `~/.workbuddy` vs `~/.workbuddy-ai` follows
 * from WHICH BUNDLE was executed — no env var, no --config flag, nothing for the
 * bridge to plumb. The identity genuinely is the bundle path, which is exactly
 * what the desktop track models. (The two catalogs really are different: the
 * international build exposes 22 models incl. `deepseek-v4.1-flash-sg`,
 * `gpt-6-astra`, `gemini-3.5-flash`, while the domestic one exposes 51.)
 */
const WORKBUDDY_CLI =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
/** The international build (com.workbuddy.workbuddy-ai, 5.5.2 on this host). */
const WORKBUDDY_AI_CLI =
  '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const AUTOCLAW_ENGINE = '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs'
/** Homebrew node: the interpreter the bundled engines need. */
const BUNDLED_NODE = '/opt/homebrew/bin/node'
/**
 * ZCode.app ships its agent CLI as a plain node bundle [proven 0.16.5]. Unlike
 * WorkBuddy's launcher it CANNOT be executed bare: it resolves its built-in
 * provider config relative to `process.argv[1]` and the in-bundle layout
 * matches neither candidate, so a bare launch dies with
 * 「无法定位 CLI ZCode Built-in Provider Config」. The documented escape hatch
 * is the env var below, which the driver also derives from the executable as a
 * fallback. See docs/findings-zcode-headless.md §1.
 */
const ZCODE_CLI = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
const ZCODE_BUILTIN_PROVIDER_CONFIG =
  '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'
/**
 * Qoder CN's agent is not a CLI on PATH and not a launcher in `bin/` — it is
 * the Agent SDK's worker runtime, hidden in the app's PRIVATE node_modules.
 *
 * `runtime-info.json` beside it reads `{"name":"qoder-worker-runtime",
 * "version":"1.1.53","productName":"qoderclicn","site":"cn"}`, i.e. this bundle
 * IS the domestic `qoderclicn` binary. The app launches this exact path itself
 * (proven: its own `qodercli/qoder-agent-sdk.log` records the WorkerTransport
 * argv) — but over the SDK's stream-json channel, NOT over ACP.
 *
 * `--acp` and `--yolo` are HIDDEN options (neither appears in `--help`, yet
 * both parse — `--config-dir` on `status` really does fail as unknown, so this
 * is not silent tolerance). They match the reference implementation's argv
 * (`qoderclicn --yolo --acp`). See docs/findings-qoder-cn-desktop.md §1–2.
 */
const QODER_CN_CLI =
  '/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs'

/** The desktop-track identities, in probe order. */
export const DESKTOP_TRACK_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    id: 'workbuddy',
    track: 'desktop',
    family: 'codebuddy',
    displayName: 'WorkBuddy (bundled CodeBuddy CLI)',
    command: { executable: WORKBUDDY_CLI, interpreter: BUNDLED_NODE },
    envPrefix: 'WORKBUDDY',
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
    notes:
      'Headless contract: `codebuddy -p --output-format stream-json --model <id> --permission-mode bypassPermissions`. Auth is the desktop login reused via copilot.tencent.com; no key is needed and none must be supplied.',
  },
  {
    id: 'workbuddy-ai',
    track: 'desktop',
    family: 'codebuddy',
    displayName: 'WorkBuddy AI (international, bundled CodeBuddy CLI)',
    command: { executable: WORKBUDDY_AI_CLI, interpreter: BUNDLED_NODE },
    envPrefix: 'WORKBUDDY_AI',
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
    notes:
      'Headless contract (verified 2.137.1): `codebuddy -p --output-format stream-json --model <id> --permission-mode bypassPermissions`. Separate identity from workbuddy, not a locale flag: it reads its own home ~/.workbuddy-ai (chosen by its bundle product.json) and authenticates as `www.workbuddy.ai` rather than `copilot.tencent.com`. A real run on 2026-09-16 returned `401 Unauthorized` with result subtype `error_during_execution`, i.e. the desktop login is not (yet) usable from the CLI — establish the app login first.',
  },
  {
    id: 'autoclaw',
    track: 'desktop',
    family: 'openclaw',
    displayName: 'AutoClaw (bundled OpenClaw engine)',
    // `--profile autoclaw` MUST precede the `agent` subcommand, and the profile
    // comes from THIS descriptor: the openclaw driver only ever READS a profile
    // out of `argsPrefix` (to phrase a diagnosis); it never sets one. It also
    // must NOT put `agent` here — `buildOpenclawArgs()` already emits the
    // subcommand as the first driver arg, so an `agent` in the prefix makes the
    // final argv `… agent agent …` and the CLI rejects it with
    // "Too many arguments for this command."
    command: { executable: AUTOCLAW_ENGINE, interpreter: BUNDLED_NODE, argsPrefix: ['--profile', 'autoclaw'] },
    envPrefix: 'AUTOCLAW',
    capabilities: { resume: true, model: true },
    notes:
      'Runs with `--profile autoclaw` (descriptor-supplied, NOT driver-supplied): the default profile loads ~/.openclaw/openclaw.json and fails config validation. `agent` is emitted by the driver, never by this prefix. Its proxy credential is bound to the client system prompt, so this identity is usable as an EXECUTOR only, never as a generic upstream.',
  },
  {
    id: 'zcode',
    track: 'desktop',
    family: 'zcode',
    displayName: 'ZCode (bundled CLI)',
    command: {
      executable: ZCODE_CLI,
      interpreter: BUNDLED_NODE,
      env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: ZCODE_BUILTIN_PROVIDER_CONFIG },
    },
    envPrefix: 'ZCODE',
    // `model: false` is not a missing feature — 0.16.5's parser REJECTS
    // `--model` (its own help advertises it; the binary disagrees) [proven].
    // Selection travels in the engine's own defaultModelSelection store, and
    // `--max-turns` is likewise help-but-not-parser [proven §2].
    capabilities: { resume: true, model: false, effort: false, mcpConfig: false },
    notes:
      'Headless contract (proven 0.16.5 up to the entitlement wall, docs/handoff-blockers.md record 8): `node zcode.cjs --prompt <text> --output-format stream-json` with ZCODE_BUILTIN_PROVIDER_CONFIG_FILE set; sessions continue via `--resume sess_…`; auth is the app login (Z.AI OAuth, encrypted credential store). A host whose plans are not entitled fails EVERY turn with turn.failed CONFIGURATION_ERROR "Select a model before continuing" — that is the account, not the bridge.',
  },
  {
    id: 'qoder-cn',
    track: 'desktop',
    family: 'acp',
    displayName: 'Qoder CN (bundled Qoder CLI CN, over ACP)',
    // The wire selector is identity data, so it lives here and not in the
    // driver: `--acp` is hidden (absent from --help) and `--yolo` is the
    // headless permission switch the reference implementation uses.
    command: { executable: QODER_CN_CLI, interpreter: BUNDLED_NODE, protocolArgs: ['--yolo', '--acp'] },
    envPrefix: 'QODER_CN',
    // Evidence-graded against TWO captures (both committed, both real bytes):
    // the PRE-LOGIN handshake (qoder-cn-acp-handshake.ndjson), where
    // `session/new` is a JSON-RPC ERROR (-32000 "Authentication required"), and
    // the AUTHENTICATED session (qoder-cn-acp-authed-session.ndjson), where it
    // answers a real session carrying `models` and `configOptions`.
    //
    //  - `resume: true` — `initialize` (which answered in BOTH states)
    //    advertises `loadSession` + `sessionCapabilities.resume`.
    //  - `effort: true` — PROVEN end to end, not inferred. The authenticated
    //    `session/new` advertises `reasoning_effort` with 4 levels; the driver's
    //    own `extractEffortOption` reads it; and
    //    `session/set_config_option {configId:"reasoning_effort", value:"low"}`
    //    is ACCEPTED and confirmed by a `config_option_update` notification.
    //  - `model: false` — DISPROVEN, not merely unproven. The engine advertises
    //    14 models and reports `currentModelId`, so a model can be READ; but
    //    `session/new` params.model — the driver's ONLY lever for SETTING one —
    //    is IGNORED. Measured with controls: the same `currentModelId` with and
    //    without the parameter, and a bogus id accepted in silence, while a
    //    bogus configId answers -32602 "Unknown config option".
    //  - `mcpConfig` / `clientTools` false — never demonstrated: no `fs/*`,
    //    `terminal/*` or `mcpServers` traffic appears in either capture.
    capabilities: { resume: true, model: false, effort: true, mcpConfig: false, clientTools: false },
    notes:
      'Speaks ACP (`--yolo --acp`, both hidden options) and reads its OWN credential store (~/.qoder-cn/.auth) on launch. A bare launch does NOT inherit the running desktop login: the app keeps its own encrypted store and mints a PER-JOB token it pushes via QODER_SDK_AUTH_PAYLOAD_FILE instead of writing that store. So while that store is empty every run fails as `failed` at session/new with -32000 "Authentication required" — never as an empty success. The fix is out-of-band and needs no bridge change: run `qoderclicn login` once. Both directions are verified on this host — empty store → -32000; after login → a full turn with status=completed and the answer text intact. The bridge\'s own `authenticate` channel does NOT work here: the engine never answers that frame, so no login URL ever reaches the model. Once credentialed the session advertises `reasoning_effort`, so the bridge can set the effort dial; it also advertises 14 models and reports a `currentModelId`, but model SELECTION is not available — `session/new` params.model is ignored, so a model can be read but not chosen (docs/findings-qoder-cn-desktop.md §3–6, §8.2; docs/handoff-blockers.md record 11).',
  },
  {
    id: 'mimo',
    track: 'desktop',
    family: 'generic',
    displayName: 'MiMo (sealed desktop app)',
    command: { executable: 'mimo' },
    envPrefix: 'MIMO',
    unsupported: {
      reason:
        'MiMo keeps its agent loop inside app.asar and exposes no CLI, ACP endpoint or daemon socket, so it cannot be driven by the bridge (design doc D8).',
    },
  },
]
