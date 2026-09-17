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
| IM-2 | Important | `src/drivers/claude.ts:746-767` | CodeBuddy/WorkBuddy 的审批帧缺 `allowed:true`（真机 bundle 只读 `allowed ?? false`）→ 每个权限请求被当拒绝 | in-batch (B1) |
| IM-3 | Important | `src/kernel/watchdog.ts:62-64,130-132` | `timeoutMs > 2^31` 被 Node 钳成 1ms → 刚 spawn 就被杀并报 timeout | in-batch (B1) |
| IM-4 | Important | `src/kernel/store.ts:26-38`（`manager.ts:178-192`） | 游离 agent 进程树在宿主重启后无人回收；pid 根本没落盘 | verified |
| IM-5 | Important | `src/kernel/manager.ts:247,359,465` | 续跑指针只在终态落盘 → 中途重启即丢，`agents_send` 永久无法续跑 | verified |
| IM-6 | Important | `src/kernel/store.ts:126-136,212-221` | 整表覆写：同目录两个 store 时，后写者吞掉先写者新增的行 | verified（**已亲手复现**，见 §B） |
| IM-7 | Important | `src/kernel/manager.ts:173,464,634`（`session.ts:80,129-144`） | 终态会话永不从 `live` 驱逐 + transcript 无上限 → 长期宿主 RSS 单调增长 | verified |
| IM-8 | Important | `src/drivers/argv.ts:544-552`（`claude.ts:1036-1050`） | 300s 空闲看门狗在 `tool_use`→`tool_result` 静默期误杀健康长工具调用 | verified |
| IM-9 | Important | `src/drivers/generic-argv.ts:17-21,237-239,305` | generic 驱动删掉所有空行，违反自己声明的逐字契约 | verified |

MI 级（复核后降级，仍修）：MI-1 Host 栅栏只看 `Host` 头（`host/api.ts:181-198`）· MI-2 不传 `cwd` 绕过 cwd 策略
（`manager.ts:403-410`）· MI-3 `allowedCwd` fail-open（`policy.ts:49-59,140`）· MI-4 `readLines` 无单行上限
（`argv.ts:509-517` · `kernel/spawn.ts:100-110` 同型）· MI-5 openclaw 混合形态永不 arm（`openclaw.ts:366-371`）·
MI-6 `exited` 只在 `close` 结算（`spawn.ts:213-223`）· MI-7 强制终态不清 `setInterval`（`manager.ts:332-357`）·
MI-8 `probe(refresh)` 同步重扫（`registry.ts:437-441`）。

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
| B1 | IM-2 · IM-3 | in-batch |
| B2 | IM-4 · IM-5 · IM-6 · IM-7 · MI-2 · MI-3 · MI-6 · MI-7 · MI-8 | pending |
| B3 | IM-8 · IM-9 · MI-4 · MI-5 + 待复核的 acp/codex 项 | pending |
| B4 | IM-1 + 待复核的 scan 项 | pending |
| B5 | MI-1 + settings/definitions/api/client 待复核项 | pending |
| B6 | 门禁自身：测试不在类型门禁内 · 真空断言 · verify 无 CI 入口 | pending |

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
