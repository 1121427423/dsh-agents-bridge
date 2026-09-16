# 本机引擎实测档案（v1 驱动依据）

> 全部为在本机**实际执行**得到的结果（命令 + 关键输出），不是推测。drivers 实现以本文件 + `docs/multica-reference.md` 为准。
> 环境：macOS，node v26.5.0（`/opt/homebrew/bin/node`，**不在默认 PATH 上**）。

## 1. WorkBuddy → CodeBuddy CLI

```bash
node "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy" --version
# → 2.137.1

node "<同上>" --help
# → Usage: codebuddy|cbc [options] [command] [prompt]
#    "CodeBuddy Code - starts an interactive session by default, use -p/--print for non-interactive output"
```

**关键事实**

- 它是 **`#!/usr/bin/env node` 脚本**，且**必须显式用 node 拉起**：直接执行会 `env: node: No such file or directory`（PATH 无 node）→ 这就是 `CommandSpec.interpreter` 字段存在的实测依据。
- 确认是 **Claude Code fork**（usage 文案、flag 命名与 claude 一致），因此 driver 复用 claude stream-json 解析器。
- 与 v1 相关的 flag：`-p/--print`、`--output-format <text|json|stream-json>`（仅与 `--print` 同用）、`--input-format`、`--include-partial-messages`、`-r/--resume [sessionId]`、`-c/--continue`、`--mcp-config <fileOrString>`、`--permission-mode <acceptEdits|bypassPermissions|default|plan|dontAsk|auto>`、`-y/--dangerously-skip-permissions`、`--model`、`--effort`、`--max-turns`、`--append-system-prompt`、`--tools`、`--allowedTools`、`--disallowedTools`、`--json-schema`。
- 另有 ACP 面：`--permission-mode` 的 help 文案含 "(TUI, --serve Web, ACP)" → v2 可选。
- 进程树观察到 WorkBuddy 桌面版维护**预热池**：`cli/bin/codebuddy --prewarm --prewarm-id wb-pool-*`，另有 `main/sidecar-entry.js --token <uuid>`（私有 API，`connect` 模式的候选）。

## 2. AutoClaw → OpenClaw 引擎

```bash
node "/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs" --help
# → OpenClaw 2026.6.8 (de37541)
#    Commands: acp* | agent | agents* | ...

node "<同上>" agent --help
# → Usage: openclaw agent [options]
#    "Run an agent turn via the Gateway (use --local for embedded)"
```

**关键事实（`agent` 子命令的全部相关 flag）**

| flag | 说明 |
|---|---|
| `--local` | **embedded 本地跑**（需要 shell 里有 model provider API keys）——v1 用这条 |
| `--json` | 结果以 JSON 输出（daemon 通信协议，必须进 blocked flags） |
| `-m, --message <text>` | prompt |
| `--model <id>` | `provider/model` 或裸 model id |
| `--session-id <id>` / `--session-key <key>` | 会话标识（resume 依据） |
| `--agent <id>` | agent 身份（覆盖 routing bindings） |
| `--thinking <level>` | `off\|minimal\|low\|medium\|high\|xhigh\|adaptive\|max` → 映射我们的 `effort`（multica 无此 flag） |
| `--timeout <seconds>` | 默认 600 |
| `--verbose <on\|off>` | 会话级 verbose |
| `--channel` / `--deliver` / `--to` / `--reply-*` | 消息投递相关，v1 不用 |

- 与 multica `buildOpenclawArgs`（`openclaw.go:228-269`）**完全对得上**：`agent --local --json --session-id <id> --timeout <sec> [--agent <model>] --message <prompt>`。
- `openclaw acp` = "Run an ACP bridge backed by the Gateway"；`openclaw agents` = 管理隔离 agent → **v2 ACP driver 的现成素材**，v1 不实现。
- AutoClaw 桌面版另有活的 gateway：本机监听 `18432 / 19654 / 19723 / 53699`，`curl` 返回 JSON（`{"ok":false,"error":"Unknown endpoint: /"}`）→ `connect` 模式（复用已登录引擎）的落点。

## 3. 边界案例：MiMo（小米）

- `Xiaomi MiMo.app` 的 agent 循环封在 `app.asar` 内（96M），**无 CLI / 无 ACP / 无对外 daemon 端口**。
- `Application Support/MiMo Automation/Runtime/0.7.11/products/**` 是它**使用**的工具（browser-replay 等 node 包），不是可驱动的 agent 入口。
- 结论：registry 里标 `unsupported`，probe 如实报告边界。

## 4. 复现命令（供后续回归）

```bash
export PATH=/opt/homebrew/bin:$PATH
node "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy" --version
node "/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs" --version
```

> 注意：macOS 无 `timeout` 命令，自动化探测须用 bash 自实现的 guard（见本项目探测实现）并给 3–5s 上限，避免探活挂死。

---

## 5. Headless 真实回合冒烟（P1 前置验证）

### 5.1 codebuddy：✅ 跑通，无需登录

```bash
node "<app>/cli/bin/codebuddy" -p --output-format stream-json "Reply with exactly: PONG"
```

- 结果：`{"type":"result","subtype":"success","is_error":false,"result":"PONG","session_id":"6581ce83-…","duration_ms":35391,"num_turns":3,"total_cost_usd":0,...}` —— **35s / 3 turns**，是真 agent loop。
- 凭证：`apiKeySource: "copilot.tencent.com"`，复用桌面端凭证，**无 login 提示**。
- 模型：`model: "auto"`（init 事件），实际 `hy4-preview`。
- **事件类型全集（实测）**：`system/init`、`system/status`、`file-history-snapshot`、`assistant`(thinking)、`assistant`(text)、`result`。
  - `file-history-snapshot` 与 `system/status` 在 claude 文档里没有 → **解析器必须白名单 + 静默忽略未知 type**。
  - **`session_id` 在第一个 `system/init` 事件里就出现** → resume 指针应尽早捕获（对应 multica `SessionID ... early resume-pointer pinning`）。
  - usage 字段名：`cache_creation_input_tokens` / `cache_read_input_tokens`（非 claude 文档里的 `cache_creation`）。

### 5.2 openclaw：裸调用失败 → 正确姿势是 `--profile autoclaw`

```
OpenClaw config is invalid
File: ~/.openclaw/openclaw.json
Problem:  - <root>: Invalid input
Fix: openclaw doctor --fix
```

- 根因：`~/.openclaw/openclaw.json` 只含 `{"mcpServers":{...}}`，是无效 stub；AutoClaw 桌面版用**自己的 profile 目录**。
- 已验证（`Config valid: ~/.openclaw-autoclaw/openclaw.json`）：
  ```bash
  node "<app>/gateway/openclaw/openclaw.mjs" --profile autoclaw config validate
  ```
- **`autoclaw` 身份 argv 前缀 = `['--profile','autoclaw','agent']`**（全局 `--profile` 必须排在子命令前）。
- 该目录含 `.gateway-token`、`agents/`、`exec-approvals.json` → 未来 `connect` 模式的凭证与审批数据来源。

### 5.3 对驱动实现的硬性结论

| 结论 | 影响 |
|---|---|
| 未知事件类型必须静默忽略 | claude.ts 与 codebuddy.ts 共用解析器时不能对未知 type 抛错 |
| session_id 从 init 事件捕获 | resume 支持不依赖 result 事件 |
| codebuddy 用 `interpreter` 拉 node 才能跑 | `CommandSpec.interpreter` 是必需字段，不是可选优化 |
| openclaw 身份必须带 profile | registry 的 `argsPrefix` 要支持「全局 flag + 子命令」组合 |
