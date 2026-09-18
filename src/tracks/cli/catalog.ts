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
 *  - `qoderclicn` → ~/.nvm/…/bin/qoderclicn (npm global `@qodercn-ai/qoderclicn`
 *    1.1.56) → `bundle/qoderclicn.js`, a 33 MB `#!/usr/bin/env node` bundle. The
 *    SAME product as the desktop identity `qoder-cn` and the same ACP wire, but a
 *    DIFFERENT binary (the desktop one is the app's private 33 MB
 *    `qoder-worker-runtime.obf.mjs`, 1.1.53), a different version, and a
 *    different credential story — so it is a second identity, not a flag (D41).
 *    Its capability row is pinned to `qoderclicn-acp-handshake.ndjson`.
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
    // `model` and `effort` (session/new `configOptions`, driven through
    // session/set_config_option), `mcpConfig` (session/new `mcpServers`, which
    // is JSON over the wire rather than a config FILE the bridge writes).
    // Both dials are named in the capture's own `configOptions[]` — five
    // entries, `mode` / `model` / `thought_level` / `sandbox` / `multitask` —
    // and that is what makes them ADDRESSABLE rather than merely advertised
    // (tests/fixtures/ACP-PROVENANCE.md). `model` and `effort` were both claimed
    // before the driver had a model lever, on the strength of that advertisement
    // plus `session/new`'s `models`; the lever now exists, so `model: true`
    // rests on the same evidence it always did. Still UNVERIFIED on this host:
    // that the engine ACCEPTS a model value — this host is not signed in, so the
    // dial has never been exercised here, and the notes below say so.
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
    //  - model: FALSE [proven], and it STAYS false after the driver grew a
    //    second lever. `session/new` ADVERTISES models.availableModels (252
    //    entries) + currentModelId, but the model was never applied when passed
    //    through `session/new` params — both the `model` and the `modelId`
    //    spelling were silently ignored and currentModelId came back unchanged.
    //    The driver's other lever, `session/set_config_option`, cannot help
    //    here either: it addresses a selector the session ADVERTISES, and this
    //    engine answers no `configOptions` at all (see the next bullet), so
    //    there is nothing to address. `model: true` would promise a knob this
    //    identity cannot reach.
    //  - effort: FALSE [proven]: `session/new` (and `session/resume`) answer NO
    //    `configOptions` at all, so the driver's effort selector (id/category
    //    in effort|thought_level|reasoning_effort) resolves to nothing — and so
    //    does its model selector, which is matched by id `model`.
    //  - clientTools: FALSE [proven for this handshake]: no `fs/*` or
    //    `terminal/*` request was observed from the engine.
    //  - `mcpConfig` is deliberately NOT claimed: `mcpServers: []` was accepted
    //    without error but never exercised with a real server, so there is no
    //    evidence either way.
    capabilities: { resume: true, model: false, effort: false, clientTools: false },
    notes:
      'ACP face of the Hermes Agent CLI (hermes-agent 0.21.3, probed 2026-09-17): `hermes acp` speaks headerless NDJSON JSON-RPC on stdio, stdout clean (adapter INFO logs go to stderr). `initialize` answers protocolVersion 1 + agentInfo + agentCapabilities + authMethods (openrouter, hermes-setup); `session/new` answers sessionId + models (252 availableModels, currentModelId) + modes, and NO configOptions. Two MEASURED negatives keep the capabilities honest: a model passed in session/new params is accepted but ignored (currentModelId never moved), and there is no effort dial — so `model` and `effort` are false rather than copied from `codebuddy-code-acp`. ACCEPTANCE 2026-09-17 (`node --experimental-strip-types scripts/acceptance.ts hermes "Reply with exactly: OK"`): probe available=true version=0.21.3, and the run reached a clean PARSED TERMINAL in 18.7s (no hang) with backendSessionId eeac6539-f93a-4a48-8222-7acd1258e467 — but it is NOT a working turn: status=completed while the only text is the engine\'s own provider failure, "OpenRouter didn\'t answer after 3 attempts … HTTP 404: This model is unavailable for free. The paid version is available now - use this slug instead: minimax/minimax-m3", delivered as an ordinary assistant chunk under a normal end-of-turn. The configured free model slug is refused upstream, and because the ACP layer carries no failure signal the bridge reports `completed`. Do not read that as a working turn — see docs/handoff-blockers.md record 9 and docs/plan.md D39. Known UNPROBED risk: plain `hermes --help` can print lazy-venv-repair banners to stdout on some hosts; the `acp` path was clean here, so the ACP line reader (tryParseJson-per-line) has not been exercised against a real banner. `hermes -z/--oneshot` (final text only) exists as a text fallback and is deliberately NOT the integration — no events.',
  },
  {
    // THE SAME PRODUCT AS `qoder-cn`, DELIBERATELY A SECOND IDENTITY.
    //
    // Not a locale flag and not a protocol alias: this is the CLI the user
    // installed themselves (npm global `@qodercn-ai/qoderclicn` 1.1.56) rather
    // than the engine an application owns (the desktop row's private 33 MB
    // `qoder-worker-runtime.obf.mjs`, 1.1.53). Same ACP wire, same capability
    // row — and that last part is the point of writing it down rather than
    // copying: both were measured, and they agreed.
    //
    // `protocolArgs` carries ONLY the protocol token, matching `hermes` and
    // `codebuddy-code-acp`, NOT the desktop sibling's `['--yolo','--acp']`.
    // That difference is a decision, not an oversight. `--yolo` is load-bearing
    // (it really does select the session mode: `currentModeId` reads `yolo`
    // with it and `default` without), so pinning it would bake a PERMISSION
    // BYPASS into identity data. Measured instead: with `--acp` alone, in mode
    // `default`, a file-creating task emitted exactly one
    // `session/request_permission` offering
    // `[allow_always, allow_once, reject_once]`, the driver's own
    // `selectPermissionOption` picked `allow_once`, the turn reached
    // `stopReason: "end_turn"`, and the file was written. So the in-band
    // handshake is sufficient, and `ACP_BLOCKED_ARGS` already states the
    // principle this follows: the permission mode is the RUN's choice, not
    // something the bridge forces. A caller who wants the bypass can still pass
    // `--permission-mode bypass_permissions` through `extraArgs` — it is
    // deliberately not blocked.
    id: 'qoderclicn',
    track: 'cli',
    family: 'acp',
    displayName: 'Qoder CLI CN (qoderclicn) over ACP',
    command: { executable: 'qoderclicn', protocolArgs: ['--acp'] },
    envPrefix: 'QODERCLICN',
    // PINNED TO `tests/fixtures/qoderclicn-acp-handshake.ndjson`, a real
    // capture of this binary on this host (2026-09-19), parsed back by
    // tests/drivers/qoderclicn-acp.test.ts with the driver's OWN extractors.
    // No `searchPath` is declared: the install resolves through
    // `CLI_SEARCH_PATH`'s first entry (`~/.nvm/versions/node/*/bin`), the same
    // reasoning as `hermes`.
    //
    //  - `resume: true` — `initialize` advertises `loadSession: true` plus
    //    `sessionCapabilities.resume` (and, unlike the desktop engine, also
    //    `close` / `delete` / `fork` / `list`). Not exercised by a live
    //    `session/resume` here either, so the basis is the advertisement.
    //  - `effort: true` — the session advertises `reasoning_effort` with four
    //    levels and the driver's `extractEffortOption` reads it. NOT yet
    //    exercised through `manager.run` on this identity the way the desktop
    //    row was; the read is proven from the capture, the SET is proven at the
    //    protocol level (§10.4b of the findings).
    //  - `model: true` — the engine has a working, VALIDATED model dial
    //    (`session/set_config_option {configId:"model"}`, which rejects an
    //    unknown id with -32602 and confirms a good one), and the driver now
    //    drives it. It did not before: its only model lever used to be the
    //    `model` key of `session/new` params, which this engine ignores in
    //    silence. Same reasoning as the desktop row; see that entry for the
    //    full measurement. NOTE the shared trap that shaped the reader: BOTH
    //    Qoder captures tag `reasoning_effort` with `category: "model"`, so the
    //    model selector is matched by ID ONLY — a category match would hand
    //    back the effort dial and then address a model id to it.
    //  - `mcpConfig` / `clientTools` false — `mcpCapabilities {http,sse}` is
    //    advertised, but `mcpServers` was only ever sent as `[]` and no `fs/*`
    //    or `terminal/*` callback appears in the capture. Advertising is not
    //    obeying, so neither is claimed.
    capabilities: { resume: true, model: true, effort: true, mcpConfig: false, clientTools: false },
    notes:
      'The standalone CLI, not the app\'s engine: `qoderclicn --acp` (the flag is HIDDEN — absent from the 107-line `--help` — but parsed, and `acp` is one of the runtime\'s own session modes alongside `tui`/`headless`/`sdk`). Same ACP wire and the same capability row as the desktop identity `qoder-cn`, but a DIFFERENT binary and version (1.1.56 vs the app\'s 1.1.53) and a DIFFERENT credential story: this CLI maintains ~/.qoder-cn/.auth itself, so a launch is credentialed as soon as the operator has run `qoderclicn login` ONCE — there is no auth wall, unlike the desktop engine, which never inherits the app login. Its TEARDOWN is the same shape as the desktop engine\'s, which is worth stating because a bare probe suggested otherwise: in the full stack the bridge waits out the grace window and signals it, and the engine\'s shutdown handler exits 143 — the acceptance run reports `status=completed exit=143`, so the D40 §8.2 fix (blame the engine only for an exit IT chose) is load-bearing for BOTH Qoder identities. `initialize` answers agentInfo `{name:"qoder-cli-cn", version:"1.1.56"}` + one authMethod (`qoderclicn-login`, a LOCAL login reuse rather than a device flow) + agentCapabilities incl. `loadSession` and `sessionCapabilities.resume/close/delete/fork/list`; `session/new` answers sessionId + 5 modes (default/acceptEdits/auto/dontAsk/yolo) + 14 models (`currentModelId` = `qfmodel` = Qwen3.8-Flash) + configOptions (`mode`, `model`, `reasoning_effort`). The `model` config option is advertised and the engine really honours it — a caller CAN now reach it, because the driver drives that selector through `session/set_config_option` instead of relying on the `model` parameter of `session/new`, which this engine IGNORES in silence (a bogus id there is accepted without complaint, while a bogus configId is rejected with -32602). The two levers differ in kind, not just in spelling: `set_config_option` VALIDATES what it is given. Effort levels are xhigh/low/medium/none — there is no `high` — and the level SET is a function of the selected model (measured on this build: `qfmodel` offers four, `qmodel` only `none`, and the engine answers -32602 to a level it accepted a moment earlier), which is why the driver sets the model BEFORE it reads effort. stdout is clean; the only stderr is one skill-config warning. See docs/findings-qoder-cn-desktop.md §10 and docs/plan.md D41.',
  },
]
