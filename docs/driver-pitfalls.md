# 方言实现踩坑档案（drivers 工作流实测 + multica 源码交叉验证）

> 来源：B 工作流在实现 4 个 driver 时的实测结论 + multica Go 源码对照。**这些是"照着文档写会错"的地方**，每条都对应代码里的一个具体防御。

## claude / codebuddy（stream-json 家族）

| # | 坑 | 防御 |
|---|---|---|
| 1 | **codebuddy 的 thinking 块字段名是 `thinking`，不是 `text`** | multica 的 struct 只读 `text`，等于**静默丢弃**；解析器两个字段都读 |
| 2 | **会发 claude 文档里没有的事件**：`file-history-snapshot`、`system/status` | 白名单 + **未知 type 静默忽略**（计数但不产消息、不报错）；`tests/fixtures/fake-stream-json-cli.mjs` 专为此回归 |
| 3 | **`session_id` 在第一个 `system` 事件就出现**，早于 result | 尽早捕获；且**终态 result 缺 session_id 时不得清掉已捕获的 id**（比 multica 的 `sessionID = msg.SessionID` 更稳） |
| 4 | **`--effort` 必须 blocked 且只注入一次** | 进 blocked 表；重复注入会让 CLI 取最后一个或报错 |
| 5 | **claude 故意不转发 `--append-system-prompt`，codebuddy 转发**（multica 有专门测试） | 两个 dialect 分开配置，不共用一套 flag 策略 |
| 6 | 子进程 env 处理不能粗暴剥离全局前缀 | 只剔除 `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `EXECPATH` / `SESSION_ID` / `SSE_PORT` 与 `CLAUDECODE_*`，**保留用户态 `CLAUDE_CODE_*`**（曾因前缀剥离在 Windows 删掉 `CLAUDE_CODE_GIT_BASH_PATH`） |
| 7 | 并发读写 stdin/stdout 会死锁 | 先挂 stdout reader 再写 stdin；stdin 保持打开以自动批准 `control_request`（对应 multica `claude_deadlock_test.go` 的存在原因） |

## openclaw / autoclaw（NDJSON 家族）

| # | 坑 | 防御 |
|---|---|---|
| 8 | **不接受没有 session 选择器的调用**：`--local` 报 `Pass --to/--session-key/--session-id/--agent…`，gateway 报 `No target session selected` | 每次 run 必带 `--session-id`；无 resume 时 `randomUUID()` |
| 9 | **CLI 自己报的 `meta.agentMeta.sessionId` 是 session 文件 id，不是合法选择器** | `AgentResult.backendSessionId` 必须回填**启动时用的那个 id**，不能用 CLI 回报的 |
| 10 | **结果 blob 是 pretty-printed 多行 JSON**（实测 1070 行），逐行 scanner 看不见 | 整缓冲解析；**"解析出完整结果 + stdout 静默一段"就是协议边界** —— multica 生产事故：T+24s 结果已写出，T+8min 进程不退、槽位仍被占用。grace 可配（测试用 10ms） |
| 11 | `autoclaw` 的 `--profile` 必须排在子命令 `agent` 之前；默认 `~/.openclaw/openclaw.json` 是无效 stub | 前缀 `['--profile','autoclaw','agent']`；配置无效时按前缀给出可读诊断（两种文案都有测试） |
| 12 | gateway/connect 模式 v1 未实现 | 抛明确"未实现"，不静默降级成 local（否则会污染用户的 GUI 会话） |

## 跨 driver 通用规则

| # | 规则 | 说明 |
|---|---|---|
| 13 | **`interpreter` 规则是全 driver 通用的** | `[interpreter, executable, ...argsPrefix, ...args]`，不是 codebuddy 专属 |
| 14 | **`generic-argv` 的 `argsPrefix` 是身份唯一的协议声明位** | 它的前缀可能就是 `--output-format stream-json`（stdin 提示模式的开关），被 blocked 过滤掉就没法调用 → 该 driver **不过滤前缀**，改用"前缀在前、驱动 flag 在后（last-wins）" |
| 15 | launch prefix 过滤只对 claude/codebuddy/openclaw 生效 | multica 的 `filterLaunchPrefix` 语义 |

## 已知 ABI 缺口（待定）

`AgentRunOptions` 目前没有 `systemPrompt` / `maxTurns` / `mcpConfig`：

- `--append-system-prompt` / `--max-turns` 可经 `extraArgs` 传（不在 blocked 表里）。
- **`--mcp-config` 被 blocked**，无法经 `extraArgs` 传 → 现以零 ABI 改动的 env 后门兜住：设 `DSH_AGENTS_BRIDGE_MCP_CONFIG=<已存在的配置文件路径>` 即生效。
- 若要正式暴露，建议在 `AgentRunOptions` 加可选 `mcpConfigPath`（一次 ABI 变更，三处适配）。
