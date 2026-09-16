# WorkBuddy international login: what "应用宝" is and what the logs actually show

Read-only forensic investigation. Machine: Apple Silicon, macOS 26.5.1 (25F80), machine clock 2026-09-17.
All timestamps below are **local CST (UTC+08:00)** unless marked `Z`. The WorkBuddy log files store UTC (`Z`), so
the two differ by exactly 8 hours: `15:53:47Z` == `23:53:47 CST`.

**Redaction legend.** Every account UID, session id, device/machine id, nickname and token-like value is replaced
with a placeholder. Two distinct account UIDs appear in this investigation:

- `<acct-A>` — the account the international app first authenticated as, bound to **www.workbuddy.ai**
- `<acct-B>` — the account the international app switched to, bound to **www.workbuddy.cn**

Both are UUID-shaped. Raw values are deliberately not printed (task hard rule: no uid/secret output).

---

## Verdict

The international app **did** authenticate successfully first: an `auth:login` RPC completed at
**23:48:43 CST** (after 46,984 ms), producing account `<acct-A>` bound to the international domain
`www.workbuddy.ai`, and for the next ~5 minutes every backend call succeeded (no HTTP errors at all).
At **23:53:47.5 CST** the app's auth owner switched to account `<acct-B>` — a **domestic-backend** identity
bound to `www.workbuddy.cn` — and **0.8 s later**, at 23:53:48.319, the app began receiving
`Request failed with status code 401` on every backend call, continuously, for the remaining 37+ minutes of
log coverage (still ongoing at the end of collection). The domestic desktop app is **not** implicated as
whatever caused this: it ran for 5 hours as the same domestic account `<acct-B>` on its own separate session
and logged **zero** 401s for its entire run. The observable failure is therefore a *domain/identity mismatch
inside the international app* (a `.cn`-scoped session presented to `.ai` endpoints, rejected at the gateway),
not a server-side "one login kicks the other" policy. Confidence: **high** on *what* failed and *when*
(the before/after boundary is sharp and comes from independent log files); **low** on *how* the `.cn` session
got into the international app; and **none** on "应用宝", which appears in **no** WorkBuddy log on this machine.

---

## What "应用宝" refers to on this machine

### OBSERVED: it is not an installed application

| Check | Result |
|---|---|
| `/Applications` | No `应用宝`, no `yingyongbao`, no `yyb`. Only `Parallels Desktop.app` matched the android/emulator pattern. |
| `~/Applications`, `~/Desktop`, `~/Downloads`, `/opt`, `/usr/local`, `/Volumes` | No match for `yingyongbao`, `yyb`, `应用宝`, `android`, `emulator`, `mumu`, `ldplayer`, `bluestacks`, `nox`. |
| `/Volumes` | Contains **only** `Macintosh HD -> /` (a symlink). No mounted disk images at all. |
| `hdiutil info` | Reports framework/driver version lines only — **no attached images**. |
| Running processes (`ps -eo pid,ppid,etime,command`) | No `yingyongbao`/`yyb`/`android`/`emulator`/`qemu`/`mumu`/`nox`. Only WorkBuddy + WorkBuddy AI. |
| `~/Library/Application Support`, `~/Library/Containers`, `~/Library/Caches`, `~/Library/Logs` | No 应用宝/Android-runtime entry. Tencent entries present are only LemonLite, meeting, qq, WeChat, WorkBuddy, CodeBuddy. |
| `mdfind -name 应用宝` | **0 hits** — and this one *is* meaningful: `mdfind -name WeChat` returns 321 hits and `mdfind -name WorkBuddy` 57, so Spotlight is working here (see the corrected note below). |
| LaunchServices `lsregister -dump` | No `yingyongbao`/`应用宝`/`yyb` registration. |

**CORRECTED — this paragraph originally claimed `mdfind` was broken on this machine. That was wrong, and the
error was the `.app` suffix.** Spotlight stores macOS app display names *without* the extension, so
`mdfind -name WeChat.app` returns 0 while `mdfind -name WeChat` returns 321:

| query | hits | query | hits |
|---|---|---|---|
| `mdfind -name WeChat` | 321 | `mdfind -name WeChat.app` | **0** |
| `mdfind -name Safari` | 210 | `mdfind -name Safari.app` | **0** |
| `mdfind -name WorkBuddy` | 57 | `mdfind -name WorkBuddy.app` | **0** |
| `mdfind -name 应用宝` | **0** | `mdfind -name 应用宝.app` | **0** |

So `mdfind` is healthy here, and `mdfind -name 应用宝` → 0 hits **is** meaningful evidence rather than a silent
failure. 应用宝's absence is therefore supported independently by Spotlight *and* by the direct filesystem /
process / LaunchServices checks above, and confirmed directly by the user: 「没有应用宝，我直接从官网下载的 dmg
安装包」。

### OBSERVED: a local artifact that names it explicitly

`/Users/king/Desktop/marvis/skills/yyb-engine-install/SKILL.md` (1,699 bytes, mtime 2026-06-24) — `yyb` is the
standard abbreviation for 应用宝. Its front-matter and body state:

> `description: "需要安装或更新腾讯应用宝移动应用引擎时，必须使用本skill。"`
> `# 腾讯应用宝移动应用引擎安装/更新流程`
> `1. 调用 mcp_androws_mcp_install_update_yyb 触发安装/更新，获取 task_id。`
> `2. 使用 mcp_androws_mcp_query_task(task_id) 轮询任务状态…`
> `- 第一次调用 mcp_androws_mcp_query_task 时，**必须**向用户输出："操作应用依赖一些必要组件，即将使用腾讯应用宝移动应用引擎为您提供app相关服务。"`

So a locally-recorded meaning of "应用宝" is the **腾讯应用宝移动应用引擎** — an *engine/infrastructure* that
supports running mobile apps, driven from an agent over MCP tools named `mcp_androws_mcp_*`. It is invoked as a
remote/componentised service, not as a `/Applications` bundle. Companion config confirms it is a **router keyword**
rather than a product: in `/Users/king/Desktop/marvis/schemas/routing_signals.yaml` (line 275) `应用宝` sits in a
list beside `企业微信`, `网易云`, `App Store`, `Google Play` under the reason `"app-agent 第三方应用操作"`; in
`schemas/agents.yaml` (line 277) it is a `trigger_keyword` of `app-agent`; and in
`orchestrator/skill_registry.py` (line 198) the skill's `display_name` is `"应用宝引擎安装"` with
`trigger_signals: ["安装引擎", "更新引擎", "应用宝引擎"]`.

Caveat (OBSERVED): the `marvis` project is a personal multi-agent framework whose own logs are stale
(`~/Library/Logs/Marvis/main.log` mtime 2026-08-11) and whose files are dated Jun–Jul 2026. **It was not the
running process during the 23:30–00:20 window**, and it left no trace in that window. Its presence proves what
the word "应用宝" *can* mean on this machine; it does not prove it was what the user opened.

### OBSERVED: 应用宝 appears in no WorkBuddy log

`grep -a '应用宝'` across `~/.workbuddy/logs/**`, `~/.workbuddy-ai/logs/**` and their `main.log`/`renderer.log`
returned **zero hits**. `grep -ri -E 'androws|yingyongbao'` across the same trees likewise returned **zero**.
There is therefore **no local evidence connecting WorkBuddy's authentication state to 应用宝 in any way** —
neither an install, nor a launch, nor a shared credential path.

### Candidate referents for the user's word "应用宝" — evidence for and against

| # | Candidate | Evidence **for** | Evidence **against** |
|---|---|---|---|
| 1 | **The WorkBuddy *mobile* app, distributed via 应用宝** (`com.tencent.workbuddy.app`) | Web evidence is direct: the 应用宝 official store page `sj.qq.com/appdetail/com.tencent.workbuddy.app` is titled "WorkBuddyapp-官方正版软件2026最新版本免费下载-**应用宝官网**". WorkBuddy has a mobile app ([iOS+Android, cloud/remote-PC dual mode](https://cloud.tencent.com/developer/article/2705345)) and multi-device sync across PC/App/mini-program ([Yahoo Finance](https://hk.finance.yahoo.com/news/%E9%A8%B0%E8%A8%8Aworkbuddy%E5%8D%87%E7%B4%9A%E5%A4%9A%E7%AB%AF%E5%90%8C%E6%AD%A5%E5%8A%9F%E8%83%BD-070343898.html)). This is the only candidate that can plausibly move *account identity* between devices and thereby explain the desktop app's auth owner changing. | Nothing in the local logs records a mobile app, a device sync, or an install event. Pure inference. |
| 2 | **The 腾讯应用宝移动应用引擎** (the agent-driven engine) | A verbatim local artifact names it and shows it is driven by MCP tools (`yyb-engine-install/SKILL.md`); it is a router keyword in the user's own agent framework. Explains "打开应用宝" = "invoke the 应用宝 engine" from an agent session rather than launching an app. | It is **not installed** on this machine and is not a process; no log records it being invoked in the window. |
| 3 | **应用宝电脑版 (PC version)** | It exists as a product ([腾讯应用宝电脑版运行设备条件](https://sj.qq.com/faq/368), [应用宝 × Microsoft Store](https://news.microsoft.com/zh-cn/...)). | The product page specifies **Windows 7+** and VT-x, AMD/Intel graphics — a Windows-only desktop program. Nothing matches it on this macOS machine, and no Android runtime (qemu/mumu/nox) is running. |
| 4 | **The domestic WorkBuddy app** (`/Applications/WorkBuddy.app`) — i.e. the user said "应用宝" but meant the domestic version | The domestic app **was** running during the entire window, and the international app did switch to a `.cn`/domestic-scoped identity at the exact moment of failure. Strongest *causal* candidate even though the name does not match. | The name is simply wrong for it; the app presents itself as `WorkBuddy`, bundle id `com.tencent.workbuddy.mac`. No evidence the user conflates the names. |
| 5 | **A phone in the user's pocket** | The word unqualified most often means the phone app store. | Unfalsifiable from this machine; no local evidence either way. |
| 6 | **WeChat / another Tencent channel** | Tencent products share a login system (`iOA`, OneID) and the app has a WeChat share extension (`com.tencent.workbuddy.mac.WechatShare` container). | No WeChat login or auth event appears in the WorkBuddy logs in the window. |

**OBSERVED, plainly:** 应用宝 is **genuinely absent** as an installed application on this Mac. I do **not** know
which of the above the user meant, and I am not going to guess. Candidates 1 and 4 are the ones that can actually
explain the observed failure; candidates 2 and 3 explain why the word appears in this user's environment.

---

## Disk images and duplicate app copies

**OBSERVED.** The LaunchServices database still holds registrations for volume-resident copies, but **no such
volume is mounted**:

| Registered path (from `lsregister -dump`) | Mounted? |
|---|---|
| `/Volumes/WorkBuddy 5.2.3-arm64/WorkBuddy.app/...` | **No** — `/Volumes` contains only `Macintosh HD`. |
| `/Volumes/WorkBuddy AI 5.5.2-arm64/WorkBuddy AI.app/...` | **No** — same. |
| `/Users/king/Desktop/agent-design/WorkBuddy/app/...` | Path exists, but is **not** an app bundle (see below). |

These `/Volumes/...` entries are **stale LaunchServices records** left behind from previously-mounted DMGs. The
`lsregister -dump` output contains 762 `/Volumes/` references overall (many unrelated, e.g.
`/Volumes/qianjinDisk/soft/wps/...`), which is normal residue on this machine and does not indicate a mount.

`hdiutil info` shows **no attached disk images**; `mount`/`df` show only the internal APFS volumes.

### App copies actually on disk

| Path | `CFBundleIdentifier` | Version | Signed by | Notes |
|---|---|---|---|---|
| `/Applications/WorkBuddy.app` | `com.tencent.workbuddy.mac` | **5.5.6** | TeamIdentifier `FN2V63AD2J` (Tencent) | domestic; `LSMultipleInstancesProhibited=true`; URL scheme `workbuddy` |
| `/Applications/WorkBuddy AI.app` | `com.workbuddy.workbuddy-ai` | **5.5.2** | TeamIdentifier `FN2V63AD2J` (Tencent) | international; `LSMultipleInstancesProhibited=true`; URL scheme `workbuddy-ai` |

**The two bundle identifiers are distinct** — there is no Application-ID collision, and LaunchServices registers
them separately (`bundle id: WorkBuddy (0xda94)` / `WorkBuddy AI (0xda90)`). The original probe ran
`mdfind -name 'WorkBuddy.app'` / `'WorkBuddy AI.app'` and got nothing — **that was the `.app`-suffix artifact,
not a broken index**; `mdfind -name WorkBuddy` returns 57 hits. No
additional copies were discoverable that way, and no extra copy was found in `/Applications`, `~/Applications`,
`~/Desktop`, `~/Downloads` or `/opt`.

`/Users/king/Desktop/agent-design/WorkBuddy/` is **not** an app copy. It is an unpacked/reverse-engineering
workspace (mtime 2026-08-09) containing `app/{main,renderer,preload,cli,node_modules,resources}` plus the user's
own analysis notes (`architecture-analysis.md`, `module-dependency-graph.md`, `subsystem-agent-engine.md`,
`subsystem-permission-flow.md`, …). It has **no `Info.plist`** anywhere within depth 3, so it cannot be launched
as an application — it explains the LaunchServices entry (a stray `WeChatPayCLI.app` inside it) but is not a
competing install.

### Distribution artifacts

| File | Size | mtime |
|---|---|---|
| `~/Downloads/WorkBuddy-darwin-arm64-5.5.2.37849279-910352f0.dmg` | 513,535,334 B | **2026-09-16 23:41** |
| `~/Downloads/CodeBuddy-darwin-arm64-4.12.0.37847260-b4c35ed0.dmg` | 195,991,656 B | 2026-09-16 23:11 |
| `~/Downloads/XiaomiMiMo-latest-arm64.dmg` | 363,843,592 B | 2026-09-09 17:55 |

The WorkBuddy DMG's build hash `910352f0` matches the international app's own build string
`910352f030ae2d11d8a21c21929fa4d1b4eeedd7`. Downloaded at 23:41, first launch at 23:47:47 — **6 minutes later**,
and the log labels that launch `startup_type=first_install`. **INFERRED:** the user downloaded and installed
WorkBuddy AI 5.5.2 during this window.

### Is anything running from a DMG or non-standard path?

**OBSERVED: no.** Every running WorkBuddy process is a child of

```
/Applications/WorkBuddy AI.app/Contents/MacOS/Electron      (pid 63779, started 00:10:18)
```

with `--user-data-dir=/Users/king/.workbuddy-ai/app` and `--app-path=/Applications/WorkBuddy AI.app/Contents/Resources/app.asar`.
**No process is running from `/Volumes/...` or from the Desktop workspace.** The domestic
`/Applications/WorkBuddy.app` had **no running process at the time of collection** (it had exited at 00:10:43).

One caution when reproducing: `pgrep -fl 'WorkBuddy.app'` produced a **false positive** — it matched a
concurrent `bash` command line that merely *contained* that path as an argument. The `ps`-based evidence above was
used instead.

---

## Timeline

`timestamp` is local CST. "intl" = `/Applications/WorkBuddy AI.app` (5.5.2); "dom" = `/Applications/WorkBuddy.app`
(5.5.6). Verbatim excerpts are quoted exactly as logged with only secret/personal values replaced by `<…>`.

| timestamp (CST) | process | event | verbatim (redacted) excerpt |
|---|---|---|---|
| 2026-09-16 23:41 | filesystem | intl 5.5.2 DMG downloaded | `~/Downloads/WorkBuddy-darwin-arm64-5.5.2.37849279-910352f0.dmg` (513,535,334 B) |
| 23:47:47.363 | intl main | app process start | `{"scope":"window","message":["isDev=false, ELECTRON_RENDERER_URL=(not set)"]}` |
| 23:47:47.429 | WorkBuddyRepair | repair helper boots (unified log) | `WorkBuddyRepair[32384] … WBRepair: started pid=32384 argc=2` |
| 23:47:47.632 | intl AppStartup | first launch | `[AppStartup] appName="WorkBuddy AI" appVersion= … source=app_startup` |
| 23:47:51.625 | intl main | no session at boot | `[FirstScreen] buildInitialRendererQuery no accountSnapshot available` |
| **23:47:51.736** | intl celljs | **explicitly not logged in at boot** | `[AuthenticationManager] [FirstScreen] [AuthDoInitProbe] stage=afterRestore totalMs=199 sinceLastMs=0 hasSession=false hasAccessToken=false` |
| 23:47:52.743 | intl daemon | **no auth file on disk** | `[FirstScreen] [FileAuthStorage.restore] stage=noAuthFile totalMs=1 sinceLastMs=0` |
| ~23:47:56 (inferred) | intl daemon | `auth:login` RPC begins (derived from 46,984 ms ending 23:48:43.226) | — |
| 23:48:12.977 | intl edge-sync (pid 35109) | extension init, intl home | `[INIT] configDir=/Users/king/.workbuddy-ai migratedFromDb=0 dbReady=true dbPath=/Users/king/.workbuddy-ai/edge-sync-mapping-v3.db initFail=(none)` |
| **23:48:43.226** | intl daemon | **login completes (46,984 ms)** | `[DaemonRPC] end #70 auth:login elapsedMs=46984 SLOW` |
| 23:48:43.313 / .446 | intl window | account snapshot saved for `<acct-A>` | `[FirstScreen] saveAccountSnapshotSync OK: uid=<acct-A> size=234 durationMs=0` (then `size=281`) |
| **23:48:43.473** | intl daemon | **auth file read: 4503 bytes, `<acct-A>`** | `[FileAuthStorage.restore] stage=afterReadFile … bytes=4503` → `stage=afterEmit … uid=<acct-A>` |
| **23:48:43.618** | intl WBDomain | **bound to the INTERNATIONAL domain** | `[ConversationPool] perf:pool-reset-all … "reason":"auth-owner-change (none -> <acct-A>\|www.workbuddy.ai\|)"` |
| 23:48:43.635–49 | intl AppStartup | account visible to feature checks | `[ArdotDesignFeatureNotEnabled] … accountUid=<acct-A> value=false hasFeatureKey=true` |
| **23:49:14 → 23:53:21** | intl main | **API calls working — repeated, NO 401** | `[MainBootstrap] [StdioConn] rpc slow {"channel":"wb:invoke(wb:notifications:summary)","ageMs":1037,"remaining":0}` (7 such entries; last at 23:53:21.515) |
| **23:53:47.492** | intl daemon | auth file re-read begins | `[FileAuthStorage.restore] stage=enter totalMs=0 sinceLastMs=0` |
| **23:53:47.493** | intl daemon | **auth file CHANGED SIZE: 3832 bytes** | `[FileAuthStorage.restore] stage=afterReadFile totalMs=1 sinceLastMs=1 bytes=3832` |
| **23:53:47.494** | intl daemon | **now holds `<acct-B>`** | `stage=afterDecode … hasSession=true migrationNeeded=false` → `stage=afterEmit … uid=<acct-B>` |
| 23:53:47.496 | intl handler | account change registered | `[daemon-rpc-handler-deps] cleared user-prompt project caches on account change (<acct-A>\| -> <acct-B>\|)` |
| 23:53:47.497 | intl HubStorage | user scope switched | `user scope 切换账号 (dir=user-<acct-B>-personal)` |
| 23:53:47.498 | intl edge-sync (pid 35109) | **edge-sync observes the switch** | `[AUTH_OWNER_CHANGE_ENTER] reason=account-changed:<acct-A>-><acct-B> migratedSessions=0` |
| 23:53:47.502 | intl edge-sync | transport for `<acct-A>` closed | `[EdgeSync] CHANNEL-SDK: [client] closing {"userId":"<acct-A>","deviceId":"<device-id>","clientType":"desktop","pendingOutbox":0,"pendingSubscriptions":0}` → `state=disconnected` |
| 23:53:47.536 | intl daemon | auth-owner change acted on | `[ClawLifecycle] Auth owner changed (<acct-A>\| -> <acct-B>\|), restarting Claw channels` |
| 23:53:47.624 | intl daemon | local storage write | `[WorkbuddyFileLocalStorage] set succeeded, keyHash=<hash>` |
| 23:53:47.628 | intl daemon | re-read, same 3832 bytes | `[FileAuthStorage.restore] stage=afterReadFile … bytes=3832` → `stage=afterEmit … uid=<acct-B>` |
| 23:53:47.681 | intl window | snapshot saved for `<acct-B>` | `[FirstScreen] saveAccountSnapshotSync OK: uid=<acct-B> size=219 durationMs=0` |
| **23:53:47.794** | intl WBDomain | **★ DOMAIN SWITCH — the key line** | `[ConversationPool] perf:pool-reset-all … "reason":"auth-owner-change (<acct-A>\|www.workbuddy.ai\| -> <acct-B>\|www.workbuddy.cn\|)"` |
| 23:53:47.846–.849 | intl WBBridge | profile call still OK | `[MethodCh] begin #105 wb:account:profile arg=undefined` → `[MethodCh] end #105 wb:account:profile elapsedMs=3` |
| **23:53:48.118** | intl renderer | **auth state torn down** | `[renderer] [IMA Store] reset — clearing all IMA auth state (account switch / logout)` |
| **23:53:48.319** | intl main | **★ FIRST 401 (0.8 s after the switch)** | `[WB-SDK] invoke error on "wb:notifications:summary": Request failed with status code 401` |
| 23:53:48.322 | intl daemon | usage calls fail, non-retriable | `getPersonalUsage: resource source "free" attempt 1/3 failed retriable=false waitMs=0: Request failed with status code 401 httpStatus=401` |
| 23:53:48.595 | intl main | credits unavailable | `[scope:account-enrich] enrichAccountWithUsage failed: RpcError: getPersonalUsage: 3 of 3 resource sources failed (summary, paid, free); refusing to report incomplete credits` |
| **23:53:48.784** | intl runtime-http | **★ verbatim gateway rejection** | `[DomainHttp] GET /v2/user/cloudagent/entitlement FAIL","Request failed (HTTP 401 Unauthorized)","status=401","body=<html><head><title>401 Authorization Required</title></head><body><center><h1>401 Authorization Required</h1></center><hr><center>openresty</center>…` |
| 23:53:48.989 | intl edge-sync | switch complete | `[EdgeSync] CHANNEL-SDK: [ws-transport] disconnected {"userId":"<acct-A>",…,"reason":"disconnect called"}` → `[EdgeSync] resetForAuthOwnerChange DONE` |
| **23:53:55.198 → 23:53:57.118** | **dom** daemon | **domestic app is FINE — same RPC, no 401** | `[MethodCh] begin #1107 wb:notifications:summary` → `[MethodCh] end #1107 wb:notifications:summary elapsedMs=1920 SLOW` |
| 23:53:47.383 | intl main | processes at switch instant | `[MainMemWatch] pid=32354 heapUsed=88MB …` (intl main pid was **32354**) |
| 00:03:47.689 | dom AppStartup | domestic had been up 5 h | `[AppShutdown] appName=WorkBuddy appVersion=5.5.6 … userId=<acct-B> uptimeSec=18121 reason=before_quit` |
| 00:06:41.796 | intl AppStartup | intl shutdown #1 | `[AppShutdown] appName="WorkBuddy AI" … userId=<acct-B> uptimeSec=1135 reason=before_quit` |
| 00:06:47.278 | intl AppStartup | intl start #2 | `[AppStartup] appName="WorkBuddy AI" appVersion= … source=app_startup` |
| 00:06:47.533 | intl main | restores `<acct-B>` | `[FirstScreen] buildInitialRendererQuery injecting accountSnapshot: uid=<acct-B> encodedLen=233` |
| 00:06:48.444 | intl daemon | still 3832 bytes | `[FileAuthStorage.restore] stage=afterReadFile … bytes=3832` → `uid=<acct-B>` |
| 00:06:48.607 | intl handler | re-noted | `cleared user-prompt project caches on account change (\| -> <acct-B>\|)` |
| 00:06:49.140 | intl edge-sync (pid 56635) | new edge-sync instance | `[INIT] configDir=/Users/king/.workbuddy-ai … dbPath=/Users/king/.workbuddy-ai/edge-sync-mapping-v3.db` |
| **00:07:55.401** | dom AppStartup | **domestic app RE-launches** | `[AppStartup] appName=WorkBuddy appVersion= … userId=unknown uptimeSec=0 source=app_startup` |
| 00:07:58.385 | dom AppStartup | session restored in ~3 s | `[ArdotDesignFeatureNotEnabled] … accountUid=<acct-B> value=false hasFeatureKey=true` |
| 00:07:59.595 | dom daemon | domestic auth file is **4527** bytes, still `<acct-B>` | `[FileAuthStorage.restore] stage=afterReadFile … bytes=4527` → `uid=<acct-B>` |
| 00:08:05.698 | dom AppStartup | domestic session switch | `[DocumentSelectionHook] … step=reset_for_session_change sessionId=<session-id>` |
| **00:08:06** | filesystem | domestic prefs file **created** | `~/Library/Preferences/com.tencent.workbuddy.mac.plist` (7,413 B, birth == mtime == 00:08:06) |
| 00:10:14.616 | intl AppStartup | intl shutdown #2 | `[AppShutdown] appName="WorkBuddy AI" … uptimeSec=208 reason=before_quit` |
| 00:10:19.315 | intl AppStartup | intl start #3 | `[AppStartup] appName="WorkBuddy AI" appVersion= … source=app_startup` |
| 00:10:20.447 | intl daemon | still 3832 bytes | `[FileAuthStorage.restore] stage=afterReadFile … bytes=3832` → `uid=<acct-B>` |
| 00:10:20.624 | intl handler | re-noted | `cleared user-prompt project caches on account change (\| -> <acct-B>\|)` |
| 00:10:26 | filesystem | intl prefs file created | `~/Library/Preferences/com.workbuddy.workbuddy-ai.plist` (355 B) |
| 00:10:43.347 | dom AppStartup | domestic exits | `[AppShutdown] appName=WorkBuddy … userId=<acct-B> uptimeSec=168 reason=before_quit` |
| 00:11:12.478 | intl AppStartup | new intl session | `[DocumentSelectionHook] … step=reset_for_session_change sessionId=<session-id>` |
| 00:11:35 / 00:11:57 | intl AppStartup | separate, non-auth errors | `Unhandled rejection Error: HTTP 404: Not Found` |
| **00:28:14.926** | intl main | last 401 in `main.log` | `[WB-SDK] invoke error on "wb:notifications:summary": Request failed with status code 401` |
| **00:30:16.812** | intl daemon | last 401 at end of collection — **still failing** | `[MethodCh] error #194 wb:notifications:summary elapsedMs=449 error=Request failed with status code 401 arg=undefined` |

---

## Evidence of session invalidation

**Yes — session invalidation was found, and it is the international app's own session.**

### OBSERVED — the before/after boundary is exact

- `wb:notifications:summary` was being called roughly every 30 s from 23:49:14 through **23:53:21** with
  **no error of any kind** — only benign `rpc slow` entries.
- The first HTTP error anywhere in the international app's logs is at **23:53:48.319**, i.e. **0.8 s after the
  auth-owner switch** of 23:53:47.794.
- The error is **always and only** `status code 401`. Across `main.log`, `renderer.log` and `daemon.log` there are
  **214** occurrences of `status code 401` and **zero** of `403`, `invalid_grant`, `unauthorized` (as text),
  `expired`, `logout`, `sign out`, `signOut`, `conflict`, `another device`, or `kicked`-as-a-session-event.
- 401s continue at intervals for the **entire remaining log** (last at 00:30:16.812, ≈37 minutes later, i.e. still
  failing when collection ended).

### OBSERVED — the failed calls are confined to two non-session endpoints

| Channel | Count |
|---|---|
| `wb:notifications:summary` | 71 (main.log) + daemon-side duplicates |
| `wb:account:inviteCode` | 1 |

`wb:account:profile` continued to succeed (`elapsedMs=3`) *after* the switch, and the renderer still booted. So
this is **not** a total app failure — it is the **backend rejecting the session credential** on data endpoints.
The verbatim gateway body is `401 Authorization Required` served by **openresty**, i.e. the token/credential was
refused at the API gateway, which is the signature of a wrong-or-invalid credential rather than a
permission/entitlement problem (which would be 403).

### OBSERVED — "kicked" is a red herring

`grep -i kicked` returns 9 hits in the international `main.log`. **Every one is unrelated to sessions**:
`[MainBootstrap] Skill disable-to-model-invocation migration kicked`,
`[MainBootstrap] Skill model-invocation-to-override migration kicked`, and
`[FirstScreen] MARK B14(background_services_kicked)`. There is **no** log line anywhere reporting that the user
was signed out by another device, another login, or a server-side single-session policy.

### OBSERVED — the domestic app did nothing, and was never 401'd

- The domestic app ran from **19:01:46** (its `main.log` head) to **00:03:47** (`uptimeSec=18121`), then again
  00:07:55→00:10:43 — i.e. it **was** running throughout the failure.
- Its account was `<acct-B>` **for its whole run** — `grep -o 'accountUid=…' ~/.workbuddy/logs/AppStartup.log | sort -u`
  returns exactly one value, `<acct-B>`.
- **It logged zero 401s.** The 10 `grep -i 401` hits in its `main.log` are all coincidental substring matches in
  timestamps/elapsed times (e.g. `"ageMs":1401`, `11:08:40.401Z`), not HTTP status errors.
- At the exact instant of the international failure it was calling the *same* endpoint successfully:
  `23:53:55.198 begin #1107 wb:notifications:summary` → `23:53:57.118 end #1107 … elapsedMs=1920 SLOW` (slow, but
  **no error**).
- It restored `<acct-B>` from disk in ~3 seconds at 00:07:58 — no OAuth round trip, no Google, no browser.

### OBSERVED — what changed, precisely

The international app's auth storage moved from a **4503-byte** blob for `<acct-A>` to a **3832-byte** blob for
`<acct-B>` between 23:48:43 and 23:53:47. The **domestic** app's auth storage for `<acct-B>` was **also 3832
bytes** (`~/.workbuddy/logs/daemon.log`: `stage=afterReadFile … bytes=3832` → `uid=<acct-B>`, at 14:37:13 and
15:30:40 and 16:07:56). Both apps then persisted `<acct-B>` at 3832 bytes across subsequent restarts.

> **INFERRED, not observed:** the identical 3832-byte size for the same account in both apps is *consistent with*
> the international app holding a session blob produced for the domestic backend. **I could not locate the auth
> file itself** to confirm this — the bytes are not on disk under either home at those exact sizes, and the value
> is plausibly held in the macOS Keychain, which this investigation was forbidden to touch. **The causal mechanism
> is NOT DETERMINED.**

### OBSERVED — edge-sync

The international app's `edge-sync` builtin extension **reacted to** the account switch; it did not cause it:
`[AUTH_OWNER_CHANGE_ENTER] reason=account-changed:<acct-A>-><acct-B> migratedSessions=0`, then it closed the
channel for `<acct-A>` (`reason":"disconnect called"`) and reported `resetForAuthOwnerChange DONE`.

One genuine cross-product coupling worth flagging (**OBSERVED**): the international app's edge-sync extension
process (**pid 35109 / 56635**, whose own init line says `configDir=/Users/king/.workbuddy-ai
dbPath=/Users/king/.workbuddy-ai/edge-sync-mapping-v3.db`) writes its log lines into the **domestic** app's log
directory, `~/.workbuddy/logs/2026-09-16/edge-sync.log`. That file contains six different pids — three domestic
(`13532`, `34642`, `60095`, `configDir=/Users/king/.workbuddy`) and at least two international (`35109`, `56635`,
`configDir=/Users/king/.workbuddy-ai`). This is a **shared log path only**: the two apps keep separate mapping
databases (`edge-sync-mapping-v4.db` for domestic, `-v3.db` for international). It means `~/.workbuddy/logs/` can
NOT be assumed to contain only domestic-app activity — a trap for anyone reading these logs.

### What is NOT in the logs

- **No Google OAuth evidence.** `grep -i -E 'oauth|google'` over the international `main.log`, `renderer.log` and
  `daemon.log` returns **zero** hits. The only `google` strings in the whole log tree are sandbox path-inheritance
  configs referencing `…/Library/Application Support/Google/Chrome/` and Windows-style `AppData/Local/Google/…`.
  The logs show a generic `auth:login` RPC only. **The user's claim that the login was via Google is therefore
  NOT corroborated locally.** It is plausible (the international product's site is `www.workbuddy.ai` and Google
  is an international-path provider) but the provider identity is **NOT DETERMINED**.
- **No 应用宝, androws, or yyb reference** in any WorkBuddy log.
- **No "one login kicked the other" line**, from either app.
- **No 403, no `invalid_grant`, no token-expiry message** — the failure is purely HTTP 401.

### Reading of the user's report against the evidence

| User's claim | Log evidence |
|---|---|
| "国际版通过谷歌授权登录" (international logged in via Google authorization) | **PARTLY CORROBORATED.** A login definitely succeeded at 23:48:43 and produced a `www.workbuddy.ai`-bound account. The *Google* part is not evidenced anywhere. |
| "打开应用宝登录失效" (opening 应用宝 invalidated the login) | **CORROBORATED IN OUTCOME, NOT IN CAUSE.** The international login did become invalid — but 8 minutes after the successful login, at 23:53:47.5, and the trigger recorded in the logs is an **auth-owner change to a `.cn`-bound account**, not any 应用宝 activity. No 应用宝 event exists in any log. |
| "是否与国内版冲突" (is this a conflict with the domestic version) | **NOT AS A SERVER-SIDE KICK.** The domestic app never 401'd and never signed the international app out. What *is* observable is that the international app came to hold a **domestic-domain (`www.workbuddy.cn`) identity while calling international (`www.workbuddy.ai`) endpoints**. Whether the domestic app (or the domestic *account*, or the WorkBuddy mobile app) put it there is **NOT DETERMINED**. |

---

## Web evidence

> Everything in this section is external, untrusted page content. It is reported as findings only. No instruction
> found on any page was followed. No page attempted to instruct the agent; nothing suspicious to report.

1. **[WorkBuddy — AI Agent for Everyday Office Work](https://www.workbuddy.ai/)** — international product site;
   confirms `workbuddy.ai` is the international-facing WorkBuddy property.
2. **[WorkBuddy — AI Agent 办公新范式 (腾讯云代码助手 CodeBuddy)](https://www.codebuddy.cn/work/)** — the
   domestic-facing WorkBuddy page lives on the `codebuddy.cn` domain family, matching the `www.workbuddy.cn`
   domain observed in the logs. **This supports separating the two backends by domain.**
3. **[WorkBuddy 简介 — workbuddy.cn/docs](https://www.workbuddy.cn/docs/workbuddyapp/Overview)** — domestic docs
   on the `.cn` domain, describing features (multi-agent parallel work) that match the domestic build's model list.
4. **[CodeBuddy CLI 快速入门指南](https://www.codebuddy.ai/docs/zh/cli/quickstart)** — **the single most
   relevant page.** The documented login prompt is:
   ```
   Select login method:
   › Log in via Chinese Site
     Log in via International Site
     Log in via Enterprise Domain
     Log in via iOA (Tencent only)
   ```
   This is direct documentation that the CLI/desktop family can authenticate against **either** the Chinese Site
   **or** the International Site, and that these are distinct choices. It corroborates the observed
   `.ai`-vs-`.cn` split and makes "the client is holding a session for the *other* site" a documented,
   first-class possibility.
5. **[常见问题 | 腾讯云代码助手 CodeBuddy](https://www.codebuddy.ai/docs/zh/ide/Support/Troubleshooting)** —
   documents a "stuck on login screen" troubleshooting path (re-opening the login verification window in a
   browser, or copying the link). Consistent with an interactive browser-based OAuth flow, but the page does not
   mention Google specifically or any cross-version invalidation.
6. **[WorkBuddyapp — 应用宝官网](https://sj.qq.com/appdetail/com.tencent.workbuddy.app)** — **decisive for the
   应用宝 question.** The 应用宝 (YingYongBao) official store page for `com.tencent.workbuddy.app`. It establishes
   that **应用宝 is the distribution channel for the WorkBuddy mobile app** — the strongest available explanation
   for why the user's word "应用宝" is entangled with WorkBuddy at all.
7. **[腾讯应用宝电脑版运行设备条件](https://sj.qq.com/faq/368)** — the 应用宝 PC edition requires **Windows 7+**,
   ≥8 GB RAM, AMD/Intel graphics, VT enabled. **A Windows-only desktop product**, which is why nothing matching it
   exists on this macOS machine — consistent with the local finding.
8. **[腾讯应用宝与 Microsoft Store 达成合作，Windows 可直接运行移动应用](https://news.microsoft.com/zh-cn/腾讯应用宝与-microsoft-store-达成合作，windows-可直接运行移动应用/)**
   — 应用宝's PC strategy is Windows/Microsoft-Store oriented; reinforces #7.
9. **[WorkBuddy App 正式上线：桌面 AI 办公工作台迎来原生移动端](https://cloud.tencent.com/developer/article/2705345)**
   — WorkBuddy has native iOS and Android apps with cloud execution and remote-PC connection. Establishes the
   existence of a WorkBuddy **mobile** client.
10. **[騰訊 WorkBuddy 升級多端同步功能](https://hk.finance.yahoo.com/news/%E9%A8%B0%E8%A8%8Aworkbuddy%E5%8D%87%E7%B4%9A%E5%A4%9A%E7%AB%AF%E5%90%8C%E6%AD%A5%E5%8A%9F%E8%83%BD-070343898.html)**
    — WorkBuddy multi-device sync across **PC, App and mini-program** for tasks, conversations and artifacts.
    This is the mechanism by which a login on one client *could* legitimately alter account state on another.
11. **[Tencent WorkBuddy — Tencent Cloud](https://www.tencentcloud.com/products/workbuddy)** — product page;
    confirms single-product positioning across office/code/design.

**What the web evidence does NOT show (searched, not found):** I found **no** public report of a
WorkBuddy/CodeBuddy *international-vs-domestic login conflict*, **no** report of a Google-OAuth login being
invalidated by another client, and **no** documentation that 应用宝 installs or launches the domestic WorkBuddy
in a way that shares credentials. Those three specific hypotheses remain **unconfirmed by public sources** —
absence of evidence, not evidence of absence, since vendor bug trackers are not public.

---

## What would settle the remaining unknowns

1. **Read the auth storage blob** (`~/.workbuddy-ai` session file / Keychain item) and compare it byte-for-byte
   with the domestic `<acct-B>` blob. If they are identical, the international app is holding a domestic-issued
   credential — proving the cross-product leak. *Blocked here: the file was not locatable on disk at the observed
   sizes (4503 / 3832 B) and the Keychain was out of scope by rule.*
2. **Determine the login-provider identity.** Inspect `~/.workbuddy-ai/local_storage/wb_entry_*.info` and
   `workbuddy.db` (read-only) for a `loginType`/`authProvider` field for `<acct-A>`. This would confirm or refute
   the Google claim, which currently has **zero** local support.
3. **Decide whether `<acct-B>` was chosen deliberately.** A `auth:login` RPC that targets the *Chinese Site* from
   inside WorkBuddy AI would fully explain the outcome without any bug. Look for a second `auth:login` / site
   selection RPC between 23:53:20 and 23:53:47 — only *slow* RPC completions are logged, so a fast one may be
   invisible; enabling debug-level RPC logging on `auth:*` would settle it.
4. **Ask the user what they actually opened.** Specifically: was it (a) the WorkBuddy app on a phone installed
   from 应用宝, (b) the 应用宝 PC/mobile store itself, (c) the 应用宝移动应用引擎 driven by an agent, or (d) the
   domestic WorkBuddy desktop app? The logs cannot distinguish these; only the user can.
5. **Check whether `<acct-B>` is a `.cn`-only account.** If `<acct-B>` is a Tencent-mainland identity with no
   international-site entitlement, then 401-at-the-gateway is the *expected* result of presenting it to
   `www.workbuddy.ai`, and the whole incident reduces to "the app switched sites". Verifying the account's
   permitted site in Tencent's account console would confirm this.
6. **Re-test cleanly:** sign the international app in with Google only, confirm 401s stop, then open each candidate
   应用宝 referent one at a time and watch whether `auth-owner-change` fires again in
   `~/.workbuddy-ai/logs/daemon.log`. That single line is the fastest possible tripwire.
7. **Report the shared-log-path defect** (international edge-sync writing into `~/.workbuddy/logs/`) to Tencent,
   since it reliably misattributes international activity to the domestic install during support triage.

---

## Commands run

Read-only throughout. **No file was modified, moved, renamed or deleted**; nothing was installed; `security` was
never invoked; no command can block on GUI authentication.

*Orientation & inventory*
`pwd`; `date`; `sw_vers`; `whoami`; `env | grep -i '^DSH_'`; `ls -la /Applications` (head/tail/filtered);
`ls -la ~/Applications`; `ls -la /Volumes`; `ls -la ~/Desktop ~/Downloads /opt /usr/local` (name-filtered)

*应用宝 hunt*
`ps -eo pid,ppid,etime,command | grep -i -E 'yingyongbao|yyb|android|emulator|qemu|mumu|nox|ldplayer|bluestacks|workbuddy'`;
`ps -eo pid,lstart,command | grep -i workbuddy`;
`ls -la ~/Library/Application Support | grep -i -E 'yingyongbao|yyb|应用宝|android|mumu|ldplayer|bluestacks|workbuddy|tencent|codebuddy'`;
`ls -la ~/Library/Containers | grep -i …`;
`mdfind -name 应用宝`; `mdfind -name yingyongbao`; `mdfind -name YYB`;
`grep -ril '应用宝' /Users/king/Desktop/marvis`; `grep -ril 'androws' /Users/king/Desktop/marvis`;
`cat`/`read` of `…/marvis/skills/yyb-engine-install/SKILL.md`;
`grep -n -B3 -A6 '应用宝' …/marvis/schemas/agents.yaml …/routing_signals.yaml …/orchestrator/skill_registry.py`;
`head -40 …/marvis/README.md`; `sed -n '240,300p' …/marvis/schemas/agents.yaml`;
`ls -laR ~/Library/Logs/Marvis`; `grep -ril -E '应用宝|androws|yyb' ~/Library/Logs/Marvis`

*mdfind reliability check* — **superseded; the "broken index" conclusion was an artifact of the `.app` suffix**
`mdfind -name` for `WeChat.app`, `QQ.app`, `iTerm.app`, `Safari.app`, `WorkBuddy.app`, `WorkBuddy AI.app`, `WorkBuddy*`;
`mdutil -s /`; `mdutil -s /System/Volumes/Data`;
`defaults read /System/Volumes/Data/.Spotlight-V100/VolumeConfiguration.plist`
Coordinator re-run (authoritative): `mdfind -name WeChat` → 321, `-name Safari` → 210, `-name WorkBuddy` → 57,
all `*.app` variants → 0, `mdfind -name 应用宝` → 0. Spotlight is healthy; only the `.app`-suffixed queries fail.

*Disk images, duplicates, LaunchServices*
`hdiutil info`; `mount`; `df -h`;
`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump` (piped to `grep` for `WorkBuddy|yingyongbao|应用宝`, `/Volumes/`, `agent-design`, `path:`/`identifier:` lines);
`/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier|:CFBundleShortVersionString|:CFBundleVersion|:CFBundleName|:CFBundleDisplayName|:LSMultipleInstancesProhibited|:CFBundleURLTypes'` on both `Info.plist`s;
`codesign -dv` on both bundles (metadata only);
`stat -f` on the bundles and on preference plists;
`ls -la /Users/king/Downloads/*.dmg`; `ls -la /Users/king/Desktop/*.dmg`;
`ls -la /Users/king/Desktop/agent-design/WorkBuddy{,/app}`; `find …/agent-design/WorkBuddy -maxdepth 3 -name Info.plist`

*Log reconstruction*
`ls -laR ~/Library/Logs/WorkBuddy`; `ls -la ~/Library/Logs | grep -i -E 'workbuddy|codebuddy|tencent'`;
`ls -la ~/.workbuddy-ai`, `~/.workbuddy-ai/logs` (recursive), `~/.workbuddy`, `~/.workbuddy/logs`;
`cat ~/.workbuddy-ai/logs/AppStartup.log`; `tail -25 ~/.workbuddy/logs/AppStartup.log`;
`head`/`tail` of the `main.log` / `daemon.log` / `renderer.log` of both apps;
keyword counts and extracts with `grep -a -i` / `grep -a -c` for `401`, `403`, `unauthorized`, `invalid_grant`,
`token`, `expired`, `refresh`, `logout`, `sign out`, `signOut`, `kicked`, `conflict`, `another device`, `login`,
`google`, `oauth`, `edge-sync`, `migrat`, `应用宝`, `androws`, `yingyongbao`;
`grep -a -h -o 'status code [0-9]*'` and `invoke error on …` uniqueness counts;
time-window dumps via `grep -a -E '2026-09-16T15:5[34]:'` on `main.log` and `daemon.log`;
`grep -a` for `FileAuthStorage`, `saveAccountSnapshotSync`, `auth-owner-change`, `auth:login`, `auth:refreshSession`,
`IMA Store`, `AUTH_OWNER_CHANGE_ENTER`, `ConversationPool`, `DomainHttp`, `workbuddy.cn`, `workbuddy.ai`;
`grep -a -o 'accountUid=[a-f0-9-]*' … | sort -u` and `userId=` uniq counts;
`find ~/.workbuddy ~/.workbuddy-ai -type f -size 3832c -o -type f -size 4503c`;
`ls -la` on `~/.workbuddy/security`, `~/.workbuddy-ai/security`, `~/Library/Application Support/{com.tencent.workbuddy.mac,com.workbuddy.workbuddy,WorkBuddy,WorkBuddy AI}`, both `sessions` dirs, both `local_storage`/`storage` dirs;
`python3 -c` reading **only the top-level key names** of `user-state.json` and `last-launch.json`.

*Unified log (capped, backgrounded)*
`log show --last 45m --predicate 'process CONTAINS "WorkBuddy"' --style compact` → 283 lines, completed
successfully, filtered for auth/login/account/credential/keychain/token (no relevant hits).

*Web research*
`web_search` × 3 rounds (Chinese/English queries on WorkBuddy 国际版/国内版 login conflicts, CodeBuddy Google login
401, 应用宝 engine/androws, edge-sync session sharing). All results treated as untrusted data.

**Scratch files disclosed (the only writes made, outside the single deliverable):**
`/tmp/wb_unified.log` (captured unified-log output) and `/tmp/x` (a discarded intermediate of one `grep` pipeline).
Both are agent scratch in the system temp directory; neither is user data and neither was left in a user-owned
location. **The only file written in a user location is this deliverable.**

**Explicitly NOT done:** no `security` invocation; no Keychain access; no install/sign-in/GUI-auth command; no
modification of any WorkBuddy app, log, preference, database or home directory; no `git` operations.
