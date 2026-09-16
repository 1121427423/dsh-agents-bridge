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

/** WorkBuddy's CLI is a node script with no node beside it. */
const WORKBUDDY_CLI =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const AUTOCLAW_ENGINE = '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs'
/** Homebrew node: the interpreter the bundled engines need. */
const BUNDLED_NODE = '/opt/homebrew/bin/node'

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
    id: 'autoclaw',
    track: 'desktop',
    family: 'openclaw',
    displayName: 'AutoClaw (bundled OpenClaw engine)',
    command: { executable: AUTOCLAW_ENGINE, interpreter: BUNDLED_NODE, argsPrefix: ['agent'] },
    envPrefix: 'AUTOCLAW',
    capabilities: { resume: true, model: true },
    notes:
      'MUST run with `--profile autoclaw` (driver-set): the default profile loads ~/.openclaw/openclaw.json and fails config validation. Its proxy credential is bound to the client system prompt, so this identity is usable as an EXECUTOR only, never as a generic upstream.',
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
