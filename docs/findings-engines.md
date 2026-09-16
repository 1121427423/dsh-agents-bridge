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

---

## 6. 模型目录是**服务端下发**的（重要更正）

**教训**：不要在 app 内置字符串里找模型 id。`app.asar` 里只有历史遗留的少量 id；**真正的账号模型目录**是服务端下发的，缓存在：

```
~/.workbuddy/cache/acc-product-config-v3.json      # 383 KB
```

结构（实测）：

| 键 | 内容 |
|---|---|
| `models[]` | 51 个条目：`id` / `name` / `credits`（倍率）/ `contextWindow{defaultLength, supportedLengths}` / `maxOutputTokens` / `supportsImages` / `supportsReasoning` / `supportsToolCall` / `reasoning{effort, summary}` |
| `modelPromotions[]` | 促销规则，每条带 `modelIds[]` + `schedule` + `hover.textZh` |
| `modelTiers[]` | 会员档位与可调度模型 |

### 6.1 `deepseek-v4.1-flash`（用户界面上看到的那个）

```json
{
  "id": "deepseek-v4.1-flash",
  "name": "Deepseek-V4.1-Flash",
  "credits": "x0.03",
  "descriptionZh": "DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态",
  "contextWindow": { "defaultLength": 300000, "supportedLengths": [300000, 1000000] },
  "maxInputTokens": 1000000,
  "maxOutputTokens": 128000,
  "onlyReasoning": true,
  "reasoning": { "effort": "high", "summary": "auto" },
  "supportsImages": true
}
```

UI 上每个数字的来源：

| UI 文案 | 配置字段 |
|---|---|
| 「支持 1M 上下文窗口」 | `maxInputTokens` / `supportedLengths` 上限 1000000 |
| 「上下文窗口 300K」 | `contextWindow.defaultLength: 300000`（**默认值**，不是上限——同一张卡同时出现 1M 与 300K 的原因） |
| 「0.03x 倍率」 | `credits: "x0.03"` —— **账号里最便宜的付费模型**（v4-flash 0.17、v4-pro 0.51；hy3 是 0.00 免费） |
| 「原生多模态」 | `supportsImages: true` + `descriptionZh` |
| 「9月10日-9月23日…工作日高峰期消耗翻倍」 | 促销 `ds-09discount-daytime-badge-202609`，`modelIds: ["deepseek-v4.1-flash"]`，`schedule` 全天 `0:00–23:59` Asia/Shanghai |

### 6.2 实测跑通（真活 + 机器验证）

```bash
node "<app>/cli/bin/codebuddy" -p --output-format stream-json \
  --model deepseek-v4.1-flash --permission-mode bypassPermissions "<任务>"
```

- 8 turns / 13.0s / `is_error:false`；usage `in=71043 out=409 cache_read=50176 cache_write=20867`
- 动作序列：`thinking` → `Write sample.txt` → `Write wordcount.py` → `Bash python3 wordcount.py`
- 汇报：「sample.txt 共 5 行、43 个单词、258 个字符」→ **独立复跑 `python3 wordcount.py` 输出逐字一致**（Lines 5 / Words 43 / Characters 258）
- 对比 `deepseek-v4-flash`：7 turns / 11.6s，倍率 0.17（v4.1-flash 便宜约 5.7 倍）

### 6.3 对插件的直接影响（→ P3）

这正是 multica `ModelDiscoveryFunc`（`builtin_runtimes.go:77`）对应的场景。当前 `agents_probe` 只报「哪个引擎可用」，**应该再报「这个引擎能用哪些模型」**：

- 数据源不是猜、不是抓 help 文本，而是读各自的模型目录缓存（WorkBuddy 已定位到具体文件）。
- 有了模型目录，`agents_run` 的 `model` 参数才有可校验的取值域；`big/fast/vision` 这类别名映射也能落到真实 id 与倍率上（按 `credits` 选性价比，按 `supportsImages` 决定能不能读图）。
- 注意 `onlyReasoning: true` 的模型要配 `--effort`（`supportedEfforts`）；v4.1-flash 只接受 `high`/`xhigh`。

---

## 7. AutoClaw（openclaw）的模型发现与 v4.1-flash 实测

### 7.1 ⚠️ 命名陷阱：显示名 ≠ 模型 id

AutoClaw 的模型目录在 profile 配置的 `models.providers.<provider>.models[]` 里，每条有 `id` / `name` / `headers`：

```jsonc
// ~/.openclaw-autoclaw/openclaw.json
{
  "id": "tdpsk_deepseek-v4-flash-202605",   // ← 真正要传给 --model 的值
  "name": "Deepseek-V4.1-Flash",            // ← UI 上显示的名字
  "contextWindow": 1048576,
  "maxTokens": 393216,
  "headers": { "X-Request-Model": "tdpsk_deepseek-v4-flash-202605", ... }
}
```

**UI 里选「Deepseek-V4.1-Flash」，实际发出的 id 是 `tdpsk_deepseek-v4-flash-202605`。** 与 WorkBuddy 的 `deepseek-v4.1-flash` 不是同一个字符串——同一家模型在两个客户端里的 id 命名不同，插件做别名映射时必须分别登记。

### 7.2 provider 与凭证形态

```jsonc
"models": { "providers": { "zai": {
  "baseUrl": "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw",
  "apiKey": "autoclaw-internal-proxy",
  "api": "openai-completions",          // OpenAI 兼容协议
  "timeoutSeconds": 1200
}}}
```

- 真实凭证是**每个模型自带的 header**（`X-Authorization: Bearer <JWT>`，含 `user_id` / `exp`），随客户端刷新。
- 因此 `--local` 不需要 shell 里另有 API key —— 配置里已具备。实测 stderr 里的 HTTP trace 可自证：
  `POST https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions status=200 provider=zai model.id=tdpsk_deepseek-v4-flash-202605`

### 7.3 模型发现命令（探活用哪个）

| 命令 | 实测结果 |
|---|---|
| `openclaw --profile autoclaw models list` | ✅ 秒级返回，列出 `<provider>/<modelId>` + 模态 + 上下文窗，可直接作为模型目录来源 |
| `openclaw --profile autoclaw models status` | ❌ **60s 超时**（探测 provider 健康状况会真的去连）→ **探活绝不能用它** |
| `openclaw --profile autoclaw agents list` | ✅ 列出 agent 及其默认模型（main / auto-coder / auto-designer…） |

### 7.4 实跑 v4.1-flash（真活 + 机器验证）

```bash
node "<app>/gateway/openclaw/openclaw.mjs" --profile autoclaw agent --local --json \
  --session-id "$(uuidgen)" --timeout 240 \
  --model zai/tdpsk_deepseek-v4-flash-202605 --message "<任务>"
```

- 结果：exit 0，**12.9s**，`meta.agentMeta.model = tdpsk_deepseek-v4-flash-202605`，`meta.executionTrace.attempts[0].model` 同样是它。
- 产物：`~/.openclaw-autoclaw/workspace/fizzbuzz.py`（182 字节）→ 独立复跑输出与汇报**一致**。
- 汇报原文在 `payloads[0].text`：「已创建并运行 fizzbuzz.py：stdout 依次输出 1、2、Fizz、4、Buzz…」

### 7.5 输出形态（对 driver 的意义）

openclaw 的 `--json` **不是** NDJSON 事件流，而是一个 **pretty-printed 单 JSON**：`{ "payloads": [{ "text": … }], "meta": { durationMs, agentMeta, executionTrace, systemPromptReport, contextBudgetStatus } }`。

→ 对应 `docs/driver-pitfalls.md` 第 10 条：必须**整缓冲解析**，且「解析出完整结果 + stdout 静默」即为协议边界。`meta` 还顺带给出 `sessionId` / `durationMs` / 每次尝试的模型，可直接用于 `AgentResult`。

### 7.6 文件工具边界

`tools.fs.workspaceOnly: true` → 它的读写被限制在自己的 workspace（`~/.openclaw-autoclaw/workspace`，按 agent 还有 `agents/<id>/workspace`）。**给它的 cwd 参数不改变这个边界**，任务产物会落在 workspace 里。`tools.exec.security: full` + `ask: off` 意味着命令执行默认放行。

---

## 8. AutoClaw 凭证能否跨客户端复用（实测边界）

问题：「把 AutoClaw 的请求凭证拿去接别的 agent，配一个转换请求的代理服务，行不行？」

### 8.1 凭证形态

| 项 | 实测值 |
|---|---|
| 真正被校验的凭证 | **`X-Authorization: Bearer <JWT>`**（配置里每条模型自带） |
| `apiKey` 字段 | 字面串 `autoclaw-internal-proxy`（占位，不是真凭证） |
| JWT 内容 | `user_id` / `jti`(邮箱) / `is_guest:false` / `power:0` |
| 有效期 | **恰好 24 小时**（`iat`→`exp`），由桌面端刷新 |
| 端点 | `https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions`（`api: openai-completions`） |
| 其余客户端标识 header | `X-Request-Model` / `X-Product:autoclaw` / `X-Channel:official` / `X-Version` / `X-Tm:mac` / `X-Lang` / `X-Client-Type:pc` |

### 8.2 对照实验（curl 直连，逐项抽 header / 改 body）

| 变体 | 结果 | 结论 |
|---|---|---|
| 全套 header + 标准 OpenAI body | `400 {"message":"invalid request"}` | **认证过了，请求体形状不被接受** —— 它不是给第三方客户端用的标准 OpenAI 端点 |
| 抽掉 `X-Authorization`（其余照发） | `401 {"error":"Invalid token"}` | **该 JWT 就是被校验的凭证**，且鉴权先于 body 校验 |
| 补上 `X-Newbie-Guide` / `X-Auto-Legal` / `X-Agent-*` 等 | `401 {"message":"新手任务凭证无效或已过期"}` | 服务端**确实读取这些客户端标识 header 并走不同判定分支** → 它有意区分客户端 |
| 换 body（去 model / 加 stream / 加 reasoning_effort） | 全部 `400` | 缺的不是这些字段，而是 openclaw 自己的请求形状 |
| 用 Python urllib 发同样的请求 | `405` + **阿里云 WAF 的 HTML 页** | **边缘防护按客户端指纹拦**：通用 HTTP 客户端会被挡在业务层之外；curl 能过 |

### 8.3 结论（给"要不要做代理复用"的判断）

1. **技术上"能过认证"是真的**：`X-Authorization` 就是凭证，缺它直接 401。
2. **但代价是精确模仿官方客户端**：请求体要照抄 openclaw 的形状（需先抓包），客户端标识 header 要齐，且要绕开/匹配 WAF 指纹。
3. **它是明确设计成"只给自家客户端用"的**：`X-Product` / `X-Channel` / `X-Client-Type` / `X-Version` + 按客户端分支的鉴权逻辑，就是为了识别与限制来源。
4. **运维上很脆**：凭证 24 小时过期（app 刷新），代理必须持续同步；一旦过期表现为 401 Invalid token。
5. **建议做法**：不要抽凭证做通用上游。要在网关里用这些模型，就走各家**官方 API**（智谱/DeepSeek 等）加一条 channel —— 你已有的 8080 网关就是干这个的。而 AutoClaw 本身，正确用法是**当执行器被驱动**（本插件的 `autoclaw` 身份已实现），而不是当模型供应商。

> 若要继续深挖（判定第 2 条的具体请求形状），唯一可靠办法是本地抓包：新建一个隔离 profile（如 `--profile probecap`，**不动** `~/.openclaw-autoclaw`），把 provider `baseUrl` 指向本地日志代理，跑一个回合即可拿到确切 body + headers，再决定是否可重放。

### 8.4 抓包结果（已完成，现场已清理）

方法：新建 `~/.openclaw-probecap`（只拷配置、`baseUrl` 改指 `http://127.0.0.1:18099`），本地代理记录后**用 curl 转发**到真实端点（curl 才过 WAF）。原始 profile 全程未改动，实验后已删除。

**请求解剖**：`POST /chat/completions`，body 115,943 字节。

| 维度 | 内容 |
|---|---|
| 客户端真身 | **官方 OpenAI Node SDK**：`user-agent: OpenAI/JS 6.39.1` + `x-stainless-{lang,os,arch,runtime,package-version,timeout}` |
| 鉴权（两个头！） | `authorization: Bearer autoclaw-internal-proxy`（占位）+ **`x-authorization: Bearer <真JWT>`** |
| 客户端身份 | `x-product:autoclaw` `x-channel:official` `x-client-type:pc` `x-version:1.18.5` `x-tm:mac` `x-lang:zh-CN` |
| 会话身份 | `x-agent-id` `x-autoclaw-agent-id` `x-session-id` `x-session-key: agent:main:explicit:<uuid>` `x-autoclaw-session-key` |
| 追踪 | `x-request-id` `traceparent` `x_trace_id: autoclaw-desktop` |
| body 字段 | `model`(**不带 `tdpsk_` 前缀**：`deepseek-v4-flash-202605`) / `messages` / `stream:true` / `stream_options.include_usage` / `tools:[63]` / `tool_choice:auto` / `max_completion_tokens:393216` / `tool_stream:true` / `thinking:{type}` |

**可行性矩阵（实测）**

| 变体 | 结果 |
|---|---|
| 原始 body 一字不改重放 | **200**，SSE 返回真实回答（`收到`，4 事件，`finish_reason:stop`） |
| 剥离 `tools` / `tool_stream` / `thinking` / `stream_options` | 均 **200** → 这些**不是**必需 |
| `max_completion_tokens` 用原值但只有 user 消息 | **400** |
| 换成通用 system 消息（"You are a helpful assistant."） | **400** |
| **原 system 截断到 2000 字** + user 消息 | **200** |
| 只有 user 消息（无 system） | **400** |

**结论**：凭证 + header 形状**确实可复用**（全保真重放拿到真实推理结果），但网关设了**内容级客户端绑定**——它校验的是 system 消息里的特定标记（长度无关：通用 system 400、截断到 2KB 的原 system 200）。所以"写个转换代理接别的 agent"不是格式翻译问题，而是要连**官方客户端的提示词标记**一起伪造。

**处置**：定位到"门槛在 system 内容"即停止，**没有继续二分出那个最小标记**——继续就是把绕过厂商客户端绑定的方法做出来。加上 24h 凭证轮换与 WAF 指纹两重脆弱性，工程结论不变：**不要把它当通用上游**。




