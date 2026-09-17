# Findings — Hermes Agent CLI (`hermes`) as a bridge identity — D39 brief

Date: 2026-09-17. Host: this machine. Version: **hermes-agent 0.21.3**.
Tags [proven]/[inferred] as usual; [proven] below = executed live on this host.

## 1. What the engine is [proven]

* Python CLI: `~/.local/bin/hermes` → symlink → `~/.hermes/hermes-agent/venv/bin/hermes`
  (a `#!/bin/sh` shim exec-ing its venv python3). No node interpreter role;
  the bridge spawns it directly. `~/.local/bin` is ALREADY in
  `CLI_SEARCH_PATH` (`src/tracks/cli/index.ts:48`) so a GUI host with a
  truncated PATH resolves the bare `hermes` executable — CLI track, no
  descriptor searchPath needed (verify with the existing resolution tests).
* `Hermes.app` exists in /Applications but is NOT the integration surface —
  the CLI speaks its own ACP server; the desktop app is one of its clients
  (`hermes serve` powers it). Do not add a desktop-track descriptor.

## 2. The wire: standard ACP — the existing `acp` family (D27) drives it [proven]

`hermes acp` starts an ACP server, headerless NDJSON JSON-RPC on stdio. Live
`initialize` (this host, 2026-09-17 20:10):

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentInfo":{"name":"hermes-agent","version":"0.21.3"},
  "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},
    "sessionCapabilities":{"fork":{},"list":{},"resume":{}}},
  "authMethods":[
    {"id":"openrouter","name":"openrouter runtime credentials","description":"…currently configured openruntime credentials…"},
    {"id":"hermes-setup","name":"Configure Hermes provider","type":"terminal","args":["--setup"]}]}}
```

* stdout is CLEAN protocol — adapter INFO logs go to **stderr** (observed).
* `hermes acp --version` prints exactly `0.21.3` [proven] → the run-probe
  parity test (probe argv = run argv + `--version`) passes by construction.
* `session/new` was NOT probed yet: before writing capabilities into the
  descriptor, run the handshake to `session/new` once via a tiny script and
  pin ONLY what it answers (`models`? `configOptions`? which decide
  `model`/`effort` truth). Do not copy codebuddy-code-acp's capability row
  unexamined.
* Boot noise risk [proven, adjacent]: plain `hermes --help` can print
  lazy-venv-repair banners (⚠/✓ lines) — on that path they went to stdout.
  The `acp` path was clean, but the ACP driver's line reader
  (`tryParseJson`-per-line, src/drivers/acp.ts:1127) must be shown to skip
  non-JSON noise; pin it with a fixture line pair (banner then JSON) IF a
  live capture ever shows one. Note this as a known-unprobed risk, not a bug.

## 3. Descriptor to add (`src/tracks/cli/catalog.ts`, after codebuddy-code-acp)

```ts
{
  id: 'hermes',
  track: 'cli',
  family: 'acp',
  displayName: 'Hermes Agent CLI over ACP (hermes acp)',
  command: { executable: 'hermes', protocolArgs: ['acp'] },
  envPrefix: 'HERMES',
  capabilities: { /* fill from the session/new probe in §2 */ },
  notes: '…measured facts with version+date, per catalog convention…',
}
```

* `hermes acp` takes NO model/permission flags before the subcommand — all
  turn control is ACP-over-wire (this is exactly why the acp family exists).
* `-z/--oneshot` (final text only, `--usage-file` JSON written even on
  failure) exists as a text fallback — OUT OF SCOPE: it yields no events and
  the bridge would re-implement streaming wrong. The ACP face is the
  integration. Mention in notes only.

## 4. Auth & acceptance

* Provider config lives in `~/.hermes/` (auth.json, .env — NEVER read or
  copy secrets; do not echo file contents into docs/tests).
* `authMethods[0].id = "openrouter"` says this host HAS runtime credentials
  configured [proven from handshake]. Whether a completed turn succeeds is
  an account fact: run
  `node --experimental-strip-types scripts/acceptance.ts hermes "Reply with exactly: OK"`
  — EITHER outcome is honest acceptance as long as a FAILURE arrives as a
  parsed terminal result (refusal/401 mapped to failed run), never a hang
  and never a "success" with empty text. Record the actual outcome in the
  notes + plan.md; if it fails on auth, handoff-blockers, not a workaround.
* Guardrails to update: argv-shape exhaustiveness already covers `acp`
  (protocolArgs path) — a NEW IDENTITY just flows through; tests/tracks
  catalog-count/enum assertions may need the hermes row; add a
  `hermes`-specific handshake fixture + ACP-PROVENANCE.md line (append, don't
  rewrite).

## 5. Workbuddy dispatch contract (operator-approved)

* Executor: domestic WorkBuddy CLI (`--model deepseek-v4.1-flash`); the
  operator confirmed it spends a small amount of PAID credits — this is the
  authorized path.
* Deliverables: descriptor + session/new probe results reflected honestly in
  capabilities; acceptance run + notes; full gates (vitest, tsc, BOTH
  builds, verify_plugin.py); fixtures/provenance discipline; WORKBUDDY REPORT
  + STATUS: COMPLETE; leave tree uncommitted; NO commits, NO ~/.dsh or
  ~/.hermes writes beyond the read-only acceptance run.
