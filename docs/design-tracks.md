# Two tracks: CLI and Desktop

Status: implemented (ABI v2). Supersedes the single-track assumption in
`design.md` §3. Decisions logged as D21–D23 in `plan.md`.

## 1. Why the split is an axis, not a flag

`ProtocolFamily` answers **what dialect** an engine speaks. It does not answer
**how the bridge gets a launchable engine on this host**, and those are
independent:

| | CLI track | Desktop track |
|---|---|---|
| Who installed it | the user (`npm i -g`, brew, nvm) | a desktop app's bundle |
| Executable | bare name found through a search path | absolute path inside the bundle |
| Missing binary | "set `<PREFIX>_PATH`" — user-fixable | "the app is not installed here" — a finding |
| Auth | the CLI's own config/key; bridge reads status only | the app's own login, reused |
| PATH problems | must be worked around | must not exist (never searched) |
| Interpreter | usually not needed; shims are repaired | mandatory (`node` ships with the app, not on PATH) |
| Profiles | none | per-app profile changes which config is read |
| Failure mode | invisible install (GUI PATH) | stale bundle path, bad profile |

`openclaw` proves the axes are orthogonal: on the CLI track it is a binary the
user installed; on the desktop track it is `openclaw.mjs` inside AutoClaw.app,
driven through the app's profile. Same dialect, different implementation.

## 2. Layout

```
src/tracks/
  types.ts             TrackPolicy, LaunchInput, notFoundReason
  index.ts             BUILTIN_DESCRIPTORS = cli ++ desktop; policyFor(track)
  cli/catalog.ts       claude, codex, openclaw, generic  (+ codebuddy-code: deferred)
  cli/index.ts         CLI policy: searchPath, node-shim repair, permission rule
  desktop/catalog.ts   workbuddy, autoclaw, mimo (unsupported)
  desktop/index.ts     Desktop policy: absolute only, refuse instead of guess
```

The kernel stays the single mechanism: it resolves `<PREFIX>_PATH` overrides,
calls `policyFor(descriptor.track).launch(...)`, and probes `<exe> --version`.
It never branches on an agent id, and the two policies never import each other.
`notFoundReason()` is shared so probe output has one shape — the model must not
have to learn two vocabularies.

## 3. Verified host facts that shaped the code

All observed on the target machine, 2026-09-16. Each one has a test.

1. **A GUI-launched host does not inherit the login PATH.** In-session
   `PATH=/opt/homebrew/bin:/usr/bin:/bin:...`: a bare `claude` resolved to
   nothing while `/usr/local/bin/claude` worked. → `CLI_SEARCH_PATH`, consulted
   *before* the inherited PATH.
2. **The login PATH puts per-user and version-managed dirs first**
   (`~/.nvm/.../bin`, `~/.local/bin`, `~/.bun/bin`, `~/bin`, then
   `/opt/homebrew/bin`). → `CLI_SEARCH_PATH` mirrors that order. It is
   load-bearing: this host has **two codex installs** — `~/bin/codex` (nvm,
   0.154.0) and `/opt/homebrew/bin/codex` (cask, 0.144.6) — and the shell picks
   the nvm one. `probe` reports the resolved absolute path *and* version so this
   is visible rather than silent.
3. **npm shims die without node.** `#!/usr/bin/env node` + no `node` on PATH =
   `env: node: No such file or directory` before any output. → the CLI policy
   reads the shebang and prepends a resolved node, but *only* for a file that is
   literally a `#!…node` script (a NUL byte in the first block means a binary).
4. **A bundle engine may be mode 644.** AutoClaw's
   `.../gateway/openclaw/openclaw.mjs` is `-rw-r--r--` and runs as
   `node openclaw.mjs`. → when a descriptor declares an interpreter, the target
   only needs to be **readable**; the interpreter still needs `+x`. This bug was
   caught by running the real probe, which had reported a healthy desktop engine
   as missing.
5. **`claude` here is not Claude Code.** `/usr/local/bin/claude` →
   `~/.nvm/.../bin/ccb` → npm `claude-code-best@2.8.4`, a reverse-engineered
   Claude Code CLI that reports `2.8.4 (Claude Code)`. The official
   `@anthropic-ai/claude-code` shim is a dangling symlink. The descriptor carries
   a `notes` field that travels into probe output, because "installed = yes" is
   not the same as "this is the thing you think it is".
6. **Two WorkBuddy builds ship ONE byte-identical launcher.** `WorkBuddy.app` and
   `WorkBuddy AI.app` (5.5.2, `com.workbuddy.workbuddy-ai`) contain the same
   `cli/bin/codebuddy` (sha256 `f8b141c3…`). The difference is the
   `cli/product.json` beside it, which the launcher reads:

   | bundle | `applicationName` | `dataFolderName` | `apiKeySource` |
   |---|---|---|---|
   | `/Applications/WorkBuddy.app` | `WorkBuddy` | `.workbuddy` | `copilot.tencent.com` |
   | `/Applications/WorkBuddy AI.app` | `workbuddy-ai` | `.workbuddy-ai` | `www.workbuddy.ai` |

   So the config home follows from **which bundle was executed** — no env var, no
   profile flag, nothing to plumb. The identity really is the bundle path, which
   is what the desktop track already models, and the two catalogs are genuinely
   different (22 international ids incl. `deepseek-v4.1-flash-sg`, `gpt-6-astra`,
   `gemini-3.5-flash` vs 51 domestic ids). A real headless run of the
   international build returns `401 Unauthorized` with result subtype
   `error_during_execution`: the desktop login must be established in that app
   before the CLI can use it, exactly like the two CLI engines in §3.5.

7. **Neither CLI can currently complete a run.** `claude` (OpenAI-compat mode,
   `OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`) gets
   `401 Invalid API key`; `codex` is pointed at the local gateway
   `http://127.0.0.1:8080` which answers
   `凭据不是本网关签发的虚拟密钥（格式应为 vk- 开头）`. **The bridge therefore
   never handles credentials**: each engine keeps its own, and `agents_probe`
   reports launch status plus a credential status derived from config *files*
   only — no network call, no secret in the bridge.

## 4. Redaction rule (non-negotiable)

Probe output may contain a path, a version, a status word and a redacted
one-line reason. It must never contain a key, token, cookie, or the contents of
`~/.codex/auth.json` / `~/.claude/settings.json` `env`. Those files are read to
answer "does a credential appear to exist", and nothing else.

## 5. Open items

- **D22** — `codex` protocol driver (`codex exec --json` JSONL). Family added to
  the ABI (`ProtocolFamily` += `'codex'`); driver not yet written.
- **D23** — `codebuddy-code` (`@tencent-ai/codebuddy-code` 2.151.0, installed at
  `~/.nvm/.../bin/codebuddy-code`). Deliberately last: its headless dialect is
  unverified, and it ships its own `dist-server`, so it may or may not speak the
  claude stream-json dialect. No descriptor until a real capture exists.
- Health/model discovery readers: **done** (`src/tracks/health.ts`,
  `src/tracks/models.ts`, shared primitives in `src/tracks/host-files.ts`), wired
  into `probe()`. Real-machine output: claude `ok` / 6 ids from
  `~/.claude/settings.json`, codex `ok` / 2 ids from `~/.codex/models.json`,
  workbuddy `not-applicable` / 51 ids, autoclaw `not-applicable` / 6 ids
  (`models.providers.zai`), openclaw CLI `missing` / not discovered, generic
  `unknown`, mimo `not-applicable`.

## 6. Two leak vectors closed while implementing §4

1. **V8 parse errors quote the input.** `JSON.parse` on a truncated
   `auth.json` throws `Unexpected token 'o', "not json"…`, which would put the
   first bytes of a key into a probe detail. `parseJsonObject()` builds its
   detail from the error's *position* only, and a test asserts the input text
   never appears in the reason.
2. **AutoClaw's config carries a live JWT.** `~/.openclaw-autoclaw/openclaw.json`
   stores a bearer token under
   `models.providers.zai.models[].headers['X-Authorization']` (plus a
   provider-level `apiKey`). The credential reader is therefore a strict
   allow-list of field NAMES at the top level and under
   `models.providers.<p>.*` — never a recursive scan — and the model reader reads
   only `models[].id`. `base_url` is deliberately not read either (a URL can
   carry userinfo). Tests assert a fixture JWT reaches neither the credential
   fragment nor the model list.

Every returned detail passes one choke point (`fragment()`) that collapses it to
a single line and runs `redactSecrets()`; model ids are excluded from redaction
because a legitimate id can exceed 32 characters.
