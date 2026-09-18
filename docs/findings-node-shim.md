# `env: node: No such file or directory` 出现在 claude / codex / codebuddy-code 行上的根因分析

**工作流报告**（2026-09-17）。本文只写**本机实际跑过**的命令与输出；每一条结论都能追到
下面某条命令。基线与命令环境：macOS，`node v26.5.0`（`/opt/homebrew/bin/node`，
**不在宿主 PATH 上**）。

> **状态：已解决。** 根因**全在本仓库内**（版本探测自己拼 argv + 把子进程 stderr 当成版本号），
> 已在 `src/kernel/registry.ts` 与 `src/kernel/command-line.ts` 修掉，并加了会真红的护栏。
> 宿主 PATH 无 node 是**已知且设计上已补偿**的环境事实（D7 / `design-tracks.md` §3.3），
> 不是本缺陷的根因，也不需要对它做任何操作；它单独记在 `handoff-blockers.md` 记录 5。

---

## 1. 结论（最终）

操作员看到的**不是一句日志，是一个被塞进 `version` 字段的错误文本**。两个缺陷叠加：

1. **版本探测自己拼 argv，绕过了 CLI 轨道的 shim 修复。**
   `src/kernel/registry.ts:509`（修复前）手工构造：

   ```ts
   const argv = [...(resolved.interpreterPath ? [resolved.interpreterPath] : []), resolved.executablePath ?? '', '--version']
   ```

   `ResolvedIdentity.interpreterPath` **只在描述符自己钉了 `interpreter` 时才有值**
   （`registry.ts:437`，桌面轨道）。而 CLI 轨道对 `#!/usr/bin/env node` shim 的修复写的是
   **另一个字段** —— `resolved.command.interpreter`（`src/tracks/cli/index.ts:177-193`）。
   于是探测把**裸 shim** 交给内核：子进程在打印任何东西之前就被 `/usr/bin/env` 判死。
   **跑（run）路径没这个问题**，因为 `src/kernel/manager.ts:316` 传的是
   `resolved.command`，而 `src/drivers/argv.ts` 的 `buildCommandLine()` 读的正是
   `command.interpreter`。

2. **`defaultVersionProbe` 把 stdout 和 stderr 拼在一起再解析。**
   子进程什么都没往 stdout 写，stderr 是 `env: node: No such file or directory`；
   `parseVersion()` 找不到 semver 就退化成「第一行非空文本」，于是那句**错误信息被当成版本号
   发布出去**，同时该身份仍被标成 `available: true` / `health.launch: 'ok'`。
   这一条是操作员**看到**那行字的直接原因。

两个缺陷缺一不可：只有 (1) 会得到「没有版本」；只有 (2) 会在其它失败形态下继续骗人。
所以两条都修了（§6）。

**桌面身份（`workbuddy` / `workbuddy-ai` / `autoclaw`）为什么没事**：它们的描述符
**自己钉了** `interpreter: '/opt/homebrew/bin/node'`（`src/tracks/desktop/catalog.ts:61,72,90`），
`interpreterPath` 因此有值，同一行手工拼出来的 argv 恰好是对的。**同一行代码，两条轨道
命运不同** —— 这正是「同一份冻结规则被实现了两次」的典型症状。

---

## 2. 方法：先复现，再定位

### 2.1 宿主 PATH 确实没有 node（复验已知事实）

```bash
ls "/Users/example/Library/Application Support/DSH Desktop/runtime-commands/generations/"
# → 68c24b0a32d4571ebb18d44b97380d522c67e885d64dae302ad011c1ab5f3123-c688fb67-32c9-438a-a7c9-4ca17095609d

ls -l /usr/bin/node
# → ls: /usr/bin/node: No such file or directory

env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' sh -c 'command -v node; echo "exit=$?"'
# → exit=1
```

即：DSH 那个 `generations/<hash>/bin` 目录真实存在，而 `/usr/bin/node` 不存在 ——
观测到的 PATH **确实一个 node 都没有**。

### 2.2 三个身份都是 `#!/usr/bin/env node` shim，且都经 nvm 解析

```bash
head -1 /usr/local/bin/claude
# → #!/usr/bin/env node
ls -l /usr/local/bin/claude
# → /usr/local/bin/claude -> /Users/example/.nvm/versions/node/v22.22.3/bin/ccb

ls -l /Users/example/.nvm/versions/node/v22.22.3/bin/codex
# → …/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js

ls -l /Users/example/.nvm/versions/node/v22.22.3/bin/codebuddy-code
# → …/bin/codebuddy-code -> ../lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy
```

`CLI_SEARCH_PATH`（`src/tracks/cli/index.ts:46-53`）把 `~/.nvm/versions/node/*/bin` 放在
**第一位**，所以三个身份都走 nvm。顺带确认一个容易踩的点：**codex 有两份安装**，
`/opt/homebrew/bin/codex` 是原生 Mach-O（`cffaedfe…`），nvm 那份才是 `#!/usr/bin/env node`
脚本 —— 搜索顺序决定桥拿到哪一份：

```bash
head -c 20 /opt/homebrew/bin/codex | xxd | head -1
# → 00000000: cffa edfe 0c00 0001 0000 0000 0200 0000  ................
```

真实探测输出（`registry.resolve('codex').executablePath`）落在 nvm 那份上 —— 见 §2.3。

### 2.3 裸 shim 的 stderr（逐字）

```bash
env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' /usr/local/bin/claude --version
# stderr: env: node: No such file or directory
# exit=127

env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' /Users/example/.nvm/versions/node/v22.22.3/bin/codex --version
# stderr: env: node: No such file or directory
# exit=127

env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' /Users/example/.nvm/versions/node/v22.22.3/bin/codebuddy-code --version
# stderr: env: node: No such file or directory
# exit=127
```

注意退出码是 **127 而不是 spawn 失败**：shebang 里的 `/usr/bin/env` 存在，exec 成功，
是 `env` 自己找不到 `node` 才失败。所以内核看到的是「进程跑起来了、退出了、stderr 有内容」，
`child.on('error')` 根本不会触发 —— 这也解释了为什么缺陷能一路走到 `parseVersion`。

### 2.4 经修复后的解释器，三个身份都答得出真版本

```bash
/Users/example/.nvm/versions/node/v24.18.0/bin/node /usr/local/bin/claude --version
# → 2.8.4 (Claude Code)
/Users/example/.nvm/versions/node/v24.18.0/bin/node /Users/example/.nvm/versions/node/v22.22.3/bin/codex --version
# → codex-cli 0.154.0
/Users/example/.nvm/versions/node/v24.18.0/bin/node /Users/example/.nvm/versions/node/v22.22.3/bin/codebuddy-code --version
# → 2.151.0
```

### 2.5 真机 probe（修复前 → 修复后）

同一段脚本，注入无 node 的 PATH，直接调真实 registry（`scan:false, portProbe:false`）：

**修复前：**

```
claude            | available=true | version="env: node: No such file or directory"
codex             | available=true | version="env: node: No such file or directory"
codebuddy-code    | available=true | version="env: node: No such file or directory"
codebuddy-code-acp| available=true | version="env: node: No such file or directory"
workbuddy         | available=true | version="2.137.1"
workbuddy-ai      | available=true | version="2.137.1"
autoclaw          | available=true | version="2026.6.8"
```

**修复后：**

```
claude            | available=true | version="2.8.4"
codex             | available=true | version="0.154.0"
codebuddy-code    | available=true | version="2.151.0"
codebuddy-code-acp| available=true | version="2.151.0"
workbuddy         | available=true | version="2.137.1"
workbuddy-ai      | available=true | version="2.137.1"
autoclaw          | available=true | version="2026.6.8"
```

桌面三个身份**前后完全一致** —— 这就是「同一行代码、两条轨道命运不同」的直接证据。

---

## 3. 失败点（`file:line`）

| 站点 | 修复前 | 说明 |
|---|---|---|
| `src/kernel/registry.ts:509` | `const argv = [...(resolved.interpreterPath ? [resolved.interpreterPath] : []), resolved.executablePath ?? '', '--version']` | **缺陷本体。** 只认描述符钉的 `interpreter`，看不见 CLI 轨道写进 `command.interpreter` 的修复 |
| `src/kernel/registry.ts:241-286`（`defaultVersionProbe`） | stdout 与 stderr 一起进 `chunks`，再交给 `parseVersion` | **症状放大器。** 「找不到 semver → 取第一行非空文本」把子进程的错误信息变成 `version` |
| `src/kernel/spawn.ts:79-82`（`buildArgv`） | `const head = command.interpreter ? [command.interpreter, command.executable] : [command.executable]` | 同一份冻结规则的**第二份实现**。当时没出错（它的调用方 `integrate.ts:62` 只传 `{ executable }`），但它就是「第二个实现」这个 bug 类本身 |

---

## 4. H2：操作员到底在哪看到这行字

**看到的地方是 `agents_probe` 的工具输出。** 两个面都确认过：

- **模型/操作员面：`agents_probe` 的结构化输出 + 渲染表格。**
  `src/tools/definitions.ts:198-200`：

  ```ts
  const version = result.version === undefined ? '' : ` v${result.version}`
  return `${…} — ${status}; path=${path}${version}`
  ```

  于是那一行读作
  `✓ claude [claude] Claude Code CLI (claude) — available; path=/usr/local/bin/claude v env: node: No such file or directory`。
  `version` 也在 `output.schema` 里（`definitions.ts:434`），所以结构化结果里同样带着它。

- **监工 UI（client half）不显示它 —— 已排除。**
  `ClientProbeResult`（`src/client/util.ts:57-69`）**没有 `version` 字段**，
  `engineRow()`（`src/client/panel.ts:70-86`）只渲染 `track` / credential / models 数量，
  不可用时渲染 `reason`。全树 grep 确认 `src/client/**` 与 `src/host/api.ts` 都不出现
  `version` 的读取（只有注释里提到）。所以「面板那一行」不是它出现的地方。

- **也没有被吞掉。** 这正是本缺陷最坏的部分：失败**没有**变成 `version: undefined`，
  而是变成了一句**看起来像版本号的错误文本**，而且该身份仍是 `available: true`。
  所以交付要求 4 的两种处理里，「不要留一个没有任何字段解释的 caveat」是必须做的：
  见 §6.2。

---

## 5. H3：全树进程 spawn 站点审计

`grep -rn "nodeSpawn|spawnSync|execFile|child_process|spawn\(" src/` 的全部命中，逐个判定：

| 站点 | 是否重推导 `[interpreter, executable, …]` | 结论 |
|---|---|---|
| `src/kernel/spawn.ts:171` `nodeSpawn(argv[0], argv.slice(1))` | 否 | 原始 spawn，argv 来自 `buildArgv` |
| `src/kernel/spawn.ts:79-82` `buildArgv` | **是（第二份实现）** | 已改为委托唯一实现（§6.1） |
| `src/kernel/registry.ts:258` `nodeSpawn(file, argv.slice(1))` | 否（它只负责跑） | 但**它的调用方**在 `registry.ts:509` 手工拼 argv —— 已修（§6.1） |
| `src/drivers/argv.ts:180` `buildCommandLine` | 是（**规范实现**） | 已上移为 `src/kernel/command-line.ts`，此处改为再导出 |
| `src/drivers/claude.ts:892` → `rt.spawn`（`:952`） | 否 | 走 `buildCommandLine` |
| `src/drivers/codebuddy.ts` | 否 | 复用 claude 驱动，无自己的 argv 拼装 |
| `src/drivers/codex.ts:632` → `rt.spawn`（`:663`） | 否 | 走 `buildCommandLine` |
| `src/drivers/openclaw.ts:703` → `rt.spawn`（`:735`） | 否 | 走 `buildCommandLine` |
| `src/drivers/acp.ts:1595` → `rt.spawn`（`:1615`） | 否 | 走 `buildCommandLine`（`protocolArgs` 由 `buildAcpArgs` 单独贡献） |
| `src/drivers/generic-argv.ts:170` → `rt.spawn`（`:189`） | 否 | 走 `buildCommandLine` |
| `src/drivers/acp.ts:1386` `this.#spawn(spec)` | **不适用** | 这是 ACP `terminal/*` 回调，替**被驱动的 agent** 起它要的进程（`{command,args}` 或 `/bin/sh -c`）。这里没有 `CommandSpec`，也不该有解释器规则 |
| `src/integrate.ts:65` `spawnDetached({ command: { executable: spec.command }, args: spec.args })` | 否 | 适配层；`buildCommandLine` 已经在上游把 interpreter 折进扁平命令行，所以这里传裸 `CommandSpec` 是对的 |

**结论**：重推导规则的一共两处 —— `registry.ts:509`（缺陷）与 `spawn.ts:79`（第二份实现）。
其余站点要么走共享构造函数，要么（ACP 的 `terminal/*`）根本不涉及这条规则。
两处都已收敛到一个实现。

---

## 6. 修复

### 6.1 一个 argv 构造函数，探针与跑路径共用

- 新增 `src/kernel/command-line.ts`：**唯一**的 `buildCommandLine()`。放在 `kernel/` 是因为
  两侧都要用它，而 `kernel/**` **不许** import `drivers/**`（D3 / `src/integrate.ts` 的模块说明）；
  `drivers/**` 反过来 import `kernel/types.ts` 早就是常态，所以 `kernel/` 是两者都能依赖的那一层。
- `src/drivers/argv.ts:181` 改为 `export { buildCommandLine } from '../kernel/command-line.ts'`
  —— 名字与导入路径不变，五个 driver 与既有单测**一行都没改**。
- `src/kernel/spawn.ts:88` 的 `buildArgv` 改为**委托**（`buildCommandLine` + 扁平化）。
  保留这个导出是因为 `tests/kernel/spawn.test.ts` 与 `tests/integration/argv-shape.test.ts`
  断言的是「操作系统真正收到的那条向量」；但它的函数体里**再也不能出现 `if (command.interpreter)`**。
- `src/kernel/registry.ts:574` 的版本探测改为：

  ```ts
  const line = buildCommandLine(resolved.command, ['--version'])
  const argv = [line.command, ...line.args]
  ```

  **探测必须在 `resolve()` 之后跑** —— 而它本来就是（`probeOne` 第一行就是 `resolve()`）。
  CLI 轨道的 shim 修复因此**先于**版本探测生效，不需要把修复抄第二遍。
  注意 argv 里现在**包含 `argsPrefix`**（`autoclaw` 的 `--profile autoclaw`）—— 这正是
  「探针与跑路径同一条构造」的含义；真机复验过它不影响取版本（§2.5，`2026.6.8` 不变）。

### 6.2 版本号只能是版本号

- `VersionProbeOutcome`（`registry.ts:96-108`）：`{ version?, diagnostic? }`。
  `VersionProbe` 的返回类型放宽成 `string | VersionProbeOutcome | undefined` ——
  **纯放宽**，既有注入器返回字符串/undefined/抛错全都照旧编译（一个测试都没动）。
- `defaultVersionProbe` 现在**分开收集 stdout 与 stderr**：版本只从 **stdout** 解析；
  stderr、spawn 失败、超时各自成为 `diagnostic`。
- `probeOne`（`registry.ts:593-598`）：拿到版本就不出声；拿不到版本但**有** diagnostic 时，
  往 `notes` 追加一行自解释的 caveat：

  ```
  [probe] --version failed: env: node: No such file or directory
  ```

  写法沿用既有的 `[scan] …` 前缀约定。**没有**占用 `health.detail` ——
  那个字段已经承载凭据说明（`src/tracks/health.ts`、`src/client/util.ts:417`），
  覆盖它会丢掉真正的凭据解释。
- 契约不变：探测实现**永远不能**让 `probe()` 失败（`try/catch` 仍在），
  **未知版本不是错误**（仍是 `available: true`，只是没有 `version`）。

  **一处诚实的边界**：`notes` 在 `agents_probe` 的**结构化输出**里
  （`output.schema` 有 `notes`），但 `renderProbe()`（`tools/definitions.ts:196-201`）
  **不渲染 `notes`** —— 表格只印 `path` 与 `version`。这是既有设计（描述符的 `notes`
  是几百字的散文，印进表格会毁掉可读性），本工作流**没有**改渲染器：
  所以「不可修复的 shim」这一行的原因，**模型**在结构化结果里读得到，
  而**人**在渲染表格里看不到。本工作流不把它算作「无人解释的 caveat」
  （字段本身自解释：它点名了失败的命令），但也不假装它出现在表格里。

### 6.3 顺带记录但**未改**的一处

`src/tracks/cli/index.ts:166-193` 已经算出了一句很有用的诊断
（`repaired node shim (…) with …` / `node shim (…) but no usable node interpreter was found`），
然后 `void detail` 把它**丢掉**了（注释说「由调用方经 logger 带出」，但调用方没做）。
把它接到探测行需要给 `CommandSpec` 或 `LaunchResult` 加字段 —— 那是 ABI 变更，
本工作流按任务书要求**不动冻结 ABI**。§6.2 的 `[probe]` 行已经覆盖了同一个事实
（shim 起不来 → 行上写明原因），所以这里只记录，不改。

---

## 7. 护栏（两个新文件 / 一个新 describe，都验证过「会真红」）

| 测试 | 位置 | 修复前 | 修复后 |
|---|---|---|---|
| 夹具 shim + 无 node PATH + **真** `defaultVersionProbe`：版本必须读得到 | `tests/kernel/registry-node-shim.test.ts` | **4/5 失败**（关键两条：`expected 'env: node: No such file or directory' to be '9.9.9'`、`expected 'env: node: No such file or directory' to be undefined`） | 5/5 通过 |
| 探针 argv == 跑路径 argv（**捕获**真实探测调用的 argv 再比对） | `tests/integration/argv-shape.test.ts` 新 describe | **1/6 失败**（`claude: the probe must spawn the run path's command line`，收到的向量是 `[<tmp>/claude, --version]`，缺了解释器） | 6/6 通过 |
| `defaultVersionProbe` 只从 stdout 取版本 | 同上文件 | 2 条失败 | 通过 |

夹具是 `tests/fixtures/node-shim-cli.mjs`（`#!/usr/bin/env node`，打印 `9.9.9 (fixture-node-shim)`）。
两个测试都**不碰本机真实 CLI**：解释器用 `process.execPath`（跑测试的那个 node）注入，
或用一个假的绝对路径。

护栏的关键设计：探针 argv 是**从一次真实 `probe()` 调用里捕获的**，再和「跑路径用同一份
`CommandSpec` 推出来的向量」比对。手工拼 argv 的实现**不可能**满足它 ——
这正是「让漂移无法再被引入」的那一点。

---

## 8. 未验证 / 未做的事

- **没在真实 GUI 宿主里点开面板复验。** 本工作流在**本机 shell** 上以
  「PATH 无 node」的环境复现了同一条链路（§2.5），并确认监工 UI 根本不接收 `version`
  （§4）。要 100% 确认操作员看到的**就是** `agents_probe` 那行，需要在宿主里跑一次
  `agents_probe`；本工作流没有可用的 GUI 宿主会话。
- **没验证 `codex` 的另一份安装（`/opt/homebrew/bin/codex`，原生二进制）在无 node PATH 下的行为** ——
  它不需要解释器，与本次缺陷无关；搜索顺序决定桥拿到 nvm 那份，这一点在 §2.2 已记录。
- **没跑任何真实 agent 任务**（`agents_run`）。本缺陷在探测阶段就结束了，
  跑路径本来就没有这个问题（§1.1）。
- **没改宿主 PATH、没碰 `~/.dsh/**`、没装任何东西**（任务书非目标）。
- **`version` 仍可能来自 stdout 上的非版本文本。** `parseVersion` 的「无 semver → 取第一行
  非空文本」回退**保留**了（有些 CLI 的版本号不是 semver 形状，删掉回退会让它们永远没有版本）。
  所以严格的界线是「**stdout** 才算候选、stderr 永远不算」—— 一个把诊断写进 **stdout** 且退出码
  非 0 的引擎仍会被误读成版本。本机三个身份都不是这样（§2.4 的 stdout 都是干净版本行），
  没有证据支持再收紧，因此**未做**；要收紧就得改成「退出码非 0 时忽略 stdout」，
  那是独立的一次改动。
- **`src/tracks/cli/index.ts` 里被丢掉的 `detail` 仍然被丢掉**（§6.3，有意为之）。
- **没有做 ABI 变更**：`src/kernel/types.ts` 一行未改。
