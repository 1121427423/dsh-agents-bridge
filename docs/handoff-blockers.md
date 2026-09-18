# 交接阻塞记录（handoff blockers）

> 本文件记录**模型 / 凭据 / 上游网络**类故障。按任务书 §0 的硬边界：这类故障**只记录、不修**——
> 不换 key、不改 baseURL、不改模型配置、不绕过。改由人工处理。
>
> 判断标准：出现 `401` / `403` / baseURL `404` / 收不到大模型响应 / 上游超时，
> 就追加一条，然后停掉依赖该能力的工作线，改做不依赖它的部分。

---

## 记录 1 — 国内版 WorkBuddy 上游连接超时（`copilot.tencent.com` ETIMEDOUT）

- **时间**：2026-09-17T19:55Z（本机时区 2026-09-17 03:55）
- **执行的命令**：
  ```bash
  export PATH=/opt/homebrew/bin:$PATH
  cd /Users/example/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge
  node --experimental-strip-types scripts/acceptance.ts workbuddy \
    "Reply with exactly: ACCEPTANCE_OK" --model=deepseek-v4.1-flash
  ```
- **影响的工作线**：`docs/plan.md` 里 P1 的「WorkBuddy 跑通一次真实任务」验收项
  （该验收项用的是**国内版**身份 `workbuddy`）。
- **原始错误全文**（引擎自己回报的，桥原样透出）：
  ```
  [status] running (model=deepseek-v4.1-flash, permissionMode=bypassPermissions)
  [status] running
  [text] 502 网络请求超时：网络链路不稳定或被限速，请稍后重试
         （connect ETIMEDOUT 43.159.104.94:443）(target: https://copilot.tencent.com)
         (06b44416d1844b3a9d4aa75d91d66252/99712073-fc5c-44a9-968e-d4053f3165fe)

  result status=failed exit=0 durationMs=166978
  error: 502 网络请求超时：网络链路不稳定或被限速，请稍后重试
         （connect ETIMEDOUT 43.159.104.94:443）(target: https://copilot.tencent.com)
  backendSessionId: 99712073-fc5c-44a9-968e-d4053f3165fe
  ```

- **桥这一侧的行为是正确的**（这条是重点，说明**不是**插件的 bug）：
  - `probe` 正确解析了桌面轨道：`track=desktop available=true`，
    `executable=/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`，
    `version=2.137.1`；
  - `agents_run` 立即返回了 `sessionId`（未阻塞）；
  - stream-json 方言解析正常：`[status]` 与 `[text]` 两类事件都被归一化并带上了引擎原文；
  - 终态被正确归类为 `failed`，`exitCode=0`（引擎以 0 退出但结果是错误——这正是
    D23 记录的「退出码 0 + 错误只在文本里」那种形态），`backendSessionId` 也拿到了（可用于 resume）。
- **未做（有意为之）**：没有换 key、没有改 baseURL、没有改模型配置、没有重试绕过。
- **人工待办**：确认国内版 WorkBuddy 的登录态与网络（`copilot.tencent.com` 可达性）；
  若国内版上游短期不可用，P1 的该项验收可改用**国际版身份 `workbuddy-ai`**
  （上游是 `www.workbuddy.ai`，本机实测可用）——但两者是**不同身份、不同上游**，
  验收结论不能互相顶替，需要分别记录。

### 1.1 紧接其后的一次「Authentication required」是**瞬态**，已排除，不是凭据故障

同一时段跑国际版身份时，一次运行返回：

```
[text] Authentication required. Please use /login command to sign in to your account
result status=failed exit=0 durationMs=2877
```

**判定为瞬态，不记入凭据故障**，依据是三个对照实验：

1. **同一 argv 直接跑同一个二进制 → 成功**（`DIRECT_OK`，4.0s，
   `result subtype success`，无 `Authentication required`）。
   argv 与插件构造的完全一致：
   `node "<WorkBuddy AI>/…/cli/bin/codebuddy" -p --output-format stream-json --model deepseek-v4.1-flash --permission-mode bypassPermissions "…"`。
   同一 cwd、同一 env、同一二进制 —— 所以**不是插件的 argv/env 缺陷**。
2. **经插件栈再跑两次 → 都成功**：`status=completed`，`text: OK1`（11.6s）/ `text: OK2`（10.4s）。
3. 该失败发生的前 ~3 分钟，国内版身份刚发生 `copilot.tencent.com` 连接超时 ——
   同一时刻链路不稳定，国际版的令牌校验同样可能取不到结果，而被 CLI 表述成
   "Authentication required. Please use /login"。

**结论**：这条是网络抖动引起的误报，**不是** key 失效、**不是** baseURL 问题、**不是**插件缺陷。
本文件第一条真正需要人工处理的只有国内版上游的 `ETIMEDOUT`。

### 1.2 本插件的真机端到端验收：**通过**

同一命令栈（`scripts/acceptance.ts`，真实 registry → manager → driver → 子进程）跑国际版身份：

```
probe  workbuddy-ai: track=desktop available=true
       executable=/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy version=2.137.1
run    session=sess_… status=running          ← 立即返回，未阻塞（不变量 1 成立）
events [status] running (model=deepseek-v4.1-flash, permissionMode=bypassPermissions)
result status=completed exit=0 durationMs=11613
text: OK1
```

即：**发现（桌面轨道 + 绝对路径）→ 立即返回 sessionId → 解析 stream-json 事件流 →
拿到终态 result 与最终文本**，四段全通。这条就是 `docs/plan.md` 里 P1「WorkBuddy 跑通一次真实任务」的证据。

---

### 1.3 D38 派发再次撞上上游（2026-09-17，两次，均为网络/服务侧）

第一次：`400 model [default-model] service info not found`（账号侧模型服务查不到，
而它自己列出的"支持模型"里就有 default-model —— 上游自相矛盾）。第二次：`--model fast-model`
换旗标后正常开工（读了 spec 与 pitfalls 两轮），随后 **502 socket hang up →
copilot.tencent.com**，两次产出回合后断线。按规程记录、不无限重试：D38 由监理方直接实施
（与 D35–D37 同一处置），全部护栏仍按「先红后绿 + 负控」执行。workbuddy 恢复判据 =
一次真实的 `-p` 回合完整跑到 result。

## 记录 2 — 子代理调查 `app.asar` 长时间无产出（非模型故障，属工具局限）

- **时间**：2026-09-16T18:52Z 起，约 45 分钟后由协调者主动终止
- **现象**：负责侦察 DSH client-half 契约的子代理长时间运行且**未落盘任何文件**
- **根因判断**：其探针依赖对 297 MB `app.asar` 做正则/上下文搜索。本仓库
  `docs/findings-wb-login-rootcause.md` §9.1 已经记载过同类教训：
  **对超大二进制做回溯正则不适合，应当用字面量 grep 或有界 Python 分块扫描**。
- **处置**：终止子代理，改由协调者直接读取磁盘上**已安装的 client-half 插件产物**
  （`~/.dsh/profiles/desktop/node_modules/dsh-history`、`dsh-better-sidebar`），
  数十秒内取得同等事实（slot 注册 API、`ctx.webServer.register` 路由契约、`dsh.client` 字段形状）。
- **不是**模型/凭据故障，记录在此仅为方法论留痕。

---

## 记录 3 — 共享 `node_modules` 被并发改动，以及一次「删除 `.ignored/` 导致断链」的回滚事故

- **时间**：2026-09-17T03:34Z 发现 `.ignored/`；03:50Z 因删除它造成断链；03:51Z 恢复
- **性质**：**协调者操作事故**，不是模型/凭据故障，但影响面大，故完整留痕。
- **经过**：
  1. `node_modules/.ignored/` 出现（含 17 个 `@deepseek-ai` 包），
     `.package-lock.json` 时间戳未变 → 判定为一次**被中断的 reify**，不是完整安装。
  2. 协调者核对后认为「`.ignored` 内的包在 `node_modules/` 中均存在」，于是 `rm -rf .ignored`。
  3. **判断错误**：`node_modules/@deepseek-ai/cordis` 实际是一个**指向 `.ignored/` 的软链**，
     删除目标后变成断链，`tsc --noEmit` 立刻报 `TS2307: Cannot find module '@deepseek-ai/cordis'`。
     （`ls` 仍能列出该名字，因此「名字存在」不等于「解析得到」——这正是最初的误判来源。）
  4. 恢复：从兄弟仓库 `dsh-background-promotion/node_modules/@deepseek-ai/cordis`
     （`4.0.1`，与本仓库其余 `@deepseek-ai` 包同源，D10 已记录该树即来自它）复制回真实目录，
     并重建 `node_modules/.bin/cordis` 软链。
- **恢复验证**：断链 0 个；`tsc --noEmit` 0 错误；**296/18 全部通过**（当时基线）；
  `lib/index.js` 184.9 KB。与事故前完全一致。
- **新增守卫**：`.wb-harness/check-toolchain.mjs`（监理工具，不入交付物）——
  检查断链、`.ignored/` 存在性、**哪些软链指向 `.ignored/`**、lockfile 时间、关键包可解析、本地 bin 齐全；
  已接进 `.wb-harness/review.mjs`，每次审核先跑。
- **根因**：每个 worktree 的 `node_modules` 是**指向本仓库同一棵树的软链**，
  因此任何在 worktree 里发生的包管理动作都会改到**全仓库共用的那一棵**。
- **人工待办**：本仓库的 `node_modules` **不可重新解析**（`@deepseek-ai/dsh-type-meta` 在 registry 上 404，D10），
  所以任何时候都不要在此仓库跑 `npm install` / `pnpm install`；
  若必须动依赖，请先整棵备份。

---

## 记录 4 — AutoClaw「跑不起来」**不是**上游/凭据故障，是桥自己的 argv 缺陷（已修复）

- **时间**：现象于 2026-09-17 由审查者实测发现；同日晚由工作流 F 修复并复验
- **现象（修复前）**：
  ```
  probe  autoclaw: track=desktop available=true     ← 探测说它可用
  run    session=sess_… status=running
  result status=failed exit=1 durationMs=1171
  error: openclaw returned no parseable output: Too many arguments for this command.
  Try: openclaw agent agent --help                  ← 注意 "agent" 出现了两次
  ```
- **判定**：**不是**凭据、**不是**网络、**不是**上游模型。根因是三段代码合起来的结果——
  `buildOpenclawArgs()`（`src/drivers/openclaw.ts:187`）无条件把 `agent` 放在 argv 最前，
  而 `buildArgv()`（`src/kernel/spawn.ts:81`）只是把描述符的 `argsPrefix` 拼在它前面，
  于是两个身份里的 `argsPrefix: ['agent']` 让最终 argv 变成 `… agent agent …`，CLI 直接拒绝。
  另外 `autoclaw` **连 `--profile autoclaw` 都没带**，裸跑会去读 `~/.openclaw/openclaw.json`（stub）报 config invalid（D12 记录过的坑）。
- **修复**：`autoclaw` → `argsPrefix: ['--profile','autoclaw']`；`openclaw` → 删除 `argsPrefix`；
  新增 `tests/integration/argv-shape.test.ts` 对每个内置身份的**最终 argv** 加护栏（见 `docs/plan.md` D28）。
- **复验（真实端到端，非模拟）**：
  ```
  probe  autoclaw: track=desktop available=true  version=2026.6.8
  run    session=sess_0ecacf5a-8612-4fa2-bfa4-acc0e5f9f08d status=running
  events (1): [text] AUTOCLAW_OK
  result status=completed exit=0 durationMs=6827
  text: AUTOCLAW_OK
  usage: {"inputTokens":14268,"outputTokens":23,"cacheReadTokens":15104,"cacheWriteTokens":0}
  backendSessionId: 95b07772-8779-4e5e-80ef-e0e70445185d
  ```
- **人工待办**：无。**若今后再看到同类报错，请先看最终 argv，不要去查 key。**
  本文件的第一条（国内版 `workbuddy` 上游 ETIMEDOUT）**仍然未解决**，那条才是真的上游问题。

---

## 记录 5 — 宿主子进程 PATH 里没有 `node`（**仓库外**事实，桥侧已补偿，无需人工处理）

- **时间**：2026-09-17（工作流 H 排查 `env: node: No such file or directory` 时复验）
- **性质**：**仓库外**的宿主环境事实。它不是本次缺陷的根因（根因全在仓库内，已修），
  但它是那条症状之所以成立的**前提**，且无法在本仓库里消除，故按任务书要求留痕。
- **事实（本机复验，逐字）**：
  ```bash
  ls "/Users/example/Library/Application Support/DSH Desktop/runtime-commands/generations/"
  # → 68c24b0a32d4571ebb18d44b97380d522c67e885d64dae302ad011c1ab5f3123-c688fb67-32c9-438a-a7c9-4ca17095609d

  ls -l /usr/bin/node
  # → ls: /usr/bin/node: No such file or directory

  env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' sh -c 'command -v node; echo "exit=$?"'
  # → exit=1
  ```
  即 GUI 启动的 DSH 宿主给子进程的 PATH 是
  `…/runtime-commands/generations/<hash>/bin:/usr/bin:/bin:/usr/sbin:/sbin`，
  里面**没有 node**（node 只存在于 `/opt/homebrew/bin`、`/usr/local/bin`、
  `~/.nvm/versions/node/*/bin` 这些**不在该 PATH 上**的位置）。
- **后果**：任何 `#!/usr/bin/env node` shim（`claude`、`codex`、`codebuddy-code` 三个身份
  都是，见 `docs/findings-node-shim.md` §2.2）被**裸执行**时，会以退出码 127 失败并输出
  `env: node: No such file or directory`。注意退出码是 127 **不是** spawn 失败：
  shebang 里的 `/usr/bin/env` 存在，exec 成功，是 `env` 自己找不到 `node`。
- **桥这一侧的处置（已完成，不是绕过）**：这正是 **CLI 轨道 shim 修复**存在的理由
  （D7、`design-tracks.md` §3.3）—— 读 shebang，用 `CLI_SEARCH_PATH` 里解析出的绝对路径 node
  去拉起脚本；桌面轨道则一律由描述符**钉死** `interpreter`。本次修的是**这条修复没能到达
  版本探测**（探测自己拼 argv），不是 PATH 本身。修复后**无 node 的 PATH 下能取到真版本**：
  协调者在**合并后的树**上用 `env PATH=/usr/bin:/bin:/usr/sbin:/sbin ./bin/dsh --profile web --no-open`
  实测 `claude` 2.8.4 / `codex` 0.154.0 / `codebuddy-code` 2.151.0 / `codebuddy-code-acp` 2.151.0
  （修复前这四行是 `version: "env: node: No such file or directory"`），桌面三身份
  `workbuddy` 2.137.1 / `workbuddy-ai` 2.137.1 / `autoclaw` 2026.6.8 **前后一致**；
  受控对照（同一段脚本、注入无 node 的 PATH、修复前 → 修复后）见
  `docs/findings-node-shim.md` §2.5，摘要进 `docs/plan.md` 交付指标。
- **未做（有意为之）**：没有改宿主 PATH、没有改 DSH 启动顺序、没有碰 `~/.dsh/**`、
  没有安装任何东西、没有往桥里塞 node 路径常量。宿主不给子进程 node，是**宿主的设计选择**，
  桥只能（且已经能）自己解析。
- **人工待办**：**无。** 留痕的目的只有一个：下次再看到 `env: node: No such file or directory`
  时，先判断它是「桥没有把解释器带上」（仓库内，看 `docs/findings-node-shim.md`）
  还是「有人绕过桥裸执行了 shim」（环境事实，本条），**不要去查 key、不要去改 PATH**。
  若将来宿主改为在 PATH 上暴露自带 node，CLI 轨道的修复会自动不再触发
  （`createCliPolicy().launch()` 只在 `lookupOnPath('node', env.PATH) === undefined` 时才修），
  本记录随之作废 —— 届时删掉即可。

---

## 记录 6 — 免费模型配额用尽，两条工作流各死一次（**配额故障，只记录、不绕过**）

- **时间**：2026-09-17 11:56（本机 CST）
- **现象**：两个 workbuddy 工作流分别以 `result.subtype = error_during_execution` 结束，
  最终 assistant 文本是服务端的一句话（逐字）：
  `429 usage exceeds frequency limit, but don't worry, your usage will reset at
  2026-09-18 02:36:49 UTC+8, alternatively, you can switch to the other models to continue using it.`
- **用量（`node-shim-note` 的 `result` 帧，逐字）**：`input_tokens` 15,223,873 /
  `output_tokens` 70,428 / `cache_creation_input_tokens` 169,921 /
  `cache_read_input_tokens` 15,053,952，`duration_ms` 2,659,279（44 分钟）。
- **影响**：
  - `node-shim-note`：死在**产出已经写完**之后（代码、测试、文档都在工作树里），只是没跑完门禁、
    没交 `## WORKBUDDY REPORT`、`state.status` 因此是 `failed`。产物由协调者**独立复核**
    （719 passed / 1 skipped、`tsc` 0 错误、`verify_plugin.py` 11/11、无 node 宿主 PATH 真机验收）后
    合并 —— 这一条**不构成人工待办**。
  - `settings-surface`：死在 65 次工具调用处，**零产出**（工作树里只有 `node_modules` 软链）。
    会话 id 已存进 `.wb-harness/state/settings-surface.json`，配额恢复后
    `dispatch.mjs --task settings-surface --resume` 即可接着跑，**不必重写任务书**。
- **未做（有意为之）**：没有改模型、没有改配额、没有重试刷量。「用哪个模型 / 要不要为它花钱」
  是操作员的决定，不是工作流能自行绕过的东西。
- **人工待办**：**只有一个选择** —— 等配额重置（2026-09-18 02:36 +08:00）后 `--resume`，
  或明确改用另一个模型重派。**不要把 `429` 当成代码缺陷去查。**

---

## 记录 7 — `command-code / qwen3.8-flash` 报 400 `developer is not one of [...]`（**上游角色词表不兼容，只记录、不改配置**）

- **时间**：2026-09-17 15:2x（本机 CST），操作员报告。
- **现象（逐字，操作员提供）**：
  `400: {"error":{"message":"developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",`
  `"type":"invalid_request_error","code":"invalid_parameter_error"}}`
- **根因（已定位到行，**只读**核对，未改任何配置）**：
  - 出角色的地方是 `~/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:910`：
    ```js
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    ```
    两个条件**同时**为真才会把系统提示发成 `role: "developer"`。
  - `compat.supportsDeveloperRole` 的探测默认值在同文件 `:1279`：
    `isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter)`
    —— 即「按标准 OpenAI 端点对待」时就为真；而 `:1329` 允许模型条目的 `compat` 覆盖它。
  - DSH 侧把它当作**可选兼容开关**暴露出来（`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:381,409,931`，
    `COMPLETIONS_COMPAT_GATE` 里 `supportsDeveloperRole: "offer"`），所以这是
    **模型条目的 compat 字段**问题，不是消息内容问题。
- **判定**：这是**上游/模型配置**层面的角色词表不兼容。`command-code` 的网关只认
  `system|assistant|user|tool|function`，而该模型条目被判为「支持 developer 角色」。
- **未做（有意为之）**：**没有**去改 `~/.dsh/settings.yaml`、`~/.dsh/profiles/**`、任何 provider 或
  模型条目，也**没有**为了复现而切换本会话的模型 —— 交接边界 §0 把配置面划在仓库之外。
- **人工待办（唯一动作，在配置文件里，不在本仓库）**：给 `command-code / qwen3.8-flash` 的模型条目
  加上 `compat: { supportsDeveloperRole: false }`（或把该 provider 标为非标准端点）。
  改完 `dsh --profile web --no-open` 重启即可验证；**不要**在本仓库里找「消息里的 developer 角色」——
  桥只搬运模型输出，不构造发给模型的角色。若将来 pi-ai 在收到该 400 时自动降级重试，本记录随之作废。

### 后续：该配置**已由操作员明确授权后加上**（越过了交接边界 §0，一次、可回滚）

- **授权**：操作员直接指示「帮我加这个配置」。§0 把配置面划在仓库之外是为了防止**未经授权**改动，
  操作员既然是本人授权，这一条就是合规的；**只有这一处被改**。
- **改动位置（一处，ROUTE 层）**：`~/.dsh/settings.yaml` → `llm-pi-ai.providers.command-code.compat:
  { supportsDeveloperRole: false }`（`settings.yaml:61-72`，含解释性注释）。
  **为什么放 route 层而不是 qwen 那个模型条目**：拒绝 `developer` 的是**端点**
  （`api.commandcode.ai/provider/v1`），而该 provider 的 `reasoning: high` 让**全部 13 个模型**都暴露在
  同一路径上；`profile.compat` 是 schema 里正为这种情况提供的层（`dsh-llm-pi-ai/lib/index.js:988`、
  `resolveModelCompat` 先取 route 再让 model 覆盖）。`system` 是所有 OpenAI 兼容端点都接受的基线，
  所以这里不可能拿走某个模型的能力；需要例外的模型仍可在自己的 `compat` 里覆盖。
- **备份**：`~/.dsh/settings.yaml.bak-20260917-154645-pre-commandcode-developer-role`
  （改前 sha256 前缀 `02c15fdf6a3db339`；改后 `6fc1d704ad5182f1`，差异仅这 12 行）。
- **已证（读代码 + 解析器）**：① YAML 合法、diff 恰好是预期 12 行（第一次编辑把 `command-code:` 缩进成
  5 空格，**被 YAML 解析器当场拒绝**后修正）；② `supportsDeveloperRole` 确实是 `openai-completions`
  **可配置**的开关 —— 直接读 `COMPLETIONS_COMPAT_GATE`（`:379-410`）与
  `COMPAT_GATES["openai-completions"]`（`:428-429`），即 `assertOfferedCompatFields` 与
  `resolveModelCompat` 查的同一张表；③ `false` **不会**被过滤掉（`configuredCompatEntries` 只丢空对象，
  `:472-476`）；④ 语义：`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole` → `false`
  → 角色回落 `system`（`@earendil-works/pi-ai/dist/api/openai-completions.js:910`）。
- **未证（如实说）**：
  - **没有对该端点发过一次真实请求** —— 工具 shell 里没有 `COMMAND_CODE_API_KEY`。所以「400 消失了」
    是**由构造推出**的，不是**观察到**的。要观察到，只能在有凭据的会话里用该模型跑一句话。
  - **本来打算用「重启宿主无告警」当证据，被自己的反向对照推翻了**：把同一个键改成非法值
    （`supportsDeveloperRole: "yes-please"`）后重启，日志里**同样没有** `invalid stored section` 告警。
    原因是 pi-ai 的校验**写在写路径上（strict）、读路径上延迟**（`resolveRouteModels(request,
    validation)`，`:630-631`）—— **手改 `settings.yaml` 不会在启动时被复查**。
    结论：那条「无告警」是**空跑的门禁**，不能算证据（「没跑到的门禁永远不是通过的门禁」）。
    附带事实（值得操作员知道）：**手写错的 compat 键不会被启动拦住**。
- **生效时机**：已解析的 profiles 按**原始配置**记忆化（`:2575-2590`），settings 文件 provider 有
  watcher；因此运行中的宿主在下次解析该路由时会取到新值。要绝对确定，重启 DSH Desktop 即可。
  **注意：我没有重启桌面端**（它就是当前会话的宿主）——只重启了 43121 上那个独立 web 测试宿主。



## 记录 8 — ZCode 桌面端账号无模型授权：`Select a model before continuing`（**账号/授权故障，只记录、不绕过**）

- **现象（真机，2026-09-17，ZCode 0.16.5）**：按官方形态拉起包内 CLI（见
  `docs/findings-zcode-headless.md` §1 的启动配方），会话可创建、`--output-format stream-json`
  可出事件，但每个 turn 立即失败：
  `{"type":"turn.failed","payload":{"error":{"code":"CONFIGURATION_ERROR","message":"Select a model before continuing"},"turnPhase":"model_creation"}}`
- **根因链（全部已证）**：① headless 的模型来自 provider-config 存储里的 `config.defaultModelSelection`，
  本机 `~/.zcode/v2/provider_config.json` 里**没有这个键**；② 能填这个键的候选全部不可用：
  四个 coding plan 在 `coding-plan-cache.json`（今天 15:12 刷新）里均为
  `coding_plan_not_entitled`，用户自配 `builtin:bigmodel` provider 的 `apiKey` 是**空串**；
  ③ 桌面端历史任务里最后完成的一条是 **8 月 28 日**，之后两条 `task_status:"error"`（`tasks-index.sqlite`）。
- **为什么这不是桥的缺陷**：同一条启动路径在 provider-config 修复前后表现一致（env 覆盖生效后
  报错从「找不到 provider 配置」变成「没有默认模型」，前进了一层）。协议、argv、会话面全部可达。
- **需要操作员做的事（二选一，然后可选一步）**：
  1. 恢复 ZCode 侧授权：续订 BigModel/Z.ai 的 coding plan，**或**在桌面端给某个 provider 填入 API key；
  2. 在桌面应用一次真实任务（或在 TUI `/model` 选定），让 `defaultModelSelection` 落盘；
  3. （无需再做别的）桥侧 zcode 驱动的端到端验收即可从「被阻塞」转为「可执行」。
- **禁止的绕法（已拒绝执行）**：手改 `~/.zcode/**`（vendor 状态目录）、伪造 plan entitlement、
  或把 `[inferred]` 的解析映射当 `[proven]` 写进驱动。

---

## 记录 9 — hermes 的默认模型被 OpenRouter 拒（HTTP 404 免费档不可用），而桥报 `completed` 却**没有任何模型输出**（**上游/账号模型可用性故障，只记录、不绕过**）

- **时间**：2026-09-17 20:35 前后（本机 CST），D39 的真机验收。
- **执行的命令**：
  ```bash
  export PATH=/opt/homebrew/bin:$PATH
  cd /Users/example/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge
  node --experimental-strip-types scripts/acceptance.ts hermes "Reply with exactly: OK"
  ```
- **原始输出（逐字）**：
  ```
  probe  hermes: track=cli available=true
         executable=/Users/example/.local/bin/hermes version=0.21.3 reason=-
  run    session=sess_756d58a0-4ada-4fbf-be18-968762c57554 status=running
  [dsh-agents-bridge:acceptance:run:hermes] acp engine advertises auth methods {"authMethods":["openrouter","hermes-setup"]}

  events (6):
    [status] engine requires authentication; it accepts: openrouter, hermes-setup. Set DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD to one of these to have the bridge authenticate.
    [status] session eeac6539-f93a-4a48-8222-7acd1258e467 ready
    [status] running
    [status] available commands update: 9 commands
    [status] session info update
    [text] OpenRouter didn't answer after 3 attempts — it looks temporarily unavailable. Wait a minute and send /retry, or switch models with /model. To avoid this in future, add a backup provider with `hermes fallback add`.  Provider said: HTTP 404: This model is unavailable for free. The paid version is available now - use this slug instead: minimax/minimax-m3

  result status=completed exit=0 durationMs=18739
  text: <与上一条 [text] 同文>
  backendSessionId: eeac6539-f93a-4a48-8222-7acd1258e467
  ```
  （`acceptance.ts` 以 `exit=0` 结束，即 `current.terminal === true`：**终态确实落地了，没有挂起**。）

- **判定：不是桥的缺陷、不是凭据失效、不是网络问题。**
  - 凭据是**活的**：`initialize` 的 `authMethods[0] = openrouter`，而且请求**真的到了 OpenRouter** ——
    404 后面那段话是 OpenRouter 自己的话术（"This model is unavailable for free… use this slug instead"）。
  - 失败的是**模型档位**：hermes 自己配置里的默认 slug `minimax/minimax-m3:free` 已不再免费，
    上游要求改用 `minimax/minimax-m3`。这是**账号/上游模型可用性**问题（与本文件记录 8 的 ZCode
    「账号无模型授权」同族），不是桥能修的。
- **必须如实记录的形态（本条的重点）**：终态是 `completed`、18.7s、`exit=0`，但**这一回合没有产生任何模型输出** ——
  唯一的 `[text]` 是引擎自己转述的上游失败。根因在引擎侧：hermes 把上游失败当成**普通 assistant 文本**发出，
  并在 ACP 层以**正常的 end-of-turn** 收尾；`stopReason` 不在 `refusal | max_tokens | max_turn_requests` 里，
  所以驱动判 `completed` 是**按协议正确**的行为。**不要**因此去改驱动的 `stopReason` 映射 ——
  那会把「引擎报告正常结束」改成「桥猜测失败」，是更糟的静默错误。这条留作**已知形态**，
  而不是靠启发式（"看到 404 就判失败"）去修。
- **为什么桥在这个身份上没有换模型的杠杆**：`hermes acp` 的 `session/new` **忽略**模型参数 ——
  实测 `model` 与 `modelId` 两种拼法都被接受但不生效（`currentModelId` 纹丝不动，见
  `tests/fixtures/ACP-PROVENANCE.md` 的「A SECOND engine on the same wire」）。所以描述符
  如实声明 `model: false` / `effort: false`（`session/new` 完全不回 `configOptions`）。
- **未做（有意为之）**：没有改 `~/.hermes/**` 的任何文件、没有换 key、没有改 baseURL、
  没有为了绕过而重试刷量、没有在驱动里加"文本里出现 404 就判失败"的启发式。
- **人工待办（唯一动作，在 hermes 自己的配置里，不在本仓库）**：把 hermes 的默认模型换成可用档位 ——
  paid slug `minimax/minimax-m3`、或在 hermes 内 `/model` 选一个可用模型、或用 `hermes fallback add`
  配后备 provider。改完复跑同一条 `scripts/acceptance.ts hermes "Reply with exactly: OK"`，
  期望看到 `[text] OK` 而不是 404 话术。**不要把这条当代码缺陷去查。**

## 记录 10 — `deepseek-v4.1-flash` 触发 429 频率限制：两个施工批次同时阵亡（**配额故障，只记录；已按用户给定的模型链继续**）

- **现象（原样）**：`2026-09-18 02:47`，两个并行派出的 workbuddy（WorkBuddy CLI，`--model deepseek-v4.1-flash`）
  在同一分钟里先后终止，`stream-json` 的 `result` 事件均为 `subtype: error_during_execution`、`is_error: true`、
  `num_turns` 分别 **392**（批次 1）与 **103**（批次 2）。两者的最后一条助手文本都是：
  `429 您的使用量已超出频率限制，将在 2026-09-18 22:55:03 UTC+8 重置，您也可以切换其他模型继续使用。`
- **性质**：**模型配额/频率限制**（与本文件记录 6「免费模型配额用尽」同族）。**不是**本仓库的代码缺陷，
  也不该去改桥的驱动或重试逻辑。
- **监理这边同时是一次真实失误（记在我头上）**：我在**同一分钟并行派了两个** workbuddy，把配额烧穿。
  本仓纪律只写了「不要并发跑两套 build/vitest」，**没有写「不要并发派多个施工代理」** —— 现在有了证据，两个都要避免。
- **用户的处置指令（2026-09-18 03:00 左右）**：切换到 **`glm-5.3-flash`**；若它也限额，切 **`hy4-preview`**；
  两者都限额就由监理收尾。WorkBuddy CLI 的 `--help` 里 `--model` 的受支持清单即含
  `glm-5.3-flash` 与 `hy4-preview`，另有 `--fallback-model`（**仅在上游“过载”时自动回退**，不覆盖请求悬挂）。
- **实测（监理亲跑）**：`glm-5.3-flash` 可用（探针 2 轮返回 `PONG`）；`hy4-preview` 可用（`PONG2`）。
  但 `glm-5.3-flash` 在**长时间 agentic 会话**里出现过一次**请求悬挂**（流 5 分钟零增长、CPU 近乎空闲），
  遂按用户给定的链改派 `hy4-preview` 重跑同一批。**这条与记录 6 一样只记录，不写进桥的代码。**
- **对交付的影响（如实）**：「会话终态主动通知」那一块因此**由监理自建**（`b3c732c`），
  没有第二方独立复核 —— 已在 `docs/review-fixes.md` §U-0 / §U-5 与 `docs/handoff-2026-09-18.md` §5 显式标注为**待复核**。
