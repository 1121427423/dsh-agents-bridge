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

## 阶段状态

- [x] 仓库创建 + git init + 骨架（package.json / tsconfig / cordis.patch.yml / build.mjs / types.ts）
- [ ] A/B/C 三工作流实现（并行进行中）
- [ ] 集成：入口接线 + 构建通过
- [ ] 安装冒烟：`dsh plugin --profile web add .` → 重启 web → `agents_probe` 可见
- [ ] **P1 验收：WorkBuddy 跑通一次真实任务（证据：agents_output 事件流）**
- [ ] **P1 验收：AutoClaw 跑通一次真实任务（证据：同上）**
- [ ] P2 取消/续接/watchdog
- [ ] P3 probe 泛化
- [ ] P4 ACP driver / 监工 UI
