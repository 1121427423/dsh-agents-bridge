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
