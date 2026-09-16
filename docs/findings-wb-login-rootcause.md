# WorkBuddy 国际版「Google 授权返回后仍显示未登录」根因分析

**协调者综合报告**（2026-09-17）。综合两路取证：`findings-wb-login-state.md`（共享状态）、
`findings-wb-login-timeline.md`（日志时间线）。本文只写**协调者亲自复现/复核过**的内容；
引用子代理结论时标注来源，与子代理冲突处标注纠正。

> **状态：已解决。** 用户最终的操作是「在国际版里退出账号、重新登录」，问题消失。
> 本文 §1 是**最终结论**；§3 保留了一次**被自己推翻的假设**（原文写得过于肯定，已就地纠正），
> 因为那条路的排查过程本身就是本次最有价值的产出之一。

---

## 1. 结论（最终）

**根本原因是国际版自己保存的身份状态被「国内化」了，而不是国内版在运行中干扰它。**
国内版在故障发生时**根本没有运行**（`ps` 无进程）——一个没运行的程序不可能是故障源。
这单条事实就否掉了「卸载国内版」这条思路。

具体链条：

1. **症状的真相是「授权拿到的是国内账号」**，而不是「回调没送到」。国际版处于
   「拿着国内站（`www.workbuddy.cn`）的账号去打国际站（`www.workbuddy.ai`）接口」的状态，
   于是每个请求都被 openresty 以 **401** 拒绝（实测 214 次，`403`/`invalid_grant`/`expired` 均为 0），
   界面就表现为「未登录」。
2. **国际版存储里同时存在两个身份**：`~/.workbuddy-ai/security/` 下有
   `8486c515…`（23:48 建，国际账号）和 `f6de4882…`（23:53 建，**国内账号**），生效的是后者。
   最后一条 `auth-owner-change` 至今仍是 `…|www.workbuddy.cn|`，之后再没切回。
3. **授权是在浏览器里完成的，而浏览器握着国内站的登录态。** Chrome 的 cookie 里同时存在
   `www.workbuddy.cn`、`.workbuddy.cn`、`www.workbuddy.ai`、`.workbuddy.ai` 等域。
   只要浏览器里国内站的会话还活着，无论 app 打开哪个站点地址，**授权回来的都可能是国内账号**——
   这精确解释了「使用国际版地址登录，但获取的授权还是国内版的」。
4. **国际版自身的配置是正确的**，所以问题不在配置：缓存
   `~/.workbuddy-ai/cache/acc-product-config-v3.json` 为 `isOversea: true`、
   `applicationName: workbuddy-ai`、`endpoint: https://www.workbuddy.ai`。

**最终有效的修复：退出国际版账号 → 重新登录。** 重置掉那份被国内化的身份后即恢复正常。

另外两处**真实存在但本次未触发**的缺陷，见 §3（互相注销，从未执行）与 §4
（共享凭据密钥目录，已实际发生并被采纳）。它们不是本次症状的病因，但是真实的代码缺陷。

---

## 2. 两个 bundle 的真实身份（不是同名双胞胎）

| | 国内版 | 国际版 |
|---|---|---|
| 路径 | `/Applications/WorkBuddy.app` | `/Applications/WorkBuddy AI.app` |
| CFBundleIdentifier | `com.tencent.workbuddy.mac` | `com.workbuddy.workbuddy-ai` |
| 版本 | 5.5.6 | 5.5.2 |
| Info.plist URL scheme | `workbuddy` | `workbuddy-ai` |
| product.json `applicationName` | `WorkBuddy` | `workbuddy-ai` |
| product.json `dataFolderName` | `.workbuddy` | `.workbuddy-ai` |
| `MacOS/Electron` sha256 | `6b6a0956…` | `13dbbb0a…` |
| TeamIdentifier | `FN2V63AD2J` | `FN2V63AD2J` |

**这一点很关键，也是最初把排查带偏的地方**：bundle id、URL scheme、`dataFolderName` **都已经分开了**，
说明厂商知道要隔离。但**代码没跟上**——国际版是直接从国内版 fork 的，隔离做了一半。

---

## 3. 冲突一：互相注销 Launch Services 注册（真实缺陷，但**本次未触发**）

### 3.1 代码原文（`/Applications/WorkBuddy AI.app/Contents/Resources/app.asar`，offset ≈108016216）

两个 bundle 里都有**同一段**代码：

```js
function removeLegacyProtocolRegistrations() {
	for (const scheme of LEGACY_SCHEMES_TO_REMOVE) electron.app.removeAsDefaultProtocolClient(scheme);
	if (process.platform === "darwin") unregisterAllWorkbuddyDeepLinksFromLaunchServices();
}
/**
* Asynchronously find all WorkBuddy app bundle paths registered in Launch Services
* that still have codebuddy:// bindings, and unregister them. Runs in background
* to avoid blocking app startup.
*
* After cleanup, re-registers the current app to restore workbuddy:// binding.
*/
function unregisterAllWorkbuddyDeepLinksFromLaunchServices() {
	const appMatch = process.execPath.match(/^(.+?\.app)\//);
	const currentBundlePath = appMatch ? appMatch[1] : "";
	try {
		(0, child_process.execFile)("/bin/sh", ["-c", `${LSREGISTER_PATH} -dump | grep -E "^(bundle id:|path:)" | grep -A 1 "bundle id:.*WorkBuddy" | grep "path:" | sort -u`], {
			encoding: "utf8", maxBuffer: 10 * 1024 * 1024
		}, (err, stdout) => {
			if (err || !stdout) return;
			const paths = [];
			for (const line of stdout.split("\n")) {
				const match = line.match(/^\s*path:\s*(.+?)\s*\(0x[0-9a-f]+\)\s*$/);
				if (!match) continue;
				const appPath = match[1].trim();
				if (currentBundlePath && appPath === currentBundlePath) continue;   // ← 只跳过自己
				if (appPath && !paths.includes(appPath)) paths.push(appPath);
			}
			if (paths.length === 0) return;
			for (const appPath of paths) try {
				(0, child_process.spawnSync)(LSREGISTER_PATH, ["-u", appPath], { timeout: 5e3 });
				console.log(`[LegacyProtocolCleanup] unregistered stale Launch Services entry: ${appPath}`);
			} catch {}
		});
	} catch {}
}
var LEGACY_SCHEMES_TO_REMOVE, LSREGISTER_PATH;
var init_app_instance = require_chunk.__esmMin((() => {
	LEGACY_SCHEMES_TO_REMOVE = ["codebuddy"];
	LSREGISTER_PATH = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
}));
```

注意 `if (currentBundlePath && appPath === currentBundlePath) continue;`——它**只把自己排除在外**，
其余全部 `lsregister -u`。这段代码的本意是清理「旧版本的残留注册」，但它的匹配条件
`bundle id:.*WorkBuddy` 把**另一个在用的 WorkBuddy 应用**也一并算作"残留"。

### 3.2 协调者真机复现（这是最硬的一条证据）

在**不修改任何东西**的前提下，原样跑代码里那条管道：

```
$ lsregister -dump | grep -E "^(bundle id:|path:)" | grep -A 1 "bundle id:.*WorkBuddy" | grep "path:" | sort -u
path:                       /Applications/WorkBuddy AI.app (0x11e18)
path:                       /Applications/WorkBuddy.app (0x11e1c)
```

匹配到的两行 `bundle id:` 是：

```
bundle id:                  WorkBuddy AI (0xda90)
bundle id:                  WorkBuddy (0xda94)
```

也就是说：**匹配是基于应用显示名（`WorkBuddy` 是 `WorkBuddy AI` 的子串），不是 bundle id。**
国际版启动时，`paths` 里会留下 `/Applications/WorkBuddy.app`，于是它对**国内版**执行
`lsregister -u /Applications/WorkBuddy.app`。国内版启动时同理注销国际版。

### 3.3 ⚠️ 本次**未触发**——这段代码从未真正执行

最初本文把 §3.3 的机制当作病因。**协调者随后用两个独立的经验检验推翻了它：**

**(a) 应用自己会记录每一次成功注销，而日志里一次都没有。**
代码在每次成功 `lsregister -u` 后打印
`[LegacyProtocolCleanup] unregistered stale Launch Services entry: <path>`。
在两个应用的全部日志树里搜索该字符串：

```
$ grep -a -r -h -o -E "\[LegacyProtocolCleanup\][^\"]{0,120}" ~/.workbuddy-ai/logs ~/.workbuddy/logs | wc -l
0
```

同时 `Failed to register protocol scheme "…"` 也是 0 次。**即：注销路径从未跑通**
（最可能是 `execFile` 回调里 `if (err || !stdout) return;` 提前返回——所有错误都被 `catch {}` 静默吞掉）。

**(b) 当前的 scheme 路由是正确且健康的。** LaunchServices 的权威处理器数据库
`~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist` 显示：

```
"LSHandlerURLScheme" => "workbuddy"     "LSHandlerRoleAll" => "com.tencent.workbuddy.mac"     （国内版）
"LSHandlerURLScheme" => "workbuddy-ai"  "LSHandlerRoleAll" => "com.workbuddy.workbuddy-ai"   （国际版）
```

两个 scheme 各自指向正确的应用，`lsregister -dump` 也显示两者都已注册并各自声明了 scheme。

**结论：§3 描述的是一个真实的、危险的代码缺陷，但它是一个潜伏风险，不是本次故障的病因。**
病因见 §1 与 §4。这也说明了一条方法论：**「代码里有这段逻辑」不等于「这段逻辑执行过」——
必须找执行痕迹（日志、状态、可观测副作用），而不是从代码推断故障。**

### 3.4 若它触发，会产生什么症状（推断）

`lsregister -u <app>` 不是"取消默认打开方式"那么轻——它把该 bundle 在 Launch Services 里的注册
**整条摘掉**，包括它声明的 URL scheme。若它真的触发，则回调 URL 会找不到接收方，
表现为「浏览器授权完成、桌面应用毫无反应」。**但这个症状本次并没有被观测到**，
本次的实际症状是「登录上了，但拿到的是国内账号」（§1）。

### 3.5 硬编码 scheme 的问题（独立于 §3.3）

国际版自身声明 `workbuddy-ai`，且其 `product.json` 的 `deepLinkSchemes` / `urlProtocol`
也确实都是 `workbuddy-ai`，所以**注册层面是对的**。但它的代码里仍有 **58 处硬编码 `workbuddy://`**，
例如：

```js
windowManager.handleOpenUrl(`workbuddy://chat/${encodeURIComponent(sessionId)}`);
```

而正确的按地区取值函数是存在的：

```js
function getDesktopDeeplinkScheme() {
	return isOverseas() ? "workbuddy-ai://" : "workbuddy://";
}
```

**即：正确写法存在，但有一批调用点绕过了它。** 这是一个独立的真实缺陷，值得修。
（原本负责确认 OAuth `redirect_uri` 的子代理 **已被终止**——见 §9——因为在实际病因确立后，
这一环已不再影响结论。）

---

## 4. 冲突二：共享的凭据密钥目录，让国际版"继承"了国内账号

来源：`findings-wb-login-state.md`（协调者已复核 hash 推导与时间戳）。

### 4.1 共享路径与与 app 无关的文件名

两个 bundle 中**逐字节相同**的代码：

```js
backupBaseDir ?? path.join(os.homedir(), ".workbuddy-key-fallback")
backupPath = join(backupBaseDir, "connector-keys", `${hashUserId(userId)}.key`)
```

- 目录名硬编码为**国内版**的 `.workbuddy-key-fallback`；`.workbuddy-ai` 在该模块中**零出现**。
- `hashUserId(u) = sha256(u, 'utf8').hex.slice(0, 32)`——**只对 userId 取 hash，不含 app 标识**。
  已复现验证：`sha256("<国内账号 uid>")[:32]` = `738c629ee09fada4231c31e5787d95a6`，
  `sha256("<国际账号 uid>")[:32]` = `e86c0039412d4105a09900a73b9afea9`，与磁盘上两个文件名完全一致。
- `getExisting()` 的逻辑是"primary 赢"并会**反向写回共享 backup**，primary 缺失时**从共享 backup 采纳**
  （`recovered-primary-from-backup`）。于是同一个逻辑账号在两个 app 里算出**同一个文件名**，
  一方写入会覆盖另一方，且密钥错配会导致 HKDF(userId) 不匹配 → 密文**不可解密**。

### 4.2 后果：身份被换掉

`~/.workbuddy-ai/logs/daemon.log` 原文（UID 已替换为占位符）：

```
"reason":"auth-owner-change (none -> <intl-uid>|www.workbuddy.ai|)"
"reason":"auth-owner-change (<intl-uid>|www.workbuddy.ai| -> <dom-uid>|www.workbuddy.cn|)"
```

**国际版把自己的 `.ai` 账号换成了国内账号 + `www.workbuddy.cn`。**
并且子代理发现：国际版 home 下该国内账号的 `.master.key` 与国际版自己的 key **字节相同**，
但其副本诞生于 23:53:47——**是采纳来的，不是新生成的**。此后所有打到 `.ai` 端点的请求被 openresty 网关
以 **401** 拒绝（共 214 次；`403`、`invalid_grant`、`expired`、`logout`、another-device 均为 **0** 次）。

> 因果强度说明：**时间戳一致（23:53:47）是强相关，但"采纳 key 直接导致 auth owner 变更"尚未被单步证明。**
> 另一个同样成立的解释是：用户在该时刻自己选择了「国内站点」登录。区分二者需要看 UI 侧的选择记录。
> 这一点标注为**未确定**，不应当作已证结论使用。

---

## 5. 附带发现：国际版把早期启动日志写进了国内版的 home（已证实）

来源：`findings-wb-login-state.md`。最强的单条证据：

- `~/.workbuddy/logs/startup/2026-09-17/63779-001019.jsonl`（9051 B）内含 `pid 63779`；
- `ps` 确认 **pid 63779 = `/Applications/WorkBuddy AI.app/Contents/MacOS/Electron`**（国际版主进程）；
- 同一次运行还写了 `~/.workbuddy-ai/logs/startup/2026-09-17/63779-001019.jsonl`，
  两份文件的 **phase 集合互不相交**（国内那份是 `A_process/B_bootstrap/C_window/F_daemon`，
  国际那份是 `D_preload/E_renderer/F_daemon`），**是两个文件，不是拷贝**。

根因：`resolveWorkbuddyDataFolderName()` 在 `tryGetWorkbuddyBaseProductConfiguration()` 抛错时
**回退到硬编码的 `.workbuddy`**，`resolveWorkbuddyConfigDir()` 随之返回 `~/.workbuddy`。
这是一个 **fail-open 默认值**：一旦产品配置解析失败，国际版就会落到国内版的目录上。

**这是「登录失效」的另一个潜在机制，目前是潜伏状态**：`app.setPath("userData", getWorkbuddyUserDataDir())`
若走到该分支，两个 app 会共用同一个 Chromium profile（Cookies / Local Storage / session / SingletonLock），
后启动的会顶掉先启动的。当前尚未触发——因为 `Singleton*` 文件仍分属两个 home
（国内 `SingletonLock KMBP-59571`、国际 `KMBP-63779`）。

同类未隔离项（均 OBSERVED，详见 `findings-wb-login-state.md`）：

| 共享位置 | 原因 |
|---|---|
| `~/.workbuddy-key-fallback/connector-keys/` | 硬编码国内路径 + 与 app 无关的文件名 |
| `~/Library/Application Support/WorkBuddy/pending-telemetry` | 运行中的国际版环境变量 `WORKBUDDY_APP_NAME=WorkBuddy`（硬编码 `DEFAULT_APP_NAME`） |
| `~/Library/Preferences/com.workbuddy.workbuddy.plist`、`com.workbuddy.repair.plist` + 对应 Caches/HTTPStorages | 两个 bundle 内**都**打包了同名 helper（`WorkBuddy Legacy Auto Launch Cleaner.app`、`WorkBuddy Repair.app`） |
| `~/.workbuddy/logs/startup/`、`~/.workbuddy/logs/2026-09-16/edge-sync.log` | 国际版进程写进国内版日志目录（已证实，见上） |
| `/var/folders/…/T/workbuddy-host-cli`、`workbuddy-prompt-vars`、`workbuddy-localstorage-*` | 固定国内品牌前缀，非 app 派生 |
| `ipcAddress` 前缀 `WorkBuddy_` | 硬编码国内字面量，但后缀是 8 字节随机 → **不构成冲突**（无跨 app 交接） |

---

## 6. 排除项（同样重要，避免误判）

| 假设 | 结论 | 依据 |
|---|---|---|
| 「应用宝」与本次故障有关 | **排除** | 本机确无应用宝：`/Applications` 无、进程无、LaunchServices 无注册；`mdfind -name 应用宝` = 0 命中（且 `mdfind` 在这台机器上**是好的**，见 §7）。用户亦确认「没有应用宝，我直接从官网下载的 dmg 安装包」。 |
| 服务端单会话互踢（一个登录顶掉另一个） | **排除** | 国内版整场运行**零** 401，日志中不存在 sign-out/kick 行；9 处 "kicked" 全是 `Skill … migration kicked` 之类的良性文本。 |
| 两 app 撞 URL scheme 名 | **排除（Info.plist 层面）** | 一个是 `workbuddy`，一个是 `workbuddy-ai`，已分开。**但代码层面没分开**，见 §3.4。 |
| 两个 app 是同一个 bundle id 的重复安装 | **排除** | id 不同（`com.tencent.workbuddy.mac` vs `com.workbuddy.workbuddy-ai`），各自 `MacOS/Electron` 哈希不同。 |
| 从 DMG 直接运行 / 磁盘上有重复副本 | **排除** | `/Volumes` 只有 `Macintosh HD`；`hdiutil info` 无已挂载映像；`/Volumes/WorkBuddy 5.2.3-arm64` 等只是 **LaunchServices 里的陈旧记录**（全盘 762 条 `/Volumes/` 引用）。`~/Desktop/agent-design/WorkBuddy/` 是逆向工作区，不是可运行副本。 |
| 是 Keychain 条目撞名 | **未确定** | 从代码推导：Electron 惯例是 service `"<app.name> Safe Storage"`，`app.name` 分别为 `WorkBuddy` / `WorkBuddy AI` → 字符串**不同**（故不构成已证冲突）。但两个 bundle 都 `CFBundleExecutable=Electron`，任何回退到可执行文件名/进程名的路径都会算出**相同**字符串。**本项未读取 Keychain**（有意为之），需要反汇编 `ElectronBrowserMainParts` 或读取**条目名**才能定论。 |

---

## 7. 一处对子代理结论的纠正（诚实记录）

`findings-wb-login-timeline.md` 原称本机 `mdfind` 坏了（"returns nothing even for apps that demonstrably
exist"），并据此认为「搜不到应用宝」不构成证据。**该结论是错的，原因是查询带了 `.app` 后缀。**
Spotlight 存的是去掉扩展名的显示名：

| 查询 | 命中 |
|---|---|
| `mdfind -name WeChat` / `WeChat.app` | 321 / **0** |
| `mdfind -name Safari` / `Safari.app` | 210 / **0** |
| `mdfind -name WorkBuddy` / `WorkBuddy.app` | 57 / **0** |
| `mdfind -name 应用宝` | **0** |

所以 `mdfind` 正常，`mdfind -name 应用宝` = 0 命中**是有意义的证据**。该文档中相关三处已就地更正。
这也说明了本次排查的一条纪律：**子代理的结论必须由协调者在真机上复现后才写进结论文档**——
本次三路取证里，这一条是靠复核抓出来的。

---

## 8. 修复与规避

### 8.1 实际有效的修复（按有效性排序）

1. **（已由用户验证有效）在国际版里退出账号 → 重新登录。** 这会重置那份被"国内化"的身份，
   故障随之消失。这是本次唯一的必要操作。
2. **若重登后仍拿到国内账号：先清浏览器的站点登录态。** 授权是在**浏览器**里完成的，
   只要浏览器还持有国内站会话，就可能再次授权成国内账号。清除 `workbuddy.cn`、`www.workbuddy.cn`、
   `workbuddy.ai`、`www.workbuddy.ai`、`codebuddy.ai`、`codebuddy.cn` 的 cookie，
   **或者直接用无痕窗口登录**（最省事）。对应 §1 第 3 条。
3. **清掉国际版已继承的国内身份**（**先备份**）：把
   `~/.workbuddy-ai/security/f6de4882-ef5d-4669-8944-3b1e24e40051/` 移到备份目录。
   只动这一个子目录——**不要**删整个 `~/.workbuddy-ai/`，里面有工作区、技能与插件。
4. **不要为本次故障卸载国内版。** 它当时并未运行，且在这条链路上它的配置完全不参与。
5. **针对 §3 的潜伏风险（可选，长期两个都用才需要）**：别让两个 WorkBuddy 同时待在 `/Applications`；
   怀疑注册被摘掉时用 `lsregister -f "/Applications/WorkBuddy AI.app"` 恢复。
6. **自检回调通道是否还在**：`open "workbuddy-ai://"` 应唤起国际版，`open "workbuddy://"` 应唤起国内版。
   哪条毫无反应，就是那个已被对方注销。
7. 凭据隔离（§4）没有用户侧开关，只能靠**不要交叉使用两个 app 的同一账号**规避。

### 8.2 上游代码修复（如果要提 issue，四条都值得提）

1. `unregisterAllWorkbuddyDeepLinksFromLaunchServices()`：把匹配条件从子串 `WorkBuddy` 收窄为
   **自家 bundle id 精确匹配**，并且**永远不要注销一个当前存在于 `/Applications` 的其他 WorkBuddy**。
   当前实现把"另一个在用的产品"当作"旧版本残留"，这是根本错误。
   另外它把所有错误都 `catch {}` 吞掉、连"清理是否真的执行了"都无法诊断，应当至少记日志。
2. `.workbuddy-key-fallback` 改为 app-scoped（用 `dataFolderName` / bundle id 派生），
   并让 `hashUserId` 的输入包含 app 身份，避免不同 app 对同一账号算出同一文件名。
3. `resolveWorkbuddyDataFolderName()` 的失败分支应由 fail-open（回退 `.workbuddy`）改为 **fail-closed**
   （报错并拒绝启动），否则国际版会静默落到国内版目录上，造成 profile 与凭据串味。
   同源的 fail-open 还有两处：`DEFAULT_APP_NAME = "WorkBuddy"` 与
   `DEFAULT_DEEPLINK_SCHEMES = ["workbuddy"]`（两个 bundle 中逐字节相同）。
4. **地区的判定源应当统一。** 目前 API 基址取自 `product.json` 的 `endpoint`
   （实测正确：`https://www.workbuddy.ai`），而 Web/登录源址取自 `getWebsiteOrigin()`
   → `isOverseas()` → `isInternationalVersion()`（**只读 DOM 属性 `data-is-chinese-version` 与
   `window.location.hostname`，从不读 product config**），失败时回退到硬编码的
   `https://www.workbuddy.cn`。**两个来源可以不一致，这正是"拿国内账号打国际接口 → 401"的成因。**
   应让 `isOverseas()` 以 product config 为唯一权威。
5. 顺带：把 §3.5 的 58 处硬编码 `workbuddy://` 统一改为 `getDesktopDeeplinkScheme()`。

---

## 9. 仍然未确定的（明确列出，不假装知道）

**已由用户实测解决：退出国际版账号 → 重新登录，故障消失。** 下表是解决后仍未闭合的问题。

1. **OAuth `redirect_uri` 实际使用哪个 scheme** —— 负责此项的子代理
   （`319d4d4d` "OAuth callback routing forensics"）**已被协调者终止**：它在长时间运行后**未产出任何
   文件**，且在实际病因确立后这一环已不影响结论。`findings-wb-login-callback.md` **不存在**，
   本文不再引用它。（终止原因：该子代理的探针依赖对大体积 `app.asar` 的正则上下文搜索，
   容易超时；协调者随后改用有界 Python 字节扫描，几秒内即取得同样的事实。）
2. **23:53:47 的 `.cn` 身份是"浏览器里的国内站会话被复用"还是"共享状态继承"还是"用户自己选了国内站点"**
   —— 三者都能产生同样的观测。实测「退出账号重新登录」即恢复，说明它是**可重置的状态**，
   而非配置错误；但**最初那次切换的触发者**仍未确证。注意 §1 第 3 条（Chrome 同时持有
   `www.workbuddy.cn` 与 `www.workbuddy.ai` 的 cookie）使"浏览器会话复用"成为最可能的解释。
3. **登录所用的身份提供方是否真的是 Google** —— 本地日志中 `oauth` / `google` 命中数为 0。
   与"授权在浏览器侧完成、app 只是接收结果"一致，但无法据此确认 provider。
4. **Keychain `safeStorage` 条目名是否真的不同** —— 见 §6（未读取 Keychain，属有意为之）。

### 9.1 本次排查的方法论教训（值得记住）

- **「代码里有这段逻辑」≠「这段逻辑执行过」。** §3 的假设被同一份代码里的一条日志语句证伪——
  永远去找执行痕迹（日志行、状态变化、可观测副作用），而不是从代码推断故障。
- **用户报告的症状措辞会掩盖真实机制。** 「登录失效」既有"回调没送到"也有"拿到了错的身份"两种
  完全不同的机制；直到用户补充「这次登录上了，但是是国内版登录的账号」，真实机制才浮出水面。
  应当尽早把症状逼问到"具体看到什么"。
- **子代理的结论必须由协调者在真机上复现后才写进结论文档。** 本次两处子代理错误都是这样抓出来的：
  「mdfind 坏了」（实为 `.app` 后缀，见 §7）与「冲突一是病因」（实为从未触发，见 §3.3）。
- **正则上下文搜索不适合大二进制。** 对 297 MB 的 `app.asar`，`grep -E '.{70}pattern.{90}'` 会因回溯
  超时（>180 s）；`grep -a -o -b <字面量>` 或 Python 有界分块扫描则是秒级。

---

## 10. 证据来源与命令

- `findings-wb-login-state.md` — 共享状态映射、hash 推导、IPC/singleton、交叉写入时间线
- `findings-wb-login-timeline.md` — 日志时间线、应用宝定位、磁盘映像与重复副本（含 §7 纠正）
- `findings-wb-login-callback.md` — **不存在**（负责它的子代理已被终止，见 §9）

协调者亲自执行的复核命令（决定性的几条）：

```bash
# 该代码到底执行过没有？——应用的自我记录（0 = 从未执行）
grep -a -r -h -o -E "\[LegacyProtocolCleanup\][^\"]{0,120}" ~/.workbuddy-ai/logs ~/.workbuddy/logs | wc -l

# scheme 路由的权威记录
plutil -p ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist \
  | grep -B4 -A1 -i "workbuddy"

# 地区判定的两个来源，以及它们是否一致
python3 -c "import json;d=json.load(open('/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/product.json'));print(d['isOversea'], d['endpoint'])"
python3 -c "import json;d=json.load(open('$HOME/.workbuddy-ai/cache/acc-product-config-v3.json'));print(d['isOversea'], d['endpoint'])"

# 国际版存了几个身份 / 生效的是哪个
ls ~/.workbuddy-ai/security/
grep -a -h -o -E "auth-owner-change \([^)]*\)" ~/.workbuddy-ai/logs/daemon.log | tail -2

# 浏览器是否握着国内站会话（只看 host_key，不读 cookie 值）
sqlite3 "file:$HOME/Library/Application Support/Google/Chrome/Default/Cookies?mode=ro" \
  "select distinct host_key from cookies where host_key like '%workbuddy%' or host_key like '%codebuddy%';"

# 401 集中在哪些接口与哪个域
grep -a -h -o -E "\[DomainHttp\] (GET|POST) /v2/[a-zA-Z0-9/_-]+" ~/.workbuddy-ai/logs/daemon.log | sort | uniq -c | sort -rn
```

```bash
# ── 以下为更早一轮的取证命令（bundle 身份、字节扫描、时间线）──
# bundle 身份
plutil -extract CFBundleURLTypes json -o - "/Applications/WorkBuddy.app/Contents/Info.plist"
plutil -extract CFBundleURLTypes json -o - "/Applications/WorkBuddy AI.app/Contents/Info.plist"
shasum -a 256 "/Applications/WorkBuddy.app/Contents/MacOS/Electron" "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron"

# 真机复现"互相注销"（只读，未执行任何 -u）
lsregister -dump | grep -E "^(bundle id:|path:)" | grep -A 1 "bundle id:.*WorkBuddy" | grep "path:" | sort -u
lsregister -dump | grep -E "^bundle id:" | grep -i workbuddy | sort -u

# 字节级取证（python3 有界扫描，避免对 297MB 二进制做回溯正则）
#   模式：unregisterAllWorkbuddyDeepLinksFromLaunchServices / LEGACY_SCHEMES_TO_REMOVE /
#        getDesktopDeeplinkScheme / workbuddy-ai:// / workbuddy://
python3 - <<'PY'   # 见 §3.1、§3.4 引文
PY

# 时间线
grep -a -h -o -E '.{0,60}auth-owner-change.{0,120}' ~/.workbuddy-ai/logs/daemon.log

# Spotlight 纠正
for n in WeChat WeChat.app Safari Safari.app WorkBuddy WorkBuddy.app 应用宝; do mdfind -name "$n" | wc -l; done
```

本报告未包含任何凭据值：账号 uid 一律以 `<intl-uid>` / `<dom-uid>` 占位，仅保留不可逆的
`sha256(uid)[:32]` 文件名（其本身就是磁盘上的可见文件名）。全程未执行 `security` 读取 Keychain。
