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
 *  - `codebuddy-code` → ~/.nvm/.../bin/codebuddy-code (a `#!/usr/bin/env node`
 *    shim, hence the CLI track's shim repair) → `@tencent-ai/codebuddy-code`
 *    2.151.0, Tencent's standalone CodeBuddy Code CLI. It speaks the SAME
 *    stream-json dialect as the CodeBuddy binary WorkBuddy bundles — a real
 *    `-p --output-format stream-json` capture emitted exactly the frame types
 *    `tests/fixtures/codebuddy-capture.ndjson` carries (`system/init`,
 *    `system/status`, `file-history-snapshot`, `assistant`, `result`) with the
 *    same `apiKeySource: copilot.tencent.com`. Hence `family: 'codebuddy'`
 *    rather than `'claude'`; see tests/drivers/codebuddy-code.test.ts.
 *  - `codebuddy-code --acp` → the SAME binary as above, reached over the Agent
 *    Client Protocol instead of the stream-json dialect, and therefore a
 *    SEPARATE identity (`codebuddy-code-acp`, family `'acp'`, decision D24).
 *    Captured 2026-09-17 against 2.151.0: headerless NDJSON JSON-RPC on stdio
 *    (`initialize` → `protocolVersion`/`authMethods`/`agentCapabilities`,
 *    `session/new` → `sessionId`/`models`/`configOptions`, then a
 *    `session/update` notification stream during `session/prompt`). The wire
 *    protocol is pinned in `command.protocolArgs`, never inferred from the
 *    binary name; see tests/fixtures/ACP-PROVENANCE.md.
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
    // Deliberately NO `mcpConfig`: codex has no `--mcp-config <file>` flag (its
    // servers are `-c mcp_servers.<name>.…` pairs or its own config.toml), so
    // advertising the capability would promise something no driver can honour.
    capabilities: { resume: true, model: true, effort: true },
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
  {
    id: 'codebuddy-code',
    track: 'cli',
    family: 'codebuddy',
    displayName: 'Tencent CodeBuddy Code CLI (codebuddy-code)',
    command: { executable: 'codebuddy-code' },
    envPrefix: 'CODEBUDDY',
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
    notes:
      'Headless contract verified 2026-09-16 (@tencent-ai/codebuddy-code 2.151.0): `codebuddy-code -p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions --disallowedTools AskUserQuestion EnterPlanMode ExitPlanMode`, prompt as one stream-json line on stdin; the frames are the CodeBuddy/claude dialect (system/init, system/status, file-history-snapshot, assistant, result). NOT verified: a completed turn — this host is not signed in, so the run ends result{is_error:true} with "Authentication required. Please use /login command", and the model ids its --help advertises are documentation only (see docs/design-tracks.md).',
  },
  {
    // SAME BINARY, DIFFERENT PROTOCOL — a second identity, not a correction of
    // `codebuddy-code` above. The bridge must not choose between the two stream
    // dialects by guessing: each identity pins its own wire protocol in
    // `command.protocolArgs`, so a caller picks a protocol by picking an id.
    id: 'codebuddy-code-acp',
    track: 'cli',
    family: 'acp',
    displayName: 'Tencent CodeBuddy Code CLI over ACP (codebuddy-code --acp)',
    command: { executable: 'codebuddy-code', protocolArgs: ['--acp'] },
    envPrefix: 'CODEBUDDY_ACP',
    // Honest about what ACP actually supports here: `resume` (session/resume),
    // `model` and `effort` (session/new `models` + `configOptions`, driven
    // through session/set_config_option), `mcpConfig` (session/new `mcpServers`,
    // which is JSON over the wire rather than a config FILE the bridge writes).
    // Deliberately NOT `clientTools`: this host's engine never issued an fs/*
    // or terminal/* callback, so claiming the capability would be a guess.
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true, clientTools: false },
    notes:
      'The ACP face of the SAME binary as `codebuddy-code` (family `codebuddy`); the two ids are distinct identities and the argv differs only by --acp. Verified 2026-09-17 (2.151.0): headerless NDJSON JSON-RPC on stdio — `initialize` answers protocolVersion/authMethods/agentCapabilities, `session/new` answers sessionId + models.availableModels + configOptions (incl. thought_level), and `session/prompt` streams session/update notifications. NOT verified: a completed turn — this host is not signed in, and the engine answers with exit code 0 plus stopReason "refusal" carrying a 401 only in _meta (the bridge maps that to a failed run, never a "model declined" answer).',
  },
]
