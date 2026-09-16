# codex fixture provenance

Every `codex-*.ndjson` fixture in this directory is either **captured** (real
bytes from the real `codex-cli`) or **derived** (transcribed from the upstream
struct definition because the dialect branch could not be exercised on this
host). The distinction is load-bearing: a derived fixture is a claim about a
schema, a captured one is a measurement.

| fixture | provenance | how it was produced |
|---|---|---|
| `codex-success.ndjson` | **captured** | `codex exec --json` against `stub-responses-server.mjs --scenario plain` |
| `codex-tools.ndjson` | **captured** | `codex exec --json` against `stub-responses-server.mjs --scenario tools` (reasoning + `exec_command`) |
| `codex-file-change.ndjson` | **captured** | `codex exec --json` against `stub-responses-server.mjs --scenario patch` (`apply_patch` → `file_change`) |
| `codex-failure.ndjson` | **captured** | `codex exec --json` with the host's stored credential, which the gateway at `127.0.0.1:8080` rejects |
| `codex-mcp-tool-call.derived.ndjson` | **DERIVED — not captured** | transcribed from `codex-rs/exec/src/exec_events.rs` (`ThreadItemDetails::McpToolCall`, `McpToolCallItemResult`), plus an unknown-type frame for tolerance coverage |

## Reproducing the captures

The host's stored codex credential is rejected by its configured gateway, so a
live success run is impossible. `stub-responses-server.mjs` stands in for the
upstream instead; codex itself is unmodified and its stdout is genuine.

```sh
BIN=~/bin/codex                 # codex-cli 0.154.0 (nvm); the cask is 0.144.6
cd tests/fixtures
node stub-responses-server.mjs --port 8799 --scenario tools --log /tmp/req.ndjson &
TMP=$(mktemp -d)
$BIN exec --json \
  -c 'model_providers.stub.name="Stub"' \
  -c 'model_providers.stub.base_url="http://127.0.0.1:8799"' \
  -c 'model_providers.stub.wire_api="responses"' \
  -c 'model_provider="stub"' \
  --skip-git-repo-check -C "$TMP" 'run the echo command' < /dev/null
```

Two notes on the invocation:

* A **custom** provider id is required. Codex 0.154.0 refuses
  `-c model_providers.openai.base_url=…` with *"model_providers contains reserved
  built-in provider IDs: `openai`. Built-in providers cannot be overridden."* —
  the `model_providers.OpenAI.…` form in the original task brief does not work on
  this version.
* `< /dev/null` is not cosmetic: with a positional prompt but an open stdin pipe,
  codex **blocks forever** waiting for stdin to close (measured: 0 stdout lines
  after 25 s). See the driver's header for what that means for the bridge.

Sanitization applied to the checked-in files: the captured thread UUIDs were
replaced with fixed ones, `/Users/king/...` became `/Users/example/...`, and the
temporary run directory became `/work/project`. Nothing else was edited; the
`item_*` ids, statuses, token counts and error text are verbatim.

## Why `stub-mcp-server.mjs` exists but produced no fixture

A minimal MCP stdio server was written to capture a genuine `mcp_tool_call`.
Codex 0.154.0 does register it (`codex mcp list` shows the server as *enabled*),
but this build defers MCP tools behind a `tool_search` tool whose
`execution` is `client` — headless `codex exec` has no client to run the search,
so the tool is never exposed and no call can be scripted. The stub is kept
because it is the harness a future capture needs, and because the deferral is
itself a dialect fact worth having on record.
