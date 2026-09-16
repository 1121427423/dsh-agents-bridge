# dsh-agents-bridge

> 把本机其他 agent CLI（Claude Code、CodeBuddy/WorkBuddy、OpenClaw/AutoClaw…）变成 DSH 主 agent 的**工具**，实现「agent 调 agent」的编排层。

参考实现是 `~/BigModel/LLM/tools/multica`（Go，26 家 agent CLI 适配的实战代码），本项目把它当规格移植。设计见 `docs/design.md`，任务追踪见 `docs/plan.md`。

---

## 1. 这个插件给你什么

6 个模型可见的工具，一次 run 是一个**分钟级的长任务**：

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `agents_probe` | `refresh?` | `ProbeResult[]` | 探测本机可用身份；**先调它**。冒烟点 |
| `agents_run` | `agent`, `prompt`（必填）, `cwd?`, `model?`, `effort?`, `timeoutMs?`, `mode?` | `{sessionId, agent, status, startedAt}` | **立即返回**，绝不等任务结束 |
| `agents_status` | `sessionId?` | `{sessions: [...]}` | 不传 = 全部会话（running 优先） |
| `agents_output` | `sessionId`, `sinceIndex?`, `limit?` | `{sessionId, status, messages, nextIndex, terminal, result, hint}` | 增量拉事件；**把 `nextIndex` 回传** |
| `agents_cancel` | `sessionId`, `reason?` | `{sessionId, cancelled, status, note}` | 杀整个进程组；幂等 |
| `agents_send` | `sessionId`, `prompt` | `{sessionId, status, resumed, messageCount}` | 续接（v1 best-effort resume） |

**典型调用序列**

```
agents_probe
    → 拿到可用身份（例如 workbuddy / autoclaw / claude）
agents_run { "agent": "workbuddy", "prompt": "<自包含的任务描述>", "cwd": "/path/to/repo" }
    → { sessionId: "s-1", status: "running" }        ← 立即返回，不要在这里等
agents_output { "sessionId": "s-1", "sinceIndex": 0 }
    → { messages: [...], nextIndex: 7, status: "running" }
agents_status { "sessionId": "s-1" }                  ← 想省 token 时用这个探活
agents_output { "sessionId": "s-1", "sinceIndex": 7 } ← 只读增量
    → status: "completed"，result.text 是最终答复
agents_cancel { "sessionId": "s-1", "reason": "方向错了" }   ← 需要时
agents_send   { "sessionId": "s-1", "prompt": "把第 2 步也改掉" } ← 续接
```

**三条硬约束（改动前先读）**

1. `agents_run` 的 `execute()` **不许等待**。工具调用有协作式超时预算，agent 任务是分钟级；在 `execute()` 里 `await` 会话结束 = 每个真实任务都会被中断。模型被明确告知要轮询 `agents_output`。
2. **分层**：`src/index.ts`（入口）→ `AgentManager`（`src/kernel/**`）→ `createBackend(family, deps)`（`src/drivers/**`）。kernel **不 import** drivers（工厂由入口注入），drivers **不 import** kernel（只 `import type` `src/kernel/types.ts`）。跨层类型只在 `src/kernel/types.ts`，那是冻结 ABI。
3. 所有注册都在 `ctx.effect()` 内，disposer 里按序 unregister 工具 + `void manager.dispose()`。

---

## 2. 安装

```bash
export PATH=/opt/homebrew/bin:$PATH
cd /Users/king/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge

pnpm install          # 首次
pnpm run build        # 产出 lib/index.js（必须成功）

# 装进 web profile（本机 DSH 是 web profile）
dsh plugin --profile web add .
```

然后**重启 `dsh web`**（bundle 形态的 Node half 在启动时加载，热更不覆盖新插件）。

验证「插件活着」的最快路径（不需要任何 agent CLI）：

```
/agents-bridge-hello 世界
→ agents-bridge is alive: hello 世界. Tools agents_probe/run/status/output/cancel/send are registered…
```

再让模型调一次 `agents_probe`：能列出身份 = 工具面已注册。

> **契约偏差（相对任务书原文）**：任务书写的是 `ctx.command('agents-bridge.hello <name>', …)`。真实 DSH 的 command 注册表（`@deepseek-ai/dsh-commands`）**没有**这个简写，只有 `ctx.commands.register({ name, description, input, handler })`，而且命令名正则是 `/^[a-z][a-z0-9_-]*$/u` —— **点号会被拒绝**，用点名注册会让整条冒烟命令注册失败。因此实现为 `/agents-bridge-hello <name>` + `ctx.commands.register`。`commands` 服务**没有**放进 `inject`（放进去会让没有命令注册表的宿主把整个插件判为 INACTIVE），而是 `ctx.get` 惰性取，取不到就跳过冒烟命令，六个工具照常注册。

---

## 3. 开发

```bash
export PATH=/opt/homebrew/bin:$PATH
cd /Users/king/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge

pnpm exec tsc --noEmit    # 类型检查（strict + verbatimModuleSyntax，类型导入必须 import type）
pnpm run build            # esbuild → lib/index.js，@deepseek-ai/* 全部 external
pnpm exec vitest run      # 单测
```

**文件所有权**（并行工作流，越界即冲突）

| 路径 | 归属 | 内容 |
|---|---|---|
| `src/kernel/**` | A | registry / spawn / session / watchdog / store / manager / logger |
| `src/drivers/**` | B | claude / codebuddy / openclaw / generic-argv / argv |
| `src/index.ts`、`src/tools/**`、`README.md` | C | 入口装配 + 6 个工具定义/注册 + 冒烟命令 |
| `src/kernel/types.ts` | **冻结 ABI** | 任何一方都不要改；要改先改 `docs/plan.md` |

**`lib/index.js` 的构建规则**：`@deepseek-ai/*` 必须保持 external。把 `@deepseek-ai/dsh-tools` 打进 bundle 会产生**第二个工具注册表**，表现是工具静默丢失（见 `scripts/build.mjs` 注释）。

---

## 4. 配置

插件 config（`cordis.yml` 行 / profile 设置）：

```yaml
agents-bridge:
  descriptors: []          # 运行时额外身份（AgentDescriptor[]），与内置表合并
  overrides:               # 逐身份覆盖内置描述符
    workbuddy:
      command:
        executable: /Applications/WorkBuddy.app/Contents/Resources/cli/bin/codebuddy
        interpreter: /Applications/WorkBuddy.app/Contents/Resources/node
  storeDir: ~/.dsh/state/dsh-agents-bridge   # 会话存储目录，缺省在 DSH home 下
  defaultCwd: /Users/king/BigModel/LLM       # agents_run 不传 cwd 时的默认工作目录
```

环境变量覆盖沿用 multica 的 `MULTICA_<ID>_PATH` 思路：`envPrefix` 决定前缀（`CLAUDE` / `WORKBUDDY` / `AUTOCLAW` / `OPENCLAW` / `GENERIC` / `MIMO`），例如 `WORKBUDDY_PATH`、`AUTOCLAW_MODEL`。

---

## 5. 已知边界（不是 bug，是记录下来的事实）

- **MiMo 不可驱动**：它的 agent 循环封在 `app.asar` 里，没有 CLI / ACP 端点 / daemon socket。registry 把它标成 `unsupported` 并带上原因 —— `agents_probe` **会**把它列出来（`available: false`），让模型学到边界，而不是让它凭空消失（设计文档 D8）。
- **WorkBuddy 必须带 `interpreter`**：它自带的 `cli/bin/codebuddy` 是 `#!/usr/bin/env node` 脚本，而本机 PATH 上**没有 node**，直接 spawn 会 `env: node: No such file or directory`。描述符里已经指向 app 自带的 node（实测 D7）。
- **AutoClaw 走 `openclaw.mjs` + `interpreter`**：`/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs agent --local --json …`。若 app 自带引擎起不来（例如缺 `~/.openclaw/openclaw.json`），退到 PATH 版身份 `openclaw`；再不行就是它的 gateway HTTP API（P4 的 `connect` 模式，v1 只留字段）。
- **`connect` 模式未实现**：`mode` 参数收 `spawn` | `connect`，但只有 `spawn` 有实现。拨已运行实例（openclaw gateway / WorkBuddy sidecar）是 P4。
- **ACP driver 未实现**：hermes/kimi/qoder 等 12 家走 ACP，是 v2 的一条 entry 解锁多家；v1 明确不做（设计文档 D1）。
- **安全**：spawn 任意 CLI = 任意代码执行。v1 依赖 DSH 自身的 approval / sandbox 语义；`cwd` 与 agent 白名单是 P2 的加固项。注意被委派的 agent **看不到本对话**，prompt 必须自包含（系统提示段已告知模型）。

---

## 6. 冒烟与验收

```bash
# 1. 构建
pnpm run build && ls -l lib/index.js

# 2. 装 + 重启 web，然后：
#    /agents-bridge-hello 世界          ← 插件活着
#    让模型调 agents_probe              ← 身份可见

# 3. P1 验收（真实任务）
#    agents_run { "agent": "workbuddy", "prompt": "..." } → 轮询 agents_output
#    证据 = agents_output 返回的事件流
```

验收记录写进 `docs/plan.md` 的「阶段状态」。
