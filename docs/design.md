# dsh-agents-bridge — 设计文档

> 目标：让 **DSH 主 agent 把本机其他 agent CLI 当作工具来调用**，实现 agent 调 agent 的编排层。
> 参考实现：`~/BigModel/LLM/tools/multica`（Go，26 家 agent CLI 适配的实战代码，本项目把它当权威规格）。
> 首个验证对象：**WorkBuddy（腾讯，内置 CodeBuddy CLI）** 与 **AutoClaw（智谱，内置 openclaw 引擎）**。

---

## 1. 目标与非目标

**目标**

1. 主 agent 能发现（probe）、启动（run / run_many）、观察（status / wait / output / usage）、打断（cancel）、续接（send）本机 agent CLI。
2. 一次 run 是**异步长任务**：立即返回 `sessionId`，事件流增量拉取——规避工具调用的超时语义（multica 的 daemon 也是这个模型）。
3. 加一个新 CLI = **加一条 registry 描述符**，不写新驱动（协议家族复用）。
4. 复用为主：方言解析、argv 构造、blocked flags、超时策略全部以 multica 源码为规格移植。

**非目标（v1 明确不做）**

- 不做看板/issue/任务队列（multica 的 server+daemon 外壳）——DSH 主 agent 就是调度器。
- 不做 GUI 监工页（P4 再说）。v1 为 `bundle` 形态、纯 Node half。
- 不做 `connect` 模式（拨已运行实例：openclaw gateway、WorkBuddy sidecar）。契约留字段，实现留空。
- 不做 ACP driver（v2；见 §3 协议决策）。**→ 已兑现：D27（`docs/plan.md`）落地 ACP driver（ABI v4）。**

---

## 2. 架构分层

```
DSH 主 agent
    │  调用 9 个工具（agents_probe / run / run_many / status / wait / output / usage / cancel / send）
    ▼
src/index.ts            ← 插件入口：inject ['tools','systemPrompt']，注册工具 + 系统提示段
    ▼
AgentManager (kernel)   ← 会话注册表 + 生命周期 + watchdog + 存储；**不认识任何方言**
    ▼  createBackend(family, deps)      ← 由入口注入的工厂（kernel 不 import drivers）
src/drivers/index.ts    ← family → driver 表
    ├── claude.ts       ← claude stream-json 方言（也覆盖 Claude Code）
    ├── codebuddy.ts    ← CodeBuddy/WorkBuddy（claude fork，argv 略有差异 + interpreter）
    ├── openclaw.ts     ← OpenClaw/AutoClaw（NDJSON + 保留 gateway 槽位）
    └── generic-argv.ts ← 一次性 `-p` 兜底（qwen/gemini/其他长尾）
    ▼
子进程（spawn / detached process group）
```

**关键设计约束**

1. **kernel 不 import drivers**：工厂函数由入口注入（`ManagerOptions.createBackend`），保证 kernel 可单测、可换驱动。
2. **drivers 不认识会话存储**：driver 只负责「起进程 + 翻译事件流 + 归一化成 AgentMessage」，状态归 kernel。
3. **一切跨模块类型只在 `src/kernel/types.ts`**：那是冻结 ABI（见 §4）。

---

## 3. 协议决策（为什么不是 ACP / MCP）

结论：**统一在内部 `AgentBackend` 契约之下，传输用各家原生方言；ACP 留作 v2 的可选 driver；MCP 只作向下工具注入，不作调度传输。**

| 协议 | 定位 | 取舍 |
|---|---|---|
| **原生方言**（claude stream-json / codebuddy stream-json / openclaw NDJSON / 一次性 argv） | **v1 主力** | multica 25 家全部这么做，源码即规格；覆盖你要先试的 WorkBuddy + AutoClaw |
| **ACP**（JSON-RPC over stdio） | v2 可选 driver | 事实标准：multica 里 hermes/kimi/kiro/qoder/trae/grok/qwenpaw/dim/zeroclaw/mcode/reasonix 共 12 家走 ACP。但 **Claude Code / Codex / OpenClaw 都不说 ACP**，对你当前两个目标零收益 |
| **MCP** | 只做「向下注入」 | tool 语义是请求-响应，缺会话生命周期/打断/续接；子 agent 的 transcript 走 tool result 会灌爆父上下文。multica 里 MCP 只占 `ExecOptions.McpConfig` 一个字段，方向是注入子 agent |
| **A2A** | 不采用 | 面向远程联网 agent，本地 CLI 零支持 |

**桌面 app 的接入类型学**（本机实测结论，写进 probe 的判定逻辑）：

| 类型 | 特征 | 例 |
|---|---|---|
| ① 引擎原生 ACP | 有 ACP server 入口 | 少数新 CLI 的桌面壳 |
| ② 引擎自带 CLI/daemon 方言 | 可 spawn 或拨 API | **AutoClaw**（`gateway/openclaw/openclaw.mjs` NDJSON + 4 个 gateway 端口）、**WorkBuddy**（`cli/bin/codebuddy` + sidecar token） |
| ③ 纯 UI、引擎封死 | 无对外入口 | **MiMo**（agent 循环封在 asar）→ registry 里标 `unsupported`，probe 如实报告边界 |

---

## 4. 冻结契约

`src/kernel/types.ts` 是 ABI。要点：

- `CommandSpec{ executable, interpreter?, argsPrefix?, env? }` —— **`interpreter` 是实测逼出来的字段**：WorkBuddy 的 codebuddy 是 `#!/usr/bin/env node` 脚本，而本机 PATH 上没有 node，直接 spawn 会 `env: node: No such file or directory`。argv 规则：`[interpreter, executable, ...argsPrefix, ...runArgs]`。
- `AgentDescriptor{ id, family, command, envPrefix?, capabilities?, unsupported? }` —— 加 CLI = 加一条；`unsupported` 让「接不了」成为一等公民。
- `AgentBackend.run(opts, deps, signal) → AgentSessionHandle` —— 对应 multica 的 `Backend.Execute(...) → *Session`。
- `AgentMessage` / `AgentUsage` / `AgentResult` —— 对应 multica 的 `Message` / `TokenUsage` / 终态结果。
- `AgentManager` —— 工具面唯一依赖；kernel 实现它。

---

## 5. 模型可见的工具（9 个）

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `agents_probe` | `refresh?: boolean` | `ProbeResult[]` | 探测本机可用身份；冒烟点 |
| `agents_run` | `agent`, `prompt` (必填), `cwd?`, `model?`, `effort?`, `timeoutMs?`, `mode?` | `{sessionId, agent, status:'running', startedAt}` | **立即返回**，不等长任务 |
| `agents_run_many` | `runs: [{agent, prompt, cwd?, model?, effort?, timeoutMs?}]`（1..16） | `{requested, started, failed, runs:[{index, agent, started, sessionId?, status?, error?}], hint}` | 并行 fan-out：一次调用起 N 个；**单项被拒不影响其余**；超 `maxConcurrent` 不排队，该项直接报错 |
| `agents_status` | `sessionId?` | `{sessions: SessionSnapshot[]}` | 不传 = 全部活跃会话 |
| `agents_wait` | `sessionIds`（字符串或数组，必填）, `timeoutMs?`（缺省 20s，上限 60s）, `until?: 'all'\|'any'`, `sinceIndex?` | `{waitedMs, timedOut, until, timeoutMs, sessions:[{sessionId, agentId, status, terminal, waitedMs, nextIndex, result?, events?}], hint}` | **有界等待**：全部/任一终态或超时即返回。**超时是正常返回**（`timedOut: true`），不取消任何会话 |
| `agents_output` | `sessionId`, `sinceIndex?`, `limit?` | `{sessionId, status, messages, nextIndex, terminal, result, hint}` | 增量拉取，`nextIndex` 回传 |
| `agents_usage` | `sessionIds?`, `includeFinished?`（缺省 true） | `{sessions:[...], summary:{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, reasoningTokens, sessions, running, finished, totalDurationMs}, note}` | 用量汇总。**`reasoningTokens` 是披露项、不计入 `totalTokens`**（引擎把它算在 output 内） |
| `agents_cancel` | `sessionId`, `reason?` | `{sessionId, cancelled, status, note}` | 三段式取消 |
| `agents_send` | `sessionId`, `prompt` | `{sessionId, status, resumed, resumedFrom, messageCount}` | 续接（用后端 resume 指针续对话，新 bridge 会话跟踪；无指针则拒绝而非另起新会话） |

工具定义必须用 `defineTool`（`@deepseek-ai/dsh-tools`），每工具声明 `output.schema`（ValueSchemaSpec DSL）+ 纯函数 `render`。
另注册一段 `ctx.systemPrompt.section(...)`，告诉模型何时该委派、prompt 必须自包含、优先 `agents_wait` 而不是高频轮询。

**两条契约（E 明确下来的）**

1. **`agents_run` 的 `execute()` 永不等待**（D5）；等待是 `agents_wait` 的全部意义，两者不许合并。
2. **面向模型的每条错误都要说下一步**：哪个参数、什么值、为什么不行、合法范围/选项。
   回归锁在 `tests/tools/error-copy.test.ts`（unknown agent / cwd 白名单 / 会话不存在 /
   超并发 / `send` 到运行中会话 / 不可驱动的身份）。

---

## 6. v1 驱动与身份清单

| 身份 id | family | 命令 | 依据（multica） |
|---|---|---|---|
| `claude` | claude | `claude --output-format stream-json ...` | `server/pkg/agent/claude.go` |
| `workbuddy` | codebuddy | `<interpreter=node> <app>/cli/bin/codebuddy ...` | `codebuddy.go`（注释原话：a Claude Code fork） |
| `autoclaw` | openclaw | `<interpreter=node> /Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs agent --local --json ...` | `openclaw.go` |
| `openclaw` | openclaw | `openclaw agent --local --json ...`（PATH 版） | 同上 |
| `generic` 兜底 | generic | 可配置 `-p` 类 | `qwen.go` 的 stdin 投喂模式 |

**方言关键点（移植时对照 multica 源码与测试）**

- **claude / codebuddy**：事件类型 `assistant` / `user` / `system` / `result` / `log` / `control_request`；content block `text` / `thinking` / `tool_use`；argv 含 `--model`、`--effort`、`--max-turns`、`--append-system-prompt`、`--resume`、`--mcp-config`；`control_request` 需要自动批准（stdin 保持打开）。
- **openclaw**：`--json` 输出 NDJSON 事件流 + 最终 JSON；`--session-id`、`--timeout`、`--agent`、`--message`；`blockedArgs` 保护 `--json` 不被 custom_args 覆盖。
- **进程管理**：detached process group（`setsid`/`process group`），取消时 **先优雅信号 → grace → 杀进程组**（multica：`claudeTerminateGrace` 5s、`dshCancelGrace` 3s 等）。

---

## 7. 生命周期与守护

- **三种超时**：`timeoutMs`（硬墙钟，0 = 无）、`idleTimeoutMs`（无输出窗口）、驱动默认值。缺省策略表随 driver 走（multica 每个 backend 都有自己的 turn/watchdog 常数）。
- **取消三段式**：`SIGTERM` → grace（默认 5s）→ `SIGKILL` 进程组；幂等。
- **状态机**：`running → completed | failed | cancelled | timeout`，`terminal` 后不再变更。
- **会话存储**：`~/.dsh/state/dsh-agents-bridge/sessions.json`（原子写），记录 sessionId → {agentId, backendSessionId, cwd, startedAt, endedAt, status}，支撑 `send`（resume）与重启后 `status` 查询。内存中保留 transcript（v1 不落盘 transcript，避免写放大）。

---

## 8. 借鉴 multica 的取舍

**移植（权威规格）**：`Backend.Execute → Session` 契约、`Message`/`TokenUsage` 归一化、每家 argv 构造与 blocked flags、`ResumeSessionID` + 续接失败提示、watchdog 常数、进程组取消、`MULTICA_<ID>_PATH` 式 env 覆盖 → 我们的 `envPrefix`、`BuiltinRuntime` 描述符表 → 我们的 registry。

**砍掉**：server/daemon/issue/board/WebSocket/claim 任务、worktree 管理（改由调用方传 `cwd`）、前端三端、26 家里 v1 用不到的身份。

**不照抄**：multica 的 config-file 上下文注入（往 workdir 写 CLAUDE.md/AGENTS.md 标记块）。v1 先把 prompt 直接交给 CLI；上下文注入列为 P3 可选（它解决「CLI 不支持 inline system prompt」，对 claude/codebuddy 不需要）。

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 骨架 + `agents_probe` | 装进 DSH，`/agents-bridge` 命令与 `agents_probe` 工具可调用 |
| **P1** | kernel + 4 driver + 6 工具 | **WorkBuddy 与 AutoClaw 各跑通一次真实任务**，事件流可见 |
| P2 | 会话存储 + resume + watchdog | 取消能杀掉整棵进程树；`send` 能续接 |
| P3 | probe 泛化（app bundle 扫描 + 端口指纹）、上下文注入 | 新桌面 app 可自动发现 |
| P4 | ACP driver / 监工 UI / 并行 fan-out 对比 | 12 家 ACP CLI 一条 entry 解锁（**ACP driver 已完成：D27**）；监工 UI 已完成（client half）；**并行 fan-out 已完成（`agents_run_many` + `agents_wait` + `agents_usage`，工具面 6 → 9）** |

## 10. 风险与开放问题

1. **WorkBuddy 的 codebuddy 可能要求登录态**：它平时由 sidecar 带 token 管理。若裸跑 CLI 报未授权，降级路线是把 `interpreter/argsPrefix/env` 换成 sidecar 的 `connect` 模式（v1 留字段）。
2. **AutoClaw 的 openclaw.mjs 是否独立可跑**：已验证是标准 node 脚本；但首次运行可能要求 `--local` 之外的配置（`~/.openclaw/openclaw.json`）。失败则退到它的 gateway HTTP API（4 个端口在监听）。
3. **工具调用超时**：`agents_run` 立即返回是硬约束——任何驱动实现若在 `execute()` 里等待子进程结束，都违反设计。
4. **安全**：spawn 任意 CLI = 任意代码执行。v1 依赖 DSH 自身的 approval/sandbox 语义；`cwd` 与 agent 白名单作为 P2 的加固项。
