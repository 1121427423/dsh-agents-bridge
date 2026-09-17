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
 *    SEPARATE identity (`codebuddy-code-acp`, family `'acp'`, decision D27).
 *    Captured 2026-09-17 against 2.151.0: headerless NDJSON JSON-RPC on stdio
 *    (`initialize` → `protocolVersion`/`authMethods`/`agentCapabilities`,
 *    `session/new` → `sessionId`/`models`/`configOptions`, then a
 *    `session/update` notification stream during `session/prompt`). The wire
 *    protocol is pinned in `command.protocolArgs`, never inferred from the
 *    binary name; see tests/fixtures/ACP-PROVENANCE.md.
 *  - `hermes` → ~/.local/bin/hermes (a `#!/bin/sh` shim into
 *    ~/.hermes/hermes-agent/venv) → `hermes-agent` 0.21.3, a Python CLI. Its
 *    ACP face (`hermes acp`, headerless NDJSON JSON-RPC) rides the SAME `acp`
 *    family, so it is a descriptor, not a dialect (D27/D39). Its capabilities
 *    were pinned from a live `initialize` + `session/new` probe, and they are
 *    NOT the codebuddy ones: `session/new` advertises a 252-entry model list
 *    but ignores a model passed in params, and answers no `configOptions`, so
 *    `model`/`effort` are declared false (see the entry below).
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
    // Deliberately NO `argsPrefix`: the openclaw driver emits the `agent`
    // subcommand itself as the first driver arg, so a prefix here would produce
    // `openclaw agent agent …` and the CLI answers "Too many arguments for this
    // command." A prefix is only for tokens the driver cannot know about — the
    // per-app profile selector the `autoclaw` descriptor needs.
    command: { executable: 'openclaw' },
    envPrefix: 'OPENCLAW',
    capabilities: { resume: true, model: true },
    notes:
      'A run MUST carry an explicit session selector (--session-id); without one the CLI exits with "No target session selected". The `agent` subcommand is supplied by the driver, not by an argsPrefix. See docs/driver-pitfalls.md.',
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
  {
    // DIFFERENT ENGINE, SAME WIRE. `hermes acp` is a Python CLI whose ACP face
    // is headerless NDJSON JSON-RPC, so it rides the existing `acp` family
    // (D27) exactly as `codebuddy-code-acp` does. NO `searchPath` is declared:
    // the install is `~/.local/bin/hermes` (a `#!/bin/sh` shim into the venv)
    // and `~/.local/bin` is ALREADY an entry in `CLI_SEARCH_PATH`
    // (src/tracks/cli/index.ts:48), so a GUI host with a truncated PATH still
    // resolves the bare name.
    id: 'hermes',
    track: 'cli',
    family: 'acp',
    displayName: 'Hermes Agent CLI over ACP (hermes acp)',
    // [proven] `hermes acp --version` prints exactly `0.21.3` on this host, and
    // the argv `hermes acp` ALONE reaches the full handshake (both probes used
    // exactly those two tokens). [inferred, from findings-hermes-acp.md §3] the
    // subcommand takes no model/permission flags at all — all turn control is
    // ACP-over-wire, which is why the acp family exists; no flag is passed here
    // either way, so the inference cannot change the argv.
    command: { executable: 'hermes', protocolArgs: ['acp'] },
    envPrefix: 'HERMES',
    // PINNED TO A LIVE PROBE, not copied from the codebuddy-code-acp row above.
    // `initialize` + `session/new` were driven against hermes-agent 0.21.3 on
    // this host (2026-09-17); the raw frames are checked in as
    // tests/fixtures/hermes-acp-handshake.ndjson and parsed back in
    // tests/drivers/hermes-acp.test.ts, which fails if these flags drift from
    // the capture.
    //  - resume [proven]: `initialize` advertises agentCapabilities.loadSession
    //    plus sessionCapabilities.resume, and a live `session/resume` returned a
    //    normal result (models + modes) with no JSON-RPC error.
    //  - model: FALSE [proven]: `session/new` ADVERTISES
    //    models.availableModels (252 entries) + currentModelId, but the model
    //    was never applied when passed through `session/new` params — both the
    //    `model` and the `modelId` spelling were silently ignored and
    //    currentModelId came back unchanged. The driver's ONLY model lever on
    //    this family is that param, so `model: true` would promise a knob this
    //    engine does not honour.
    //  - effort: FALSE [proven]: `session/new` (and `session/resume`) answer NO
    //    `configOptions` at all, so the driver's effort selector (id/category
    //    in effort|thought_level|reasoning_effort) resolves to nothing.
    //  - clientTools: FALSE [proven for this handshake]: no `fs/*` or
    //    `terminal/*` request was observed from the engine.
    //  - `mcpConfig` is deliberately NOT claimed: `mcpServers: []` was accepted
    //    without error but never exercised with a real server, so there is no
    //    evidence either way.
    capabilities: { resume: true, model: false, effort: false, clientTools: false },
    notes:
      'ACP face of the Hermes Agent CLI (hermes-agent 0.21.3, probed 2026-09-17): `hermes acp` speaks headerless NDJSON JSON-RPC on stdio, stdout clean (adapter INFO logs go to stderr). `initialize` answers protocolVersion 1 + agentInfo + agentCapabilities + authMethods (openrouter, hermes-setup); `session/new` answers sessionId + models (252 availableModels, currentModelId) + modes, and NO configOptions. Two MEASURED negatives keep the capabilities honest: a model passed in session/new params is accepted but ignored (currentModelId never moved), and there is no effort dial — so `model` and `effort` are false rather than copied from `codebuddy-code-acp`. ACCEPTANCE 2026-09-17 (`node --experimental-strip-types scripts/acceptance.ts hermes "Reply with exactly: OK"`): probe available=true version=0.21.3, and the run reached a clean PARSED TERMINAL in 18.7s (no hang) with backendSessionId eeac6539-f93a-4a48-8222-7acd1258e467 — but it is NOT a working turn: status=completed while the only text is the engine\'s own provider failure, "OpenRouter didn\'t answer after 3 attempts … HTTP 404: This model is unavailable for free. The paid version is available now - use this slug instead: minimax/minimax-m3", delivered as an ordinary assistant chunk under a normal end-of-turn. The configured free model slug is refused upstream, and because the ACP layer carries no failure signal the bridge reports `completed`. Do not read that as a working turn — see docs/handoff-blockers.md record 9 and docs/plan.md D39. Known UNPROBED risk: plain `hermes --help` can print lazy-venv-repair banners to stdout on some hosts; the `acp` path was clean here, so the ACP line reader (tryParseJson-per-line) has not been exercised against a real banner. `hermes -z/--oneshot` (final text only) exists as a text fallback and is deliberately NOT the integration — no events.',
  },
]
