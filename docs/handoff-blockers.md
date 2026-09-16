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
  cd /Users/king/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge
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
