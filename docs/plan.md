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
| D12 | `autoclaw` 身份 argv 前缀为 `['--profile','autoclaw','agent']` | 裸跑报 config invalid（`~/.openclaw/openclaw.json` 是 stub）；`--profile autoclaw` 实测 `Config valid` | ✅ 已验证 |
| D13 | 驱动解析必须「白名单 + 静默忽略未知事件」 | codebuddy 实测发出 `system/status`、`file-history-snapshot` 等 claude 文档外事件 | ✅ 已验证 |
| D14 | `session_id` 从 `system/init` 尽早捕获 | 实测 init 事件即带 session_id（对应 multica 的 early resume-pointer pinning） | ✅ 已验证 |
| D15 | 冒烟命令用 `ctx.commands.register({name})`，名字 **不能含点号** | 实测本机 DSH 无 `ctx.command(...)`；命令名正则 `/^[a-z][a-z0-9_-]*$/u` 拒绝点号 → 命令名取 `agents-bridge-hello`。**dsh-plugin-studio 技能的 command-tool 配方对本版本 DSH 不适用** | ✅ 已修正 |
| D16 | `commands` 不放进 `inject`，改惰性 `ctx.get` | 放进 inject 会让无命令注册表的宿主把整个插件判为 INACTIVE（6 个工具一起丢） | ✅ 已定 |
| D17 | `exports['.']` 用字符串 `./lib/index.js` | DSH 插件合同校验器要求字符串形式；类型走顶层 `types` 字段，不影响 TS | ✅ 已修正 |
| D18 | `src/integrate.ts` 作为 kernel↔drivers 的唯一适配层 | 两侧并行定下的形状不一致（行回调 vs stream、cancel vs terminate、SpawnExit vs ProcessExit）；单独适配比改任一冻结接口更安全 | ✅ 已实现 |
| D19 | 模型目录从**服务端下发的缓存**读取，不搜 app 内置字符串 | 更正：`deepseek-v4.1-flash` 确实存在（0.03x、1M/默认300K、原生多模态），它在 `~/.workbuddy/cache/acc-product-config-v3.json` 里；我先前只搜 app.asar 内置串因而误判 | ✅ 已定位 |
| D20 | `agents_probe` 增补模型发现（P3） | 对应 multica `ModelDiscoveryFunc`；有了可取值的模型目录，`agents_run{model}` 才可校验，别名映射（按 `credits` 选性价比、按 `supportsImages` 判多模态）才有真实落点 | ⏳ P3 |

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
| `src/tools/definitions.ts` | 6 个 `defineTool(...)`（含 `output.schema` + `render`） |
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
  `gemini-3.5-flash`、`glm-5.3|5.2`、`kimi-k3|k2.6`、`minimax-m3`（可直接喂给
  模型发现，无需读配置文件）。

## 阶段状态

- [x] 仓库创建 + git init + 骨架（package.json / tsconfig / cordis.patch.yml / build.mjs / types.ts）
- [x] **A · kernel 完成**：7 个模块 + 6 个测试文件，**50/50 单测通过**（修掉了 Clock 契约漂移：`Clock.now` 是方法，须经 `clock` 调用）
- [x] **C · 工具面完成**：入口 + 6 个 defineTool + 冒烟命令 + README；`tsc` 零错误；`pnpm run build` → `lib/index.js`
- [~] **B · drivers**：4 个方言 driver + argv 工具 + fixtures 已落盘，**B 仍在收敛 2 个测试失败**（`generic-argv` 的 argv 断言、`openclaw` 无输出时的错误文案）
- [x] 集成：入口已接线 `installDriverRuntime()`；**端到端集成测试 5/5 通过**（真子进程 + 真 stream-json 解析 + 取消 + usage + resume 指针）
- [x] 合同校验：`verify_plugin.py` **11/11 PASS**
- [ ] 安装冒烟：装进 `desktop` profile → 重启 DSH → `/agents-bridge-hello` 与 `agents_probe` 可见（**待用户确认，因为需重启正在运行的会话**）
- [ ] **P1 验收：WorkBuddy 跑通一次真实任务（证据：agents_output 事件流）** — 前置已证：codebuddy headless 实测可跑（findings §5.1）
- [ ] **P1 验收：AutoClaw 跑通一次真实任务（证据：同上）** — 前置已证：`--profile autoclaw` 配置有效（findings §5.2）
- [x] **两条实现落地（D21）**：ABI v2（`track` 必填）+ CLI/桌面两个 catalog 与 policy + 15 个新测试；`tsc` 0 错误，**159/159 通过**
- [x] **真机探测**：claude 2.8.4(/usr/local/bin，GUI PATH 下不可见)、codex 0.154.0(~/bin)、workbuddy 2.137.1、autoclaw 2026.6.8
- [x] **桌面轨道真机跑通**：WorkBuddy + `deepseek-v4.1-flash` 完成一次真实任务（`scripts/acceptance.ts`：10.4s，text=OK，usage + backendSessionId）
- [x] **CLI 轨道真机跑通（到引擎边界）**：claude 被搜索路径找到 → 子进程 → stream-json 解析 → 终态失败=引擎自己的上游 401（凭据不归桥管）
- [x] **D22 codex driver 完成**：`src/drivers/codex.ts` + 33 测试 + **真实抓包 fixtures**（本地 Responses stub 驱动真二进制）；真实端到端跑通（成功 / resume / 凭据失败三条路径）。三个关键发现：位置参数仍读 stdin 且不关就**永久阻塞**（与 claude 相反）、`turn.failed` 才是终态失败事件、`-c model_providers.OpenAI.*` 被拒为保留 id
- [x] **probe health / 模型发现（D20）**：`src/tracks/{health,models,host-files}.ts` + 60 个测试，已接进 `probe()`；真机输出 claude ok/6、codex ok/2、workbuddy n-a/51、autoclaw n-a/6、openclaw missing/未发现；关闭两个泄露面（V8 解析错误会回显输入、autoclaw 配置里存着 JWT）
- [ ] **D23 codebuddy-code**（最后做，先抓包验证方言）
- [x] **桌面轨道新增 WorkBuddy AI（国际版）身份**：`workbuddy-ai`，与国内版是**两个 bundle、两个身份**（同一份字节相同的 launcher，靠各自 `product.json` 的 `dataFolderName` 选 `~/.workbuddy-ai` / `~/.workbuddy`）；`tests/tracks/desktop.test.ts` 11 个测试（含宿主相关断言：两份 product.json 的 dataFolderName 必须不同、launcher 字节相同）
- [ ] 待两个子代理收工后补 `workbuddy-ai` 的 health（`not-applicable`）与 models（`~/.workbuddy-ai/cache/acc-product-config-v3.json`，22 个 id）行——**同一文件同一时刻只允许一个写者**
- [ ] P2 取消/续接/watchdog 打磨
- [ ] P3 probe 泛化（app bundle 扫描 + 端口指纹）
- [ ] P4 ACP driver / 监工 UI / 并行 fan-out

## 交付指标（当前）

| 指标 | 值 |
|---|---|
| TS 文件 | 45 个（src 33 / tests 11 / scripts 1） |
| 测试 | **296 个全部通过**（+33 codex、+20 codebuddy-code、+9 desktop、+… 见各 commit） |
| `tsc --noEmit` | 0 错误 |
| 构建产物 | `lib/index.js` 129.3 KB |
| 合同校验 | 11/11 PASS |
| 端到端集成 | 5/5 PASS |
