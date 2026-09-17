# Findings — ZCode desktop bundle as a bridge engine

Date: 2026-09-17. Probed live on this host: ZCode.app 0.16.5 at
`/Applications/ZCode.app`, CLI bundle `Contents/Resources/glm/zcode.cjs`
(`#!/usr/bin/env node` script, 11.4 MB), shared state under `~/.zcode/`.

Every claim below is tagged **[proven]** (executed/observed on this host) or
**[inferred]** (read from the minified bundle, not executed). The distinction
is load-bearing: the driver's tests may only treat [proven] facts as oracles,
and every [inferred] parser mapping must fail OPEN (unknown event type →
ignore, never crash).

## 1. Launch recipe [proven up to the entitlement wall]

```
interpreter: /opt/homebrew/bin/node            (desktop-track rule: node is NOT beside the script)
executable:  /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
env:         ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
argv:        -p <prompt> --output-format stream-json [--resume sess_...|--cwd ...|--mode ...]
```

The env var is mandatory, not cosmetic. Without it the CLI throws at startup:

```
无法定位 CLI ZCode Built-in Provider Config：
  <dir-of-argv1>/provider/zcode-builtin.json, ../../../../../config/provider/zcode-builtin.json
```

Resolution formula [proven from bundle, `qSo`]: dirname(process.argv[1]) +
`provider/zcode-builtin.json`, else 5 levels up +
`config/provider/zcode-builtin.json`. The in-bundle layout satisfies NEITHER
(candidate 1 would need the file inside `Resources/glm/`, actual location is
`Resources/config/provider/`). The official escape hatch [proven]:
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (plus companion
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`; when both are set the probe is skipped
entirely). A symlink shim also works (built and verified: `zcode.cjs ->
bundle`, `provider/zcode-builtin.json -> Resources/config/...`), but env wins:
`CommandSpec.env` already carries per-identity env, and creating state on
first probe needs a lifetime nobody owns. `~/.zcode/v2/provider_config.json`
is discovered automatically from `dataBaseDir` (default `$HOME`, overridable
via `ZCODE_DATA_BASE_DIR` [proven string, untested as override]).

Do NOT use `--settings` for this: it swaps the USER config file, not the
provider catalogue.

## 2. Help text is not the contract [proven]

The parser of 0.16.5 REJECTS two flags its own `--help` advertises:

```
$ zcode --prompt "..." --max-turns 1
Unknown option '--max-turns'.
$ zcode --prompt "..." --model X
Unknown option '--model'.
```

Accepted forms [proven]: `-p <positional>`, `--prompt <text>`,
`--output-format text|json|stream-json` (parser enum; not in top-level help),
`--json`, `--mode build|edit|plan|yolo`, `--permission-mode` (legacy alias),
`--resume sess_...`, `-c/--continue`, `--cwd <path>`, `--surface
terminal|desktop`, `--attach <path>`, `--settings <path>`, `--allowed-tools`,
`--disallowed-tools`/`--disallowedTools`, `--locale`, `--verbose`, `--no-color`.

Consequence for every builder: never pass `--model` or `--max-turns`. Model
selection travels via §4; max-turns does not exist headless.

## 3. Wire protocol — ZCode Protocol NDJSON (NOT claude's stream-json)

`--output-format stream-json` emits one JSON object per line with THIS
envelope [proven — captured live]:

```json
{"eventId":"...","seq":1,"sessionId":"sess_...","turnId":"turn_...",
 "timestamp":1789636895202,"traceId":"...","type":"turn.failed",
 "payload":{...}}
```

Contrast with claude family: envelope keys (`type` uses dotted lifecycle
names, payload nested under `payload`, session id under `sessionId` with a
`sess_` prefix) and the absence of `--input-format` (there is NO stream-json
INPUT; the claude runner's open-stdin control_request model does not apply).

Event vocabulary (strings present in the bundle [inferred]; the mapping to
bridge events must be defensive):

* turn lifecycle: `turn.started`, `turn.completed`, `turn.failed`,
  `turn.terminal` (2 hits — likely the terminal wrapper)
* text: `text.delta` (19), `message.upserted`, `message.removed`,
  `agent.message.send/respond`
* tools: `tool.call.started`, `tool.call.completed`, `tool.call.failed`,
  `tool.permission.denied|evaluated|resolved`, `tool.updated`
* session: `session.created`, `session.model.updated`, `session.mode.updated`,
  `session.message.persisted`, `session.persisted`, `session.closed`
* goals/compaction: `goal_*`, `compact.*`

Observed terminal behavior [proven twice, shim runs]: after `turn.failed` the
process MIGHT NOT EXIT (first run hung > 120 s with 4 MCP "closed" log lines;
later runs exited). The driver must therefore treat a terminal event
(`turn.completed`/`turn.failed`) as run-end and enforce its own grace + kill,
exactly the openclaw idle-grace pattern — never "wait for exit".

`--json` (text mode) prints a terminal summary object (no streaming): a
`wantsJsonSummary` predicate gates it [inferred]; fine for probe/one-shot,
not the run transport.

Session id for the handle: `sessionId` from any event (or
`session.created.payload`) — `sess_` prefixed; `--resume sess_...` is the
proven continuation flag.

## 4. Model selection — the operator-side gate [proven blocker]

Headless turns resolve the model from the provider-config store's
`config.defaultModelSelection` — schema
`{providerId: string, modelId: string, options?: {reasoningLevel?: ...}}`
[inferred from zod `mo` + `defaultModelSelection:mo.optional()` in the
bundle]. This machine:

* `~/.zcode/v2/provider_config.json` has NO `defaultModelSelection`;
* `~/.zcode/v2/coding-plan-cache.json` (refreshed 2026-09-17 15:12): all four
  plans `{"status":"unavailable","reason":"coding_plan_not_entitled"}`;
* the user's custom `builtin:bigmodel` provider in `~/.zcode/v2/config.json`
  has `"apiKey":""`;
* desktop tasks-index `model` strings have the form
  `builtin:bigmodel-coding-plan/GLM-5.3-Flash` — i.e. `providerId/modelId`
  [proven], last completed desktop task 2026-08-28, two later ones `error`.

Failure mode until the operator restores entitlement + picks a default model:

```json
{"type":"turn.failed","payload":{"error":{"code":"CONFIGURATION_ERROR",
 "message":"Select a model before continuing", ...},"turnPhase":"model_creation"}}
```

This is a credential/account condition, not a code defect: per §0 it goes to
handoff-blockers (record 8) and NO workaround (no hand-editing `~/.zcode/**`,
no vendor file mutation, no plan-faking).

## 5. Desktop-track fit

`src/tracks/desktop/catalog.ts` header rules map one-to-one: absolute
in-bundle executable ✓, app-owned auth (Z.AI OAuth, `~/.zcode/v2/credentials.json`,
values encrypted `enc:v1:` [proven]) → credential status `not-applicable` ✓,
node-script-without-node ✓. New identity `id:'zcode'`, `family:'zcode'` —
family extension follows the `acp` precedent (D27). Scan must verify bundle +
provider file + the §1 recipe at least reaching turn creation; a missing
ZCode.app is a hard unsupported.

Optional later (NOT this task): `--surface desktop` presents headless runs in
the desktop UI; `app-server` subcommand speaks the same ZCode Protocol over
stdio JSON-RPC (`initialize` handshake; NOT ACP — zero `session/prompt` /
`agent-client-protocol` strings in the bundle [proven]) and additionally fails
at startup for the provider-config reason until env is set — the same
override applies. A follow-on decision for a persistent-session mode.

## 6. Implementation contract for the driver (D38)

1. `src/drivers/zcode.ts`, family `zcode`, built on the shared `argv.ts`
   harness (spawn contract, process-group terminate, readLines). One run =
   one `-p` turn; continuation via `--resume <sessionId>` from the previous
   run's events (session handle = last observed `sessionId`). No stdin
   protocol: prompt goes in argv via the documented builder path (desktop
   track is macOS here; note the generic-driver PowerShell caveat in the
   header — do not "fix" it by switching to stdin, that is a different CLI).
2. Fixed launch args: `-p` … `--output-format stream-json`; when the caller
   passes a permission mode, map it to `--mode` (yolo default already per
   help for `--prompt` — do not pass redundant flags). `--cwd` honored by
   kernel spawn cwd; do not duplicate.
3. Blocked args: `-p`, `--prompt`, `--output-format`, `--json`, `--resume`,
   `-c`, `--continue`, `--mode`, `--permission-mode`, `--surface`, `--cwd`,
   `--settings`, `--attach`, `--model`, `--max-turns` (last two are
   parser-rejected anyway; block so a future parser can't steal the run).
4. Parser: envelope of §3. Map terminal events to the bridge's
   AgentResult/terminal `text`; `text.delta`/`message.upserted` to streaming
   text [inferred shapes — parse leniently]; `tool.call.*` to tool events;
   `turn.failed.payload.error.message` to the run's error text (proven
   shape). Unknown `type` → ignore + count. No O(n²) retention: this driver
   sees the same event firehose as claude family.
5. Terminal-on-event + grace-kill (openclaw pattern) because §3 hang is
   proven. Test with a fake spawn whose stdout ends but whose exit never
   arrives.
6. Env: driver must ensure `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (and pass
   through `ZCODE_DATA_BASE_DIR` if set). If the identity's CommandSpec.env
   is the plumbing point, ship the default in the descriptor; a driver that
   silently launches without it is launching a broken CLI.
7. Registry/catalog/scan + models track read of the built-in provider JSON
   (templateRules→modelIds; §1 file) — pure read, never write vendor state.
8. Tests: guardrails red-first with negative controls per repo doctrine;
   happy-path live acceptance is BLOCKED on record 8 — tests must not fake a
   successful turn; [inferred] mappings are pinned by parser unit tests over
   recorded envelope fixtures (the captured `turn.failed` line is one).
9. i18n/display: `ZCode (bundled CLI)`; settings lists (allowedAgents) pick
   it up from the registry automatically.

## 7. Commands for reproduction

```
# version probe
/opt/homebrew/bin/node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs version
# proven failing-without-env (expect 无法定位… message, exit 1)
/opt/homebrew/bin/node .../zcode.cjs app-server
# proven launch (expect turn.failed CONFIGURATION_ERROR or — after the
# operator restores entitlement — a real turn):
nohup env ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json \
  /opt/homebrew/bin/node .../zcode.cjs -p "reply with exactly: ok" --output-format stream-json >/tmp/z.out 2>/tmp/z.err &
# logs the CLI writes: ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl (turn.failed
# records), rollouts: ~/.zcode/cli/rollout/model-io-sess_*.jsonl
```
