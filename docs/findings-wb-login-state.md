# WorkBuddy international vs domestic: shared state and credential-key collision

Read-only forensic investigation on the live machine (`KMBP`, Apple Silicon, macOS 26.5.1,
machine date 2026-09-17, session start 00:26 CST). Nothing was written, moved, chmod-ed or
deleted except this one file. No `security` invocation, no keychain read. No secret value was
printed, copied, or hashed; `.key` files are reported as filename + size + mtime only, and the
one byte-level comparison performed is reported purely as an identity boolean (see §3).

Legend: **OBSERVED** = directly read from disk/process/code at investigation time.
**INFERRED** = derived by reasoning from observed facts. **NOT DETERMINED** = insufficient
evidence.

---

## Verdict

**Partial — confirmed for connector credentials, not established for the login token itself, and
one latent hazard that would produce exactly "登录失效".** The two apps *do* share one mutable,
credential-bearing, globally-scoped key store: `~/.workbuddy-key-fallback/connector-keys/`, whose
filename is `sha256(userId).hex[0:32]` and therefore **app-independent** — the same logical account
yields the same filename whether the domestic or the international build computes it. Both builds
contain byte-identical code that resolves this path to the *domestic* name (`.workbuddy-key-fallback`,
never `.workbuddy-ai-key-fallback`), and I found a live key in that shared directory that the
international app demonstrably wrote (hash matches the international-only userId). That store backs
`ConnectorOAuthMasterKeyStore`, whose `getExisting()` deliberately overwrites the shared backup with
whichever app's primary key wins, so one app's write can make the other's stored connector
ciphertext (`connector-states.v3.json`, `.credentials.v3.json`) undecryptable. **However**, the
logged-in *session* is not held in that store: it lives in the per-app Chromium profile
(`<configDir>/app/session/`) and `<configDir>/security/<userId>/cipher`, both namespaced by
`WORKBUDDY_CONFIG_DIR`, which I confirmed live (`/Users/example/.workbuddy-ai`) — so I cannot show that
the domestic app makes the international *login* undecryptable. The mechanism that *would* produce
exactly that symptom is real but latent: the international build's fallback when `product.json`
fails to resolve is the hardcoded domestic `.workbuddy`, and its early-startup path demonstrably
already falls back to `~/.workbuddy` (the international app's main-process startup trace was written
into the domestic home). If that fallback ever applies to `app.setPath("userData", …)`, the two apps
would share one Chromium profile and the second one to start would hijack the first one's
Cookies/Local Storage — i.e. "登录失效".

**Confidence:** *high* (≈0.9) on the shared-state map, the path derivations, the hash input, and the
cross-write facts — all are direct code/disk/process evidence. *Medium* (≈0.6) that the domestic app
can actually cause the international app's login loss, because the session store is namespaced and I
found no cross-write into it. *Medium* (≈0.6) that `safeStorage` keychain strings differ (see §4).

---

## Shared vs namespaced state

| location | domestic | international | SHARED / NAMESPACED | evidence |
|---|---|---|---|---|
| config home (`~/.workbuddy` vs `~/.workbuddy-ai`) | `~/.workbuddy` | `~/.workbuddy-ai` | NAMESPACED | OBSERVED both dirs; live env `WORKBUDDY_CONFIG_DIR=/Users/example/.workbuddy-ai` on all 11 intl processes; `product.json dataFolderName=.workbuddy/.workbuddy-ai`; code `resolveWorkbuddyConfigDir() = env \|\| homedir + dataFolderName` |
| `.../connector-keys/` **fallback** master key | `~/.workbuddy-key-fallback/connector-keys/` | identical path | **SHARED** | OBSERVED: `738c629e…` and `e86c0039…` both present there; code in *both* asars: `path.join(os.homedir(), ".workbuddy-key-fallback")`, byte-identical |
| `<configDir>/app` (Chromium userData, `--user-data-dir`) | `~/.workbuddy/app` | `~/.workbuddy-ai/app` | NAMESPACED | OBSERVED live `--user-data-dir=/Users/example/.workbuddy-ai/app`; `~/.workbuddy/app/SingletonLock`; code `app.setPath("userData", getWorkbuddyUserDataDir())` where `userDataDir = env WORKBUDDY_USER_DATA_DIR \|\| <configDir>/app` |
| `<configDir>/app/connector-keys/` (injected backup) | `~/.workbuddy/app/connector-keys/` | `~/.workbuddy-ai/app/connector-keys/` | NAMESPACED | OBSERVED both dirs; code `new ConnectorOAuthStore(uid, { backupBaseDir: getWorkbuddyRuntimeUserDataDir() })` |
| `<configDir>/connectors/<userId>/` | `~/.workbuddy/connectors/f6de4882-…` | `~/.workbuddy-ai/connectors/f6de4882-…`, `…/8486c515-…` | NAMESPACED (same userId in both) | OBSERVED dirs + `.master.key` mtimes |
| `<configDir>/security/<userId>/cipher` | `~/.workbuddy/security/f6de4882-…/cipher` | `~/.workbuddy-ai/security/f6de4882-…/cipher` | NAMESPACED | OBSERVED (names/sizes only) |
| `~/.workbuddy/ioa-im-override.json` | present, 00:07:59 | **`~/.workbuddy-ai/ioa-im-override.json`**, 00:10:20 | NAMESPACED-in-practice / SHARED-by-default | OBSERVED both files; code in both builds is byte-identical and defaults to `~/.workbuddy` |
| `~/Library/Application Support/WorkBuddy/pending-telemetry` | present | **same path** | **SHARED** | OBSERVED (files at 19:01); code `getWorkbuddyPendingTelemetryDir()` = `~/Library/Application Support/<getWorkbuddyAppName()>/pending-telemetry`, and the live env shows `WORKBUDDY_APP_NAME=WorkBuddy` **on the international app too** |
| `~/Library/Application Support/WorkBuddy AI/` | absent | present, empty, 23:47 | NAMESPACED (a *second*, conflicting app-name derivation) | OBSERVED; code `resolveMacInstallChannelDir()` uses `product.productName ?? product.applicationName` |
| `~/Library/Application Support/com.tencent.workbuddy.mac/` | present (TuringShield `.ts_*`) | — | NAMESPACED | OBSERVED; intl counterpart `com.workbuddy.workbuddy-ai` **does not exist** |
| `~/Library/Preferences/com.tencent.workbuddy.mac.plist` | present (00:08) | — | NAMESPACED | OBSERVED; bundle id differs |
| `~/Library/Preferences/com.workbuddy.workbuddy-ai.plist` | — | present (00:10) | NAMESPACED | OBSERVED; = intl `CFBundleIdentifier` |
| `~/Library/Preferences/com.workbuddy.workbuddy.plist` | present | **same file** | **SHARED** | OBSERVED; both bundles ship `WorkBuddy Legacy Auto Launch Cleaner.app` with the *identical* `CFBundleIdentifier=com.workbuddy.workbuddy` |
| `~/Library/Preferences/com.workbuddy.repair.plist` | present | **same file** | **SHARED** | OBSERVED; both bundles ship `WorkBuddy Repair.app` with identical `CFBundleIdentifier=com.workbuddy.repair` |
| `~/Library/Caches/com.tencent.workbuddy.mac` | present (00:08) | — | NAMESPACED | OBSERVED; no `com.workbuddy.workbuddy-ai` cache dir exists |
| `~/Library/Caches/com.workbuddy.workbuddy` | present (helper) | **same dir** | **SHARED** | OBSERVED; shared cleaner-helper bundle id |
| `~/Library/HTTPStorages/com.tencent.workbuddy.mac` | present (00:07) | — | NAMESPACED | OBSERVED |
| `~/Library/HTTPStorages/com.workbuddy.workbuddy` | present | **same dir** | **SHARED** | OBSERVED; shared cleaner-helper bundle id |
| `~/Library/WebKit/com.tencent.workbuddy.mac` | present | — | NAMESPACED (domestic-only) | OBSERVED; no intl WebKit dir |
| `~/Library/Containers/com.tencent.workbuddy.mac.WechatShare` | present | — | NAMESPACED (domestic-only) | OBSERVED; no intl container |
| `~/Library/Saved Application State/*` | none | none | n/a | OBSERVED |
| `~/Library/Group Containers/*` | none | none | n/a | OBSERVED |
| `~/Library/Logs/WorkBuddy` | present (last write 19:01) | **same path by code** | **SHARED by default**, namespaced in practice | OBSERVED `~/Library/Logs/WorkBuddy` and no `…/WorkBuddy AI`; code `resolveLogDir() = ~/Library/Logs/<WORKBUDDY_APP_NAME \|\| "WorkBuddy">`; the app overrides it with `setAppLogsPath(<configDir>/logs)` |
| `~/.workbuddy/logs/startup/` | domestic traces | **intl traces too** | **SHARED (cross-write, proven)** | OBSERVED `~/.workbuddy/logs/startup/2026-09-17/63779-001019.jsonl` whose records carry `pid 63779`, and pid 63779 = `/Applications/WorkBuddy AI.app/Contents/MacOS/Electron` |
| `~/WorkBuddy` vs `~/WorkBuddy AI` | `~/WorkBuddy` (Aug 7…) | `~/WorkBuddy AI` (Sep 16 23:47…) | NAMESPACED | OBSERVED; code `getSystemDefaultWorkspaceRoot() = ~/<appNameProvider()>` = `electron.app.name` |
| `/tmp/WorkBuddy_<16hex>.sock` (`ipcAddress`) | `WorkBuddy_…` | `WorkBuddy_…` (same prefix) | prefix SHARED, suffix random → effectively NAMESPACED | OBSERVED ~19 stale sockets; code `_generateIpcAddress(){ crypto.randomBytes(8).toString("hex") } → \`WorkBuddy_${hex}\`` — prefix hardcoded, not app-derived |
| `/tmp/workbuddy-sandbox-center-<fnv64>.sock` | `…b0ef6e021ba80a4c…` | `…a9ff45a414b250ad…` | NAMESPACED (hash of appHome) | recomputed FNV-1a-64 of `/Users/example/.workbuddy` → `b0ef6e021ba80a4c` and of `/Users/example/.workbuddy-ai` → `a9ff45a414b250ad`; both `.sock`/`.lock` present on disk |
| `/var/folders/…/T/workbuddy-host-cli/`, `…/workbuddy-prompt-vars`, `…/workbuddy-localstorage-*`, `…/workbuddy-pac-*`, `…/workbuddy-product-spill-*` | fixed shared prefixes | same | **SHARED** (fixed names) / distinct for `product-spill-*` | OBSERVED all present; no app token in any name |
| `/var/folders/…/T/com.tencent.workbuddy.mac`, `com.apple.WebKit.*+com.tencent.workbuddy.mac` | present | — | NAMESPACED (domestic-only) | OBSERVED; no intl equivalents (intl runs under `scoped_dir*` because of `--user-data-dir`) |
| deep-link URL schemes | `workbuddy` | `workbuddy-ai` | NAMESPACED | OBSERVED `CFBundleURLSchemes` / `product.json urlProtocol`; note both builds hardcode `DEFAULT_DEEPLINK_SCHEMES=["workbuddy"]` as the fallback |
| keychain `safeStorage` entry | `<app.name> Safe Storage` / account `<app.name>` | same formula, different `app.name` | NAMESPACED *if* `app.name` is bundle/product-derived (see §4) | code strings only; keychain not read |

### The two independent "app name" notions (root of the confusion)

`electron.app.name` and the internal `WORKBUDDY_APP_NAME` **disagree inside the international app**:

- `electron.app.name` → **"WorkBuddy AI"** (from `package.json` `productName`). OBSERVED indirectly: the
  intl app created `~/WorkBuddy AI/` and `~/.workbuddy-ai/projects/Users-king-WorkBuddy AI-2026-09-17-00-05-03/`.
- `WORKBUDDY_APP_NAME` → **"WorkBuddy"** (domestic brand). OBSERVED directly in the live environment
  of all intl child processes (`ps eww`), and the code that injects it is
  `WORKBUDDY_APP_NAME: getWorkbuddyAppName()`, where `getWorkbuddyAppName()` returns
  `env.WORKBUDDY_APP_NAME || deriveDefaultAppName()` and `deriveDefaultAppName()` returns the
  **hardcoded** `DEFAULT_APP_NAME = "WorkBuddy"` (`/main/workbuddy-paths.js`, byte-identical in both
  builds). INFERRED: the main process evaluates that expression *before*
  `ensureWorkbuddyBootstrapProductEnv()` sets the env from `product.productName`, so the hardcoded
  domestic default is frozen into every child's environment. Everything that consumes
  `getWorkbuddyAppName()` therefore collides across the two apps.

---

## The key-fallback store

### Path derivation

Both builds ship **byte-identical** code for `ConnectorOAuthMasterKeyStore`
(domestic copy: `/main/axios2.js` @~108.77 MB; international copy: `/main/application-manifest.js`
@~109.52 MB — different container file, identical text):

```js
const primaryDir   = opts.primaryDir   ?? path.join(os.homedir(), ".workbuddy", "connectors", opts.userId);
const backupBaseDir= opts.backupBaseDir?? path.join(os.homedir(), ".workbuddy-key-fallback");
this.primaryPath   = path.join(primaryDir, ".master.key");            // PRIMARY_FILE_NAME
this.backupPath    = path.join(backupBaseDir, "connector-keys", `${hashUserId(opts.userId)}.key`); // BACKUP_DIR_NAME
```

Priority order documented in the same module: **(1)** explicitly injected `backupBaseDir`
(production daemon / tests) → **(2)** `<homeDir>/.workbuddy-key-fallback/` → **(3)**
`os.homedir()/.workbuddy-key-fallback/`. The `~/.workbuddy-ai` token appears **nowhere** in this
module in either build.

Two call paths exist, and they disagree:

- **Electron/desktop (injected):** `get store() { … new ConnectorOAuthStore(userId, { backupBaseDir:
  require_runtime_context.getWorkbuddyRuntimeUserDataDir() }) }` → `<configDir>/app` → namespaced.
  OBSERVED on disk: `~/.workbuddy-ai/app/connector-keys/738c…key`.
- **Daemon/CLI (un-injected):** `masterKeyBackupBaseDir: options?.backupBaseDir ?? (options?.homeDir ?
  path.join(options.homeDir, ".workbuddy-key-fallback") : undefined)` → `undefined` reaches
  `ConnectorOAuthMasterKeyStore`, which uses `os.homedir()/.workbuddy-key-fallback`. OBSERVED on disk:
  `~/.workbuddy-key-fallback/connector-keys/` containing keys for **two different userIds**, one of
  which belongs to the international app.

### Filename hashing scheme and hash input — RECOVERED

```js
function hashUserId(userId) {
  return crypto.createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32);
}
```

- algorithm: **SHA-256**, input: the **`userId` string, UTF-8**, output: **first 32 hex chars** →
  filename `<32hex>.key`.
- The code is byte-identical in both builds.
- **Hash input confirmed by reproduction** (`python3 hashlib`), against the userIds that appear as
  plain directory names on this machine:

  | userId (plain, from `connectors/<uid>/`) | sha256(uid)[:32] | observed `.key` filename |
  |---|---|---|
  | `f6de4882-ef5d-4669-8944-3b1e24e40051` | `738c629ee09fada4231c31e5787d95a6` | `738c629ee09fada4231c31e5787d95a6.key` ✅ |
  | `8486c515-c28b-4a71-9849-a7cf4d3f5969` | `e86c0039412d4105a09900a73b9afea9` | `e86c0039412d4105a09900a73b9afea9.key` ✅ |

  Both matches are exact, so the hash input is **`userId`**, not the app id, not a connector id, not
  a per-app salt. (`userId` is an account identifier already exposed as a plain directory name on
  disk, so reproducing this hash leaks no secret.)

> Note a documentation defect in the module: the header comment says
> `backup: <backupBaseDir>/connector-keys/<sha256(userId).slice(0,16)>.key`, but the code — and every
> key on disk — uses `.slice(0,32)`. The code is authoritative.

### Collision verdict — **CONFIRMED (mechanism + live artifact); not yet materialized as a break**

Yes: the two apps compute **the same filename for the same logical connector owner**, and they
compute it from a path that is not app-scoped whenever `backupBaseDir` is not injected. Evidence:

1. **Identical filename in three directories** (OBSERVED): `738c629ee09fada4231c31e5787d95a6.key`
   exists at `~/.workbuddy-key-fallback/connector-keys/`, `~/.workbuddy/app/connector-keys/` and
   `~/.workbuddy-ai/app/connector-keys/`.
2. **Identical key material** (OBSERVED, identity boolean only — no content printed, no digest
   computed): `cmp -s` reports the 32-byte files at all three paths as identical, and
   `~/.workbuddy/connectors/f6de4882-…/.master.key` identical to
   `~/.workbuddy-ai/connectors/f6de4882-…/.master.key`. So the international app is currently using
   the **same** master key as the domestic app for the same userId — i.e. the two apps' connector
   ciphertext is cross-readable. mtimes: fallback copy **2026-08-07 00:34:13** (domestic install era),
   `~/.workbuddy/app` copy **2026-08-07 00:35:49**, `~/.workbuddy-ai/app` copy
   **2026-09-16 23:53:47**. INFERRED: since the intl copies were *born* 2026-09-16 23:53:47 yet hold
   the *Aug-7* key bytes, the international app must have **adopted the domestic key from a shared
   location** (`~/.workbuddy-key-fallback`, or a read of the domestic home) rather than calling
   `getOrCreate()` (whose `crypto.randomBytes(32)` would have produced different bytes). The module's
   own recovery logic (`recovered-primary-from-backup` / `loaded-from-backup`) is exactly that path.
3. **The shared fallback is live and written by the international app** (OBSERVED):
   `~/.workbuddy-key-fallback/connector-keys/e86c0039412d4105a09900a73b9afea9.key`, 32 bytes, mtime
   **2026-09-16 23:48:43**; its hash input `8486c515-…` exists only under the **international** home
   (`~/.workbuddy-ai/connectors/8486c515-…/.master.key`, same second 23:48:43), and the intl app had
   been running since 23:47. The containing directory was created 2026-08-07 (domestic era) and is
   still named `workbuddy`, not `workbuddy-ai`.

**The overwrite condition** (from the byte-identical module code, INFERRED as a mechanism):

- `getExisting()` → if primary and backup both exist and **differ**, it writes primary over the
  backup (`tryWriteKey(this.backupPath, primary)`, diagnostic `mismatch-primary-wins`).
- If primary is absent but the **shared** backup exists, it copies the shared backup **into** its own
  primary (`recovered-primary-from-backup`).

So: app A writes its key to `<configDir_A>/connectors/<uid>/.master.key` **and** to the shared
fallback. App B, whose own primary is missing (fresh install, `~/.workbuddy-ai` cleanup, profile
reset, or an early-startup call before `backupBaseDir` is injected), silently adopts A's master key
as its own, then cannot decrypt ciphertext it wrote under a different key — the app's own docstring
calls this out as the thing that "误触发重新授权". Because the AES key is derived via HKDF from
`masterKey` **and** `userId`, a wrong master key means undecryptable, not merely wrong. The failure
mode is therefore *connector-credential loss / forced re-authorization*; the module that owns it is
`ConnectorOAuth*`, **not** the auth/session module.

**Residual uncertainty for this section:** I did not (and must not) compare key *bytes* beyond the
identity boolean, and I did not read ciphertext, so I cannot state which of the two apps' current
connector payloads is the one at risk. `NOT DETERMINED`: whether the shared fallback was ever read
by a `getExisting()` call that then diverged the two primaries. Settling that needs the daemon log
lines containing `[oauth-master-key]` / `[oauth-persistence] loadOrCreateMasterKey failed` /
`diagnostics.action` values over time — see §What would settle.

---

## Session persistence and keychain service strings

### How the logged-in session is persisted (per app, from code + disk)

| aspect | domestic | international |
|---|---|---|
| Chromium profile (Cookies, Local Storage, Session Storage) | `<configDir>/app/session/` = `~/.workbuddy/app/session/` | `<configDir>/app/session/` = `~/.workbuddy-ai/app/session/` |
| `Cookies` SQLite rows (`select count(*) from cookies`, ro) | **2** | **0** |
| session id store (`app/sessions.json`) | `~/.workbuddy/app/sessions.json`, 2995 B, 2026-09-11 | absent (intl equivalent not created) |
| credential cipher dir | `~/.workbuddy/security/f6de4882-…/cipher` | `~/.workbuddy-ai/security/f6de4882-…/cipher` |
| legacy path | `createElectronHostAuth().decryptLegacyAuthSession()` → `electron.safeStorage.decryptString(...)` | same code (byte-identical module) |

OBSERVED: the intl app's `Cookies` DB has **0** rows while the user is logged in via Google OAuth,
so the live international session is **not** primarily a Chromium cookie — it is held under
`<configDir>/security/<userId>/cipher` and/or the daemon-side auth store, both keyed by `configDir`.
`NOT DETERMINED`: the exact file/format holding the intl bearer token — I deliberately did not open
anything that could contain a token beyond SQLite schema/row counts.

`safeStorage` is therefore reached only on the **legacy** migration path
(`decryptLegacyAuthSession`), which means a `safeStorage`/keychain collision is *not* the primary
explanation for the current login architecture.

### What each app's "app name" resolves to

| name source | domestic | international | note |
|---|---|---|---|
| `package.json` `productName` | `WorkBuddy` | `WorkBuddy AI` | OBSERVED (asar `package.json`) |
| `package.json` `name` | `@genie/workbuddy-desktop` | `@genie/workbuddy-desktop` | **identical in both** |
| `Info.plist` `CFBundleName` / `CFBundleDisplayName` | `WorkBuddy` | `WorkBuddy AI` | OBSERVED |
| `Info.plist` `CFBundleExecutable` | `Electron` | `Electron` | **identical in both** |
| `Info.plist` `CFBundleIdentifier` | `com.tencent.workbuddy.mac` | `com.workbuddy.workbuddy-ai` | OBSERVED |
| `--user-data-dir` basename | `app` | `app` | **identical in both** |
| `product.json` `applicationName` | `WorkBuddy` | `workbuddy-ai` | OBSERVED (unpacked `cli/product.json`) |
| `product.json` `productName` | `WorkBuddy` | `WorkBuddy AI` | OBSERVED |
| `WORKBUDDY_APP_NAME` (env, live) | `WorkBuddy` | **`WorkBuddy`** | OBSERVED via `ps eww` — **COLLIDES** |
| `electron.app.name` (inferred from artifacts) | `WorkBuddy` | `WorkBuddy AI` | INFERRED from `~/WorkBuddy` vs `~/WorkBuddy AI` |

### Keychain service/account strings

- **Derivation (code evidence):** the Electron framework binary contains the literal
  `" Safe Storage"` inside the string table adjacent to
  `../electron/shell/browser/electron_browser_main_parts.cc` and `make_unique`
  (offset 135635876 in `/Applications/WorkBuddy AI.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
  Electron **37.10.3**). Chromium's own defaults `"Chromium Safe Storage"` / `"Chromium"` are also
  present (offset 156609209), and `components/os_crypt/sync/keychain_password_mac.mm` is referenced.
  This is consistent with Electron's documented behaviour: service `"<app name> Safe Storage"`,
  account `"<app name>"` ([Electron safeStorage docs](https://electronjs.org/docs/latest/api/safe-storage),
  [electron#45328](https://github.com/electron/electron/issues/45328)).
- **`app.name` for each app:** domestic `WorkBuddy`, international `WorkBuddy AI` — from
  `package.json` `productName` (Electron's default app name), corroborated by the observed
  `~/WorkBuddy` vs `~/WorkBuddy AI` workspace roots.
- **Verdict:** the two strings are **different**
  (`"WorkBuddy Safe Storage"` / account `"WorkBuddy"` vs `"WorkBuddy AI Safe Storage"` / account
  `"WorkBuddy AI"`) → **NOT a confirmed collision point.** Confidence *medium*, not high, for one
  concrete reason: **both bundles have `CFBundleExecutable = "Electron"` and the same
  `--user-data-dir` basename (`app`)**, so any code path that falls back to the executable/process
  name instead of the bundle display name would make both apps compute the *same* string, and
  Electron's own issue [#34614](https://github.com/electron/electron/issues/34614) documents a real
  fallback to the generic `"Chromium Safe Storage"` service when `safeStorage` is used very early.
  I could not disassemble the stripped framework far enough to pin which source
  `electron_browser_main_parts.cc` uses, and I am forbidden from reading the keychain to check which
  entries actually exist.
- **Security-relevant aside (OBSERVED, likely unrelated to the symptom):** both apps' prefs contain a
  TuringShield keychain opt-out —
  `~/Library/Preferences/com.workbuddy.workbuddy-ai.plist`: `0.ts.BASEOS0..settings.KeyChainAccessDisabled = true`,
  `ts.BASEOS0..settings.KeyChainAccessAllowed = false`; domestic
  `~/Library/Preferences/com.tencent.workbuddy.mac.plist`:
  `0.com.tencent.TuringShield..settings.KeyChainAccessDisabled = true` (×2 domains),
  `com.tencent.TuringShield..settings.KeyChainAccessAllowed = false`. These live in **different
  NSUserDefaults domains**, so they are namespaced; the `KeyChainAccess*` strings do not appear
  anywhere in either `app.asar`, so they originate in the native `TuringShield.bundle`. I did not
  determine whether that flag can suppress the `safeStorage` keychain entry.

---

## Single-instance / IPC names

### Chromium `Singleton*` — NAMESPACED (safe)

| file | domestic | international |
|---|---|---|
| `…/app/SingletonLock` | `KMBP-59571` | `KMBP-63779` |
| `…/app/SingletonCookie` | `3418749454600796939` | `5003567669564930566` |
| `…/app/SingletonSocket` | `/var/folders/71/…/T/scoped_dirFxmi5N/SingletonSocket` | `/var/folders/71/…/T/scoped_dirurBpKw/SingletonSocket` |
| mtime | 00:07 | 00:10 |

`app.requestSingleInstanceLock()` is used (`/main/app-instance.js`, `acquireSingletonLock()`), but the
lock file lives in `userData`, and `app.setPath("userData", getWorkbuddyUserDataDir())` resolves to
different directories today → the two apps do **not** contend for a single-instance lock. **This
namespacing is entirely a consequence of `getWorkbuddyUserDataDir()` returning the right config dir**
— see the latent hazard in §Verdict.

### `ipcAddress` — prefix collides, suffix does not

Recovered from
`/Applications/{WorkBuddy,WorkBuddy AI}.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy.js`
(the two files **differ** — 23,318,379 vs 23,499,756 bytes — but this function is textually identical):

```js
_generateIpcAddress() {
  let eA = cS.randomBytes(8).toString("hex");
  return `WorkBuddy_${eA}`;
}
_buildStartConfig(eA) {
  let el = cI.PathUtils.getRootPathSync();
  let ec = [cQ.join(el, "bin", "runtime", "git", "bin")];
  …
  return { extraPath: ec, enableGlobalProjection: !1, ipcAddress: eA };
}
```

- The `WorkBuddy_` prefix is a **hardcoded domestic-branded literal** (not derived from
  `applicationName`), so the observed `ipcAddress=WorkBuddy_920cc44512b903b6` carries no
  `workbuddy-ai` token.
- The suffix is **8 random bytes**, so the domestic app computes a *different* name each run.
  `WorkBuddy_920cc44512b903b6` is therefore **not** reproducible and **not** a shared name — one app
  cannot hand work off to the other through it. OBSERVED `/tmp/WorkBuddy_*.sock`: ~19 stale sockets
  spanning Aug 28 – Sep 17 from both apps, with `WorkBuddy_920cc44512b903b6.sock` (00:11) belonging
  to the international app.
- **Relate `ipcAddress` is NOT the `--user-data-dir` basename and NOT `app.getName()`** — it is a
  per-spawn random token prefixed with the domestic brand string.

### `sandbox-cli` control socket — namespaced by an FNV-1a-64 hash of appHome (verified)

`resolveSandboxCenterSocketPath(appHome)` in the same bundle:

```js
let ec = 0xcbf29ce484222325n;
for (let el of Buffer.from(eA, "utf8")) ec ^= BigInt(el), ec = BigInt.asUintN(64, 1099511628211n * ec);
let eu = ec.toString(16).padStart(16, "0");
return process.platform === "win32"
  ? `\\\\.\\pipe\\WorkBuddy_SandboxCenter_${eu}`
  : `/tmp/workbuddy-sandbox-center-${eu}.sock`;
```

I recomputed the FNV-1a-64 of the two live `--app_home` values and matched them to real sockets:

| `--app_home` | recomputed hash | `/tmp/workbuddy-sandbox-center-<hash>.sock` present? |
|---|---|---|
| `/Users/example/.workbuddy` | `b0ef6e021ba80a4c` | yes (+ `.lock`, 00:08) |
| `/Users/example/.workbuddy-ai` | `a9ff45a414b250ad` | yes (+ `.lock`, 00:10) |

→ NAMESPACED, but **only because `appHome` differs**; the prefix again is a fixed domestic-branded
`workbuddy-sandbox-center-`.

### Helper bundle identifiers — SHARED (two of them)

Both bundles ship helpers with **identical** `CFBundleIdentifier`s:

| helper | domestic id | international id | shared? |
|---|---|---|---|
| `WorkBuddy Helper(.GPU/.Plugin/.Renderer).app` | `com.tencent.workbuddy.mac.helper…` | `com.workbuddy.workbuddy-ai.helper…` | no |
| `WorkBuddy Legacy Auto Launch Cleaner.app` | `com.workbuddy.workbuddy` | `com.workbuddy.workbuddy` | **YES** |
| `WorkBuddy Repair.app` | `com.workbuddy.repair` | `com.workbuddy.repair` | **YES** |

Consequence (OBSERVED): `~/Library/Preferences/com.workbuddy.workbuddy.plist` and
`~/Library/Preferences/com.workbuddy.repair.plist`, plus `~/Library/Caches/com.workbuddy.workbuddy`
and `~/Library/HTTPStorages/com.workbuddy.workbuddy`, are **shared mutable state** between the two
installations. Note the international bundle still ships helpers branded `WorkBuddy`, not
`WorkBuddy AI`.

---

## Cross-write timeline

All times 2026-09-17 CST (machine clock; app logs are UTC = −8 h).

| time | actor | evidence |
|---|---|---|
| 23:47:47 | **intl** first launch layout | `~/Library/Application Support/WorkBuddy AI/` created; `~/WorkBuddy AI/…` |
| 23:47:52 | intl (pid 32354) | `~/.workbuddy-ai/logs/startup/2026-09-16/32354-234747.jsonl` **and** `~/.workbuddy/logs/startup/2026-09-16/32354-234747.jsonl` — same pid in both homes |
| 23:48:43 | **intl** writes the domestic-named shared fallback | `~/.workbuddy-key-fallback/connector-keys/e86c0039412d4105a09900a73b9afea9.key` born, twinned with `~/.workbuddy-ai/connectors/8486c515-…/.master.key` (same second); `sha256("8486c515-…")[:32] = e86c0039…` |
| 23:53:47 | **intl** adopts the Aug-7 domestic master key | `~/.workbuddy-ai/app/connector-keys/738c629e…key` and `~/.workbuddy-ai/connectors/f6de4882-…/.master.key` both *born* here, bytes identical to the domestic Aug-7 copies |
| 00:05:04–00:06 | intl workspace/session bootstrap | `~/.workbuddy-ai/{BOOTSTRAP,IDENTITY,SOUL,USER}.md`, `workspace-state.json`, `projects/Users-king-WorkBuddy AI-2026-09-17-00-05-03/` |
| 00:06:47 | intl (pid 56116) | `~/.workbuddy-ai/logs/startup/2026-09-17/56116-000647.jsonl` **and** `~/.workbuddy/logs/startup/2026-09-17/56116-000647.jsonl` |
| 00:06:48 | intl daemon + domestic-home write | `~/.workbuddy/logs/startup/2026-09-17/…`; `~/.workbuddy/connectors/f6de4882-…` touched |
| 00:07:55–00:08:07 | **domestic** run (pid 59571, `SingletonLock → KMBP-59571`) | `~/.workbuddy/app/{renderer-version.json 5.5.6, session/, playbook-covers/}`, `~/.workbuddy/{last-launch.json v5.5.6, ioa-im-override.json, user-state.json}`, `~/Library/Preferences/com.tencent.workbuddy.mac.plist` (00:08:06) |
| 00:10:18 | **intl** main process starts | pid 63779; `~/.workbuddy-ai/app/SingletonLock → KMBP-63779` |
| 00:10:19–00:10:20 | **intl writes into the domestic home** | `~/.workbuddy/logs/startup/2026-09-17/63779-001019.jsonl` (9051 B, 00:10:20) — records carry `pid 63779`, and pid 63779 is `/Applications/WorkBuddy AI.app/Contents/MacOS/Electron` |
| 00:10:19–00:10:26 | intl own state | `~/.workbuddy-ai/app/{app-config.json, renderer-version.json 5.5.2, session/, window-state.json}`; `~/.workbuddy-ai/ioa-im-override.json`; `~/Library/Preferences/com.workbuddy.workbuddy-ai.plist` (00:10:26) |
| 00:10:43 | **domestic** final writes before exit | `~/.workbuddy/app/{memory, window-state.json}`, `~/.workbuddy/{workbuddy.db, sessions, shell-snapshots}`; pid 59571 no longer alive at 00:26 |
| 00:26+ | intl only | all live WorkBuddy processes are `WorkBuddy AI.app` |

### The cross-write, stated precisely

The two startup traces for the **same run** (pid 63779) are **different files with disjoint
phase sets**, which rules out a copy:

| file | phases | `source` values |
|---|---|---|
| `~/.workbuddy/logs/startup/2026-09-17/63779-001019.jsonl` (domestic home) | `A_process`, `B_bootstrap`, `C_window`, `F_daemon` | `main` ×30, `daemon-rpc` ×6 |
| `~/.workbuddy-ai/logs/startup/2026-09-17/63779-001019.jsonl` (intl home) | `D_preload`, `E_renderer`, `F_daemon` | `daemon` ×13, `preload` ×5, `renderer` ×13 |

So the **international app's main process** writes its early startup trace under
`~/.workbuddy/logs/startup/`, while its child processes (which inherit
`WORKBUDDY_CONFIG_DIR=/Users/example/.workbuddy-ai`) write under `~/.workbuddy-ai/logs/startup/`. The
same split exists for the 23:47 (pid 32354) and 00:06 (pid 56116) intl runs, while the domestic run
(pid 59571) appears **only** in `~/.workbuddy`. This is a **confirmed cross-namespace write by the
international app into the domestic app's home**, and it is direct evidence that at least one early
intl code path resolves the config dir to the hardcoded domestic default before
`WORKBUDDY_CONFIG_DIR` / `product.json dataFolderName` is applied.

The code that makes the fallback possible:

```js
function resolveWorkbuddyDataFolderName() {
  const dataFolderName = tryGetWorkbuddyBaseProductConfiguration()?.dataFolderName;
  return typeof dataFolderName === "string" && dataFolderName.trim() ? dataFolderName.trim() : ".workbuddy";
}
function resolveWorkbuddyConfigDir() {
  const envDir = process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), resolveWorkbuddyDataFolderName());
}
```

and, in `/main/app-instance.js` (byte-identical in both builds):

```js
process.env.WORKBUDDY_APPLICATION_NAME = applicationName?.trim() || "workbuddy";
electron.app.setPath("userData",     require_workbuddy_paths.getWorkbuddyUserDataDir());
electron.app.setPath("sessionData",  require_workbuddy_paths.getWorkbuddySessionDataDir());
electron.app.setAppLogsPath(require_workbuddy_paths.getWorkbuddyLogsDir());
```

If `tryGetWorkbuddyBaseProductConfiguration()` throws (it is wrapped in `try/catch` and returns
`undefined` on any failure), the international app's `userData` becomes **`~/.workbuddy/app`** — the
domestic Chromium profile — and the two apps then share `Cookies`, `Local Storage`, `sessions.json`
and the `SingletonLock`. **No such userData cross-write is observed today** (the `Singleton*` files
are per-home and `window-state.json` contents differ, `isFullScreen:true` domestic vs `false` intl),
so this remains a *latent* hazard rather than a realized one.

---

## What would settle the remaining unknowns

1. **Can the domestic app break the international app's *login*?** Read (or ask the user to read)
   the intl `main.log` / `daemon.log` under `~/.workbuddy-ai/logs/` for `auth` / `session` /
   401 / `unauthorized` / `token` lifecycle lines around 00:10, and check whether the intl app
   reported a *session* failure or only a *connector* failure. That single distinction decides
   between "connector re-auth prompt" and the reported "登录失效".
2. **Which file holds the intl bearer token?** Inventory `~/.workbuddy-ai/security/<uid>/cipher`
   (filenames + sizes) and `~/.workbuddy-ai/app/sessions.json`'s existence, plus daemon-side auth
   store paths from `~/.workbuddy-ai/logs/daemon.log`. That establishes whether the session is under
   `configDir` (namespaced → domestic app cannot break it) or somewhere shared.
3. **Did a `getExisting()` divergence already happen?** Grep the daemon logs for
   `[oauth-master-key]`, `[oauth-persistence]`, `mismatch-primary-wins`,
   `recovered-primary-from-backup`, `recovered-backup-from-primary`, and for the ABSOLUTE paths
   logged by `buildDiag()`. Presence of `mismatch-primary-wins` proves an actual key overwrite.
4. **safeStorage keychain service strings.** Two options, both outside my mandate: (a) read the
   keychain entries' *names* only (`security dump-keychain` / Keychain Access) — forbidden here;
   (b) disassemble `ElectronBrowserMainParts` around the `" Safe Storage"` literal
   (`otool -tV` / Hopper) to see whether the product name comes from `CFBundleName`,
   `CFBundleDisplayName`, or the executable/process name. The latter is the decisive experiment for
   §4, and it matters because both bundles share `CFBundleExecutable=Electron`.
5. **Whether the early intl default-path write can reach `userData`.** Instrument or trace
   `app.setPath("userData", …)` in the international build (e.g. launch with
   `ELECTRON_ENABLE_LOGGING=1` and an unreadable/renamed `cli/product.json`) to see whether it falls
   back to `~/.workbuddy/app`. If it does, the two apps will share one Chromium profile and the
   second to start will evict the first — the exact "登录失效" mechanism.
6. **Which app wrote `~/.workbuddy/app/{memory,window-state.json}` at 00:10:43.** A launch where
   only one app runs at a time (isolating the domestic app, then watching for writes to
   `~/.workbuddy/app/session/`) would attribute those files unambiguously; the current evidence is
   ambiguous because both apps were alive in the 00:10:14–00:10:43 window.

---

## Commands run

Investigation was read-only. Grouped as executed.

**Bundle / metadata**

```
date; pwd
ls -la /Applications/ | grep -i workbuddy
ls -la "/Applications/WorkBuddy.app/Contents/Resources/"
ls -la "/Applications/WorkBuddy AI.app/Contents/Resources/"
plutil -p "<app>/Contents/Info.plist" | grep -Ei 'CFBundleIdentifier|CFBundleName|CFBundleDisplayName|CFBundleExecutable|CFBundleShortVersionString|CFBundleURLSchemes|CFBundleURLName'
plutil -extract CFBundleIdentifier raw "<helper>.app/Contents/Info.plist"   # per helper, both bundles
plutil -p "/Applications/…/Electron Framework.framework/Versions/A/Resources/Info.plist" | grep -E 'CFBundleIdentifier|CFBundleName|CFBundleVersion'
ls "/Applications/WorkBuddy AI.app/Contents/Frameworks/"; ls "/Applications/WorkBuddy.app/Contents/Frameworks/"
find "/Applications/WorkBuddy.app/Contents" -maxdepth 3 -name "product*.json"
find "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked" -maxdepth 3
ls -la "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/"
# product.json keys (read-only, json.load) for both cli/product.json files
```

**asar extraction** — no helper file was written; all readers were `python3 - <<'PYEOF'` heredocs on
stdin that parse the uncompressed asar header (`uint32 4`, `uint32 headerSize`, `uint32 stringSize`,
JSON at offset 16, data base `8 + headerSize`) and `raw_decode` the directory table:

```
# list / locate / extract by path, and map absolute asar byte offsets -> containing file
python3 - <<'PYEOF'  # Asar class: header parse, walk(), read(relpath), locate(goff)
python3 - <<'PYEOF'  # idem, printing /main/*.js source regions and diffs
```

**Code greps performed on the extracted modules (domestic /main/axios2.js, /main/application-manifest.js;
intl /main/application-manifest.js, plus both builds' /main/{workbuddy-paths,runtime-context,workbuddy-product-config,
app-instance,dev-env-override,ioa-im-override,index,server,common,launch-args,fs-protection,
host-power-events,daemon-app-server-main}.js):** patterns
`key-fallback`, `hashUserId`, `connector-keys`, `createHash`, `.master.key`, `safeStorage`,
`requestSingleInstanceLock`, `second-instance`, `--user-data-dir`, `setPath("userData"`,
`appendSwitch`, `getWorkbuddyRuntimeUserDataDir`, `ensureWorkbuddyBootstrapProductEnv`,
`ensureWorkbuddyCustomAppNameEnv`, `ensureWorkbuddyCustomUserDataDirEnv`, `dataFolderName`,
`applicationName`, `WORKBUDDY_APP_NAME`, `resolveSandboxCenterSocketPath`, `ioa-im-override`,
`KeyChainAccess*`.

**Unpacked CLI bundles**

```
grep -rl 'ipcAddress' "<app>/Contents/Resources/app.asar.unpacked"
grep -rl 'WorkBuddy_'   "<app>/Contents/Resources/app.asar.unpacked"
cmp -s "<domestic>/cli/dist/codebuddy.js" "<intl>/cli/dist/codebuddy.js"
cmp -s "<domestic>/cli/vendor/sandbox/5.5.5/sandbox-cli" "<intl>/cli/vendor/sandbox/5.5.5/sandbox-cli"
python3 - <<'PYEOF'   # context extraction for /ipcAddress/ and /WorkBuddy_/ in codebuddy.js
```

**Framework binary (mmap, read-only)**

```
python3 - <<'PYEOF'   # mmap.find for b'Safe Storage', b'Chromium Safe Storage',
                      # b'keychain_password', b'EncryptString', b'isEncryptionAvailable',
                      # b'CFBundleDisplayName', b'CFBundleName', b'processName', b'localizedName'
```

**Disk enumeration**

```
ls -la ~/.workbuddy ~/.workbuddy-ai ~/.workbuddy-key-fallback
find ~/.workbuddy -maxdepth 4 -name connector-keys -o -name '*.key'
find ~/.workbuddy ~/.workbuddy-ai -maxdepth 4 \( -iname '*credential*' -o -iname '*token*' -o -iname '*auth*' -o -iname '*.v3.json' \)
ls -la ~/Library/{Preferences,Caches,HTTPStorages,Containers,WebKit,"Saved Application State",Logs,"Group Containers","Application Scripts"}
ls -laR ~/Library/Logs/WorkBuddy
ls -la ~/WorkBuddy ~/"WorkBuddy AI"
ls -la /tmp | grep -Ei 'workbuddy'
find /var/folders -maxdepth 5 -iname '*workbuddy*'
find /tmp -maxdepth 3 -iname '*workbuddy*'
stat -f '%N | size=%z | mode=%Sp | mtime=%Sm | birth=%SB' -t '%Y-%m-%d %H:%M:%S' <each .key / .master.key / dir>
find <home> -newermt '2026-09-17 00:05:00' \( -type f -o -type d \) -exec stat -f '%Sm | %N' …
ls -la ~/.workbuddy/app ~/.workbuddy-ai/app ~/.workbuddy/app/session ~/.workbuddy-ai/app/session
head -c N <small non-secret json: app-config.json, renderer-version.json, window-state.json,
          last-launch.json, user-state.json, workspace-state.json, ioa-im-override.json>
```

**Identity comparison (reported as boolean only — no content, no digest)**

```
cmp -s ~/.workbuddy-key-fallback/connector-keys/738c629ee09fada4231c31e5787d95a6.key ~/.workbuddy/app/connector-keys/738c629ee09fada4231c31e5787d95a6.key
cmp -s ~/.workbuddy-key-fallback/connector-keys/738c629ee09fada4231c31e5787d95a6.key ~/.workbuddy-ai/app/connector-keys/738c629ee09fada4231c31e5787d95a6.key
cmp -s ~/.workbuddy/app/connector-keys/738c629ee09fada4231c31e5787d95a6.key ~/.workbuddy-ai/app/connector-keys/738c629ee09fada4231c31e5787d95a6.key
cmp -s ~/.workbuddy/connectors/f6de4882-…/.master.key ~/.workbuddy-ai/connectors/f6de4882-…/.master.key
cmp -s ~/.workbuddy/logs/startup/2026-09-17/63779-001019.jsonl ~/.workbuddy-ai/logs/startup/2026-09-17/63779-001019.jsonl
```

**Hash-input verification** (`hashlib`, on userIds already exposed as directory names)

```
python3 -c "import hashlib; print(hashlib.sha256(b'f6de4882-ef5d-4669-8944-3b1e24e40051').hexdigest()[:32])"
python3 -c "import hashlib; print(hashlib.sha256(b'8486c515-c28b-4a71-9849-a7cf4d3f5969').hexdigest()[:32])"
python3 - <<'PYEOF'   # FNV-1a-64 of the two --app_home values -> sandbox-center socket names
```

**Processes / environment**

```
ps -axo pid,ppid,user,lstart,command | grep -i workbuddy | grep -v grep
ps -axo pid,command | grep -i workbuddy | grep -oE '\-\-user-data-dir=[^ ]*' | sort -u
ps eww -p <pid> | tr ' ' '\n' | grep -E '^(WORKBUDDY_CONFIG_DIR|WORKBUDDY_USER_DATA_DIR|WORKBUDDY_APP_NAME|WORKBUDDY_APP_VERSION|WORKBUDDY_LOCALE|ELECTRON_RUN_AS_NODE|NODE_ENV)='
ps -p 59571 -o pid=,comm= ; ps -p 56116 -o pid=,comm= ; ps -p 63779 -o pid=,comm=
```

**SQLite (read-only, schema/row counts only — never `.dump`, never rows)**

```
sqlite3 "file:$HOME/.workbuddy/app/session/Cookies?mode=ro"    ".tables"
sqlite3 "file:$HOME/.workbuddy/app/session/Cookies?mode=ro"    "select name from sqlite_master where type='table';"
sqlite3 "file:$HOME/.workbuddy/app/session/Cookies?mode=ro"    "select count(*) from cookies;"
sqlite3 "file:$HOME/.workbuddy-ai/app/session/Cookies?mode=ro" (同上)
```

**Plist reads**

```
plutil -p ~/Library/Preferences/com.workbuddy.workbuddy-ai.plist   # key names + bool values only
plutil -p ~/Library/Preferences/com.workbuddy.workbuddy.plist
plutil -p ~/Library/Preferences/com.workbuddy.repair.plist | sed -E 's/=.*//'   # key names only
plutil -p ~/Library/Preferences/com.tencent.workbuddy.mac.plist | grep -iE 'keychain|ts\.|BASEOS'
```

**Log inspection**

```
ls -la ~/.workbuddy/logs/startup/2026-09-17/ ~/.workbuddy-ai/logs/startup/2026-09-17/
head -c 1200 <each *.jsonl>
grep -o -E '"phase":"[^"]*"' … | sort | uniq -c
grep -o -E '"(source|proc)":"[^"]*"' … | sort | uniq -c
grep -c -E '5\.5\.2|workbuddy-ai' ~/Library/Logs/WorkBuddy/main.log
head -c 300 ~/Library/Logs/WorkBuddy/main.log
```

**Explicitly NOT run:** `security` (or any keychain access), any GUI/authentication-blocking command,
any write/move/rename/chmod/delete outside the single deliverable file, `git add`/`commit`,
`.dump` on any SQLite file, and any read of the contents of a `.key`, token, cookie, credential, or
session file.
