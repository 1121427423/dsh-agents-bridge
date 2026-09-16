/**
 * dsh-agents-bridge / CLI track — the identity catalog.
 *
 * Every entry here is a binary the user installed themselves and that keeps its
 * OWN credential. The bridge never reads, stores or forwards that credential;
 * it only reports whether one appears to exist (see `credentialSources`).
 *
 * Verified on the target machine (2026-09-16):
 *  - `codex` → /opt/homebrew/bin/codex → Caskroom/codex/0.144.6, `codex-cli 0.144.6`.
 *    Headless contract: `codex exec --json` prints ONE JSON object per line
 *    (`thread.started`, `item.completed`, `turn.started`, `turn.completed`,
 *    `error`). `--json` is JSONL, not a single document.
 *  - `claude` → /usr/local/bin/claude → ~/.nvm/.../bin/ccb → npm package
 *    `claude-code-best@2.8.4` ("Reverse-engineered Anthropic Claude Code CLI"),
 *    which reports itself as `2.8.4 (Claude Code)`. It is a SUPERSET of the
 *    Claude Code arg surface (`-p`, `--output-format stream-json`,
 *    `--input-format stream-json`, `--session-id`, `--permission-mode`,
 *    `--model`), so the `claude` protocol family drives it.
 *  - The official `@anthropic-ai/claude-code` package is NOT installed: its
 *    nvm shim is a dangling symlink. Do not assume official binaries.
 *
 * @module dsh-agents-bridge/tracks/cli/catalog
 */

import type { AgentDescriptor } from '../../kernel/types.ts'

/** The CLI-track identities, in probe order. */
export const CLI_TRACK_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    id: 'claude',
    track: 'cli',
    family: 'claude',
    displayName: 'Claude Code CLI (claude)',
    command: { executable: 'claude' },
    envPrefix: 'CLAUDE',
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
    notes:
      'On this host `claude` resolves to the npm package claude-code-best@2.8.4, a reverse-engineered Claude Code CLI that reports "2.8.4 (Claude Code)". Verify the resolved path in probe output before assuming official behaviour.',
  },
  {
    id: 'codex',
    track: 'cli',
    family: 'codex',
    displayName: 'Codex CLI (codex exec)',
    command: { executable: 'codex' },
    envPrefix: 'CODEX',
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
    notes:
      'Headless contract: `codex exec --json [PROMPT]`. Emits JSONL (`thread.started` / `item.completed` / `turn.started` / `turn.completed` / `error`). Auth and provider config come from ~/.codex/{auth.json,config.toml}; the bridge passes them through untouched.',
  },
  {
    id: 'openclaw',
    track: 'cli',
    family: 'openclaw',
    displayName: 'OpenClaw CLI (openclaw on PATH)',
    command: { executable: 'openclaw', argsPrefix: ['agent'] },
    envPrefix: 'OPENCLAW',
    capabilities: { resume: true, model: true },
    notes:
      'A run MUST carry an explicit session selector (--session-id); without one the CLI exits with "No target session selected". See docs/driver-pitfalls.md.',
  },
  {
    id: 'generic',
    track: 'cli',
    family: 'generic',
    displayName: 'Generic agent CLI (set GENERIC_PATH)',
    command: { executable: 'agent-cli' },
    envPrefix: 'GENERIC',
    capabilities: { model: true },
    notes:
      'Placeholder executable on purpose: resolving it to something that could accidentally exist (`sh`) would make probe lie about availability. Point it at a real CLI with GENERIC_PATH.',
  },
  // DEFERRED (user-ordered last): `codebuddy-code` — @tencent-ai/codebuddy-code
  // 2.151.0 is installed at ~/.nvm/.../bin/{codebuddy,codebuddy-code,cbc}. Its
  // dialect is UNVERIFIED: it ships its own dist-server, so it may speak the
  // claude stream-json dialect (like WorkBuddy's bundled CodeBuddy) or its own.
  // Add the descriptor only after capturing a real headless run — see
  // docs/plan.md D23.
]
