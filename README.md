# dsh-agents-bridge

> 把本机其他 agent CLI（Claude Code、CodeBuddy/WorkBuddy、OpenClaw/AutoClaw…）变成 DSH 主 agent 的**工具**，实现「agent 调 agent」的编排层。

参考实现是 `~/BigModel/LLM/tools/multica`（Go，26 家 agent CLI 适配的实战代码），本项目把它当规格移植。设计见 `docs/design.md`，任务追踪见 `docs/plan.md`。

---

## 1. 这个插件给你什么

9 个模型可见的工具，一次 run 是一个**分钟级的长任务**：

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `agents_probe` | `refresh?` | `ProbeResult[]` | 探测本机可用身份；**先调它**。冒烟点 |
| `agents_run` | `agent`, `prompt`（必填）, `cwd?`, `model?`, `effort?`, `timeoutMs?`, `mode?` | `{sessionId, agent, status, startedAt}` | **立即返回**，绝不等任务结束 |
| `agents_run_many` | `runs: [{agent, prompt, cwd?, model?, effort?, timeoutMs?}]`（1..16） | `{requested, started, failed, runs: [{index, agent, started, sessionId?, status?, error?}], hint}` | **并行 fan-out**：一次调用起 N 个；单项被拒只让那一项报错，其余照常启动；超并发上限**不排队**，该项直接报错 |
| `agents_status` | `sessionId?` | `{sessions: [...]}` | 不传 = 全部会话（running 优先） |
| `agents_wait` | `sessionIds`（字符串或数组，必填）, `timeoutMs?`（缺省 20s，**上限 60s**）, `until?`（`all`\|`any`）, `sinceIndex?` | `{waitedMs, timedOut, until, timeoutMs, sessions: [{sessionId, agentId, status, terminal, waitedMs, nextIndex, result?, events?}], hint}` | **有界等待**：全部终态 / 任一终态 / 超时即返回。**超时不是错误**（`timedOut: true`），什么都没取消 |
| `agents_output` | `sessionId`, `sinceIndex?`, `limit?` | `{sessionId, status, messages, nextIndex, terminal, result, hint}` | 增量拉事件；**把 `nextIndex` 回传** |
| `agents_usage` | `sessionIds?`, `includeFinished?`（缺省 `true`） | `{sessions: [...], summary: {...}, note}` | **账单**：逐会话 + 汇总 token/时长。`reasoningTokens` **单列且不计入总量**（见 §5） |
| `agents_cancel` | `sessionId`, `reason?` | `{sessionId, cancelled, status, note}` | 杀整个进程组；幂等 |
| `agents_send` | `sessionId`, `prompt` | `{sessionId, status, resumed, resumedFrom, messageCount}` | 续接（resume 指针续后端对话，新会话跟踪；无指针拒绝开新会话） |

**典型调用序列**

```
agents_probe
    → 拿到可用身份（例如 workbuddy / autoclaw / claude）

# 单个任务
agents_run { "agent": "workbuddy", "prompt": "<自包含的任务描述>", "cwd": "/path/to/repo" }
    → { sessionId: "s-1", status: "running" }        ← 立即返回，不要在这里等
agents_wait { "sessionIds": "s-1", "timeoutMs": 20000 }
    → 全部终态就返回（timedOut=false）；20s 还没完也返回（timedOut=true，正常结果）
      想继续等就再调一次 agents_wait，想看细节用 agents_output 拉增量
agents_output { "sessionId": "s-1", "sinceIndex": 0 }
    → { messages: [...], nextIndex: 7, status: "completed", result: {...} }

# 并行 fan-out（「这 5 个文件各让一个 agent 去改」）
agents_run_many { "runs": [ {"agent":"claude","prompt":"改 a.ts"}, {"agent":"claude","prompt":"改 b.ts"} ] }
    → { started: 2, failed: 0, runs: [{sessionId:"s-2"},{sessionId:"s-3"}] }   ← 立即返回
agents_wait { "sessionIds": ["s-2","s-3"], "timeoutMs": 20000 }
    → 一次等到两个都终态（或超时，仍是正常结果）
agents_usage { "sessionIds": ["s-2","s-3"] }        ← 这套编排烧了多少 token
agents_cancel { "sessionId": "s-3", "reason": "方向错了" }   ← 需要时
agents_send   { "sessionId": "s-2", "prompt": "把第 2 步也改掉" } ← 续接
```

**四条硬约束（改动前先读）**

1. `agents_run` 的 `execute()` **不许等待**。工具调用有协作式超时预算，agent 任务是分钟级；在 `execute()` 里 `await` 会话结束 = 每个真实任务都会被中断。**等待是另一个工具**：`agents_wait` 的全部意义就是有界等待，它的等待不许被塞回 `agents_run`。
2. **分层**：`src/index.ts`（入口）→ `AgentManager`（`src/kernel/**`）→ `createBackend(family, deps)`（`src/drivers/**`）。kernel **不 import** drivers（工厂由入口注入），drivers **不 import** kernel（只 `import type` `src/kernel/types.ts`）。跨层类型只在 `src/kernel/types.ts`，那是冻结 ABI。
3. 所有注册都在 `ctx.effect()` 内，disposer 里按序 unregister 工具 + `void manager.dispose()`。
4. **面向模型的错误必须说下一步**：哪个参数、什么值、为什么不行、合法范围是什么。裸 `Error:`/堆栈/只有错误码没有出路都不合格 —— 回归测试见 `tests/tools/error-copy.test.ts`。

---

## 2. 安装

```bash
export PATH=/opt/homebrew/bin:$PATH
cd /Users/example/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge

pnpm install          # 首次
pnpm run build        # 产出 lib/index.js + lib/client.js（必须成功；client 产物带 ModuleLoader 包装）

# 装进 web profile（本机 DSH 是 web profile）
dsh plugin --profile web add .
```

然后**重启 `dsh web`**（bundle 形态的 Node half 在启动时加载，热更不覆盖新插件）。

验证「插件活着」的最快路径（不需要任何 agent CLI）：

```
/agents-bridge-hello 世界
→ agents-bridge is alive: hello 世界. Tools agents_probe/agents_run/agents_run_many/agents_status/agents_wait/agents_output/agents_usage/agents_cancel/agents_send are registered…
```

再让模型调一次 `agents_probe`：能列出身份 = 工具面已注册。

> **契约偏差（相对任务书原文）**：任务书写的是 `ctx.command('agents-bridge.hello <name>', …)`。真实 DSH 的 command 注册表（`@deepseek-ai/dsh-commands`）**没有**这个简写，只有 `ctx.commands.register({ name, description, input, handler })`，而且命令名正则是 `/^[a-z][a-z0-9_-]*$/u` —— **点号会被拒绝**，用点名注册会让整条冒烟命令注册失败。因此实现为 `/agents-bridge-hello <name>` + `ctx.commands.register`。`commands` 服务**没有**放进 `inject`（放进去会让没有命令注册表的宿主把整个插件判为 INACTIVE），而是 `ctx.get` 惰性取，取不到就跳过冒烟命令，九个工具照常注册。

---

## 3. 开发

```bash
export PATH=/opt/homebrew/bin:$PATH
cd /Users/example/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge

pnpm exec tsc --noEmit    # 类型检查（strict + verbatimModuleSyntax，类型导入必须 import type）
pnpm run build            # esbuild → lib/index.js，@deepseek-ai/* 全部 external
pnpm exec vitest run      # 单测（client 的集成用例断言构建产物，先跑一次 build）
pnpm run verify           # 合同门禁：dsh-plugin-studio 的 verify_plugin.py，目标 11/11 PASS
```

**文件所有权**（并行工作流，越界即冲突）

| 路径 | 归属 | 内容 |
|---|---|---|
| `src/kernel/**` | A | registry / spawn / session / watchdog / store / manager / logger |
| `src/drivers/**` | B | claude / codebuddy / openclaw / generic-argv / argv |
| `src/index.ts`、`src/tools/**`、`README.md` | C | 入口装配 + 9 个工具定义/注册（E 加了 wait/run_many/usage）+ 冒烟命令 |
| `src/kernel/types.ts` | **冻结 ABI** | 任何一方都不要改；要改先改 `docs/plan.md` |

**`lib/index.js` 的构建规则**：`@deepseek-ai/*` 必须保持 external。把 `@deepseek-ai/dsh-tools` 打进 bundle 会产生**第二个工具注册表**，表现是工具静默丢失（见 `scripts/build.mjs` 注释）。

**`lib/client.js` 的构建规则**：产物**必须带 ModuleLoader 包装** —— `window.__ModuleLoader__.load({ id, factory })`，`id` 由 `package.json#name` 派生。宿主是在启动时**注册 factory**（模块主体保持惰性），**不是** import 产物后读 exports；丢了包装的表现是 **UI 静默不出现**：不报错，因为没有任何一方在找这个 bundle。`react` / `react-dom` 系列同样必须保持 external（打进 bundle 就是第二个 React，等于第二个 hooks dispatcher）。改 `scripts/build-client.mjs` 时别丢这两条；护栏是 `tests/integration/client-bundle.test.ts`（在 `node:vm` 里求值**构建产物**、自己扮演宿主），合同门禁是 `pnpm run verify`。

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
  defaultCwd: /Users/example/BigModel/LLM       # agents_run 不传 cwd 时的默认工作目录
```

### 4.1 在 DSH 设置界面里改（设置 → 插件 → 可配置）

上表里的一部分值不必手改 YAML：本插件注册了一个 settings 命名空间
（`dsh-agents-bridge`，即包名），DSH 的「设置 → 插件」里会出现一张属于它的卡片。

| 字段 | 类型 | 生效时机 | 说明 |
|---|---|---|---|
| `defaultCwd` | 字符串 | **立即**（每次 run 都读，`src/kernel/manager.ts:401`） | `agents_run` 不传 `cwd` 时的默认目录 |
| `maxConcurrent` | 正整数 | 下次加载（构造 manager 时快照进运行策略，`manager.ts:160-168`） | 同时运行的会话上限，超了直接拒绝、不排队 |
| `allowedCwd` / `deniedCwd` | 字符串列表 | 下次加载 | `cwd` 白名单 / 黑名单（`realpath` 后比较） |
| `allowedAgents` | 字符串列表 | 下次加载 | 允许被驱动的身份白名单 |

几条刻意的规矩：

- **保存后写进 `$DSH_HOME/settings.yaml` 的 `dsh-agents-bridge:` 节**，与手写 config 叠加；
  卡片上标着每个字段是「立即生效」还是「下次加载生效」——不写清楚的话，一个不生效的开关
  和一个生效的开关看起来一模一样。
- **留空 = 跟随内核默认或部署配置**，插件不在 schema 里声明任何默认值：默认值只在代码里
  定义一次，设置面板抄一份就会两边漂移（有一条测试专门盯这件事）。
- **恢复默认**只清除该字段的用户层条目，让它回落到部署配置。
- **本部署没挂设置服务时**卡片照常显示，但标明不可写，保存会被**拒绝**（不是静默成功）。
- 写入只走 settings 服务的 scope（按命名空间串行 + revision 栅），插件自己从不直接改
  `settings.yaml`。

### 4.2 P2 加固项（都可选，不配 = 与之前完全一致）

```yaml
agents-bridge:
  allowedCwd: ["/Users/example/BigModel/LLM"]   # cwd 必须落在其中之一（含子目录）
  deniedCwd: ["/etc", "/System", "/private/var"]  # 优先级高于 allowedCwd
  allowedAgents: ["workbuddy", "autoclaw"]   # 缺省 = 全部内置身份
  maxConcurrent: 4                           # 同时运行的会话上限
  graceMs: 5000                              # 取消时 SIGTERM → SIGKILL 的宽限期
```

- **`cwd` 校验先 `realpath` 再比较**。macOS 上 `/tmp` 是指向 `/private/tmp` 的
  符号链接，只比字符串的话 `cwd: /tmp/x` 能绕进按 `/private/var` 配置的规则里。
  被拒时的错误会同时说明**被拒的值**和**允许的范围**。
- **`maxConcurrent` 超限时立刻失败，绝不排队**。排队会撞上工具调用自己的超时预算，
  最后失败得更难解释；现在的错误直接说明「当前几个在跑、上限多少、怎么办」。
  缺省 4 的理由见 `src/kernel/policy.ts` 的 `DEFAULT_MAX_CONCURRENT` 注释。
- **尺度**：这套白名单是「防模型手滑把 `cwd` 指到 `/`」，**不是沙箱**。
  被委派的 agent 拿到写文件的工具后仍能走出 cwd —— 那只能靠 OS 层的 approval /
  sandbox 拦，见 §5。

环境变量覆盖沿用 multica 的 `MULTICA_<ID>_PATH` 思路：`envPrefix` 决定前缀（`CLAUDE` / `WORKBUDDY` / `AUTOCLAW` / `OPENCLAW` / `GENERIC` / `MIMO`），例如 `WORKBUDDY_PATH`、`AUTOCLAW_MODEL`。

---

## 5. 已知边界（不是 bug，是记录下来的事实）

- **MiMo 不可驱动**：它的 agent 循环封在 `app.asar` 里，没有 CLI / ACP 端点 / daemon socket。registry 把它标成 `unsupported` 并带上原因 —— `agents_probe` **会**把它列出来（`available: false`），让模型学到边界，而不是让它凭空消失（设计文档 D8）。
- **WorkBuddy 必须带 `interpreter`**：它自带的 `cli/bin/codebuddy` 是 `#!/usr/bin/env node` 脚本，而本机 PATH 上**没有 node**，直接 spawn 会 `env: node: No such file or directory`。描述符里已经指向 app 自带的 node（实测 D7）。
- **AutoClaw 走 `openclaw.mjs` + `interpreter`**：`/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs agent --local --json …`。若 app 自带引擎起不来（例如缺 `~/.openclaw/openclaw.json`），退到 PATH 版身份 `openclaw`；再不行就是它的 gateway HTTP API（P4 的 `connect` 模式，v1 只留字段）。
- **`connect` 模式未实现**：`mode` 参数收 `spawn` | `connect`，但只有 `spawn` 有实现。拨已运行实例（openclaw gateway / WorkBuddy sidecar）是 P4。
- **ACP driver 已实现（D27）**：`ProtocolFamily += 'acp'`（ABI v4）+ `src/drivers/acp.ts` + CLI 轨道身份 `codebuddy-code-acp`（真机 2.151.0 端到端跑通）。一条 ACP entry 解锁 multica 里 12 家说 ACP 的 CLI。
- **`agents_usage` 的 token 记账规则**：`totalTokens` **只加四个互斥桶**（input / output / cache read / cache write）。`reasoningTokens` 是**披露项不是桶** —— codex 把它报成 `output_tokens` 的**子集**，加进去就是重复计数，所以它单列并标注「已含在 output 内」。同一个会话没有终态结果时用量按 0 计并标 `usageReported: false`，零不能被读成「这次没花钱」。
- **安全**：spawn 任意 CLI = 任意代码执行。这仍然是**设计前提**，没有变：v1 依赖 DSH 自身的 approval / sandbox 语义。P2 补上的是 `cwd` / agent 白名单与并发上限（§4.2），它们的作用域是「防误操作」——防止模型手滑把 `cwd` 指到 `/`、或一次点起十几个 agent 树把机器打死。它们**不是**沙箱：被委派的 agent 一旦拿到写文件的工具，仍然可以走出 `cwd`；真正拦这件事的只有 OS 层的 approval / sandbox。注意被委派的 agent **看不到本对话**，prompt 必须自包含（系统提示段已告知模型）。

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
