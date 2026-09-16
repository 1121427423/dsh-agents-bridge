# dsh-agents-bridge — 计划与决策追踪

> 每个阶段做完在这里勾选并记录证据（命令 + 实际输出）。上层设计见 `docs/design.md`。

## 决策记录

| # | 决策 | 理由 | 状态 |
|---|---|---|---|
| D1 | 传输用各家原生方言，不做 ACP（v2 再说） | WorkBuddy/AutoClaw 均不说 ACP；multica 源码即规格 | ✅ 已定 |
| D2 | MCP 只做向下工具注入，不做调度传输 | tool 语义缺会话生命周期；父上下文会被 transcript 灌爆 | ✅ 已定 |
| D3 | kernel 不 import drivers，工厂由入口注入 | kernel 可单测；driver 可插拔 | ✅ 已定 |
| D4 | 形态 `bundle`（纯 Node half，无 client） | 与同仓 `dsh-background-promotion` 一致；P4 加 UI 时直接加 client half | ✅ 已定 |
| D5 | `agents_run` 立即返回 sessionId，绝不等待 | 工具调用有超时，agent 任务是分钟级 | ✅ 已定 |
| D6 | 契约冻结在 `src/kernel/types.ts` | 三个并行工作流的安全边界 | ✅ 已定 |
| D7 | WorkBuddy 用 `interpreter` 指自带 node | 实测 `env: node: No such file or directory`（PATH 无 node） | ✅ 已验证 |
| D8 | MiMo 标 `unsupported`，不进 v1 | agent 循环封在 asar，无 CLI/ACP/daemon 入口 | ✅ 已验证 |
| D9 | `connect` 模式只留字段不实现 | openclaw gateway / sidecar 有需求但非首个验证目标 | ✅ 已定 |
| D10 | 依赖树直接复用兄弟项目 `dsh-background-promotion/node_modules` | pnpm 解析 `@deepseek-ai/dsh-type-meta` 失败（该包从未发布到 registry，兄弟项目用 npm 装的同版本树可用） | ✅ 已解决 |
| D11 | `openclaw` 驱动额外支持 `--thinking`（映射 `effort`） | 实测 OpenClaw 2026.6.8 的 `agent` 子命令有该 flag，multica 版本没有 | ✅ 已核实 |
| D12 | `autoclaw` 身份 argv 前缀为 `['--profile','autoclaw']`（**不含 `agent`**） | 裸跑报 config invalid（`~/.openclaw/openclaw.json` 是 stub）；`--profile autoclaw` 实测 `Config valid`。**2026-09-17 更正**：原记为 `['--profile','autoclaw','agent']`，那个值本身就会让最终 argv 变成 `… agent agent …`（driver 的 `buildOpenclawArgs()` 已经把 `agent` 放在第一个），实测被 CLI 拒为 "Too many arguments for this command."。`agent` 归 driver，profile 归描述符 | ✅ 已验证（真机跑通，见下方 P1 验收） |
| D13 | 驱动解析必须「白名单 + 静默忽略未知事件」 | codebuddy 实测发出 `system/status`、`file-history-snapshot` 等 claude 文档外事件 | ✅ 已验证 |
| D14 | `session_id` 从 `system/init` 尽早捕获 | 实测 init 事件即带 session_id（对应 multica 的 early resume-pointer pinning） | ✅ 已验证 |
| D15 | 冒烟命令用 `ctx.commands.register({name})`，名字 **不能含点号** | 实测本机 DSH 无 `ctx.command(...)`；命令名正则 `/^[a-z][a-z0-9_-]*$/u` 拒绝点号 → 命令名取 `agents-bridge-hello`。**dsh-plugin-studio 技能的 command-tool 配方对本版本 DSH 不适用** | ✅ 已修正 |
| D16 | `commands` 不放进 `inject`，改惰性 `ctx.get` | 放进 inject 会让无命令注册表的宿主把整个插件判为 INACTIVE（整条工具面一起丢） | ✅ 已定 |
| D17 | `exports['.']` 用字符串 `./lib/index.js` | DSH 插件合同校验器要求字符串形式；类型走顶层 `types` 字段，不影响 TS | ✅ 已修正 |
| D18 | `src/integrate.ts` 作为 kernel↔drivers 的唯一适配层 | 两侧并行定下的形状不一致（行回调 vs stream、cancel vs terminate、SpawnExit vs ProcessExit）；单独适配比改任一冻结接口更安全 | ✅ 已实现 |
| D19 | 模型目录从**服务端下发的缓存**读取，不搜 app 内置字符串 | 更正：`deepseek-v4.1-flash` 确实存在（0.03x、1M/默认300K、原生多模态），它在 `~/.workbuddy/cache/acc-product-config-v3.json` 里；我先前只搜 app.asar 内置串因而误判 | ✅ 已定位 |
| D20 | `agents_probe` 增补模型发现（P3） | 对应 multica `ModelDiscoveryFunc`；有了可取值的模型目录，`agents_run{model}` 才可校验，别名映射（按 `credits` 选性价比、按 `supportsImages` 判多模态）才有真实落点 | ✅ 已实现 |
| D24 | P3 扫描**只读真实文件、绝不读 `app.asar`**；身份由 `product.json` 决定而非 bundle 名 | 实测两个 WorkBuddy 的 launcher 字节相同，唯一区别是 `cli/product.json` 的 `dataFolderName`/`isOversea`；按目录名猜会在重命名或多语言包上直接错。asar 是 297MB 存档，读它要解包器且零新增事实 | ✅ 已验证 |
| D25 | P3 端口指纹**默认期望表为空**，且**永不影响 `available`** | 本机没有已验证的 gateway 端口，猜一个就是往探测输出塞假事实；且"没在监听"是桌面应用的常态（应用没开），不能因此把可启动的身份判为不可用——`available` 只回答"能不能真启动" | ✅ 已定 |
| D28 | **argv 所有权切分**：driver 独占「子命令」token（openclaw 的 `agent`、codex 的 `exec`），描述符的 `argsPrefix` 只放 driver 无法知道的全局 token（`--profile autoclaw`、wrappers） | 两个 openclaw 身份都曾在 `argsPrefix` 里重复 driver 的子命令，`spawn.ts` 直接拼接后得到 `… agent agent …`，被 CLI 拒为 "Too many arguments for this command."。既有测试全部只断言**单个字段**（`argsPrefix === ['agent']`），于是每个测试都通过、唯独真正交给操作系统的 argv 是错的。护栏：`tests/integration/argv-shape.test.ts` 对**每一个内置身份**断言最终 argv（通用不变量：无相邻重复 token；openclaw 引擎的 `agent` 恰好出现一次；`--profile` 必须早于 `agent`） | ✅ 已实现 |
| D29 | **`src/kernel/types.ts` 仅改注释**（冻结 ABI 的例外，纯文档） | `CommandSpec.argsPrefix` 的示例仍写作 `['agent']` —— 正是 D28 那个 bug 的示范值，留着会继续误导下一个读者。**只改注释，不改任何字段、类型或可选性**，故 ABI 不变、无需版本号变更 | ✅ 已改（本工作流唯一触碰 types.ts 之处） |

## 任务拆分（3 个并行工作流）

文件所有权严格互斥：**越界即冲突**。所有工作流都只依赖 `src/kernel/types.ts`。

### Workstream A — kernel（`src/kernel/**`，除 types.ts）

| 文件 | 职责 |
|---|---|
| `registry.ts` | 内置描述符表（claude / workbuddy / autoclaw / openclaw / generic）+ `probe()`（PATH 与绝对路径解析、版本探测、`envPrefix` 覆盖、`unsupported` 处理、带 TTL 的缓存） |
| `spawn.ts` | `spawnDetached()`：detached process group、逐行 stdout/stderr 读取、graceful→grace→进程组 kill、退出码归一化 |
| `session.ts` | `AgentSessionHandle` 实现：事件缓冲、`done` promise、状态机、`snapshot()` |
| `watchdog.ts` | idle/硬超时定时器（可注入 clock，便于测试） |
| `store.ts` | 会话映射原子读写（`~/.dsh/state/dsh-agents-bridge/sessions.json`），损坏时降级为空 |
| `manager.ts` | `AgentManager` 实现：run/status/list/output/cancel/send/dispose；`createBackend` 注入 |
| `logger.ts` | 从 `console` 适配 `BridgeLogger` |

**验收**：`tsc --noEmit` 通过；kernel 单测（内存 fake backend）覆盖 run→output 增量→cancel 三段式→terminal；不 import `src/drivers/**`。

### Workstream B — drivers（`src/drivers/**`）

| 文件 | 职责 |
|---|---|
| `index.ts` | `DRIVER_FAMILIES` + `createBackend(family, deps)`；未知 family 抛错 |
| `claude.ts` | stream-json 解析（`assistant`/`user`/`system`/`result`/`log`/`control_request`；content `text`/`thinking`/`tool_use`）、argv 构造、`--resume`、blocked flags |
| `codebuddy.ts` | 复用 claude 解析 + WorkBuddy/CodeBuddy argv 差异 + `interpreter` 支持 |
| `openclaw.ts` | NDJSON 事件 + 最终 JSON 解析、`--local/--json/--session-id/--timeout/--agent/--message`、blocked args |
| `generic-argv.ts` | stdin 投喂 prompt、stdout 归一化、`--resume` 可选 |
| `argv.ts` | 共享 argv 构造与 custom args 过滤（blocked flag 表） |

**验收**：每个 driver 有单测（用 `tests/fixtures/*.ndjson` 假事件流，跑一个假可执行脚本）；`tsc --noEmit` 通过；不 import `src/kernel/**`（只 `import type` types.ts）。

### Workstream C — surface（`src/index.ts`、`src/tools/**`、`README.md`）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 导出 `inject = ['tools','systemPrompt']` + `apply(ctx, config)`；构造 manager；注册工具与 systemPrompt section；`ctx.effect()` 内注册并在 disposer 里 `dispose()` |
| `src/tools/definitions.ts` | 9 个 `defineTool(...)`（含 `output.schema` + `render`；E 加了 `agents_wait` / `agents_run_many` / `agents_usage`） |
| `src/tools/register.ts` | `ctx.tools.register(...)` 装配 + disposer 收集 |
| `src/tools/smoke.ts` | 冒烟命令 `/agents-bridge.hello`（`ctx.command`） |
| `README.md` | 安装/开发/验证说明 |

**验收**：`pnpm run build` 产出 `lib/index.js`；`inject` 覆盖所有用到的服务；注册全在 `ctx.effect()` 内并返回 disposer；不直接 import drivers（通过 manager）。

## 决策 D21–D23（两条实现）

**D21 — 集成轨道（track）是与协议族正交的独立轴，两个实现分开。**

`ProtocolFamily` 回答"说什么方言"，不回答"怎么在本机拿到一个可启动的引擎"。
两者独立（openclaw 同时存在于两条轨道上：PATH 上的二进制 vs AutoClaw.app 内的
`openclaw.mjs`）。因此 `AgentDescriptor.track` 是**必填**字段，两侧各自一个模块、
互不 import：

| | CLI 轨道 | 桌面轨道 |
|---|---|---|
| 启动物 | 用户自己装的二进制，裸名 + 搜索路径 | 应用包内绝对路径 |
| 找不到时 | 提示 `<PREFIX>_PATH` | "应用不在这" — 是发现，不是可修配置 |
| 凭据 | CLI 自己的配置；桥只读状态，不持有 | 应用自己的登录，复用 |
| 解释器 | 通常不需要（shim 才修复） | 必需（node 不随 PATH 来） |
| 失败模式 | GUI PATH 导致"装了但看不见" | 包路径过期 / profile 选错 |

实现位置：`src/tracks/{types,index}.ts`、`src/tracks/cli/**`、`src/tracks/desktop/**`；
kernel 只保留共享机制（`<PREFIX>_PATH` 覆盖、解析、`<exe> --version` 探测），
并按 `descriptor.track` 调 `policyFor(track).launch()`，自身不判断 agent id。
`notFoundReason()` 两轨共用，保证探测输出只有一种措辞。

**D22 — `codex` 方言**：ABI 已加 `'codex'` 族与 `codex` CLI 身份
（`codex exec --json` 输出 JSONL：`thread.started` / `item.completed` /
`turn.started` / `turn.completed` / `error`）。driver 由子代理实现中。

**D23 — `codebuddy-code` 放最后**（用户指定顺序）。`@tencent-ai/codebuddy-code@2.151.0`
已装（`~/.nvm/.../bin/{codebuddy,codebuddy-code,cbc}`，`#!/usr/bin/env node` 脚本）。
已完成侦察（`--help`，未跑真实请求）：

- **方言倾向 claude 族**：参数面与 Claude Code 几乎逐条对应 —— `-p/--print`、
  `--output-format text|json|stream-json`、`--input-format stream-json`、
  `--model`、`--permission-mode {acceptEdits,bypassPermissions,default,plan,dontAsk,auto}`、
  `--session-id`、`-r/--resume`、`--mcp-config`、`--dangerously-skip-permissions`、
  `--include-partial-messages`。与 WorkBuddy 内的 codebuddy 同源，因此预期**复用
  `claude` driver + 一个 dialect 配置**，而不是新写方言——但必须先用一次真实
  headless 抓包确认帧结构（`--output-format stream-json`），再落描述符。
- **额外发现**：它支持 `--acp`（ACP over stdin/stdout，ndJsonStream），这为 P4 的
  ACP driver 提供了本机可验证的第一个真实对端，不必只依赖 multica 的移植笔记。
- 模型 id：`default-model / fast-model / balanced-model / primary-model / deep-model`，
  以及 `gpt-5.6-sol|terra|luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.3-codex`、
  `gemini-3.5-flash`、`glm-5.3|5.2`、`kimi-k3|k2.6`、`minimax-m3`。
  **更正（实测）**：这些 id 只能当文档，**不能**当作模型发现的结果——
  `~/.codebuddy/models.json` 只有 19 字节的 `{"models": []}`，是用户缓存而非目录，
  报 `models: []` 等于宣称"这引擎不接受任何模型"。所以 `codebuddy-code` 的行为是
  **not discovered + 原因**，凭据是 `unknown`（`~/.codebuddy` 下没有任何 key/token
  文件，也没有复用桌面登录，所以既不是 `missing` 也不是 `not-applicable`）。
- **实测结论（已落地）**：方言 = `codebuddy` 族（不是 `claude`）。真抓包五个顶层帧
  与 WorkBuddy 完全同序同名（含两个未文档化帧），`apiKeySource` 同为
  `copilot.tencent.com`，且 `terminal_reason` 在 2.151.0 里根本不存在 → claude 的
  结构化原因读取器无字段可读。**零 ABI 变更**。默认模型（不传 `--model`）是 `hy3`。

**D27 — ACP driver（ABI v4，`ProtocolFamily += 'acp'`）。**

> 编号说明：ACP 这一条原先被写成**与上面决策表里「P3 扫描」那一行相同的号**（重号），现按审查
> 意见改为 **D27**（`D26` 是 P2 加固）；决策表里 P3 的两行**保持原号不动**。
> ABI 版本号以 `src/kernel/types.ts` 的 CHANGELOG 为准：**v3 = P2 加固（D26）**、
> **v4 = ACP driver（本条）**；本节正文原先写作 v3，一并更正。

D1 把 ACP 推给 v2，理由原文是「WorkBuddy/AutoClaw 均不说 ACP」——那个理由对**这两个
身份**成立，对「一条 driver entry 解锁多家 CLI」不成立：multica 里 hermes / kimi /
kiro / qoder / trae / grok / qwenpaw / dim / zeroclaw / mcode / reasonix 共 12 家说
ACP（`docs/multica-reference.md` §4 原本把 `acp_*.go` 列为「v2 移植」）。今天每接一家
要写一个方言 driver，有了 ACP driver 接一家 = 加一条描述符。**并且本机就有了第一个
可验证的真实对端**：`codebuddy-code --acp`（`--help` 原文 "…using ndJsonStream"），
所以这次不必只依赖移植笔记，能抓真实字节。

- **帧格式是 `ndJsonStream`，不是 LSP 的 `Content-Length` 头。** 一行一个 JSON-RPC
  对象。实测抓包确认（见「阶段状态」里的证据行），multica `hermes.go` 的
  `newAgentStreamScanner` 也是逐行读。
- **同一个二进制、两个身份。** `codebuddy-code` 已在 CLI catalog 里有一条**非 ACP**
  身份（`family:'codebuddy'`，D23）。ACP 那条是**不同身份**：id 取
  `codebuddy-code-acp`，协议选择走新增的 `AgentDescriptor.protocolArgs`
  （`['--acp']`），**不硬编码在 driver 里** —— 「怎么选中这条协议」是身份数据，
  与「这条协议怎么说」是两件事，混在一起就等于把某个 CLI 的具体 flag 焊进 ACP 协议族。
- **ABI v4 只做加法**：`ProtocolFamily += 'acp'`；新增可选字段
  `AgentDescriptor.protocolArgs`、`AgentDescriptor.capabilities.clientTools`、
  `ProbeResult.authMethods`。唯一「破坏性」的是联合类型多了一个成员，而它对**声明式**
  消费方是增量的（每个既有描述符照样编译），两个 `switch` 是穷尽式写法、编译器会点名
  —— 这正是我们要的提示方式，不是静默 fallback 到 `generic`。
- **安全红线：客户端侧能力必须落在 `opts.cwd` 之内。** ACP 的对端会反过来调我们
  （`fs/read_text_file` / `fs/write_text_file` / `terminal/create|output|wait_for_exit|
  kill|release`），这等于让被驱动的 agent 读写本机文件、起进程。策略：路径先
  `path.resolve(cwd, p)`，再对**最深的已存在祖先**做 `realpath`（否则一个
  `/tmp/link -> /etc` 的软链就能把所有检查绕过去），越界即以 JSON-RPC 错误拒绝并带上
  越界的路径与允许的根；`terminal/create` 的 `cwd` 同规则、默认取 `opts.cwd`。
  且这些能力**默认关闭**，由 `DSH_AGENTS_BRIDGE_ACP_FS` / `_ACP_TERMINAL` 显式开启，
  `initialize` 里只广播真正开启的位 —— 不能一边广播能力一边拒绝。
- **`session/request_permission` 照 multica 的语义，不照 claude 族。** claude 那边是
  「保持 stdin 打开自动批准 `control_request`」，ACP 这边是「从对端**真正给过的**
  optionId 里选一个」：先已知的会话级批准 id（`allow_session`/`approve_for_session`），
  再 `kind:"allow_once"`，再退到对端给过的 `reject_once`（只否掉这一个动作），
  **绝不自动选 `allow_always`** —— ACP v1 里 allow_always 会「记住选择」，在 Hermes 上
  落到运行时属主的磁盘 allowlist，比任务活得久。一个都选不了就回 `-32603` 协议错误，
  既不伪造没给过的 id，也不回 `cancelled`（那会被别的 ACP 后端读成整轮取消）。
- **归一化不新增 `AgentMessageType`**：`agent_message_chunk`→`text`、
  `agent_thought_chunk`→`thinking`、`tool_call`→`tool_use`、
  `tool_call_update`(completed/failed)→`tool_result`、
  `config_option_update`/`available_commands_update`/`session_info_update`→`status`、
  真正不认识的→`log`。usage 走 `AgentUsage` 四桶互斥（`reasoningTokens` 是披露项、
  不是桶，见 types.ts 注释），移植 `acp_usage.go` 的**逐桶取最大值**合并
  （`usage_update` 通知与终态 prompt 结果两条计量路径）。
- **终态判定**：`end_turn`→completed；`cancelled`→cancelled；`refusal`/
  `max_tokens`/`max_turn_requests`→failed；取消信号→cancelled；`timeoutMs`→timeout；
  起不来 / 无终态帧的非零退出→failed。**「refusal 也算 failed」有实测依据**：本机
  codebuddy-code 未登录时正是以**退出码 0** 回 `stopReason:"refusal"`，真正的错误
  （401 Authentication required）只藏在 `result._meta["codebuddy.ai/errorMessage"]`
  里，照 stopReason 字面读会把它报成一次正常的「模型拒答」。
- **对端会发没有 `id` 的请求。** 实测 `_codebuddy.ai/command` 帧就是 `method` 有、
  `id` 没有 —— JSON-RPC 不允许，但真实存在。所以读侧规则是「有 `id` 才回，没 `id`
  当通知丢弃」，否则我们会回一帧 `id:null` 的响应去污染对端状态机。
- **ACP 引擎是常驻服务，收工必须由我们主动关 stdin。** 这是实现期才暴露的坑：
  `session/prompt` 应答之后引擎**不会自己退出**（它是个 server），所以任何形如
  「等 `child.exited` 再定终态」的写法都会**永久挂住**——第一次跑测试时 23 个用例
  全部超时 20s，就是这个原因。multica 的写法一致（`hermes.go:717` 注释「Close stdin
  first so Hermes can observe EOF and exit cleanly」，随后 `hermesReaderDrainGrace`
  兜底强杀）。落地为 `AcpClient.shutdown(graceMs)`：先 `flushWrites()`，再 `stdin.end()`，
  在 `ACP_SHUTDOWN_GRACE_MS`（2s）内等退出，超时就 `terminate()` 整组。
- **客户端侧能力是 multica 没做过的增量，必须标注。** multica 的 `hermesClient` 对
  `fs/*` 一律回 `-32601 method not found`（`hermes_test.go:966` 就是这个断言），也就是
  它**从不广播** `clientCapabilities.fs`。本 driver 按任务要求**真的实现**了
  `fs/read_text_file` / `fs/write_text_file` / `terminal/*`，因此这里是**有意的分歧**，
  不是移植偏差：能力默认关闭（env 开启），开启了才广播，广播了就一定服务。

**被否决的替代方案**：① 把 `--acp` 写死在 driver 里（等于 ACP 协议族只能驱动
codebuddy-code，12 家变 1 家）；② 自动批准一切权限（含 `allow_always`）（把一个越界
的持久授权留给用户去收拾）；③ 无条件广播 terminal 能力（广播了就没人问我们为什么不
工作）；④ 用 `log` 兜住所有映射不上的 update（`status` 更有信息量，`log` 会把它降级成
噪声）。

**D26 — P2 加固（ABI v3）：策略拒绝必须是机器可读的，白名单必须是显式的。**

`src/kernel/types.ts` 的 v3 段落地的是 P2 那一轮加固。加的字段全在 `ManagerOptions`
（都是可选）：`allowedCwd` / `deniedCwd` / `allowedAgents` / `maxConcurrent`，
加上运行时侧的 `graceMs`（取消时 SIGTERM → SIGKILL 的宽限期；它走插件 `Config` →
`installDriverRuntime()`，**不在 `ManagerOptions` 上**，与上面四个宿主策略旋钮同属
v3 那一批）。配套新增 `RunRejectionCode` 联合与 `AgentRunRejectedError` 类。

- **为什么要有类型化的拒绝**：原来的拒绝是一条裸 `Error`，它唯一的契约是**消息文本**。
  调用方（工具层、测试、未来的 embedder）想区分「agent 不存在」和「cwd 越界」，就只能
  去匹配随时会被改写的散文 —— 那是把错误文案当成 API。改成 `AgentRunRejectedError`
  之后，`code`（`unknown-agent` / `unsupported-agent` / `agent-not-allowed` /
  `cwd-denied` / `cwd-not-allowed` / `cwd-unresolvable` / `max-concurrent`）是稳定的，
  `value` / `allowed` / `maxConcurrent` / `running` 把「被拒的值」和「能接受的范围」
  一起带出来，工具层才能在**不改内核**的前提下把错误渲染成「下一步改什么」。
  `tests/kernel/manager-policy.test.ts` 与 `tests/plugin-config.test.ts` 断言的就是
  `code` 而不是文案；工作流 E 的工具层因此选择**就地增强 message、保留同一个错误对象**，
  而不是把它包成新的 `Error`（包了就等于把 v3 的机器可读性丢掉）。
- **为什么是白名单**：`cwd` 与 agent 白名单是 `design.md` §10.4 点名的加固项
  （「spawn 任意 CLI = 任意代码执行」的缓解）。两处比较都在 `realpath` 之后做，
  所以 macOS 上 `/tmp` → `/private/tmp` 这种软链别名不能绕过；`maxConcurrent`
  超限**同步拒绝、绝不排队**，因为排队会先烧掉调用方自己的超时预算再失败。
- **尺度**：这套东西是「防模型手滑把 `cwd` 指到 `/`」，**不是沙箱**（§10.4 原话）。
- **纯增量**：五个旋钮全部可选，`RunRejectionCode` / `AgentRunRejectedError` 是新增
  导出。按老样子构造 `ManagerOptions` 的调用方行为一字不变，既有测试零改动通过。

**被否决的替代方案（P2 加固）**：① 用 `error.message.includes('cwd')` 这类字符串匹配
在工具层区分拒绝类型（文案一改就静默失效）；② 把白名单做成「拒绝时抛裸 `Error` +
不同文案」（调用方没有稳定契约，测试只能锁散文）；③ 超并发时**排队**等一个槽位
（会先耗尽工具调用自己的超时预算，最后失败得更难解释）。

## 阶段状态

- [x] 仓库创建 + git init + 骨架（package.json / tsconfig / cordis.patch.yml / build.mjs / types.ts）
- [x] **A · kernel 完成**：7 个模块 + 6 个测试文件，**50/50 单测通过**（修掉了 Clock 契约漂移：`Clock.now` 是方法，须经 `clock` 调用）
- [x] **C · 工具面完成**：入口 + 6 个 defineTool（E 之前；现为 9 个）+ 冒烟命令 + README；`tsc` 零错误；`pnpm run build` → `lib/index.js`
- [x] **B · drivers**：4 个方言 driver + argv 工具 + fixtures；两个遗留断言（`generic-argv` 的 argv、`openclaw` 无输出时的错误文案）已由后续工作流收敛 —— 当前 `vitest run` 全绿（见「交付指标」）
- [x] 集成：入口已接线 `installDriverRuntime()`；**端到端集成测试 5/5 通过**（真子进程 + 真 stream-json 解析 + 取消 + usage + resume 指针）
- [x] 合同校验：`verify_plugin.py` **11/11 PASS**
- [ ] 安装冒烟：装进 `desktop` profile → 重启 DSH → `/agents-bridge-hello` 与 `agents_probe` 可见（**待用户确认，因为需重启正在运行的会话**）
- [ ] **P1 验收：WorkBuddy 跑通一次真实任务（证据：agents_output 事件流）** — 前置已证：codebuddy headless 实测可跑（findings §5.1）。**注**：国内版 `workbuddy` 的上游当时 ETIMEDOUT（见 `docs/handoff-blockers.md` 记录 1）；国际版 `workbuddy-ai` 已用同一命令栈跑通（`status=completed`，`text: OK1`，11.6s，证据见 handoff-blockers §1.2）。两者是不同身份/不同上游，不能互相顶替，故国内版这一条仍留未勾。
- [x] **P1 验收：AutoClaw 跑通一次真实任务（证据：同上）** — **2026-09-17 通过**（工作流 F 修掉 argv 重复子命令后）。
  - 命令（`PATH=/opt/homebrew/bin:$PATH`）：
    ```bash
    node --experimental-strip-types scripts/acceptance.ts autoclaw "Reply with exactly: AUTOCLAW_OK"
    ```
  - 原始输出（两次独立运行结果一致，下为第二次全文，exit=0）：
    ```
    probe  autoclaw: track=desktop available=true
           executable=/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs version=2026.6.8 reason=-
    run    session=sess_0ecacf5a-8612-4fa2-bfa4-acc0e5f9f08d status=running

    events (1):
      [text] AUTOCLAW_OK

    result status=completed exit=0 durationMs=6827
    text: AUTOCLAW_OK
    usage: {"inputTokens":14268,"outputTokens":23,"cacheReadTokens":15104,"cacheWriteTokens":0}
    backendSessionId: 95b07772-8779-4e5e-80ef-e0e70445185d
    ```
  - 第一次运行：`session=sess_02da3568-… status=running` → `result status=completed exit=0 durationMs=7166`，`text: AUTOCLAW_OK`，`backendSessionId: 5ca9ade7-…`。
  - 修复前同一命令的失败形态（审查者实测，留作回归对照）：`status=failed exit=1 durationMs=1171`，`error: openclaw returned no parseable output: Too many arguments for this command.` —— 根因是最终 argv 里的 `… agent agent …`。
  - 另有一次**不经插件栈**的裸跑对照（证明 argv 形状本身可用）：`node <AutoClaw>/…/openclaw.mjs --profile autoclaw agent --local --json --session-id probe-test-1 --message "Reply with exactly: AUTOCLAW_OK"` → `"text": "AUTOCLAW_OK"`，`meta.durationMs: 3972`，`provider=zai`，HTTP `status=200`。
- [x] **两条实现落地（D21）**：ABI v2（`track` 必填）+ CLI/桌面两个 catalog 与 policy + 15 个新测试；`tsc` 0 错误，**159/159 通过**
- [x] **真机探测**：claude 2.8.4(/usr/local/bin，GUI PATH 下不可见)、codex 0.154.0(~/bin)、workbuddy 2.137.1、autoclaw 2026.6.8
- [x] **桌面轨道真机跑通**：WorkBuddy + `deepseek-v4.1-flash` 完成一次真实任务（`scripts/acceptance.ts`：10.4s，text=OK，usage + backendSessionId）
- [x] **CLI 轨道真机跑通（到引擎边界）**：claude 被搜索路径找到 → 子进程 → stream-json 解析 → 终态失败=引擎自己的上游 401（凭据不归桥管）
- [x] **D22 codex driver 完成**：`src/drivers/codex.ts` + 33 测试 + **真实抓包 fixtures**（本地 Responses stub 驱动真二进制）；真实端到端跑通（成功 / resume / 凭据失败三条路径）。三个关键发现：位置参数仍读 stdin 且不关就**永久阻塞**（与 claude 相反）、`turn.failed` 才是终态失败事件、`-c model_providers.OpenAI.*` 被拒为保留 id
- [x] **probe health / 模型发现（D20）**：`src/tracks/{health,models,host-files}.ts` + 60 个测试，已接进 `probe()`；真机输出 claude ok/6、codex ok/2、workbuddy n-a/51、autoclaw n-a/6、openclaw missing/未发现；关闭两个泄露面（V8 解析错误会回显输入、autoclaw 配置里存着 JWT）
- [x] **D23 codebuddy-code 完成**：`family: codebuddy`（真实字节决定，非照文档猜）+ 20 测试 + 真实抓包 fixture；已接进 `agents_probe`（avail=true 2.151.0）。抓的是一次**鉴权失败**——退出码 0、stderr 空、错误只在 `errors[]`/assistant 文本里，正是最有价值的证据
- [x] **桌面轨道新增 WorkBuddy AI（国际版）身份**：`workbuddy-ai`，与国内版是**两个 bundle、两个身份**（同一份字节相同的 launcher，靠各自 `product.json` 的 `dataFolderName` 选 `~/.workbuddy-ai` / `~/.workbuddy`）；`tests/tracks/desktop.test.ts` 11 个测试（含宿主相关断言：两份 product.json 的 dataFolderName 必须不同、launcher 字节相同）
- [x] **`workbuddy-ai` 的 health / models 两行补齐**（P3）：health = `not-applicable`（桌面登录，桥不持有凭据；实测 `~/.workbuddy-ai/security/` 下有 UUID 命名的凭据目录，而 `src/` 全树**不含 `security` 字样**，测试用 tripwire reader 断言"一个路径都没碰"）；models 读 `~/.workbuddy-ai/cache/acc-product-config-v3.json`（真机 22 个 id，含 `deepseek-v4.1-flash-sg` / `gpt-6-astra` / `gemini-3.5-flash`），**不读**国内版的目录；读失败（缺失/不可读/非法 JSON）一律降级为 "not discovered" 而非抛错（D19：服务端下发缓存，缺席是常态）
- [x] **P3 probe 泛化（app bundle 扫描 + 端口指纹）**：`src/tracks/desktop/{scan,port-probe}.ts` + 50 个测试
  - **扫描**：只读 `app.asar.unpacked/` 下的真实文件，**绝不读 `app.asar`**（297MB 存档）；身份来自 `product.json` 的 `applicationName`/`dataFolderName`/`isOversea`/`darwinBundleIdentifier`，**不靠 bundle 名猜**（实测 `WorkBuddy.app` 与 `WorkBuddy AI.app` 的 launcher 字节相同，只有 product.json 不同）；深度/单目录条目/单文件大小/整轮墙钟四重上限，任何异常降级为 "bundle unrecognized"；id 只由 bundle 相对路径与文件内容派生（无随机数、无时间戳、无绝对路径），可复现
  - **合并语义**：内置表优先（`mergeScannedIdentities`），扫描只做补充；被遮蔽的 bundle 进 `scanDiagnostics()`，不静默丢弃
  - **缓存**：复用 `registry.ts` 既有的 TTL probe 缓存，未新增第二套缓存机制（扫描结果额外 memoise：装了哪些 bundle 不随 60s TTL 变化）
  - **端口指纹**：只探 `127.0.0.1` / `::1`（`localhost` 明确拒绝，避免走 resolver）；连接超时 ≤300ms、并发封顶、整轮墙钟预算；失败一律静默降级。**只有端口 + 响应签名同时命中才算 `confirmed`**，否则只是**疑似**，且**两者都不得影响 `available`**（`available` 仍只由"能不能真启动"决定）。默认期望表为**空**：本机没有已验证的 gateway 端口，猜一个等于往探测输出里塞假事实
  - **扫描真机实测**：29ms 扫完 `/Applications` 的 64 个 bundle，识别出 AutoClaw 的 gateway（`Resources/gateway/openclaw/openclaw.mjs` + bundle 内 `Resources/node/darwin-arm64/node`），并按内置优先规则正确遮蔽
- [x] **P2 取消/续接/watchdog 打磨**：三段式取消（SIGTERM → grace → **进程组** SIGKILL）配孤儿证明测试（假 CLI fork 出孙进程 + 故意忽略 SIGTERM，cancel 后断言两个 pid 都 ESRCH）；watchdog 硬超时/idle 各自独立、终态 `timeout`、终态后定时器归零；`send` 对终态会话给可执行错误；`cwd`/agent 白名单（`realpath` 后比较）+ `maxConcurrent`（同步拒绝，不排队）；store 并发写者不再撞临时文件名（原 bug：per-instance 计数器 → 丢记录）。新增 81 个测试
- [x] **D27 ACP driver 完成**：ABI v4（`ProtocolFamily += 'acp'` + 三个可选字段，纯加法）+ `src/drivers/acp.ts` + CLI 轨道新身份 `codebuddy-code-acp` + `tests/fixtures/fake-acp-cli.mjs`（DERIVED，见 `tests/fixtures/ACP-PROVENANCE.md`）+ 44 个 ACP 测试。**真实端到端**（`DSH_ACP_E2E=1`，`@tencent-ai/codebuddy-code` 2.151.0）：走完 `initialize` → `session/new`（拿到真实 `backendSessionId` `01a0abca-7768-79fd-bb1e-d44abfb0125d`）→ `session/prompt`，通知流被正确归一化成 `status`（`session info update`、`available commands update: 49 commands`/`60 commands`），终态是**鉴权失败**（退出码 0、stderr 空、`stopReason:"refusal"`、401 只在 `result._meta["codebuddy.ai/errorMessage"]` 里）——与 D23 同款最有价值证据，且证明 `refusal`→failed 的映射真的生效（否则会把死凭据报成「模型拒答」）。五个实测发现：帧格式是无头的 NDJSON；对端会发**没有 `id` 的请求**（`_codebuddy.ai/command`）；`refusal` 不是「模型拒答」而是失败态；**引擎是常驻服务、不主动关 stdin 就永不退出**（见 D27 正文）；客户端能力是 multica 没做过的**有意增量**。安全红线：`fs/*`、`terminal/*` 全部限制在 `opts.cwd` 内（含 realpath 反软链穿越），且默认关闭、需 env 显式开启
- [x] **client half（监工 UI）落地**（工作流 A）：`src/client/**` + `src/host/api.ts` —— 宿主 HTTP 路由 `kind:"prefix"`、POST-only、复用 better-sidebar 的 `fence` 语义；`webServer` 用 `ctx.get` 惰性取而不进 `inject`（否则没有该服务的宿主会把整个插件判为 INACTIVE，D16），取不到只少 UI、工具面照常注册。client 侧按 slot 注册（`conversation.session.header.utilities` 常驻计数 + `sidebar.right.pane.tab` 完整面板，独立降级），增量读取回传 `nextIndex`，无会话时停轮询，中英双语 + 跟随宿主主题变量。`package.json` 加 `dsh.client` 与 `exports["./client"]`，`exports["."]` 保持字符串（D17）。新增 `lib/client.js` 产物与 `vitest.config.ts`（`tests/**` 锚定，避免 vitest 扫到兄弟 worktree——这个坑在合并期真实发生过）
- [x] **P4 并行 fan-out（工作流 E）**：工具面 6 → 9。`agents_wait`（有界等待：全部 / 任一（`until:"any"`）终态或超时即返回；**超时是正常返回**，`timedOut: true`，什么都不取消；`timeoutMs` 缺省 20s、上限硬编码 60s、超了**钳位并在 render 里说明**）+ `agents_run_many`（一次起 ≤16 个；**单项被拒不影响其余**，错误带 `runs[i]` 前缀；超 `maxConcurrent` **不排队**、该项直接报错）+ `agents_usage`（逐会话 + 汇总；`reasoningTokens` 单列、**不计入 `totalTokens`**，因为它已被引擎算在 `output` 之内）。同一次交付还收了：**错误文案人因化**（`describeRunFailure` 就地增强 v3 的类型化拒绝、`unknownSessionMessage` 列出已知会话；`tests/tools/error-copy.test.ts` 11 个用例把「说了下一步」锁住）、**系统提示段重写**（何时委派 / prompt 必须自包含 / 先 `agents_wait` 再 `agents_output` 且回传 `nextIndex` / 并行用 `agents_run_many` / 方向错了 `agents_cancel` / 只看得到归一化事件）。**不变量 1 未被触碰**：`agents_run.execute()` 依旧立即返回（`tests/tools/wait.test.ts` 有用例锁住）。**证据**：`pnpm exec vitest run` → **691 passed / 1 skipped（40 个文件）**；`pnpm exec tsc --noEmit` → 0 错误；`pnpm run build` → `lib/index.js` 309.1 KB + `lib/client.js` 59.1 KB。（P4 的另外两件 —— ACP driver 与监工 UI —— 见上面两行，均已合并。）

  - [x] **工作流 F · openclaw/autoclaw argv 重复子命令修复（2026-09-17）**：两个身份都跑不起来 —— `buildOpenclawArgs()`（`src/drivers/openclaw.ts:187`）**无条件**把 `agent` 放在 argv 最前，而 `spawn.ts:81` 的 `buildArgv()` 只是把 `argsPrefix` 拼在它前面，于是两个描述符里的 `argsPrefix: ['agent']` 把子命令变成了 `… agent agent …`，CLI 回 `Too many arguments for this command.`（审查者实测 `exit=1 durationMs=1171`）。
    - **修复**：`src/tracks/desktop/catalog.ts` 的 `autoclaw` → `argsPrefix: ['--profile','autoclaw']`（原来**连 profile 都没有**，会去读 `~/.openclaw/openclaw.json` stub 报 config invalid）；`src/tracks/cli/catalog.ts` 的 `openclaw` → **删掉整个 `argsPrefix`**（driver 自己会给 `agent`）。两个身份的 `notes` 一并改正：profile 由**描述符**提供，driver 只在 `openclawProfileFromArgsPrefix()` 里**读**它。
    - **护栏（本次最重要的产出）**：新增 `tests/integration/argv-shape.test.ts`（5 个用例）—— 对**每一个内置身份**用注入假 resolver 的 registry 解析出 `command`，再用 `spawn.ts` 的 `buildArgv()` 拼出最终 argv，断言：① 通用不变量「无相邻重复 token」；② 每个 openclaw 引擎的 `agent` **恰好出现一次**；③ `autoclaw` 的 `--profile` 值为 `autoclaw` 且**早于** `agent`；④ 没有身份的 `argsPrefix` 里出现 driver 独占的子命令（`agent`/`exec`）。**已验证它真的会红**：把两个描述符改回 bug 值后，5/5 全部失败（失败信息里能直接看到 `[ 'agent', 'agent', '--local' ]`）。测试不依赖宿主机安装（`scan: false` + `PATH: ''` + 注入 resolver）。
    - **修断言（不删测试）**：`tests/kernel/registry.test.ts`、`tests/tracks/scan.test.ts`、`tests/tracks/desktop.test.ts` 三处把 bug 值当期望值的断言改成正确值（`['--profile','autoclaw']` / `toBeUndefined()`）。`tests/drivers/openclaw.test.ts` 里 `openclawProfileFromArgsPrefix(['--profile','autoclaw','agent'])` 是 helper 单测，保留。
    - **真机验收通过**：`scripts/acceptance.ts autoclaw "Reply with exactly: AUTOCLAW_OK"` → `status=completed exit=0 durationMs=6827`，`text: AUTOCLAW_OK`（原始输出见上方 P1 验收条目）。
    - **证据**：`pnpm exec vitest run` → **696 passed / 1 skipped（41 个文件）**；`tsc --noEmit` → 0 错误；`pnpm run build` → 见交付指标。

## 交付指标（当前）

> 下表所有数字来自工作流 F 合并后**本机真跑**：`pnpm exec vitest run` / `pnpm exec tsc --noEmit` / `pnpm run build`。

| 指标 | 值 |
|---|---|
| TS 文件 | 90 个（src 42 / tests 45 / scripts 3） |
| 测试 | **696 个通过 + 1 skipped（41 个文件）** —— 基线 691/1（40 文件）；F 新增 5 个（`tests/integration/argv-shape.test.ts`），零删除、零跳过 |
| `tsc --noEmit` | 0 错误 |
| 构建产物 · `lib/index.js` | 310.1 KB（esbuild，`@deepseek-ai/*` 全部 external） |
| 构建产物 · `lib/client.js` | 59.1 KB（web platform，`react` external） |
| 工具面 | **9 个**（`agents_probe` / `run` / `run_many` / `status` / `wait` / `output` / `usage` / `cancel` / `send`） |
| 合同校验 | 11/11 PASS（**上一轮**结论；`verify_plugin.py` 不在本仓，本轮未重跑。E/F 只加 `defineTool` 与注释、未动 `package.json` / `exports` / `cordis.patch.yml`，合同面未变） |
| 端到端集成 | `tests/integration/pipeline.test.ts`（真子进程 + 真 stream-json 解析 + 取消 + usage + resume 指针）全绿；`tests/integration/argv-shape.test.ts`（每个内置身份的最终 argv 形状，5 个用例）全绿 |
| 真机验收 | `autoclaw` 端到端 **completed**（`scripts/acceptance.ts`，7.2s/6.8s 两次，`text: AUTOCLAW_OK`） |
