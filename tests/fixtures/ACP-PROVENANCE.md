# ACP fixture provenance

The ACP wire protocol is **not** what a driver author usually assumes. The two
traps that cost real time here, both measured rather than read:

1. **Framing is headerless NDJSON.** One compact JSON-RPC object per `\n`, no
   `Content-Length`. This is ACP's `ndJsonStream`, and it is *not* LSP framing —
   an implementation that reads for a `Content-Length` header reads zero frames
   and hangs forever with no error.
2. **`stopReason: "refusal"` is a FAILURE, not a model declining.** See below.

| fixture | provenance | how it was produced |
|---|---|---|
| `fake-acp-cli.mjs` | **DERIVED — not captured** | frame shapes transcribed from real captures of `codebuddy-code --acp` 2.151.0; the *sequences* are authored to exercise specific driver branches |
| `hermes-acp-handshake.ndjson` | **CAPTURED** (exactly one field ABRIDGED — see below) | real `initialize` + `session/new` frames from `hermes acp` (hermes-agent 0.21.3) on this host, 2026-09-17, over real stdio |
| `qoder-cn-acp-handshake.ndjson` | **CAPTURED** (verbatim, nothing abridged) | real `initialize` result + `session/new` **error** frame from `node <Qoder CN.app bundle>/…/qoder-worker-runtime.obf.mjs --yolo --acp` ("Qoder CLI CN" 1.1.53) on this host, 2026-09-19, while the desktop app itself was signed in and running — see `docs/findings-qoder-cn-desktop.md` §3. It is two frames and the second is an ERROR on purpose: the auth wall is the finding, and there is no session to abridge. |
| `qoder-cn-acp-authed-session.ndjson` | **CAPTURED** (frames verbatim; ONE frame OMITTED — see below) | the SAME engine and flags as the row above, same host, 2026-09-19, **after** the operator ran `qoderclicn login` out of band: real `initialize` + `session/new` **result** (sessionId + `models` + `configOptions`) + two stream updates + the `session/prompt` result (`stopReason: "end_turn"`, text `OK`). See `docs/findings-qoder-cn-desktop.md` §3.1. **The omitted frame** is the `available_commands_update` notification (77 437 B of 268 command names, zero evidential value); every frame kept is byte-for-byte as it arrived. This is the capture that evidences `effort: true` and `model: true` — the session advertises BOTH selectors (`reasoning_effort` and `model`), which is what makes either dial addressable. It also carries the trap that decided how the model selector is read: `reasoning_effort` is tagged `category: "model"`, so a category match would return the effort dial as the model dial. |
| `qoderclicn-acp-handshake.ndjson` | **CAPTURED** (frames verbatim; ONE frame OMITTED — see below) | **A DIFFERENT BINARY from the two rows above**, despite the same product: the standalone npm CLI `@qodercn-ai/qoderclicn` 1.1.56, i.e. `~/.nvm/…/bin/qoderclicn --acp` (NOT the app's bundled `qoder-worker-runtime.obf.mjs`, which is 1.1.53). Same host, 2026-09-19, with the operator's own CLI login in place. Frames: `initialize` result + `session/new` result (sessionId + 5 `modes` + 14 `models` + 3 `configOptions`) + one `agent_thought_chunk` + one `agent_message_chunk` + the `session/prompt` result (`stopReason: "end_turn"`, text `OK`). **The omitted frame** is again `available_commands_update`. The argv is `--acp` and ONLY `--acp` — the exact vector the descriptor pins, so `currentModeId` is `"default"` here, not `"yolo"`: the sibling desktop row pins `--yolo`, this one deliberately does not, and the capture reflects the difference rather than papering over it. `agentInfo.version` is the field that tells the two Qoder captures apart — 1.1.56 here, 1.1.53 above — which is why the version is asserted in the test rather than assumed. |

There are no `acp-*.ndjson` capture files checked in, and that is deliberate: a
capture of this engine on this host contains only the auth failure below, so it
would be a one-line file. The measured frame shapes live in the fixture source
instead, annotated at each builder.

## The real capture (raw evidence)

Taken 2026-09-17 against
`/Users/example/.nvm/versions/node/v22.22.3/bin/codebuddy-code --acp`
(`@tencent-ai/codebuddy-code` 2.151.0), driving
`initialize` → `session/new` → `session/prompt` over real stdio.

**`initialize` result** (abridged — the 4 auth methods are verbatim):

```json
{"protocolVersion":1,
 "agentCapabilities":{"promptCapabilities":{"image":true,"embeddedContext":true},
   "mcpCapabilities":{"http":true,"sse":true},"loadSession":true,
   "delegateToolsSupport":true,"mainAgentSupport":false,"multitaskSupport":true},
 "authMethods":[{"id":"iOA","name":"Login with iOA","description":null},
   {"id":"external","name":"Login with Google/Github","description":null},
   {"id":"internal","name":"Login with WeChat","description":null},
   {"id":"selfhosted","name":"Login with Enterprise Domain","description":null}]}
```

**`session/new` result** (abridged): `sessionId`, `models.availableModels[]`
(17 model entries carrying `modelId` / `name` / `description` / `_meta`),
`modes.{currentModeId,availableModes[]}`, and `configOptions[]` — five entries
(`mode` / `model` / `thought_level` / `sandbox` / `multitask`), each a
`{type,id,name,description,category,currentValue,options[]}` select. The driver
reads `thought_level` out of these to resolve `effort`; `currentValue` is
`"enabled"` and the option set is
`disabled | minimal | low | medium | high | xhigh | max | enabled`.

**`session/update` types observed during the turn**, in order:

| update | count | note |
|---|---|---|
| `config_option_update` | 1 | full `configOptions` echo |
| `available_commands_update` | 2 | slash-command catalogue |
| `session_info_update` | 10 | `_meta['codebuddy.ai/agentPhase']` = idle → preparing → model_requesting → idle |
| `usage_update` | 1 | `{"used":0,"size":176000,"_meta":{...}}` |

**An id-less agent→client request was observed:**

```json
{"jsonrpc":"2.0","method":"_codebuddy.ai/command",
 "params":{"sessionId":"…","action":"workspace_info","params":{"isGitWorkspace":false}}}
```

No `id`. A driver that replies to it violates JSON-RPC; a driver that treats it
as a response to one of its own pending calls corrupts its pending map. The
bridge does neither, and the fixture replays it to keep that locked down.

**`session/prompt` result — the failure this host can actually produce:**

```json
{"stopReason":"refusal",
 "userMessageId":"01a0abb2-47cd-7896-96ad-e54fcc57858b",
 "_meta":{
   "codebuddy.ai/errorMessage":"{\"code\":-32000,\"message\":\"Authentication required\",\"data\":{\"statusCode\":401,\"details\":\"401 Authentication required. Please use /login command to sign in to your account (auth-type:cli-external-link,token-type:Bearer,token-length:1398) (target: https://copilot.tencent.com) (…)\",\"code\":401,\"category\":\"auth\"}}",
   "codebuddy.ai/outcome":"FAILED_MODEL_REQUEST"}}
```

Process exit code: **0**. Stderr: **empty**.

## Why there is no successful capture

This host is not signed in to CodeBuddy, so every prompt ends in the 401 above
and **no `agent_message_chunk` is ever emitted**. A completed turn is therefore
not reproducible here.

Per the repo's convention (see D23 and `CODEX-PROVENANCE.md`, which treats a
captured auth failure as equally valuable evidence), the failure is recorded
verbatim above rather than papered over with a synthetic success. Three
consequences for the reader:

* The driver's `stopReason: "refusal"` → `status: "failed"` mapping is
  **measured**, not guessed. Treating `refusal` as an ordinary outcome would
  report a dead credential as a turn in which the model declined — a silent
  wrong answer, which is worse than an error.
* `agent_message_chunk`, `agent_thought_chunk`, `tool_call` and
  `tool_call_update` are **DERIVED** frame shapes. They are transcribed from the
  ACP schema and from multica's `hermes.go` handlers (`handleAgentMessage`,
  `handleToolCall`, the `toolNameFromTitle` table), not from a live success on
  this host. The fixture is labelled DERIVED for that reason.
* A future run on a signed-in host should re-capture and replace the derived
  builders with the real bytes.

## Reproducing the capture

```sh
BIN=~/.nvm/versions/node/v22.22.3/bin/codebuddy-code
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"capture","version":"0.1.0"},"clientCapabilities":{}}}' \
  | { $BIN --acp & } ; wait
```

In practice a small Node driver is needed (the handshake is stateful and
`session/new` must carry the `cwd`); `/tmp/acpcap2/capture.mjs` is the throwaway
script used here and its only non-obvious trick is that it must keep reading
stdout *while* writing, or the exchange stalls — the very trap the driver's own
`deadlock` scenario exists to prevent.

## A SECOND engine on the same wire — `hermes-acp-handshake.ndjson`

Appended 2026-09-17 (D39). Nothing above is changed by this section.

Taken against `/Users/example/.local/bin/hermes` → `~/.hermes/hermes-agent/venv/bin/hermes`,
**`hermes-agent` 0.21.3**, driving `initialize` → `session/new` over real stdio
with the throwaway script `/tmp/hermes-acp-probe.mjs`. `hermes acp --version`
prints exactly `0.21.3` [proven].

Two lines, one JSON-RPC frame each:

* line 1 — the verbatim `initialize` **result** (`agentInfo`, `agentCapabilities`,
  `authMethods`).
* line 2 — the `session/new` **result**. **ABRIDGED in exactly one field**:
  `models.availableModels` was truncated 252 → 6 entries to keep the fixture
  reviewable. Every other byte is verbatim, including the live `sessionId`
  (an ephemeral local session id, not a credential).

Measured facts this fixture locks down (all [proven] on this host):

* The framing is the same headerless NDJSON as CodeBuddy's, and **stdout carried
  ONLY these two frames** — the adapter's very large INFO log went to **stderr**.
  So the "non-JSON noise on stdout" risk is real but **unobserved on this path**:
  the driver's per-line `tryParseJson` skip is NOT exercised against a real
  banner here, and no synthetic banner fixture was invented to pretend otherwise.
* `authMethods` = `openrouter` + `hermes-setup` (the second is a `type:"terminal"`
  method with `args:["--setup"]`).
* `session/new` answers `sessionId` + `models` (`availableModels`,
  `currentModelId`) + `modes`, and **NO `configOptions`** → an effort dial cannot
  be claimed (`extractEffortOption` returns `undefined` on these bytes).
* `agentCapabilities.loadSession: true` and `sessionCapabilities.resume: {}`.

What this fixture deliberately does **not** show (probed separately, same host
and day, `/tmp/hermes-acp-model-probe.mjs` + `/tmp/hermes-acp-probe3.mjs`):

* Whether `session/new` HONOURS a model param — it does **not**. Passing
  `model` and the `modelId` spelling both left `currentModelId` at
  `openrouter:minimax/minimax-m3:free`. The model LIST is real; the SELECTION is
  not. That measurement is why the descriptor declares `model: false` even
  though the capture shows 252 models.
* A `session/resume` call (not in this fixture) returned a normal result
  (`models` + `modes`, no JSON-RPC error) but **no `sessionId`** — the driver
  falls back to the caller's pinned id, which is why `resume: true` still holds.
* A completed turn: the acceptance outcome is recorded in `docs/plan.md`.

Consumer: `tests/drivers/hermes-acp.test.ts` parses both frames with the
driver's OWN extractors (`extractAuthMethods`, `extractSessionId`,
`extractCurrentModelId`, `extractEffortOption`, `extractModelOption`) and fails
if the descriptor's capability flags disagree with these bytes. Note the last
one: hermes is where `extractModelOption` must return `undefined` — a real
252-entry model catalogue with no addressable selector, which is the negative
control for `model: false` staying false on this identity.

## Two added DERIVED scenarios (batch C, 2026-09-18)

Appended by the RR-IM-6 / RR-MI-7 repair batch. Nothing above is changed.

Both live in `fake-acp-cli.mjs` and are **DERIVED — not captured**: they model
failure shapes the driver must survive, and neither is a transcription of bytes
seen from a live engine.

| scenario | provenance | shape |
|---|---|---|
| `orphan-before-session` | **DERIVED** | `initialize` answered, then the engine asks for a `terminal/create` and only afterwards fails `session/new` with a JSON-RPC error. The refused-handshake shape is a real engine behaviour class (the driver already maps any `session/new` error to a failed run); what is authored here is the ORDER, so the terminal exists before the failure. The terminal's command writes its pid to `orphan.pid` in the run cwd and `exec`s a long sleep, and the fixture waits for that file before failing — so the pid is observable no matter how fast the driver cleans up. |
| `overflow-handshake` | **DERIVED** | `initialize` is answered with one 17 MB stdout line (past the 16 MB `MAX_STREAM_LINE_BYTES` cap) and then the engine parks without ever exiting. Not a shape any real engine was observed to produce; it is the minimal stream that forces the reader's overflow path while the run is NOT awaiting a response it can reject. |

Consumer: `tests/drivers/acp.test.ts` (RR-IM-6 and RR-MI-7).

