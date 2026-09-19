# 代码审查报告 — `arena/01a0b97d-dsh-agents-bridge`（2026-09-19）

**审查范围**：本分支当前代码。分支自 `feature/dev` 的 `8a06874`（D46：Qoder CN CLI headless stream-json + 传输开关）分出，其上无新增提交、工作区干净，因此审查对象即该提交所代表的完整代码库（src 约 24.9k 行，测试约 23.9k 行，1100 个用例）。

**验证基线**（本机实测）：

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck`（src） | ✅ 0 错误 |
| `pnpm typecheck:tests` | ✅ 0 错误 |
| `pnpm test`（1100 用例） | ⚠️ 1092 过 / 7 跳过 / **1 失败**（平台相关，见 P1） |
| 单跑该失败用例 | 稳定复现（非 flaky） |

---

## 一、总体评价：质量很高

这是一份少见的高成熟度代码库，值得先说清楚优点：

1. **架构纪律是真实落地的，不是口号。** 三层（entry → kernel → drivers）靠注入而不是 import 解耦：`createBackend` 工厂由 `src/index.ts` 注入 manager，kernel 零 `drivers/**` import，drivers 只 `import type` kernel 的冻结 ABI（`kernel/types.ts`）。`src/integrate.ts` 作为唯一同时认识两侧形状的适配层存在，理由（两个平行工作流的接口对不齐）写在文件头里。
2. **注释解释「为什么」而不是「是什么」。** 几乎每个非平凡决策都带着它修掉的缺陷编号（IM-x / MI-x / RR-x）和复现证据。例如 `spawn.ts` 对 `POST_EXIT_DRAIN_MS` 分支为什么要 SIGKILL 进程组的推导、`policy.ts` 对「配置了但全部解析失败的 allow-list 必须 fail CLOSED」的处理，都是可以直接当事故复盘读的水平。
3. **防御性设计系统且成体系**：
   - 进程生命周期：detached 进程组 + 三段式取消（SIGTERM→grace→SIGKILL）、重启后孤儿树回收带 **PID 复用双重校验**（子进程 + owner 进程的 start-time 对比，`ownerIsGone`/`reapOrphan`）；
   - 内存边界：终态会话从 `live` 移入 20 条 LRU、转录 500 条环形缓冲带**绝对索引基**（裁剪不重编号，`dropped` 如实上报）、流输出单行 16MiB/总量 256MiB 上限（超限杀组而非截断——截断的线和完整帧对解析器不可区分）；
   - 定时器：`>2^31-1` 的 `setTimeout` 会被 Node 静默改写成 1ms，`normalizeRunWindowMs`/`clampTimerDelay` 在入口处把「无期限」钳到天花板而不是让它变成「立即超时」；
   - 会话存储：同目录临时文件 + rename 原子写、写前重读磁盘做 **merge**（两个 store 共存不丢行）、进程级临时文件序号防两实例撞名。
4. **安全边界认真做过**：`host/api.ts` 的浏览器信任栅栏四步判定（Host 可解析 → loopback 主张必须与 socket peer 双重验证防 DNS rebinding → 拒 `sec-fetch-site: cross-site` → Origin 与 Host 比对**含端口的 authority**），顺序即契约，403 在读 body 之前；内部错误上线缆是 opaque 的 `internal error`，栈与路径不出 host。cwd 策略在 `realpath` 上比较（`/tmp`→`/private/tmp` 别名攻击面已关）。
5. **D46 本身（分支基点提交）做法正确**：新方言是薄声明（`qoderclicn.ts` 137 行，复用 `runStreamJsonFamily`），三个旗标差异全部有实测依据；传输开关用「把未选中行标 `unsupported` + probe 可解释」而非删行，模型能学到边界；field-level override 合并防止调用方整对象覆盖把开关抹掉；穷尽性由编译器驱动——新 family 让 `tsc` 点名所有按 family 枚举的表，且顺手把两处手抄清单改成从 `DRIVER_FAMILIES` 派生。测试配套齐（6 条方言负控 + 5 条开关语义）。

---

## 二、发现的问题

### P1（建议尽快修）测试套件不是跨平台的 — 1 个用例在 Linux 上必挂

**位置**：`tests/drivers/acp-resident.test.ts:351-371`（`dispose() terminates every parked process`）

用例用 `const cwds = ['/tmp', '/private/tmp']` 制造「两个不同的 pool key」。`/private/tmp` 只存在于 macOS；在 Linux 上以不存在的目录作 cwd 派生，`spawn` 立刻 ENOENT，该 run 以 `failed` 结算，第 362 行 `expect(result.status).toBe('completed')` 挂掉。**本机（Linux）单跑该用例稳定失败，非负载敏感**。提交信息里「唯一失败是 pipeline rescan（负载敏感）」是作者 macOS 机器上的观察——换到 Linux/CI 全量套件就是红的。

仓库其余 host 相关用例已经用 `describe.skipIf` 处理平台依赖（`tests/tracks/desktop.test.ts`、`scan.test.ts`），这里漏了。

**建议修法**（任选其一）：
- 用 `fs.mkdtempSync(path.join(os.tmpdir(), 'acp-resident-'))` 建两个真实临时目录当两个 cwd（最干净，两个平台都测得到真行为）；
- 或 `describe.skipIf(process.platform !== 'darwin')` 并加注释说明 `/private/tmp` 依赖。

**附带观察**：`residentKey(agentId, cwd)`（`src/drivers/acp.ts:1766`）用**原始字符串**拼 key 而不做 realpath 归一。在 macOS 上 `/tmp` 与 `/private/tmp` 是同一真实目录却会停驻两个完全相同的引擎进程——无害但浪费一个常驻进程，也和仓库其他地方「比较前先 realpath」的纪律不一致。可考虑顺手归一（归一后该测试也自然要改成两个真实不同的目录）。

### P2（清理项）死代码

- **`src/kernel/registry.ts:761` 的 `notFoundReason()`** 是孤儿：全文件无任何调用点，真实实现是 `src/tracks/types.ts:71` 的同名导出（tracks 模块都从那里 import）。疑似数据外移到 track 目录时留下的副本。两处文案实现已略有差异（`prefix` 是否先做大写化），留着就是漂移源。**建议删除。**
- **`createRegistryWithLogger`（registry.ts:784）** 在 src/tests/scripts 中零调用。若是留给 embedder 的公共接口请保留；否则同删。

### P3（格式瑕疵）

- `src/drivers/claude.ts:1236`：`}    if (status !== 'completed' && stderrTail.value.trim() !== '') {` — 上一个 `if` 块的闭括号与下一个 `if` 挤在同一行，缺换行。疑似合并/编辑事故，不影响行为。

### P4（观察项，非阻塞）

1. **`qoderTransport` 开关没有进 settings 面板。** `SETTINGS_FIELDS` 只有 5 个字段（`src/settings.ts`），D46 的开关只能走 composition entry 或 env。如果是有意（开关属于部署决策）可以接受；若希望面板可切，需要补一个枚举字段并声明 `effect: 'reload'`（开关在 `apply()` 时读，改动后需重载）。
2. **两张 family→idle-timeout 表靠注释约定同步。** `kernel/manager.ts` 的 `DEFAULT_IDLE_TIMEOUT_MS` 和 `drivers/argv.ts`/`acp.ts` 的驱动侧表互为镜像，注释写明「must equal」，但没有测试断言一致性。family 枚举已经派生化了，这两张表是剩下的手抄漂移源。**建议加一条测试**：构造一个结构上能同时看到两侧的断言（例如在 entry 层/集成测试里比较 `createBackend` 各 family 的实际空闲阈值与 manager 表），或至少把「两表相等」变成 `tests/drivers/timer-clamp.test.ts` 附近的显式用例。
3. **`agents_wait` 的实现是 20ms 级轮询**（`WAIT_POLL_MS`）——对分钟级任务完全够用，轮询上界也被 `remaining` 钳住、不会多睡一个整周期；仅记录为已审。
4. `host/api.ts` 的 body 限额在 chunk 已收下之后才检查，最坏会多收一个 chunk（>1MiB + 1 chunk）——可接受，与 better-sidebar 同款。
5. 文档纪律好到罕见（`docs/review-fixes.md` 96 条主张的对抗复核台账、findings 系列、每条能力的实测日期）。唯一提醒：`docs/plan.md` D46 行与实现一致，但真机验收结果（PONG、backendSessionId）只存在于提交信息与 plan 里，**CI 环境无法复验真机路径**，这是该类项目的固有边界，不算缺陷。

---

## 三、逐层审查摘要

| 层 | 文件 | 结论 |
|---|---|---|
| kernel | `manager.ts`（1075 行） | 核心并发逻辑扎实：`run()` 全同步返回、取消与驱动结算的竞速（`forced` promise）、`finally` 顺序（先落盘再释放 handle）、dispose 与延迟结算的竞态都被 `retireSession` 的 disposed 分支覆盖。未见泄漏路径。 |
| kernel | `session.ts` / `watchdog.ts` / `spawn.ts` / `store.ts` / `policy.ts` | 均已逐行读。环形缓冲绝对索引、看门狗时钟注入、`ps -o lstart` 强制 C locale（`zh_CN` 本地化日期会骗过 `Date.parse`，RR-MI-12）、allow-list fail-closed——细节都是踩过坑的样子。 |
| kernel | `registry.ts` | 逻辑正确（probe 单飞、refresh 与 rescan 两动词分寿命、版本探测 stdout/stderr 分离）。**死代码 ×2（P2）**。 |
| drivers | `argv.ts` / `claude.ts`（stream-json 引擎）/ `codebuddy.ts` / `qoderclicn.ts` | 引擎是本仓库最贵的资产：先挂 stdout 读再写 stdin（防 banner 死锁）、只有 `result` 帧证明成功、`terminal_reason` 高于 `is_error`、control_request 自动批准按方言决定是否带 `allowed` 键、resume 拒绝识别后清空指针。D46 方言声明与实测证据吻合。**P3 格式瑕疵 ×1**。 |
| drivers | `acp.ts`（2850 行）/ `acp-resident.ts` / `codex.ts` / `openclaw.ts` / `generic-argv.ts` / `zcode.ts` | 抽查关键路径（空闲超时表、residentKey、定时器钳制、结算分支）：与 stream-json 家族同款模式、同样钳制。ACP 驱动体量最大，未逐行审读；其测试覆盖（含真子进程 fixture）是主要信心来源。 |
| tools | `definitions.ts`（1925 行）/ `register.ts` / `smoke.ts` | `agents_wait` 有界等待实现正确（先校验后等、超出不超过一次轮询）；错误文案带下一步（有 `tests/tools/error-copy.test.ts` 回归）；family enum 已派生。 |
| host | `api.ts` / `jobs.ts` | 信任栅栏四步判定正确且顺序有测试意义；路由体确为薄投影；500 上线缆文案不泄内部信息。 |
| client | 10 个文件约 3.8k 行 | 未逐行审读；抽查 `api.ts`：envelope 解析为纯函数、失败态全部本地化映射、无裸栈进 DOM。有独立测试 6 个文件覆盖。 |
| entry | `index.ts` / `settings.ts` / `integrate.ts` | D46 开关、ACP keepalive、scope 注入 webServer/jobs 的延迟挂载处理都正确；`MutableManagerOptions` 的 live/reload 语义在设置卡片中逐字段声明。 |

---

## 四、建议的行动顺序

1. 修 P1（`/private/tmp` → mkdtemp 或平台跳过）——这是当前唯一让全量套件在非 macOS 上变红的问题。
2. 删 P2 死代码、修 P3 换行——十分钟的事，消除一个文案漂移源。
3. （可选）P4-2 的两表一致性测试与 P4-1 的开关入面板，排入下一批。

*审查方式：全量读 kernel/tools/host/integrate/settings + stream-json 驱动族，抽查 ACP/codex/openclaw/generic/zcode 驱动与 client 半侧；本机实跑 typecheck ×2 与全量 vitest；对失败用例做隔离复现定位根因。*

---

# 第二轮审查（同日，修复后）

**第一轮修复落地情况**（均已验证）：

| 项 | 修复 | 验证 |
|---|---|---|
| P1 平台相关测试 | `tests/drivers/acp-resident.test.ts` 改用 `mkdtempSync` 双真实目录 + `try/finally` 清理 | 单跑通过、全量通过 |
| P2 死代码 | 删除 `registry.ts` 的 `notFoundReason`、`createRegistryWithLogger`（及随之失效的 `childLogger` import） | typecheck 干净 |
| P3 格式 | `claude.ts:1236` 恢复换行 | — |
| P4-2 两表漂移 | `manager.ts` 表导出为 `MANAGER_DEFAULT_IDLE_TIMEOUT_MS`，新增 `tests/kernel/manager-idle-consistency.test.ts`（9 例：键集 = `DRIVER_FAMILIES` + 逐 family 与 argv/codex/acp 三处驱动默认值比对） | 9/9 通过 |

修复后全量门禁：**`tsc` src+tests 0 错误；vitest 1102 过 / 7 跳过 / 0 失败**（含新增 9 例；此前负载敏感的 pipeline rescan 用例本轮全量跑也通过）。

## 第二轮覆盖范围（第一轮只抽查的部分）

- `src/drivers/acp.ts`（2850 行）：安全红线全部过了一遍 —— `confineToRoot`/`realpathOfDeepestAncestor`（对最深存在祖先做 realpath，能抓住「目标尚不存在的写 + 中间目录符号链接」组合；读路径允许 root 内符号链接、写路径 `O_NOFOLLOW`，不对称有明确论证）、`requireRegularFile`（FIFO 拒绝）、读写 1MiB 上限（读取循环里还有「读着读着变大」的二次检查）、`acpTerminalEnvironment` 凭据过滤、终端命令允许名单。结算路径逐段读：`stopReason:"refusal"` 当失败（401 在 `_meta` 里）、`exitedCleanly` 才把非零退出记到引擎头上（Qoder 143 误判的修复）、cancel/timeout 分支对 adopted 进程走 `evict` 绝不回池、`failBeforePrompt` 也 evict。
- `src/drivers/acp-resident.ts` 全量读（发现并修复一处，见下）。
- `src/drivers/codex.ts` / `openclaw.ts` / `generic-argv.ts` / `zcode.ts`：结算段、定时器段、读挂载顺序、abort 监听释放逐一对齐——与 stream-json 家族同一套纪律（钳制、溢出杀组、`finishOnce` 单点释放监听）。
- `src/tools/definitions.ts`：run / run_many / wait / probe 的 execute、`idleWindow` 下限设计（0 在工具层被拒，因为到 kernel 会变成「无空闲期限」，与调用者意图相反——有注释有测试）、`announceCompletion` 与 jobs 缝隙、surrogate-pair 感知的截断。
- `src/host/jobs.ts`、`src/tools/smoke.ts`、`src/client/store.ts|api.ts`（无 DOM 注入路径，grep 过 `innerHTML/eval/document.write`）、`src/tracks/host-files.ts` + `kernel/logger.ts` 的脱敏（在唯一的自由文本出口强制、深度有界）、`scripts/build.mjs`（externals 单一事实源）、`vitest.config.ts`（react stub 的来由）。

## 第二轮发现

### R2-1（已修复，低概率正确性问题）`acp-resident.ts` `release()` 死分支可能误删健康条目

**位置**：`src/drivers/acp-resident.ts` `release()` 的 `entry.dead` 分支（原 `entries.delete(entry.key)` 无条件删除）。

**分析**：条目在 `inUse` 时子进程死亡，`watchExit` 置 `dead` 但保留 map 槽；若此后 `dispose()`（它连 in-use 条目一起 evict）把该条目从 map 里拿掉并终止，而持有它的 run 稍后仍以 `completed` 结算、调 `release(entry)`，死分支会无条件 `entries.delete(key)` —— 若此时同 key 已停驻**替换**条目，健康进程会被抹出簿记：`dispose()` 与空闲驱逐从此都看不见它（进程泄漏）。触发需要 use-after-dispose 的交叠，在现有接线（每次 apply 新池）下只是理论窗口，但修复是一行且绝对安全：**仅当 map 槽仍持有本条目时才删除**（`entries.get(entry.key) === entry`）。已修，acp-resident 8 例全过。

### R2-2（接受的风险，记录在案）`confineToRoot` 的 TOCTOU 窗口

检查与打开之间，中间目录可被换成符号链接从而逃出 root。代码对此有清醒的文档：读路径明说「同一用户、同目录内的竞争者得不到额外能力」，写路径用 `O_NOFOLLOW` 关掉最危险的末组件方向；设计文档 §10.4 也声明这是防误指不是沙箱。**判定：不修**，威胁模型自洽。

### R2-3（观察）其余小点

1. `jobStatusOf` 把 `timeout` 归入 `failed` 而非 `killed`——注释有明确立场（「没成功就是 failed」），接受。
2. `generic-argv` 的 prompt 写入不看 `terminalReason`（刚取消也会把 prompt 写完再杀）——子进程随即被杀，无后果。
3. `runAcp` adopted 路径复用首个 run 挂好读器的同一个 `AcpClient` 对象，读器随对象存活——正确，且 `resume` 时只认绑定同一 backend session 的停驻进程，否则放回，细节到位。
4. 第一轮报告里「`residentKey` 不做 realpath 归一」的观察维持原判：管理器下发的 cwd 本就是 `checkCwd` 解析过的真实路径，裸字符串 key 在真实链路上不构成问题，仅测试/直连场景可见，不动。

## 第二轮结论

第一轮之外的深水区（ACP 驱动全量、其余驱动结算段、工具层、client/tracks/scripts）未发现新的阻塞性问题；唯一的正确性瑕疵（R2-1）已顺手修复并回归。**当前分支状态：两套 typecheck 干净、1102/1102 可过用例全绿、无未修复发现。** 尚余低优先事项仅 P4-1（`qoderTransport` 是否进设置面板，需产品决定）。

---

# 第二轮补记：P4-1 落地（同日，应用户要求「需要」）

P4-1（`qoderTransport` 进设置面板）已实现。**过程中发现并修复了一个接线缺口**，它本身就是本轮审查最有价值的产出：

## R2-4（发现于实现 P4-1 时，已修复）面板写入原本没有任何读取方——假开关

第一版只把字段加进 schema 和卡片：面板保存会走 `settings-write` → 用户层 → settings.yaml，**报 ok**；但 `apply()` 的开关决策 `decideQoderTransport(config.qoderTransport)` 只读插件 config——设置命名空间的用户层没有任何代码读它来决定 transport。用户在面板里翻到 ACP，得到「已保存」，而桥下次加载依然走 stream-json。这正是 `src/settings.ts` 模块注释里点名的失败模式（「a switch that does nothing would be worse than no switch」），也是第一轮审查里卡片踩过的「假保存」坑的镜像。

**修复**：决策点后移到 `installSettings` 之后，读端口的解析值（`settings.read()` 的 `qoderTransport` 字段），优先级变为 **settings 用户层 > 插件配置 > env > 默认**——与本命名空间其余字段的分层规则（用户层压过组合条目）完全一致。effect 保持 `reload`：决策只在插件加载时做一次，卡片文案诚实。日志的 `source` 字段只在用户层真的压过了 config 时才标 `settings`，否则维持 `decision.from` 的原语义。

## 落地清单

| 处 | 内容 |
|---|---|
| `src/settings.ts` | 新 `choice` 字段类型（`options` 闭集 + 拒绝时指名全集合）；schema 换 `z.union(['stream-json','acp'])`（实测：缺席键保持缺席，baseline 比较不受扰）；`coerceField` 对 choice 做 trim+lowercase（与 config/env 门同一归一）；`applyTo` 显式跳过本字段并写明原因（kernel 不读它） |
| `src/client/api.ts` | wire 类型加 `kind: 'choice'` + `options`；规范化只对 choice 收选项、过滤非字符串、无选项行保留不丢 |
| `src/client/settings.ts` | `choice` 渲染 `<select>`：恰好一个「跟随部署配置」空档（`value: ''` = 保存时清键）+ 精确选项表；只读部署照常禁用 |
| `src/client/i18n.ts` | `settingsFieldQoderTransport` + `settingsChoiceUnset`，中英双语 |
| `src/index.ts` | 决策块移到 `installSettings` 与 `createAgentManager` 之间；overrides 逐字段合并进 manager 持有的同一对象；`source` 诚实标注 |
| README / plan.md | §4.1 表新增一行 + 三扇门优先级说明；D46 切换说明更新；`docs/plan.md` 新增 **D47** 决策行 |

## 测试（+9，全量 1102 → **1111**）

- settings 套件 +3：闭集外值被拒且指名全集合（含大小写归一）、写后**不**落到 managerOptions（kernel 确实不读）、组合条目携带 + 清空后回落。
- plugin-config +2（端到端，经 `agents_probe` 观察）：**用户层压过 config**（config `stream-json` + 用户层 `acp` → 未选中行翻为 `qoderclicn-print`）；**空用户层回落 config**（base ← user 解析链不断）。
- client api +2：choice 选项串过滤（非字符串丢弃、非 choice 字段不带 options）、无选项 choice 行保留。
- client components +2：select 的选项恰为 `['', ...options]`、onChange 编辑对应字段、只读部署禁用。

**最终门禁：`tsc` src+tests 0 错误；全量 vitest 1111 passed / 7 skipped / 0 failed。** 全部发现（R2-1 修复、R2-4 修复、R2-2/R2-3 记录在案）闭环，无遗留审查项。
