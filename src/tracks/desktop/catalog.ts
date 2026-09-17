/**
 * dsh-agents-bridge / desktop track.
 *
 * The desktop track drives an engine that a desktop APPLICATION owns. The
 * differences from the CLI track are not cosmetic, and that is why this is a
 * separate implementation rather than a flag:
 *
 *  - the executable is an absolute path INSIDE the bundle; it is never
 *    searched for on PATH, and a missing bundle is a hard "unsupported",
 *  - auth is the app's own login (WorkBuddy reuses `copilot.tencent.com`; the
 *    user never pastes a key), so credential status is `not-applicable` here
 *    and the bridge must not look for a token file,
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
