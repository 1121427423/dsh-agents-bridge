# 全项目审查台账（review-repair ledger）

来源：2026-09-17 对 `c6666dd` 的**只读**全项目审查 —— 36 个 agent（7 透镜 × 2 轮 +
14 + 8 对手复核），产出 96 条原始主张。判定规则：**只有经对抗复核（独立 agent 试图推翻）后
仍成立者才进修复队列**；单透镜主张先复核再决定，绝不"照着可能是错的主张改代码"。

台账口径（findings 的 ID 由审查输出分配，此处固定）：

| 状态 | 含义 |
|---|---|
| `fixed` | 已修 + 回归测试先红后绿 + 全门禁通过 + 监理复核 |
| `in-batch` | 已派给 workbuddy，等待落地与复核 |
| `verified` | 对抗复核判定成立，尚未派工 |
| `verifying` | 正在对抗复核（结论未出） |
| `rejected` | 复核判定不成立（附反证） |

## A. 已复核成立 · 修复队列

| ID | 严重度 | 位置 | 一句话 | 状态 |
|---|---|---|---|---|
| IM-1 | Important | `src/tracks/desktop/scan.ts:708-712`（经 `registry.ts:574-579,308`） | 扫描产物仅凭文件名形状即标为可启动，`agents_probe` 随即执行它；D26 声称的允许清单只管 run 不管 probe | verified |
| IM-2 | Important | `src/drivers/claude.ts:746-767` | CodeBuddy/WorkBuddy 的审批帧缺 `allowed:true`（真机 bundle 只读 `allowed ?? false`）→ 每个权限请求被当拒绝 | **fixed**（c554a6f） |
| IM-3 | Important | `src/kernel/watchdog.ts:62-64,130-132` | `timeoutMs > 2^31` 被 Node 钳成 1ms → 刚 spawn 就被杀并报 timeout | **fixed**（c554a6f） |
| IM-4 | Important | `src/kernel/store.ts:26-38`（`manager.ts:178-192`） | 游离 agent 进程树在宿主重启后无人回收；pid 根本没落盘 | **fixed**（B2） |
| IM-5 | Important | `src/kernel/manager.ts:247,359,465` | 续跑指针只在终态落盘 → 中途重启即丢，`agents_send` 永久无法续跑 | **fixed**（B2） |
| IM-6 | Important | `src/kernel/store.ts:126-136,212-221` | 整表覆写：同目录两个 store 时，后写者吞掉先写者新增的行 | **fixed**（B2，见 §I） |
| IM-7 | Important | `src/kernel/manager.ts:173,464,634`（`session.ts:80,129-144`） | 终态会话永不从 `live` 驱逐 + transcript 无上限 → 长期宿主 RSS 单调增长 | **fixed**（B2） |
| IM-8 | Important | `src/drivers/argv.ts:544-552`（`claude.ts:1036-1050`） | 300s 空闲看门狗在 `tool_use`→`tool_result` 静默期误杀健康长工具调用 | **fixed**（B3，见 §J） |
| IM-9 | Important | `src/drivers/generic-argv.ts:17-21,237-239,305` | generic 驱动删掉所有空行，违反自己声明的逐字契约 | **fixed**（B3，见 §J） |

MI 级（复核后降级，仍修）：MI-1 Host 栅栏只看 `Host` 头（`host/api.ts:181-198`）· MI-2 不传 `cwd` 绕过 cwd 策略
（`manager.ts:403-410`）· MI-3 `allowedCwd` fail-open（`policy.ts:49-59,140`）· MI-4 `readLines` 无单行上限
（`argv.ts:509-517` · `kernel/spawn.ts:100-110` 同型）· MI-5 openclaw 混合形态永不 arm（`openclaw.ts:366-371`）·
MI-6 `exited` 只在 `close` 结算（`spawn.ts:213-223`）· MI-7 强制终态不清 `setInterval`（`manager.ts:332-357`）·
MI-8 `probe(refresh)` 同步重扫（`registry.ts:437-441`）。

**B2 状态**：上述 MI 段中属 B2 的 **MI-2 · MI-3 · MI-6 · MI-7 · MI-8 均已 fixed**（其余 MI-4/MI-5 属 B3，未动）。

**B3 状态**：MI 段中的 **MI-4 · MI-5 已 fixed**，§G-3 的 **MI-18** 同批 fixed（三条均见 §J）；
其余 MI-1/MI-9…MI-15/MI-22 与 IM-15/MI-16/MI-17/MI-19/MI-20/MI-21 依 §E-2 并入后续批次，本批未动。

## B. 监理亲手复现（独立于 workbuddy 自述）

脚本：`/tmp/repro-review.ts`、`/tmp/repro-store3.ts`（只读仓库、只写 `/tmp`）。

**IM-3 —— 定时器上界**（`createWatchdog` 真实模块）：

```
IM-3 control  (timeoutMs=5_000_000): did not fire
IM-3 overflow (timeoutMs=2147483648): fired after 2ms      ← 附带 Node 告警 "Timeout duration was set to 1."
IM-3 overflow (timeoutMs=1e12)      : fired after 1ms
```

**IM-6 —— 整表覆写丢行**（真实 `createSessionStore`，含管理器的 `reload()` 流程）：

```
1. s1 (reloaded).upsert(A)      disk = A
2. s2 (reloaded).upsert(B)      disk = A,B
3. s1.upsert(C)  <-- lost update disk = A,C     ← B 被吞
4. fresh.reload() sees          = A,C           ← B 永久消失
```

> 复现过程中两次自纠：第一版脚本没建目录 → 磁盘根本没写，那句 "DEFECT REPRODUCED" 是**空跑结论**；
> 第二版漏了 `reload()`（构造时不读盘）→ 又得出错误中间态。补全后才可信。**"没跑到的门禁不是通过的门禁"
> 同样适用于复现脚本本身** —— 空跑结论比没有结论更危险。

## C. 复核后驳回 / 降级

- rejected 1 条（理由随审查输出截断丢失，已记录为已知不完整处）。
- 两条 CR 主张经复核均**降级**：IM-1 CR→IM（`~/Applications` 属用户可写，能种文件者已在以该用户执行代码，
  差的不是新的初始 RCE，而是默认开启 + 模型可调用路径上的持久化/隐蔽触发）；MI-1 CR→MI（照抄 DSH 自己的
  browser-trust 栅栏，其 header 明确"不是认证层"）。
- 8 条降级为 MI 的见 §A 末段。

## D. 已知不完整处（不粉饰）

1. **2 条已复核 IM 因工具输出截断丢失**（第一轮 severity 排序第 10-14 位中），第一轮 26 条 MI 清单与那条
   rejected 理由同样失落。复核配额为 CR/IM 前 14 条。
2. 第二轮 24 条 IM 主张**正在**对抗复核（`verifying`），结论将并入后续批次；本轮审查对它们**不预设真假**。
3. `tests-meta` 透镜点出 5 条最危险**未测**路径，其中 `scripts/verify.mjs` 无 CI 入口、
   `manager.ts:435` 的生产默认 idle 零测试 —— 见 B6 批次。

## E. 批次计划

| 批次 | 范围 | 状态 |
|---|---|---|
| B1 | IM-2 · IM-3 | **fixed**（`c554a6f`；监理复跑 785/1 · tsc 0 · 双构建 · verify 11/11，并自验负控：把 codebuddy 新字段翻回 `false` → 新测试真红） |
| B2 | IM-4 · IM-5 · IM-6 · IM-7 · MI-2 · MI-3 · MI-6 · MI-7 · MI-8 | **fixed**（本分支未提交；vitest 808/1 · tsc 0 · 双构建 · verify 11/11，九条均先红后绿，见 §I） |
| B3 | IM-8 · IM-9 · MI-4 · MI-5 + **IM-15**（ACP `dispose()` 零调用者 → 终端孤儿）· MI-16 · MI-17 · MI-18 · MI-19 · MI-20 · MI-21 | **IM-8 · IM-9 · MI-4 · MI-5 · MI-18 fixed**（见 §J）；其余（IM-15 · MI-16 · MI-17 · MI-19 · MI-20 · MI-21）依 §E-2 并入 B3b+B6 卫生批 |
| B4 | IM-1 · IM-10 · IM-11 · IM-12 · IM-13 · MI-9 —— **IM-1 与 IM-10 必须同批**（前者今天被后者掩盖） | pending |
| B5 | MI-1 · **IM-16**（settings 清空字段静默 no-op，却报 ok:true）· **IM-17**（`agents_output` nextIndex 越过未展示事件）· **IM-18**（Origin 丢端口 → 任意 loopback 端口页面可驱动 API）· **IM-19**（`textSeen` 永不复位 → 渲染粘连）· MI-10…MI-15 · MI-22 | pending |
| B6 | 门禁自身：**IM-14**（测试文件不在类型门禁内，含 4 个真 TS2339）· 真空断言 · `verify` 无 CI 入口 | pending → **并入 B3b**（见 §E-2） |

**裁定完成度**：四组 24 条主张已全部裁定（scan 4 成立 / driver 1 成立 / surface 4 成立 / client+tests 1 成立），
合计**新增 10 条成立项**（IM-10…IM-19）与 14 条降级项（MI-9…MI-22）。
即：原始报告的 33 条 CR/IM 主张中，**最终只有 15 条以 IM 级成立**，其余降级或驳回。

## E-2 批次排序的两处调整（2026-09-17，监理决定）

1. **IM-14 提前并入 B3b**。理由：它是「测试文件不在类型门禁内 + 已有 4 个真 TS2339」。
   后续每一批都要改测试文件，**门禁先装上，后面的测试改动才会被类型检查覆盖**；放最后等于让
   中间几批的测试改动全部逃过类型门禁 —— 与「没跑到的门禁不是通过的门禁」同源。
2. **B3b 与 B6 合并为"卫生批"**：dialect 卫生（MI-16 · MI-17 · IM-15 · MI-19 · MI-20 · MI-21）
   + 门禁卫生（IM-14）。两者都在改驱动边界与测试，合批省一次"读全仓库"的开销；
   代价是单批略大，由监理逐项复核吸收。

调整后剩余流水线：**B3（在跑）→ B3b+B6（卫生）→ B4（scan）→ B5a（surface）→ B5b（client）**。
为在有限轮次内落地，监理采用**错峰流水**：上一批进程退出后才派下一批（不在同一时刻跑两个
`build.mjs`/vitest），而监理对本批的复核与下一批的**阅读阶段**并行 —— 复核只读，不产生冲突。

## H. 监理亲手复现清单（= 修复验收 oracle）

脚本都在 `/tmp`（`repro-review.ts`、`repro-store3.ts`、`repro-readlines.ts`、`repro-origin.ts`、`repro-wd2.ts`），
**只读仓库、只写 /tmp**。这些不是"复核者说"，是我自己跑出来的判据。

| 项 | 复现要点 | 修复后判据 |
|---|---|---|
| IM-6 | 真实 `createSessionStore` 含 `reload()` 流程：`A` → `A,B` → 写 C 后磁盘变 `A,C`，**B 永久消失** | 三次写后磁盘含 A、B、C |
| IM-9 | 真实 `readLines` + generic 的重组方式：`line1\n\nline2\n\n\nline3\n` → `line1\nline2\nline3`（**删掉 3 个空行**） | 驱动 text 与原始 stdout 一致（仅首尾 trim） |
| IM-3 | 真实 `createWatchdog`：修前 `2147483648` → **2ms 触发**（附 Node 告警 `Timeout duration was set to 1`）、`1e12` → 1ms；**已修**后两者均不触发，正向对照 `50ms` 仍在 51ms 触发 | 保持已修状态 |
| IM-18 | 真实 `isTrustedApiRequest`：`Origin http://localhost:9999` / `Host localhost:43120` → **true**（应当 false），`127.0.0.1:9999` 同 | 两条翻 `false`；四条对照（同 authority / 无 Origin / cross-site / 外部 Host）保持原值 |
| IM-15 | `grep -rn "\.dispose()" src/drivers/acp.ts` 与全 `src` 的 acp dispose 调用点均为**空** → 只有定义、没有调用者 | `runAcp` 两条退出路径上都出现调用；且 fixture 的"建了就忘"模式下 `process.kill(pid,0)` 抛 ESRCH |
| MI-16 | `buildCodebuddyArgs({extraArgs:['--strict-mcp-config']})` → 该 token **原样留存** | 被丢；对照：`--output-format`/`--permission-mode` 仍被丢、无害 extra 仍保留 |
| MI-17 | `buildClaudeArgs({extraArgs:['-p','/tmp/x']})` → `/tmp/x` **留成位置参数** | 不再出现；`-p=/tmp/x` 形式仍被拦 |

**一次对照写错的记录（同样记账）**：验证 MI-16 时我第一版对照写成"claude 应恰好发出一次
`--mcp-config`"，结果 false —— 因为 `--mcp-config` 是**由 runner 追加**、不在 args builder 里，
**我测错了层**。改用"已知会被拦的旗标必须被丢"作为对照后，过滤器行为得到证实，
从而把结论精确到「泄漏的原因是 blocked 表缺这一项」，而不是"过滤器坏了"。
**对照写错会给出假信号 —— 与空跑结论同类。**

**复现过程中的自纠（两次）同样记在这里**：IM-6 第一版脚本没建目录 → 磁盘根本没写，却输出
"DEFECT REPRODUCED"；第二版漏了 `reload()`（store 构造时不读盘）→ 又得出错误中间态。
**空跑结论比没有结论更危险** —— 与"没跑到的门禁不是通过的门禁"是同一条纪律。

**串行纪律**：批次不并行 —— 两个 workbuddy 同时跑 `scripts/build.mjs` 会互相覆写
`lib/index.js`，并发 vitest 会让门禁数字失去意义。

## F. 修复方向（每条的验收判据）

> 每条都遵循同一形状：**先写能真红的回归测试 → 修 → 负控（把修复撤掉看它变红）→ 全门禁**。
> 「唯一一处实现冻结规则」是本仓库的教条：不允许在调用点各自打补丁。

**B2（kernel）**

- **IM-4 游离进程树**：`StoredSession` 增 `pid?`（spawn 时写入）；重启恢复循环里对仍标 `running` 的行
  `process.kill(-pid,'SIGKILL')`，复用 spawn 既有的 ESRCH/EPERM 处理；**必须防 pid 复用**（比对
  startedAt 或写入进程启动标识后再杀）。测试：注入 killer，喂一条 `{status:'running',pid:4242}`，
  断言收到 `-4242/SIGKILL` 且该行被改写为 `failed`。
- **IM-5 续跑指针**：把 backendSessionId 提到 handle 上（或 `session.pinBackendSessionId()`），
  观察到的**当场** upsert，而不是等终态。测试：起一轮 → 在 settle 前 `store.reload()` → 断言指针已在。
- **IM-6 整表覆写**：写入时**合并**——重读 `sessions.json`、应用本次变更、再 tmp+rename；
  或改按会话分行/追加日志。测试：`s1.upsert(A); s2(reload).upsert(B); s1.upsert(C)`
  → 断言磁盘含 A、B、C（今天的实测结果是 A、C，B 消失——见 §B）。**注意**：仓库现有
  `store-robustness.test.ts:71-73` 把这种丢失写成了预期，该断言必须一起改，否则修了也会红。
- **IM-7 内存无上限**：终态会话移出 `live`（已有 `restored` 可放紧凑行），只留小 LRU（如最近 20 条）
  供 `output()`；`AgentSession.buffer` 用 drop-oldest 环 + 一条合成 `status` 事件说明丢了多少；
  `startRun` 的 finally 里 `rec.handle=undefined` 并摘掉 abort 监听。测试：跑 60 个终态会话 +
  每条 200 事件 → 断言 `live` 有界、`snapshot().messageCount <= cap`。
- **MI-2 cwd 绕过**：`const requestedCwd = runOptions.cwd ?? options.defaultCwd ?? process.cwd()`，
  无条件过 `checkCwd`，并把解析结果**总是**放进 `effective`（检查的路径 = spawn 的路径）。
  测试：policy 配 `allowedCwd:[tmp]`、run **不传** cwd → 断言拒绝或 `opts.cwd` 落在 tmp 内（今天是 `undefined`）。
- **MI-3 fail-open**：realpath 失败时保留 `path.resolve` 的原串兜底；把被丢弃的根收集起来，
  给 `createRunPolicy` 一个 logger 并 `error` 一行；「配了但全解析不出来」应**fail-closed**。
  测试：`createRunPolicy({allowedCwd:['/no/such/root']})` → 断言 `checkCwd('/',p)` 抛错（今天返回 `'/'`）。
- **MI-6 `exited` 只在 close 结算**：同时监听 `exit`（`once`）并在「exit 后给 stdout 一个有界 drain 宽限」
  与 `close` 之间取先到者。测试：`sh -c 'sleep 30 & exit 0'` → 断言 `exited` 在 ~1s 内 settle
  （今天要等满 30s），且 `cancel()` 仍能回收进程组。
- **MI-7 轮询定时器**：在 `cancelInternal` 的强制终态分支与 `live.clear()` 之前清 `rec.poll`；
  或把 `setInterval` 换成「终态即停」的 `setTimeout` 循环。测试：done 永不 settle 的假后端 +
  注入时钟 → 断言终态后不再读 handle。
- **MI-8 probe(refresh) 同步重扫**：`refresh` **不再**丢弃 scan 记忆（安装态不随 TTL 变化，源码 416-423
  的理据自洽）；并把目录遍历移出事件循环（异步 fs 或 worker）。测试：注入慢目录读取器 →
  断言第二次 `probe({refresh:true})` 不再重走。

**B3（drivers）**：IM-8 空闲看门狗 —— 提高 claude/codebuddy 默认窗口到"单次工具调用可信上限"之上，
或在「有未配对的 tool_use」期间不把静默当 idle，并把 `idleTimeoutMs` 暴露到 `agents_run` schema；
测试用假 CLI：init → tool_use → 睡 6 分钟 → tool_result，断言今天判 timeout、修后 completed。
IM-9 generic 逐字 —— 改为收集**原始 chunk**再 trim 得到 text（不再用按行重组），
或给 `readLines` 加 `preserveBlankLines` 供 generic 使用；测试：打印 `line1\n\nline2\n\n\nline3\n` 的假 CLI
→ 断言 text 与原始输出一致。MI-4 `readLines` 加单行/总量上限（溢出即报错并终止进程组，同型补
`kernel/spawn.ts` 的 LineSplitter）；测试喂 50MB 无换行流 → 断言以溢出信号收敛而不是涨 RSS。
MI-5 openclaw 混合形态 —— 让 cheap gate 在同一 buffer 里继续找真正的整块 result（今天遇到第一个
`{` 开头行就 return，导致永不 arm）；测试用「事件流 + 尾部单行 blob」的合成 fixture。

**B4（tracks/scan）**：IM-1 —— 扫描产物默认 **`unsupported`**（与 scan.ts:654-656 的引擎识别器同姿态：
没验过的不启动），或按 `CFBundleIdentifier`/签名校验后才算 launchable；`--version` 探针要过与 run 同一套
允许清单。测试：种 `~/Applications/ScanProbe.app/.../bin/codebuddy`（`touch /tmp/marker`）→
调 probe → 断言 marker **不出现**（今天会出现）。

**B5（surface/client）**：MI-1 Host 栅栏 —— 当 `Host` 声称 loopback 时，**额外**要求
`req.socket.remoteAddress` 也是 loopback；`trustedHosts` 只当 origin 允许清单，不当"谁在调用"的证明。
其余（settings 清空 no-op／`agents_output` nextIndex 越界／Origin 丢端口／渲染粘连／probe 无单飞／
client 4 条）待 §D-2 的复核结论并入后派工。

**B6（门禁自身）**：让测试文件进入类型门禁（独立 tsconfig 或 `tsc -p tsconfig.tests.json`）；
把「输出 schema 物化」护栏从只有 `agents_probe` 推广到全部 9 个工具；给 `scripts/verify.mjs`
一个 CI 入口（缺本地 skill 路径时应 fail 而不是 exit 2 静默溜过）；修掉
`manager-resume.test.ts:76-87` 的条件断言真空通过。

**F-补遗 · 裁定新增项的修复方向**（并入 B3/B4/B5）

- **IM-15（B3）ACP 终端孤儿**：在 `runAcp` 的两条退出路径（cancel 早返回 ~`acp.ts:1957`、正常 settle ~`:2005`）
  上都 `await client.dispose()`。测试：给 `tests/fixtures/fake-acp-cli.mjs` 加一个「建长驻终端且从不释放、
  并回报其 pid」的模式 → 断言 `handle.done` 后 `process.kill(pid,0)` 抛 ESRCH。负控：现有释放路径仍绿。
- **MI-16（B3）`--strict-mcp-config`**：把 `'--strict-mcp-config': 'standalone'` 加进 `CLAUDE_BLOCKED_ARGS`
  （`codebuddy` 自动继承该表）。测试：`buildCodebuddyArgs({mcpConfigPath, extraArgs:['--strict-mcp-config']})`
  → 断言 args 不含它。负控：删掉该表项 → 红。
- **MI-17（B3）`-p` 吞值**：`CLAUDE_BLOCKED_ARGS['-p']` 由 `standalone` 改 `optionalValue`
  （`argv.ts:268-271` 已支持吃掉后随非旗标 token）。**这是对 multica 规格的有意偏离**，必须写进
  `docs/driver-pitfalls.md`。测试：`buildClaudeArgs({extraArgs:['-p','/tmp/x']})` 不含 `/tmp/x`；
  负控：`-p=/tmp/x` 仍被拦。
- **MI-18（B3）abort 监听器**：把 `removeEventListener` 移进 `finishOnce`（`generic-argv.ts:209`，
  同理 `openclaw.ts:766`、`zcode.ts:386`）。测试：记录 add/remove 的假 signal，取消后断言已移除。
  注意它的另一半就是 IM-7（`live` 不修剪），别重复实现。
- **MI-19（B3）ACP 输出上限**：`#createTerminal` 里 `Math.min(engineLimit, ACP_MAX_OUTPUT_BYTE_LIMIT)`
  （新常量放 `acp.ts:167` 附近的默认值旁）。测试：`outputByteLimit:1e12` + fixture 打印超限 → 断言保留长度 ≤ 上限。
- **MI-20（B3）codex resume id**：`codex.ts:194` 处拒绝空值或以 `-` 开头的 resume id（报命名错误），
  不要把它当位置参数塞进去。测试：`buildCodexArgs({resumeSessionId:'--sandbox'})` 不得出现在位置槽。
- **MI-21（B3）codex 超时丢弃已完成回合**：`requestTerminal`（`codex.ts:706`）在
  `sawTurnCompleted/sawTurnFailed` 已为真时**从 parser 状态结算**再终止 —— 照抄 zcode 的边界结算。
  测试：发 `turn.completed` 后让假子进程活过 `timeoutMs` → 断言 `completed` 且带正文；负控：不发终态帧仍是 `timeout`。

- **IM-16（B5）settings 清空假保存**：`write()`（`settings.ts:459-482`）按 `coerceField === undefined`
  分区：有值的走 `scope.update`，无值的走 `scope.replace({...userLayer 去掉这些键})`（与 `reset` 同一惯用法），
  **绝不再发 `update({k: undefined})`**；也可直接 `ok:false` 点名该字段。测试：镜像真 provider 语义的 scope 假件
  （`update` 丢 undefined、`replace` 换 section）→ `write({defaultCwd:''})` 后断言该键 `overridden === false`。
  负控：`write({maxConcurrent:4})` 仍能持久化并置 `overridden === true`。
- **IM-17（B5）`agents_output` nextIndex 越界**：`execute` 里**总是**传
  `limit: Math.min(args.limit ?? MAX_RENDERED_MESSAGES, MAX_RENDERED_MESSAGES)`，使 `nextIndex ≡ sinceIndex + rendered`。
  测试：200 条消息的假 manager → 断言首读 `nextIndex === 80`，且以 80 续读能拿到第 80 条（无空洞）。
  负控：显式 `limit:5` 时 `nextIndex = sinceIndex+5`。
- **IM-18（B5）Origin 丢端口**：`isTrustedApiRequest`（`api.ts:194`）改为比 **authority**：
  `new URL(origin).host === hostUrl.host`（两侧都会把缺省/缺失端口归一为 `''`，故裸 `Host: localhost` 仍匹配）。
  **验收判据（监理已亲手复现，见 §H）**：`Origin http://localhost:9999` 与 `127.0.0.1:9999` 必须翻成 `false`；
  同 authority、无 Origin、`sec-fetch-site: cross-site`、外部 Host 四条对照必须保持原值。
- **IM-19（B5）渲染粘连**：`renderEventBlocks`（`definitions.ts:375-400`）把粘性 `textSeen` 换成
  `previousWasText`（每轮非 join 分支末尾按 `isText` 赋值），并把它放进 join 条件。
  测试：`[text a, tool_use Bash, text b]` → 3 个 block，第三个以 `#2 [text]` 开头；负控：`[text a, text b]` 仍合并为 1 块。
- **MI-22（B5）probe 无单飞**：`registry.probe`（`registry.ts:617`）保住 in-flight promise，
  并发调用者拿到同一个；测试：计数的 `probeVersion` 假件 + 两次并发 `refresh:true` → 总调用数等于身份数而非 2×。

## G. 待复核主张的裁定（滚动更新）

复核规则：独立 agent **试图推翻**该主张；`CONFIRMED` = 真、可达、实质；`DOWNGRADED` = 真但被高估；
`REJECTED` = 错（须给反证 file:line）。

### G-1 tracks/scan 组（4 成立 / 1 降级，已完成）

| ID | 判定 | 位置 | 裁定要点 | 修法 |
|---|---|---|---|---|
| IM-10 | CONFIRMED | `scan.ts:362` | `findBundles` 用共享 `bundles` 数组判 `out.length`，根 1 满了就 return → **`~/Applications` 从未被扫**；本机 `/Applications` 有 100 个 `.app`，而 `plan.md:764` 记录的真实运行恰好停在 "64 bundles"（正是上限），**用户可写根今天实际已被丢弃** | `findBundles` 里按根快照 `startLen`，用 `out.length - startLen` 判上限；墙钟预算仍全局 |
| IM-11 | CONFIRMED | `scan.ts:655`（同型 681-683） | `unsupported.reason` 叫操作员「设 `<PREFIX>_PATH` 并配 driver family 来启用」，但 `registry.ts:515-516` **先于** policy 返回 `unsupported`，`manager.ts:382-386` 一律拒跑 → 该 remedy **永远无效**，「enable it」是假的 | 改写这两处文案指向 `config.descriptors`（`index.ts:75`） |
| IM-12 | CONFIRMED | `scan.ts:759`（组装 731-746） | `notes`/`displayName` **逐字**取自 product.json 的 `applicationName`/`dataFolderName`/`darwinBundleIdentifier`/`endpoint` + 攻击者命名的 bundle 路径；`stringField` 只 trim，无 `oneLine`、无长度钳、无 `redactSecrets`（后两者仓库里都有：`host-files.ts:135/142`、`health.ts:76`）→ 敌意 bundle 可**伪造额外 probe 表行**（换行原样保留） | 每个事实字段钳到 ~200 字符，`notes`/`displayName` 过 `oneLine`，`slugify` 出的 `id` 也钳长 |
| IM-13 | CONFIRMED | `scan.ts:312` | `readBundleIdentifier` 用**裸** `fs.readFileSync`，绕过扫描器自己的 `readBounded`（409-421，`MAX_FILE_BYTES` 189）—— 而那段注释（402-407）正是为防 FIFO/2GB 文件挂住遍历而写的；已 stat 的 `plist.size` 被忽略，且该函数对用户可写根里的**每个**候选 bundle 都会调用 | 改走 `readBounded`（或先拒 `plist.size > MAX_FILE_BYTES`） |
| MI-9 | DOWNGRADED | `desktop/index.ts:36-42` | 机制为真（policy 重建 command 时丢 `protocolArgs`，而 `acp.ts:1592` 要读它），但**当前零爆炸半径**：没有任何已发布 desktop 描述符声明 `protocolArgs`，desktop 轨也没有 `acp` family —— 只能经 `overrides`/`descriptors` 配置面触达 | 对称性修复：`launch()` 里补 spread |

**IM-1 与 IM-10 的排期约束（复核者交叉发现，必须遵守）**：
IM-10 今天**掩盖**了 IM-1 —— 用户可写根从未进入执行路径。（a）修 IM-10 会**打开**这条路径，
因此 **IM-1 必须与 IM-10 同批落地**，且在扫描相关文档里写清契约：「扫描根下的任何 bundle 都会在
probe 时被执行」，理想情况给**家目录根一个显式 opt-in**；（b）子进程继承合并后的用户环境，
敌意 `codebuddy` 因此可读用户机密。
**IM-1 仍维持 IM 而非 CR**：跨不过权限边界（能种文件者已在以该用户执行代码），也无远程向量；
只有当 probe 以提权身份运行、或 bundle 路径变得远程可控时才会升级为 CR。修 IM-1 时，
`~/Applications` 目前被丢弃这点也一并记录 —— 别让"修好了上限 bug"顺手把执行面放大而无人知晓。

### G-2 client / tests-meta 组（1 成立 / 6 降级，已完成）—— 严重度标定被系统性纠偏

> 这一组是"审查高估"的集中体现：7 条 IM 主张里 **6 条被降级**。复核者的反证都落到了具体行号，
> 因此这里按复核后的真实严重度重编号（MI-10…MI-15），修复仍照做 —— 降级不等于不修。

| ID | 判定 | 位置 | 裁定要点（含反证） |
|---|---|---|---|
| IM-14 | **CONFIRMED** | `tsconfig.json:36` + `package.json:38` | `include:["src"]`、`exclude:["tests"]`、无第二份 tsconfig、无 CI、vitest 配置里也没有 `typecheck` 块 → **52 个测试文件（外加 `scripts/acceptance.ts`）完全不在类型门禁内**；`tests/integration/client-bundle.test.ts` 里存在 4 个真 TS2339（273/289×2/290：`module.SETTINGS_SLOT`、`settings?.key`、`module.SETTINGS_NAMESPACE`），因为该文件本地的 `ClientModule`/`Registration` 接口从未补上 `src/client/index.ts:64,72` 已导出的字段 |
| MI-10 | DOWNGRADED | `client/store.ts:274-275,426-427` | 打开 transcript 期间列表轮询被暂停（`paused: selectedId !== undefined`），而 `loadTranscript` **丢掉** `read.terminal`、`startTranscriptTimer` 只复查内存行 → 会话在观看期间结束会**永远保持 1.2s 轮询**。但"列表再也不更新"被推翻：`closeSession`/`refresh()`/可见性回调都会重跑 `schedule()`。真实代价是**浪费请求**，不是死列表 |
| MI-11 | DOWNGRADED | `client/indicator.ts:53` | 点击取排序后**第一个 failed** 而非第一个**未见过的** failure → 当已见失败排在未见失败之前时，徽标不下降且打开错的行。"永远清不掉"被推翻：面板每一行都有 `openOutput`（`panel.ts:166-171`）会把该会话标记为已见 |
| MI-12 | DOWNGRADED | `client/api.ts:282-306` | 20s 看门狗在 299 行清掉、303 行才读 body → 只覆盖"等到响应头"；body 卡住会让面板永久 loading 且无错误。但**仓库内无触发路径**（唯一写者 `host/api.ts:205-212` 同步 writeHead+end），属潜在缺口而非已证挂起 |
| MI-13 | DOWNGRADED | `kernel/store.ts:174-178` | V8 只在**首个 token** 解析失败时才回显文件字节；`StoredSession` 只存 id/状态/时间戳/cwd/model（transcript 只在内存，`store.ts:1-8`）→ 泄漏被限制在 store 自身约 25 字节头部，且不含任何提示词内容 |
| MI-14 | DOWNGRADED | `docs/plan.md:790` | 跳测机制实为**三种**（`acp-e2e.test.ts:70` 的 `describe.runIf`；`desktop.test.ts:138` 与 `scan.test.ts:823` 的 `describe.skipIf` 宿主探测，各 2 例），指标表只写了第一种。"静默消失"被推翻：vitest 会把 skipIf 记为 skipped，干净机器上是 +4 skipped，不是 4 个幽灵通过 |
| MI-15 | DOWNGRADED | `tests/kernel/manager-resume.test.ts:84-86` | `if (status === 'running')` 能静默跳过唯一断言，但**不是**"快宿主"导致（`void manager.cancel()` 的终态要等 await，83 行读取发生在 cancel 的同步前缀内）。真正的洞是**未断言的前置条件**：spawn/fixture 失败会让该测试零断言地变绿 |

**监理独立核对（IM-14）**：`tsc --noEmit --skipLibCheck tests/integration/client-bundle.test.ts` 报 8 条，
其中 **4 条 TS2339 为真**（273/289×2/290）；另 4 条（TS1259 `esModuleInterop`、TS1343 `import.meta`、
TS2322、TS2349）是**脱离工程 tsconfig 独立编译的假象**，不计入缺陷。修 IM-14 时必须用
`tsconfig.tests.json`（继承基准 + `noEmit`）来判定，否则门禁会带进假阳性。

### G-3 driver 组（1 成立 / 6 降级，已完成）

| ID | 判定 | 位置 | 裁定要点 |
|---|---|---|---|
| IM-15 | **CONFIRMED** | `acp.ts:1088-1092,1345-1349,1399,1637` | `dispose()` 是**唯一**会杀掉所有已登记终端的代码，而它在 `src` 里**零调用者**；terminal/release 只处理引擎自己释放的，settle/cancel 只杀引擎主进程组，而每个终端子进程是用 `rt.spawn` 起在**自己独立的 detached 组**里（`kernel/spawn.ts:173`）→ 引擎「建了就忘」即留下孤儿进程 |
| MI-16 | DOWNGRADED | `claude.ts:75-85,202` + `codebuddy.ts:78` | `--strict-mcp-config` 确实不在 `CODEBUDDY_BLOCKED_ARGS`（`filterCustomArgs` 逐字放过），但**不可达**：`opts.extraArgs` 没有任何已发布调用者填充（`definitions.ts:562-570,729-737` 逐字段构造，只给 agent/prompt/cwd/model/effort/timeoutMs/mode），host API 也没有 run 路由 → 潜在 ABI 洞而非可达缺陷 |
| MI-17 | DOWNGRADED | `argv.ts:264-271` + `claude.ts:76` | `["-p","/some/path"]` 确实只吃掉 `-p`、把路径留成位置参数 —— 但这是 multica 权威规格的忠实移植（`claude.go:714` `"-p": blockedStandalone` + 同款 Go filter），且同样不可达。真实代价：调用方写 `-p` 会变成"错提示词"脚枪 |
| MI-18 | DOWNGRADED | `generic-argv.ts:287-302` | 监听器确实存活（移除语句在 `:297-300` 提前 return 之后），但"保留上下文"不是增量问题：`DriverSession` 本就持有同一 run 作用域闭包，且管理器从不修剪已终态记录 → **跨切面真问题就是 IM-7**（`live` 永不驱逐）；终态后的 abort 是 no-op |
| MI-19 | DOWNGRADED | `acp.ts:1376-1378,1405-1416,167` | 引擎给的 `outputByteLimit` 被逐字采纳、`append()` 每块重拼整个缓冲（无界保留 + 二次拷贝）。但同一引擎在该能力开关下本就能以用户身份执行任意命令（`acp.ts:193-222`）→ 越不过信任边界，属内存/健壮性而非提权 |
| MI-20 | DOWNGRADED | `codex.ts:194-195,440-441` | 引擎给的 resume id 未经校验就进位置参数，但**不是 argv 注入**：它只是无 shell 的 detached spawn 的**单个数组元素**，加不出 token；以 `-` 开头只会让 clap 报错退出 |
| MI-21 | DOWNGRADED | `codex.ts:700-716,744-753,762-770` | `requestTerminal` 会闩死 timeout/空文本且不检查 `sawTurnCompleted`，而结算只在 exit+flush 后 → 已完成的 codex 回合可能被计时器丢弃。真实但窗口只是终态帧之后的收尾间隙，且**没有实测到滞留的 codex**（不像 zcode/openclaw 有显式的边界即杀，D38/pitfalls #10） |

### G-4 surface 组（4 成立 / 1 降级，已完成）—— 本轮最重的四条

| ID | 判定 | 位置 | 裁定要点 |
|---|---|---|---|
| IM-16 | **CONFIRMED** | `settings.ts:247,258,265,459-482` | 清空字段被 coerce 成 `undefined`，`clean` 仍保留该键，`scope.update({k:undefined})` 到达真 provider 后其 `cloneJsonShaped` 静默丢弃 undefined 项（`dsh-settings/lib/index.js:218`）→ `mergeLayers(current,{})` 把旧 section 原样写回，而 `write()` **返回 `{ok:true}`**。**从已发布 UI 可达**：`client/settings.ts:308-310` 对每个 dirty 字段发 `drafts[k] ?? ''`，清空即 dirty。结果：用户清空字段 → 卡片显示「已保存」并自动收起 → 旧值与 `overridden` 徽标原样回来。只有每字段的 reset 按钮（走 `scope.replace`）能真正删除 |
| IM-17 | **CONFIRMED** | `definitions.ts:1233,1250` | `messages` 被截到 `MAX_RENDERED_MESSAGES=80`，但 `nextIndex` 逐字透传 `read.nextIndex`（= `end`，即**请求的全部**事件，`manager.ts:513-519`）；且只在模型显式给 limit 时才转发。于是首读 300 事件的一轮会得到 `nextIndex=300` 与「用 sinceIndex=nextIndex 只读新事件」的提示 → **照做就静默跳过 80..299** |
| IM-18 | **CONFIRMED** | `host/api.ts:191-197` | Origin 只比 `hostname`，**丢弃端口** → `Origin: http://localhost:9999` 对 `Host: localhost:43120` 通过；判定 3 也救不了（同机不同端口是 `same-site` 而非 `cross-site`）。**无需 CORS 即可利用**：任意 loopback 端口的页面可用 `fetch(...,{mode:'no-cors'})` 发简单请求，body 被 `readJsonBody` 逐字解析，且**不需要 token**。头部注释宣称的「跨源页面无法驱动本插件」对这种情况是假的 |
| IM-19 | **CONFIRMED** | `definitions.ts:376-397` | `textSeen` 在 397 行置真后**永不复位** → 之后任何 text 事件都会粘到 `blocks[last]`，无论那是 tool_use/tool_result/error：`#2 [tool_use] Bash → out#3 text` 连成一行，text 丢掉自己的序号与类型，工具输出与正文黏连。`tests/tools/` 下无任何覆盖 |
| MI-22 | DOWNGRADED | `host/api.ts:496-509` + `registry.ts:617-643` | 确实无单飞、无限流：每次 `refresh:true` 都重置 scan 记忆、同步重走 bundle（2s 预算）、扫端口、为每个身份起一个 `--version`（各 3s）。但"无界/阻塞宿主"被高估：同一栅栏本就允许 `run`（起真进程），面板只在显式点击时带 `refresh:true`，每轮有界 → 低危防御性加固，非在线 DoS |

## I. B2 落地记录（kernel）

树未提交（按要求保持 dirty）。九条全部**先红后绿**；红是"撤掉修复"的负控实测，
命令皆为 `/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run <file> -t "<name>"`。

| ID | 修复 | 红（负控 → 观测失败） |
|---|---|---|
| IM-4 | `StoredSession.pid`；run 时随 `running` 行落盘（`manager.ts` startRun）；重启恢复对 `status:'running'` 且有 pid 的行按**进程启动时间**比对 `startedAt`（`ORPHAN_SPAWN_SLACK_MS`）后 `kill(-pid,SIGKILL)`（`spawn.ts` 的 `signalProcessGroup` 复用 ESRCH/EPERM 处理）；pid 复用/取不到启动时间/无 pid 一律不杀 | `git stash push -- src/kernel/manager.ts` → `expected [] to deeply equal [ 4242 ]`（未杀）；`persists the live pid` → `expected false to be true` |
| IM-5 | ABI v6 增 `AgentSessionHandle.backendSessionId?` + `pid?`；`DriverSession` 增 `pinBackendSessionId`/`attachProcess`；六个驱动在**观察点**pin；manager 轮询发现即 `store.upsert`；终态以 result 为准、取消/超时回落到已观测值（claude 拒绝续跑时 `settleBackendSessionId('')` 清除，不落死指针） | 同上 stash → `expected undefined to be 'fake-slow-session'` |
| IM-6 | `store.persist()` 改为**合并写**：重读磁盘有效行 → 应用本实例 pending（upsert/删除）→ tmp+rename；`reload()` 也把 pending 折回。§B/§H 的 `A,B,C` 场景现在三次写后磁盘含 A、B、C | `git stash push -- src/kernel/store.ts` → `expected [ 'sess_A', 'sess_C' ] to deeply equal [ 'sess_A', 'sess_B', 'sess_C' ]`（与 §B 复现逐字一致） |
| IM-7 | 终态会话移出 `live` → 20 条 finished-LRU（留 transcript）→ 溢出压成 compact 行（`restored` 上界 500）；`AgentSession.buffer` 为 500 上限 drop-oldest 环，头部一条合成 `status` 说明丢了多少；settle 释放 `rec.handle` | 逐条负控：① 环上限临时置 `MAX_SAFE_INTEGER` → `expected 600 to be less than or equal to 500`；② stash manager.ts → `expected [ {type:'text'…}, …(2) ] to deeply equal []`（旧 `live` 仍返回 transcript） |
| MI-2 | `requestedCwd = runOptions.cwd ?? defaultCwd ?? process.cwd()`，**无条件** `checkCwd`，解析结果总进 `effective`（检查路径 = spawn 路径） | stash manager.ts → `expected { …(6) } to be an instance of AgentRunRejectedError`（不传 cwd 时旧代码直接放行） |
| MI-3 | realpath 失败保留 `path.resolve` 词法兜底；丢弃的根收集后经 logger `error` 一行；`allowedCwdConfigured` 区分"未配置=不受限"与"配了但一个都解析不出=**fail-closed**"。`deniedCwd` 同型 | `git stash push -- src/kernel/policy.ts` → `expected function to throw an error, but it didn't`（旧 `checkCwd('/',p)` 返回 `'/'`） |
| MI-6 | `spawnDetached` 同时听 `exit`；settle 取「`close`」与「`exit` + `POST_EXIT_DRAIN_MS`(300ms)」先到者，settle 时 flush 行缓冲并**移除 abort 监听器** | 单行负控 `POST_EXIT_DRAIN_MS = 60_000` → `expected 2013 to be less than 1500`（后代占着 stdio，旧行为等它 2s） |
| MI-7 | `cancelInternal` 强制终态分支 `resolveForced()` + 清 `rec.poll`；`startRun` 用 `Promise.race([handle.done, rec.forced])`，使 wedged driver 的 run task 也能走完 `finally` | stash manager.ts → `expected 29 to be 25`（终态后 poll 仍在读 handle） |
| MI-8 | `effectiveDescriptors()` 不再因 `refresh` 清 scan 记忆：安装态不随 TTL 变化，refresh 只重跑廉价的 `--version` | `git stash push -- src/kernel/registry.ts` → `expected 10 to be 5`（refresh 又走了一遍目录树） |

**改动的既有断言（必须改，否则修了也红）**

- `tests/kernel/store-robustness.test.ts:71-73` 原先把 IM-6 的丢行**写成了预期**（`toEqual(['sess_b'])`）。现改为
  `['sess_a','sess_b']` 并在注释里写明这是 merge-on-write 的回归点 —— 该断言本身就是缺陷的一部分。
- `tests/tracks/scan.test.ts` 的 `re-scans when the caller asks for a refresh` 断言的是 **MI-8 的缺陷行为**，
  改名为 `does NOT re-walk the bundle scan when the caller asks for a refresh` 并翻转断言。

**IM-7 / MI-6 / MI-7 的相互影响（同一份生命周期，已一起落地）**

三者是同一条生命周期链上的三个缺口：`exited` 拖延（MI-6）→ 驱动 `done` 可能永不结算 → 强制终态（MI-7）
若不清 poll / 不结束 run task，记录就永远留在 `live` → IM-7 的"终态驱逐"永远等不到。因此 `startRun` 的 `finally`
统一做：清 `poll` → 停 watchdog → 写 store（**先于**释放 handle，因为续跑指针要从 handle 取）→ `rec.handle = undefined`
→ `resolveSettled` → `retireSession()` 移出 `live`。`spawnDetached` 侧则在 settle 时移除 abort 监听器，
不再把 spawn 闭包挂在 `AbortController` 上。

**遗留（不粉饰）**：MI-8 只做到"refresh 不再重走"；**首次冷扫描仍是同步 `fs.readdirSync`**（原设计，
受 `budgetMs` 约束），把它真正移出事件循环需要把 `scanDesktopBundles` 改异步或上 worker，属 B4 范围，
未在本批夹带。

## J. B3 落地记录（drivers：流式 + 生命周期卫生）

范围 = 监理指派的**五条**：**IM-8 · IM-9 · MI-4 · MI-5 · MI-18**。
（§E-2 已把 B3 原列的 IM-15 · MI-16 · MI-17 · MI-19 · MI-20 · MI-21 并入 B3b+B6，本批**未动**。）
树未提交（按要求保持 dirty）。本批新增 22 个测试：B2 的 808/1 → 本批 **830 passed / 1 skipped**。

五条全部**先红后绿**；红是"撤掉修复"的负控实测（与该条的绿在同一会话内跑出）。
命令皆为 `/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run <file> -t "<name>"`。

| ID | 修复（文件:行） | 红（负控 → 观测失败文本） |
|---|---|---|
| IM-8 | `argv.ts:670-706` 新增 `STREAM_JSON_IDLE_TIMEOUT_MS = 1_800_000`，claude/codebuddy 默认窗口 300s→30min；`manager.ts:80-110` 同表同步抬高（法条要求两层同数）；`definitions.ts:546,595,654,772-774` 把 `idleTimeoutMs` 加进 `agents_run` / `agents_run_many` 并透传（`capRunWindow`） | ① 驱动层 `git stash push -- src/drivers/argv.ts src/kernel/manager.ts` → `expected 'timeout' to be 'running'`（claude.test.ts:666，6 分钟静默处）；② 管理层同一 stash → `expected 'timeout' to be 'running'`（manager-watchdog.test.ts:151）；③ `git stash push -- src/tools/definitions.ts` → 2 failed，`expected { agent: 'fake-slow', …(1) } to match object { idleTimeoutMs: 7000 }` |
| IM-9 | `argv.ts:541-561,576-668` 给 `readLines` 加 `preserveBlankLines`；`generic-argv.ts:253-274` 传 `true`（不再用"按行重组 + 删空行"） | 负控改回 `preserveBlankLines: false` → `expected 'line1\nline2\nline3\ngap\nend' to be 'line1\n\nline2\n\n\nline3\ngap\n   \n…'`（与 §H 的 `line1\n\nline2\n\n\nline3` 复现逐字一致） |
| MI-4 | 新模块 `kernel/stream-limits.ts`（单行 16 MiB / 单流 256 MiB / `StreamOverflowError`）；`argv.ts:576-668` 的 `readLines` 与 `kernel/spawn.ts:122-182` 的 `LineSplitter` 同数执行；`spawn.ts:384-405` 溢出即 SIGKILL 进程组并以 error 结算；六个驱动（claude/codebuddy 同路径、generic、openclaw、zcode、codex、acp）都把 `onOverflow` 接到自己的终态机制（新终态 `'overflow'` → `status:'failed'`，绝不静默截断） | ① `git stash push -- src/drivers/argv.ts`（reader 回到无上限）→ 单行 `expected [] to have a length of 1 but got +0`；总量 `expected [ 'aaaa', 'bbbb', 'cccc', 'dddd' ] to deeply equal [ 'aaaa', 'bbbb' ]`；② 上限临时置 `MAX_SAFE_INTEGER` → 内核 `expected undefined to be an instance of Error`（spawnDetached 不再溢出结算），并触发 sanity 断言 `expected 268435456 to be greater than or equal to 9007199254740991`；③ 只把 generic 的 `onOverflow` 改成 no-op → `expected 'pending' to be 'result'`（2015ms：驱动器再也不会结算） |
| MI-5 | `openclaw.ts:354-398` `parseWholeBufferOpenclawResult` 改为**遍历每一个** `{` 开头行直到找到完整 result（原先遇到第一个就 `return`）；用"最后一个 result 标记（`payloads`/`durationMs`）"作为候选上界，纯事件流仍是一次子串扫描、零次 parse | 负控把该行改回 `return tryParseOpenclawResult(...)` → `expected 'timeout' to be 'completed'`（边界永不 arm，答案被空闲看门狗丢弃） |
| MI-18 | 把 `signal.removeEventListener('abort', onAbort)` 移进**唯一的** settle 出口 `finishOnce`：`generic-argv.ts:215-226`、`openclaw.ts:798-807`、`zcode.ts:388-397`；`onAbort` 改成提升声明（与 codex 同形），settle 路径里原先"早返回之后"的那行删除 | 负控同时注释掉三处释放 → 3 failed，`expected 1 to be +0`（取消后监听器仍在） |

**IM-8 的取舍（为什么选"抬默认值"而不是"未配对 tool_use 不计 idle"）**：ledger 给了两条路。
真正在生产里杀运行的是**管理层**看门狗（`manager.ts:626-647`），它只看到归一化事件、看不到
`tool_use`/`tool_result` 帧，所以"驱动侧识别未配对 tool_use"这一半**单独落地并不能阻止那次误杀**；
而两层表按本仓库法条必须同数。因此选"把默认窗口抬到单次工具调用可信上限之上"（Claude Code 自己的
单次工具上限是 600s，30min 是它的 3 倍），并把 `idleTimeoutMs` 暴露到 schema 让调用方按任务加宽 ——
这是最小且端到端自洽的改动。**残余**：调用方显式给一个很小的 `idleTimeoutMs` 时，长工具调用仍会被杀 ——
现在这是被文档化的知情选择，而不是默认行为。

**MI-18 只做了一半**：ledger 明示其"保留上下文"那一半就是 IM-7（`live` 永不驱逐），B2 已修；
本批只动监听器释放，未重复实现。

**一次自纠（记账，与 §B/§H 同一条纪律）**：MI-18 的第一版测试让假 `AbortSignal` **自己 fire**，
负控跑出来是**绿的** —— 因为无论是平台还是我的假件，`{once:true}` 监听器在事件触发后就会被摘掉，
"监听器计数为 0"于是与驱动器有没有释放**无关**。这正是"对照写错会给出假信号"。改成经
`handle.cancel()`（管理器真实杀路径，abort 事件从不触发）后，负控 3/3 真红。
记录：`tests/helpers/recording-signal.ts` 的注释里写明了为什么不可以用 abort-fire 驱动这个断言。

**门禁（最终树，真实数字）**

- `/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run` → **830 passed / 1 skipped**（53 files：52 passed / 1 skipped）
- `/opt/homebrew/bin/node node_modules/typescript/bin/tsc --noEmit` → **0 errors**
- `/opt/homebrew/bin/node scripts/build.mjs` → `lib/index.js 360.6kb`
- `/opt/homebrew/bin/node scripts/build-client.mjs` → `lib/client.js 73.8kb`
- `python3 /Users/king/.agents/skills/dsh-plugin-studio/scripts/verify_plugin.py .` → **11/11 PASS**
- （额外，非本批门禁）用 `/tmp/tsconfig.b3tests.json`（`extends` 仓库 tsconfig、`rootDir` 上提、只 include
  本批改动的 9 个测试文件 + helpers）复核：**0 errors** —— 提前确认本批的测试改动不会给 IM-14/B3b 添新债。

**已知残余（不粉饰）**

1. MI-4 的**总量上限（256 MiB/流）**是"失败得响亮"的取舍：一个真的吐出 >256 MiB stdout 的运行现在会
   报 `failed` 而不是继续吃宿主内存。这是 ledger「溢出即报错并终止进程组」的字面要求；阈值取在
   任何可信运行之上、宿主危险线之下，且两条 reader 同数。
2. `readLines` 的驱动侧上限在**生产路径上不可达**：`integrate.ts` 的 `kernelSpawn` 让内核 `LineSplitter`
   先在同一数值上触发。保留它是纵深防御（驱动可被别的 spawn 缝直接使用），不是重复检测。
3. 本批**没有**碰 §E 原列在 B3 的 IM-15/MI-16/MI-17/MI-19/MI-20/MI-21（§E-2 已把它们移出 B3）。
4. `openclaw` 的整块 result 扫描现在以"最后一个 result 标记"为界：一个把 `"durationMs"` 字样放进
   **日志行**的长流会多付几次 O(候选) 的 parse（仍远小于原先每行全 buffer 的代价），语义上不会误判。
