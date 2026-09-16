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

There are no `acp-*.ndjson` capture files checked in, and that is deliberate: a
capture of this engine on this host contains only the auth failure below, so it
would be a one-line file. The measured frame shapes live in the fixture source
instead, annotated at each builder.

## The real capture (raw evidence)

Taken 2026-09-17 against
`/Users/king/.nvm/versions/node/v22.22.3/bin/codebuddy-code --acp`
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
