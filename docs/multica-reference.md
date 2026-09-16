# multica → dsh-agents-bridge 移植对照表

> 源码位置：`~/BigModel/LLM/tools/multica`（Go）。**这份 Go 代码是本项目 driver 层的权威规格**，实现时逐条对照，不要凭印象重写。
> 索引已建立（codebase MCP project: `Users-king-BigModel-LLM-tools-multica`，41861 节点）。

## 1. 契约层对照

| multica | 位置 | 本项目 |
|---|---|---|
| `Backend` 接口（唯一方法 `Execute`） | `server/pkg/agent/agent.go:18` | `AgentBackend.run()`（`src/kernel/types.ts`） |
| `ExecOptions`（Cwd/Model/Timeout/ResumeSessionID/ThinkingLevel/McpConfig/ExtraArgs/CustomArgs…） | `agent.go:26-140` | `AgentRunOptions`（取子集 + 加 `effort`） |
| `Session`（Messages 流 + Result + ToolActivity + TerminalObserved） | `agent.go:149-197` | `AgentSessionHandle` |
| `Message{Type,Content,Tool,CallID,Input,Output,Status,Level,SessionID}` | `agent.go:199-209` | `AgentMessage`（同构，`at` 为新增时间戳） |
| `TokenUsage`（四桶互斥） | `agent.go:216-230` | `AgentUsage` |
| `SupportedTypes`（协议家族清单，25 家） | `agent.go:350-375` | `ProtocolFamily`（v1 四个） |
| `BuiltinRuntime` 描述符表（身份 fork 复用协议） | `builtin_runtimes.go:18-70, 87+` | `AgentDescriptor` + registry 表 |
| `ModelDiscoveryFunc` | `builtin_runtimes.go:77` | v1 不做（`agents_probe` 只报可用性） |
| `Config.ExecutablePath` / `MULTICA_<ID>_PATH` 覆盖 | `agent.go:296`、`builtin_runtimes.go:34-36` | `CommandSpec.executable` + `AgentDescriptor.envPrefix` |
| `New()` 工厂分发（family → backend） | `agent.go:477` 附近 | `src/drivers/index.ts` 的 `createBackend()` |

## 2. driver 层对照

### claude（`server/pkg/agent/claude.go`）

- argv 由 `buildClaudeArgs(opts, logger)` 构造；核心 `--output-format stream-json`。
- 事件分支：`assistant`(229) / `user`(237) / `system`(241) / `result`(246) / `log`(256) / `control_request`(264)。
- content block：`text`(401) / `thinking`(406) / `tool_use`(410)。
- `--mcp-config` 走临时文件（`writeMcpConfigToTemp` + cleanup）。
- 终止宽限 `claudeTerminateGrace`（默认 5s，原子变量可覆盖）。
- 测试即金标准：`claude_test.go`、`claude_usage_test.go`、`claude_deadlock_test.go`（并发读写 stdin/stdout 防死锁 —— **这个坑必须照抄**）。

### codebuddy / WorkBuddy（`server/pkg/agent/codebuddy.go`）

- 头注释原文：*"spawns the CodeBuddy CLI (a Claude Code fork) with `--output-format stream-json`"*，执行模型对齐 `claude.go`（并发 stdin/stdout、保持 stdin 打开以自动批准 `control_request`）。
- argv：`--model`(77) / `--effort`(80) / `--max-turns`(83) / `--append-system-prompt`(86) / `--resume`(89) / `--mcp-config`(129)。
- `codebuddyBlockedArgs` 保护协议参数不被 custom args 覆盖。
- → 本项目 `codebuddy.ts` 复用 `claude.ts` 的解析器，只差异 argv 与 `interpreter`。

### openclaw / AutoClaw（`server/pkg/agent/openclaw.go`）

- argv（`buildOpenclawArgs`，228-269）：`agent` + `--local`（gateway 模式去掉）+ `--json` + `--session-id <id>` + `--timeout <sec>` + `--agent <model>` + custom args + `--message <prompt>`。
- `blockedStandalone` 保护 `--json`（41 行）：它是 daemon 通信协议，不能被覆盖。
- 输出：stdout NDJSON 事件（`openclawEvent`，718+）+ 最终 `openclawResult`（783+）。
- 模式切换 `OpenclawMode`（`agent.go:118-135`）：`local` 自己跑 agent loop；`gateway` 丢给已配置的 Gateway。
- → 本项目 `openclaw.ts` + registry 两条身份：`openclaw`（PATH）与 `autoclaw`（app bundle 内 `.mjs` + `interpreter`）。

### 一次性 argv（`server/pkg/agent/qwen.go` 等）

- prompt 通过 **stdin** 投喂（`TestQwenBackendDeliversPromptOnStdin`），参数 `--model` / `--resume`，`--yolo` 类放权开关，`blockedWithValue` 过滤。
- → 本项目 `generic-argv.ts`：stdin 投喂 + stdout 归一的兜底。

## 3. 进程与生命周期对照（`server/pkg/agent/launch.go`）

| 机制 | multica | 本项目 |
|---|---|---|
| 进程组隔离 | `TestRuntimeCommandsGetTheirOwnProcessGroup`、`newRuntimeCmd`(133) | `spawn.ts`：`detached: true` + `process.kill(-pid)` |
| 取消杀子孙进程 | `TestRuntimeCommandCancellationKillsDescendants` | 同上，杀整个进程组 |
| 启动前缀（wrappers，如 `mise exec --`） | `FilterLaunchPrefix`(475)、`filterLaunchPrefix`(502) | `CommandSpec.argsPrefix` |
| blocked flags 过滤 | `filterCustomArgs` + 各家 `blockedArgs` 表 | `argv.ts` 的 `filterCustomArgs` |
| 日志脱敏 | `redactAgentCommandArgs`(399) | logger 里不打印 key/token |
| 超时/保活 | `runContext`（零超时=无 deadline）+ 多个 watchdog | `watchdog.ts` + `AgentRunOptions.timeoutMs` |

## 4. 明确**不**移植的部分

- `server/internal/daemon/**`（任务认领、worktree、事件回传、WebSocket）——DSH 主 agent 即调度器。
- `server/internal/handler/**`、`packages/**`、`apps/**`（看板/issue/三端 UI）。
- `writeContextFiles`（往 workdir 写 CLAUDE.md/AGENTS.md 标记块）——列 P3 可选，claude/codebuddy 不需要。
- ACP 共享库（`acp_session.go` / `acp_usage.go` / `acp_effort.go` / `acp_terminal.go` / `acp_deliverable.go`）——v2 移植，一次解锁 12 家。
- DSH 自身作为被驱动方的协议（`dsh.go`：`--profile X --stdio`，协议 v1 的 `execute`/`cancel` JSONL）——本插件是反方向，暂不需要；但留作 P4 的 `connect` 目标。

## 5. 查询技巧

索引已建，可直接用结构化查询代替通读：

```
search_graph(query: "claude stream-json parse assistant tool_use", label: "Function")
search_graph(query: "blocked args filter custom launch", label: "Function")
get_code_snippet(qualified_name: "...server.pkg.agent.buildClaudeArgs")
trace_path(function_name: "buildClaudeArgs", direction: "inbound")
```
