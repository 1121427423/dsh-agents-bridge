# dsh-agents-bridge — 计划与决策追踪

> 每个阶段做完在这里勾选并记录证据（命令 + 实际输出）。上层设计见 `docs/design.md`。

## 决策记录

| # | 决策 | 理由 | 状态 |
|---|---|---|---|
| D1 | 传输用各家原生方言，不做 ACP（v2 再说） | WorkBuddy/AutoClaw 均不说 ACP；multica 源码即规格 | ✅ 已定 |
| D2 | MCP 只做向下工具注入，不做调度传输 | tool 语义缺会话生命周期；父上下文会被 transcript 灌爆 | ✅ 已定 |
| D3 | kernel 不 import drivers，工厂由入口注入 | kernel 可单测；driver 可插拔 | ✅ 已定 |
| D4 | 形态 `bundle`（纯 Node half，无 client） | 与同仓 `dsh-background-promotion` 一致；P4 加 UI 时直接加 client half | ✅ 已定 |
| D5 | `agents_run` 立即返回 sessionId，绝不等待 | 工具调用有超时，agent 任务是分钟级 | ✅ 已定 |
| D6 | 契约冻结在 `src/kernel/types.ts` | 三个并行工作流的安全边界 | ✅ 已定 |
| D7 | WorkBuddy 用 `interpreter` 指自带 node | 实测 `env: node: No such file or directory`（PATH 无 node） | ✅ 已验证 |
| D8 | MiMo 标 `unsupported`，不进 v1 | agent 循环封在 asar，无 CLI/ACP/daemon 入口 | ✅ 已验证 |
| D9 | `connect` 模式只留字段不实现 | openclaw gateway / sidecar 有需求但非首个验证目标 | ✅ 已定 |
| D10 | 依赖树直接复用兄弟项目 `dsh-background-promotion/node_modules` | pnpm 解析 `@deepseek-ai/dsh-type-meta` 失败（该包从未发布到 registry，兄弟项目用 npm 装的同版本树可用） | ✅ 已解决 |
| D11 | `openclaw` 驱动额外支持 `--thinking`（映射 `effort`） | 实测 OpenClaw 2026.6.8 的 `agent` 子命令有该 flag，multica 版本没有 | ✅ 已核实 |
| D12 | `autoclaw` 身份 argv 前缀为 `['--profile','autoclaw']`（**不含 `agent`**） | 裸跑报 config invalid（`~/.openclaw/openclaw.json` 是 stub）；`--profile autoclaw` 实测 `Config valid`。**2026-09-17 更正**：原记为 `['--profile','autoclaw','agent']`，那个值本身就会让最终 argv 变成 `… agent agent …`（driver 的 `buildOpenclawArgs()` 已经把 `agent` 放在第一个），实测被 CLI 拒为 "Too many arguments for this command."。`agent` 归 driver，profile 归描述符 | ✅ 已验证（真机跑通，见下方 P1 验收） |
| D13 | 驱动解析必须「白名单 + 静默忽略未知事件」 | codebuddy 实测发出 `system/status`、`file-history-snapshot` 等 claude 文档外事件 | ✅ 已验证 |
| D14 | `session_id` 从 `system/init` 尽早捕获 | 实测 init 事件即带 session_id（对应 multica 的 early resume-pointer pinning） | ✅ 已验证 |
| D15 | 冒烟命令用 `ctx.commands.register({name})`，名字 **不能含点号** | 实测本机 DSH 无 `ctx.command(...)`；命令名正则 `/^[a-z][a-z0-9_-]*$/u` 拒绝点号 → 命令名取 `agents-bridge-hello`。**dsh-plugin-studio 技能的 command-tool 配方对本版本 DSH 不适用** | ✅ 已修正 |
| D16 | `commands` 不放进 `inject`，改惰性 `ctx.get` | 放进 inject 会让无命令注册表的宿主把整个插件判为 INACTIVE（整条工具面一起丢） | ✅ 已定 |
| D17 | `exports['.']` 用字符串 `./lib/index.js` | DSH 插件合同校验器要求字符串形式；类型走顶层 `types` 字段，不影响 TS | ✅ 已修正 |
| D18 | `src/integrate.ts` 作为 kernel↔drivers 的唯一适配层 | 两侧并行定下的形状不一致（行回调 vs stream、cancel vs terminate、SpawnExit vs ProcessExit）；单独适配比改任一冻结接口更安全 | ✅ 已实现 |
| D19 | 模型目录从**服务端下发的缓存**读取，不搜 app 内置字符串 | 更正：`deepseek-v4.1-flash` 确实存在（0.03x、1M/默认300K、原生多模态），它在 `~/.workbuddy/cache/acc-product-config-v3.json` 里；我先前只搜 app.asar 内置串因而误判 | ✅ 已定位 |
| D20 | `agents_probe` 增补模型发现（P3） | 对应 multica `ModelDiscoveryFunc`；有了可取值的模型目录，`agents_run{model}` 才可校验，别名映射（按 `credits` 选性价比、按 `supportsImages` 判多模态）才有真实落点 | ✅ 已实现 |
| D24 | P3 扫描**只读真实文件、绝不读 `app.asar`**；身份由 `product.json` 决定而非 bundle 名 | 实测两个 WorkBuddy 的 launcher 字节相同，唯一区别是 `cli/product.json` 的 `dataFolderName`/`isOversea`；按目录名猜会在重命名或多语言包上直接错。asar 是 297MB 存档，读它要解包器且零新增事实 | ✅ 已验证 |
| D25 | P3 端口指纹**默认期望表为空**，且**永不影响 `available`** | 本机没有已验证的 gateway 端口，猜一个就是往探测输出塞假事实；且"没在监听"是桌面应用的常态（应用没开），不能因此把可启动的身份判为不可用——`available` 只回答"能不能真启动" | ✅ 已定 |
| D28 | **argv 所有权切分**：driver 独占「子命令」token（openclaw 的 `agent`、codex 的 `exec`），描述符的 `argsPrefix` 只放 driver 无法知道的全局 token（`--profile autoclaw`、wrappers） | 两个 openclaw 身份都曾在 `argsPrefix` 里重复 driver 的子命令，`spawn.ts` 直接拼接后得到 `… agent agent …`，被 CLI 拒为 "Too many arguments for this command."。既有测试全部只断言**单个字段**（`argsPrefix === ['agent']`），于是每个测试都通过、唯独真正交给操作系统的 argv 是错的。护栏：`tests/integration/argv-shape.test.ts` 对**每一个内置身份**断言最终 argv（通用不变量：无相邻重复 token；openclaw 引擎的 `agent` 恰好出现一次；`--profile` 必须早于 `agent`） | ✅ 已实现 |
| D29 | **`src/kernel/types.ts` 仅改注释**（冻结 ABI 的例外，纯文档） | `CommandSpec.argsPrefix` 的示例仍写作 `['agent']` —— 正是 D28 那个 bug 的示范值，留着会继续误导下一个读者。**只改注释，不改任何字段、类型或可选性**，故 ABI 不变、无需版本号变更 | ✅ 已改（本工作流唯一触碰 types.ts 之处） |
| D30 | **client bundle 必须包装成 `window.__ModuleLoader__.load({ id, factory })`**；`id`、slot 注册 `id`、`registrant` 一律从 `package.json#name` 派生（构建期 `define`，源码里不出现字面量） | 宿主**不是** import 产物再读 exports，而是启动时注册 factory；裸 esbuild CJS 产物全文 0 次 `ModuleLoader`，于是**装不上且静默无 UI**（不报错，因为没人去找它）。字面量则会在改包名时静默失配 | ✅ 已实现（`verify_plugin.py` 11/11 PASS） |
| D31 | **工具的 `output.schema` 必须声明内核实际返回的每一个字段**；护栏 `tests/tools/probe-schema.test.ts` 把**真实返回值**逐键走过**真实声明的 schema** | `ProbeResult.capabilities` 一直是 registry 返回的字段，而 `agents_probe` 的 `output.schema` 没声明它、同时开着 `additionalProperties: false` → 内核物化输出时对**每一个身份**抛 `value[0].capabilities is not a declared property`：模型在任何会话里的第一个调用就失败，从模型视角看「没有任何东西可驱动」。单测只把 `execute()` 的返回值拿去断言、**不经物化**，所以 704 个全绿用例照漏（与 D28 同一形状：被断言的不是真正交出去的那个对象）。护栏改走运行时那条路——同一份 schema、同一个返回值 | ✅ 已修（+3 用例） |
| D32 | **argv 规则 `[interpreter, executable, ...argsPrefix, …]` 全树只有一份实现**：`src/kernel/command-line.ts#buildCommandLine`；**版本探测与跑路径必须用同一个构造函数、喂同一份 `CommandSpec`**。`drivers/argv.ts` 再导出、`kernel/spawn.ts#buildArgv` 委托，二者都不再实现规则 | 探测曾自己拼 argv，只读 `ResolvedIdentity.interpreterPath`（**仅描述符钉了 interpreter 时才有值**，即桌面轨道），而 CLI 轨道的 shim 修复写的是 `command.interpreter` → `claude`/`codex`/`codebuddy-code` 被当**裸 shim** 探测，子进程以 `env: node: No such file or directory` 退出；桌面三个身份**同一行代码**却正常。规则放在 `kernel/` 是因为 `kernel/**` 不许 import `drivers/**`（D3），反向依赖早已存在 | ✅ 已实现（真机复验 + `tests/integration/argv-shape.test.ts` 新 describe，已验证会真红） |
| D33 | **版本号只能是版本号**：`defaultVersionProbe` 分开收 stdout / stderr，版本只从 **stdout** 解析；stderr / spawn 失败 / 超时成为 `diagnostic`，由 `probeOne` 落到 `notes` 的自解释行 `[probe] --version failed: …`。**不占用 `health.detail`**（那里已承载凭据说明） | 原实现把 stdout 与 stderr 一起喂给 `parseVersion`，其「无 semver → 取第一行非空文本」的回退**把子进程的错误信息当成了版本号**，同时该身份仍是 `available: true` / `launch: 'ok'` —— 操作员看到的正是这一行。契约不变：探测实现永不能让 `probe()` 失败，未知版本不是错误 | ✅ 已实现（`tests/kernel/registry-node-shim.test.ts` 已验证会真红） |
| D34 | **本插件有自己的 settings 命名空间 `dsh-agents-bridge`**（= 包名）；schema **不声明任何默认值**（默认值只由内核定义一次）；**每个字段必须标注生效时机**（`live` 每次调用读 / `reload` 构造时快照）；客户端卡片注册在 **keyed 槽位 `settings.plugin.item`** 上，键即命名空间 | 三个非显然的实测事实：① 一方的 `ConfigurablePluginsTab` **只按命名空间派发**该槽位（"a served namespace no card claims renders nothing"）——只注册命名空间**不会**出现任何 UI；② `ctx.settings.register()` 才返回可写的 scope（`installSection` 只给读的 getter），所以面板要用 `register` 并自己补回 unload 回落；③ `defaultCwd` 每次 run 都读（`manager.ts:401`）而策略字段在构造时快照（`manager.ts:160-168`）——不逐字段标注，就会得到一个"保存了但不生效"的开关 | ✅ 已实现（隔离 `DSH_HOME` 真机往返 + 734 passed / 1 skipped） |
| D35 | **「有没有被用户覆盖」是 provider 的回答，不是我们的推断**：`userLayer()` 返回**三态**（`known:false` = 这个 provider 不描述命名空间；`known:true, user:{}` = 它查了、且没有任何覆盖），只有 `known:false` 才走值比较回退，且回退基准是 **schema 解析结果**而不是 composition entry；**provider 的写必须 `await`**（它的 scope 方法是 `async`） | 三个都只能在真机上看见：① 真实 provider 对**没有存过 section** 的命名空间会**省略 `user` 键**（`...detachedUser === void 0 ? {} : {user}`），而我们把它和"无法描述"混成一态 → 卡片在**操作员从未改过**的 `settings.yaml` 上把三个列表字段标成"已被用户覆盖"；② 它把缺省的 `z.array()` 解析成 `[]`（而非 `undefined`），所以回退拿 `entry` 当基准时 `[] !== undefined` 必然误报；③ scope 的 `update`/`replace` 是 `async`（`dsh-settings/lib/index.js:410,424`），丢掉返回的 promise 会让**写入失败仍报 `ok: true`**，并留下一个 unhandled rejection —— Node 默认 `--unhandled-rejections=throw`，那会**打死整个宿主进程** | ✅ 已实现（4 条新用例先真红后真绿；真机复验 5 个字段全部 `overridden: false`） |
| D36 | **设置卡片必须自证身份**：卡片**在每一个渲染状态**（加载中 / 只读 / 失败 / 表单）都打印一行等宽标识 `插件标识： dsh-agents-bridge`，取自**共享常量**（`src/namespace.ts`）而不是宿主返回的数据 —— 所以它在任何状态下都带着身份。标识是**数据不是文案**，两种语言都不翻译 | 操作员在真机浏览器里看到了卡片，却必须**来问我「监督桥设置 这个是你的吗」**。设置页把每个插件的卡片并排列出，一个人类名字（「监督桥设置」/「Bridge settings」）**无法**回答「这是哪个插件」—— 只有命名空间能，而命名空间**就是包名**。同一处还有第二个证据：`src/client/settings.ts` 的模块注释把 key 写成 `agents-bridge`（漏 `dsh-`），**源码自己都在暗示一个错的标识**。这是"人因"缺陷而非功能缺陷：功能全对，只是使用者无法核对 | ✅ 已实现（2 条用例在桩渲染器可触及的首屏状态断言标识；把标识移出该状态后 2/2 真红） |
| D37 | **设置卡片长得和这一节里其他卡片一样**：一个 `<li>` 卡片 + 一个全宽 header `<button>`（`aria-expanded`、标题、插件标识、未保存 pill、chevron）**默认收起**，点开才渲染表单体（字段 + 放弃/保存）；**读失败时自动展开**（看不见的错误状态不算错误状态），**保存成功后自动收起**（与其他卡片一致）。**不引入宿主的 UI kit** | 操作员第二次反馈：「设置卡片展示修改跟其他的一致, 一个卡片,点击展开,在输入配置框」—— 我原来那张卡片是一个永久展开的表单，和同节其他卡片都不一样。核对宿主源码后确认：那张卡片的观感来自**它自己包内的私有 CSS module**（`PluginCard.module.css`），第三方半边**寻址不到**；共享的 `@deepseek-ai/dsh-client-ui-primitives` 只能借到 `IconChevronDownOutline14` 与 `Tag`，却要让**整个 client half** 多背一个硬模块依赖（缺了它，我的指示器与面板会一起消失）。所以 chevron 用自写 inline SVG、pill 用 `<span>`，chrome 用 inline 样式逼近，卡片保持除 `react` 之外自足 | ✅ 已实现（3 条用例：`<li>` 且默认 `aria-expanded:false` 且**体内一个字段标签都不渲染**；`SettingsFields` 逐字段标注生效时机 / 未知字段按原始 key 渲染。把默认值改成 `true` 后该用例真红） |
| D38 | **zcode 成为第 7 个方言**：它借用 claude 的**旗标词汇**（`-p/--prompt`、`--output-format stream-json`）但**不共享任何线格式** —— 事件是 ZCode Protocol 信封 `{eventId,seq,sessionId,turnId,type,payload}`，生命周期名带点（`turn.failed`…）；`turn.completed/turn.failed` 事件本身就是协议边界（实测引擎失败后可能**永不退出**），终态一到宽限即杀进程组；prompt 走 argv（它没有 stream-json 输入），`--model`/`--max-turns` 是「help 有、解析器拒」的旗标，既不传也拦；包内 CLI 裸启必挂，`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 是官方逃生门 —— descriptor 携带 + driver 从 executable 相对推导兜底 | 桌面端捆绑 CLI 的第三种形状（codebuddy 直接可跑、openclaw 要 profile、zcode 要 env 逃生门）。真机全栈验收已把它推到诚实上限：`scripts/acceptance.ts zcode` 在 1053ms 内落地干净的 `failed`（引擎自己的 CONFIGURATION_ERROR 消息）+ `sess_` 前缀的 `backendSessionId`，**没有挂住**；happy path 被记录 8（账号无模型授权）挡住，测试一律不伪造成功回合（fixtures 分 proven/derived 两档，provenance 文件注明） | ✅ 已实现（18 条新用例；两条负控真红：拆掉边界结算 → 挂起用例超时红；把无终态退出改成 completed → 静默失败用例红。argv-shape 穷尽护栏在注册 case 前自己先红 —— 新方言接线的证据） |
| D39 | **hermes 成为 ACP 家族的第二个引擎身份**：`hermes acp` 复用既有 `acp` family（D27），描述符 `id: hermes` / `protocolArgs: ['acp']` / `envPrefix: HERMES`，**描述符不声明 `searchPath`**（安装位 `~/.local/bin/hermes` 已在 `CLI_SEARCH_PATH`）。**能力必须从真机 `session/new` 探针逐字段钉死，不许抄 `codebuddy-code-acp` 那一行**：`resume: true`（`initialize` 声明 `sessionCapabilities.resume` + `loadSession`，且实测 `session/resume` 正常返回）、`model: false`（引擎**广播** 252 个模型却**忽略** `session/new` 的模型参数）、`effort: false`（`session/new` 根本不回 `configOptions`）、`clientTools: false`；`mcpConfig` **不声明**（拿真 server 验过才算） | 同一根线上第二个引擎 = 一条描述符而不是一个方言：这正是 D27 存在的理由。抄邻居那一行的代价在这一家是**可见的错**：codebuddy 有能力行里是 `model/effort/mcpConfig: true`，而 hermes 这三项分别被真机探针否掉（模型参数被忽略、没有 `configOptions`、没拿真 MCP server 验过）。**验收（真机，2026-09-17）**：`scripts/acceptance.ts hermes` 干净落地终态（18.7s，非挂起），但形态必须如实记为「`status=completed` 却**没有任何模型输出**」—— 引擎把自己上游的 404 当成普通 assistant 文本 + 正常 end-of-turn 发出。按协议判 completed 是**对的**，因此**不改驱动映射**、不加启发式；上游模型档位问题按 §0 记入 `docs/handoff-blockers.md` 记录 9，人工处置 | ✅ 已实现（`hermes` 描述符 + 11 条 `tests/drivers/hermes-acp.test.ts` + cli/registry/argv-shape 枚举更新 + 真机握手 fixture；**6 条负控全部真红**：`effort→true`、`model→true`、`resume→false`、`argsPrefix:['acp']`（argv 出现相邻重复 token）、身份移出 catalog（11 条红）、把手握手 fixture 写成 node shim（「不修复 node shim」断言红）） |

## 任务拆分（3 个并行工作流）

文件所有权严格互斥：**越界即冲突**。所有工作流都只依赖 `src/kernel/types.ts`。

### Workstream A — kernel（`src/kernel/**`，除 types.ts）

| 文件 | 职责 |
|---|---|
| `registry.ts` | 内置描述符表（claude / workbuddy / autoclaw / openclaw / generic）+ `probe()`（PATH 与绝对路径解析、版本探测、`envPrefix` 覆盖、`unsupported` 处理、带 TTL 的缓存） |
| `spawn.ts` | `spawnDetached()`：detached process group、逐行 stdout/stderr 读取、graceful→grace→进程组 kill、退出码归一化 |
| `session.ts` | `AgentSessionHandle` 实现：事件缓冲、`done` promise、状态机、`snapshot()` |
| `watchdog.ts` | idle/硬超时定时器（可注入 clock，便于测试） |
| `store.ts` | 会话映射原子读写（`~/.dsh/state/dsh-agents-bridge/sessions.json`），损坏时降级为空 |
| `manager.ts` | `AgentManager` 实现：run/status/list/output/cancel/send/dispose；`createBackend` 注入 |
| `logger.ts` | 从 `console` 适配 `BridgeLogger` |

**验收**：`tsc --noEmit` 通过；kernel 单测（内存 fake backend）覆盖 run→output 增量→cancel 三段式→terminal；不 import `src/drivers/**`。

### Workstream B — drivers（`src/drivers/**`）

| 文件 | 职责 |
|---|---|
| `index.ts` | `DRIVER_FAMILIES` + `createBackend(family, deps)`；未知 family 抛错 |
| `claude.ts` | stream-json 解析（`assistant`/`user`/`system`/`result`/`log`/`control_request`；content `text`/`thinking`/`tool_use`）、argv 构造、`--resume`、blocked flags |
| `codebuddy.ts` | 复用 claude 解析 + WorkBuddy/CodeBuddy argv 差异 + `interpreter` 支持 |
| `openclaw.ts` | NDJSON 事件 + 最终 JSON 解析、`--local/--json/--session-id/--timeout/--agent/--message`、blocked args |
| `generic-argv.ts` | stdin 投喂 prompt、stdout 归一化、`--resume` 可选 |
| `argv.ts` | 共享 argv 构造与 custom args 过滤（blocked flag 表） |

**验收**：每个 driver 有单测（用 `tests/fixtures/*.ndjson` 假事件流，跑一个假可执行脚本）；`tsc --noEmit` 通过；不 import `src/kernel/**`（只 `import type` types.ts）。

### Workstream C — surface（`src/index.ts`、`src/tools/**`、`README.md`）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 导出 `inject = ['tools','systemPrompt']` + `apply(ctx, config)`；构造 manager；注册工具与 systemPrompt section；`ctx.effect()` 内注册并在 disposer 里 `dispose()` |
| `src/tools/definitions.ts` | 9 个 `defineTool(...)`（含 `output.schema` + `render`；E 加了 `agents_wait` / `agents_run_many` / `agents_usage`） |
| `src/tools/register.ts` | `ctx.tools.register(...)` 装配 + disposer 收集 |
| `src/tools/smoke.ts` | 冒烟命令 `/agents-bridge.hello`（`ctx.command`） |
| `README.md` | 安装/开发/验证说明 |

**验收**：`pnpm run build` 产出 `lib/index.js`；`inject` 覆盖所有用到的服务；注册全在 `ctx.effect()` 内并返回 disposer；不直接 import drivers（通过 manager）。

## 决策 D21–D23（两条实现）

**D21 — 集成轨道（track）是与协议族正交的独立轴，两个实现分开。**

`ProtocolFamily` 回答"说什么方言"，不回答"怎么在本机拿到一个可启动的引擎"。
两者独立（openclaw 同时存在于两条轨道上：PATH 上的二进制 vs AutoClaw.app 内的
`openclaw.mjs`）。因此 `AgentDescriptor.track` 是**必填**字段，两侧各自一个模块、
互不 import：

| | CLI 轨道 | 桌面轨道 |
|---|---|---|
| 启动物 | 用户自己装的二进制，裸名 + 搜索路径 | 应用包内绝对路径 |
| 找不到时 | 提示 `<PREFIX>_PATH` | "应用不在这" — 是发现，不是可修配置 |
| 凭据 | CLI 自己的配置；桥只读状态，不持有 | 应用自己的登录，复用 |
| 解释器 | 通常不需要（shim 才修复） | 必需（node 不随 PATH 来） |
| 失败模式 | GUI PATH 导致"装了但看不见" | 包路径过期 / profile 选错 |

实现位置：`src/tracks/{types,index}.ts`、`src/tracks/cli/**`、`src/tracks/desktop/**`；
kernel 只保留共享机制（`<PREFIX>_PATH` 覆盖、解析、`<exe> --version` 探测），
并按 `descriptor.track` 调 `policyFor(track).launch()`，自身不判断 agent id。
`notFoundReason()` 两轨共用，保证探测输出只有一种措辞。

**D22 — `codex` 方言**：ABI 已加 `'codex'` 族与 `codex` CLI 身份
（`codex exec --json` 输出 JSONL：`thread.started` / `item.completed` /
`turn.started` / `turn.completed` / `error`）。driver 由子代理实现中。

**D23 — `codebuddy-code` 放最后**（用户指定顺序）。`@tencent-ai/codebuddy-code@2.151.0`
已装（`~/.nvm/.../bin/{codebuddy,codebuddy-code,cbc}`，`#!/usr/bin/env node` 脚本）。
已完成侦察（`--help`，未跑真实请求）：

- **方言倾向 claude 族**：参数面与 Claude Code 几乎逐条对应 —— `-p/--print`、
  `--output-format text|json|stream-json`、`--input-format stream-json`、
  `--model`、`--permission-mode {acceptEdits,bypassPermissions,default,plan,dontAsk,auto}`、
  `--session-id`、`-r/--resume`、`--mcp-config`、`--dangerously-skip-permissions`、
  `--include-partial-messages`。与 WorkBuddy 内的 codebuddy 同源，因此预期**复用
  `claude` driver + 一个 dialect 配置**，而不是新写方言——但必须先用一次真实
  headless 抓包确认帧结构（`--output-format stream-json`），再落描述符。
- **额外发现**：它支持 `--acp`（ACP over stdin/stdout，ndJsonStream），这为 P4 的
  ACP driver 提供了本机可验证的第一个真实对端，不必只依赖 multica 的移植笔记。
- 模型 id：`default-model / fast-model / balanced-model / primary-model / deep-model`，
  以及 `gpt-5.6-sol|terra|luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.3-codex`、
  `gemini-3.5-flash`、`glm-5.3|5.2`、`kimi-k3|k2.6`、`minimax-m3`。
  **更正（实测）**：这些 id 只能当文档，**不能**当作模型发现的结果——
  `~/.codebuddy/models.json` 只有 19 字节的 `{"models": []}`，是用户缓存而非目录，
  报 `models: []` 等于宣称"这引擎不接受任何模型"。所以 `codebuddy-code` 的行为是
  **not discovered + 原因**，凭据是 `unknown`（`~/.codebuddy` 下没有任何 key/token
  文件，也没有复用桌面登录，所以既不是 `missing` 也不是 `not-applicable`）。
- **实测结论（已落地）**：方言 = `codebuddy` 族（不是 `claude`）。真抓包五个顶层帧
  与 WorkBuddy 完全同序同名（含两个未文档化帧），`apiKeySource` 同为
  `copilot.tencent.com`，且 `terminal_reason` 在 2.151.0 里根本不存在 → claude 的
  结构化原因读取器无字段可读。**零 ABI 变更**。默认模型（不传 `--model`）是 `hy3`。

**D27 — ACP driver（ABI v4，`ProtocolFamily += 'acp'`）。**

> 编号说明：ACP 这一条原先被写成**与上面决策表里「P3 扫描」那一行相同的号**（重号），现按审查
> 意见改为 **D27**（`D26` 是 P2 加固）；决策表里 P3 的两行**保持原号不动**。
> ABI 版本号以 `src/kernel/types.ts` 的 CHANGELOG 为准：**v3 = P2 加固（D26）**、
> **v4 = ACP driver（本条）**；本节正文原先写作 v3，一并更正。

D1 把 ACP 推给 v2，理由原文是「WorkBuddy/AutoClaw 均不说 ACP」——那个理由对**这两个
身份**成立，对「一条 driver entry 解锁多家 CLI」不成立：multica 里 hermes / kimi /
kiro / qoder / trae / grok / qwenpaw / dim / zeroclaw / mcode / reasonix 共 12 家说
ACP（`docs/multica-reference.md` §4 原本把 `acp_*.go` 列为「v2 移植」）。今天每接一家
要写一个方言 driver，有了 ACP driver 接一家 = 加一条描述符。**并且本机就有了第一个
可验证的真实对端**：`codebuddy-code --acp`（`--help` 原文 "…using ndJsonStream"），
所以这次不必只依赖移植笔记，能抓真实字节。

- **帧格式是 `ndJsonStream`，不是 LSP 的 `Content-Length` 头。** 一行一个 JSON-RPC
  对象。实测抓包确认（见「阶段状态」里的证据行），multica `hermes.go` 的
  `newAgentStreamScanner` 也是逐行读。
- **同一个二进制、两个身份。** `codebuddy-code` 已在 CLI catalog 里有一条**非 ACP**
  身份（`family:'codebuddy'`，D23）。ACP 那条是**不同身份**：id 取
  `codebuddy-code-acp`，协议选择走新增的 `AgentDescriptor.protocolArgs`
  （`['--acp']`），**不硬编码在 driver 里** —— 「怎么选中这条协议」是身份数据，
  与「这条协议怎么说」是两件事，混在一起就等于把某个 CLI 的具体 flag 焊进 ACP 协议族。
- **ABI v4 只做加法**：`ProtocolFamily += 'acp'`；新增可选字段
  `AgentDescriptor.protocolArgs`、`AgentDescriptor.capabilities.clientTools`、
  `ProbeResult.authMethods`。唯一「破坏性」的是联合类型多了一个成员，而它对**声明式**
  消费方是增量的（每个既有描述符照样编译），两个 `switch` 是穷尽式写法、编译器会点名
  —— 这正是我们要的提示方式，不是静默 fallback 到 `generic`。
- **安全红线：客户端侧能力必须落在 `opts.cwd` 之内。** ACP 的对端会反过来调我们
  （`fs/read_text_file` / `fs/write_text_file` / `terminal/create|output|wait_for_exit|
  kill|release`），这等于让被驱动的 agent 读写本机文件、起进程。策略：路径先
  `path.resolve(cwd, p)`，再对**最深的已存在祖先**做 `realpath`（否则一个
  `/tmp/link -> /etc` 的软链就能把所有检查绕过去），越界即以 JSON-RPC 错误拒绝并带上
  越界的路径与允许的根；`terminal/create` 的 `cwd` 同规则、默认取 `opts.cwd`。
  且这些能力**默认关闭**，由 `DSH_AGENTS_BRIDGE_ACP_FS` / `_ACP_TERMINAL` 显式开启，
  `initialize` 里只广播真正开启的位 —— 不能一边广播能力一边拒绝。
- **`session/request_permission` 照 multica 的语义，不照 claude 族。** claude 那边是
  「保持 stdin 打开自动批准 `control_request`」，ACP 这边是「从对端**真正给过的**
  optionId 里选一个」：先已知的会话级批准 id（`allow_session`/`approve_for_session`），
  再 `kind:"allow_once"`，再退到对端给过的 `reject_once`（只否掉这一个动作），
  **绝不自动选 `allow_always`** —— ACP v1 里 allow_always 会「记住选择」，在 Hermes 上
  落到运行时属主的磁盘 allowlist，比任务活得久。一个都选不了就回 `-32603` 协议错误，
  既不伪造没给过的 id，也不回 `cancelled`（那会被别的 ACP 后端读成整轮取消）。
- **归一化不新增 `AgentMessageType`**：`agent_message_chunk`→`text`、
  `agent_thought_chunk`→`thinking`、`tool_call`→`tool_use`、
  `tool_call_update`(completed/failed)→`tool_result`、
  `config_option_update`/`available_commands_update`/`session_info_update`→`status`、
  真正不认识的→`log`。usage 走 `AgentUsage` 四桶互斥（`reasoningTokens` 是披露项、
  不是桶，见 types.ts 注释），移植 `acp_usage.go` 的**逐桶取最大值**合并
  （`usage_update` 通知与终态 prompt 结果两条计量路径）。
- **终态判定**：`end_turn`→completed；`cancelled`→cancelled；`refusal`/
  `max_tokens`/`max_turn_requests`→failed；取消信号→cancelled；`timeoutMs`→timeout；
  起不来 / 无终态帧的非零退出→failed。**「refusal 也算 failed」有实测依据**：本机
  codebuddy-code 未登录时正是以**退出码 0** 回 `stopReason:"refusal"`，真正的错误
  （401 Authentication required）只藏在 `result._meta["codebuddy.ai/errorMessage"]`
  里，照 stopReason 字面读会把它报成一次正常的「模型拒答」。
- **对端会发没有 `id` 的请求。** 实测 `_codebuddy.ai/command` 帧就是 `method` 有、
  `id` 没有 —— JSON-RPC 不允许，但真实存在。所以读侧规则是「有 `id` 才回，没 `id`
  当通知丢弃」，否则我们会回一帧 `id:null` 的响应去污染对端状态机。
- **ACP 引擎是常驻服务，收工必须由我们主动关 stdin。** 这是实现期才暴露的坑：
  `session/prompt` 应答之后引擎**不会自己退出**（它是个 server），所以任何形如
  「等 `child.exited` 再定终态」的写法都会**永久挂住**——第一次跑测试时 23 个用例
  全部超时 20s，就是这个原因。multica 的写法一致（`hermes.go:717` 注释「Close stdin
  first so Hermes can observe EOF and exit cleanly」，随后 `hermesReaderDrainGrace`
  兜底强杀）。落地为 `AcpClient.shutdown(graceMs)`：先 `flushWrites()`，再 `stdin.end()`，
  在 `ACP_SHUTDOWN_GRACE_MS`（2s）内等退出，超时就 `terminate()` 整组。
- **客户端侧能力是 multica 没做过的增量，必须标注。** multica 的 `hermesClient` 对
  `fs/*` 一律回 `-32601 method not found`（`hermes_test.go:966` 就是这个断言），也就是
  它**从不广播** `clientCapabilities.fs`。本 driver 按任务要求**真的实现**了
  `fs/read_text_file` / `fs/write_text_file` / `terminal/*`，因此这里是**有意的分歧**，
  不是移植偏差：能力默认关闭（env 开启），开启了才广播，广播了就一定服务。

**被否决的替代方案**：① 把 `--acp` 写死在 driver 里（等于 ACP 协议族只能驱动
codebuddy-code，12 家变 1 家）；② 自动批准一切权限（含 `allow_always`）（把一个越界
的持久授权留给用户去收拾）；③ 无条件广播 terminal 能力（广播了就没人问我们为什么不
工作）；④ 用 `log` 兜住所有映射不上的 update（`status` 更有信息量，`log` 会把它降级成
噪声）。

**D26 — P2 加固（ABI v3）：策略拒绝必须是机器可读的，白名单必须是显式的。**

`src/kernel/types.ts` 的 v3 段落地的是 P2 那一轮加固。加的字段全在 `ManagerOptions`
（都是可选）：`allowedCwd` / `deniedCwd` / `allowedAgents` / `maxConcurrent`，
加上运行时侧的 `graceMs`（取消时 SIGTERM → SIGKILL 的宽限期；它走插件 `Config` →
`installDriverRuntime()`，**不在 `ManagerOptions` 上**，与上面四个宿主策略旋钮同属
v3 那一批）。配套新增 `RunRejectionCode` 联合与 `AgentRunRejectedError` 类。

- **为什么要有类型化的拒绝**：原来的拒绝是一条裸 `Error`，它唯一的契约是**消息文本**。
  调用方（工具层、测试、未来的 embedder）想区分「agent 不存在」和「cwd 越界」，就只能
  去匹配随时会被改写的散文 —— 那是把错误文案当成 API。改成 `AgentRunRejectedError`
  之后，`code`（`unknown-agent` / `unsupported-agent` / `agent-not-allowed` /
  `cwd-denied` / `cwd-not-allowed` / `cwd-unresolvable` / `max-concurrent`）是稳定的，
  `value` / `allowed` / `maxConcurrent` / `running` 把「被拒的值」和「能接受的范围」
  一起带出来，工具层才能在**不改内核**的前提下把错误渲染成「下一步改什么」。
  `tests/kernel/manager-policy.test.ts` 与 `tests/plugin-config.test.ts` 断言的就是
  `code` 而不是文案；工作流 E 的工具层因此选择**就地增强 message、保留同一个错误对象**，
  而不是把它包成新的 `Error`（包了就等于把 v3 的机器可读性丢掉）。
- **为什么是白名单**：`cwd` 与 agent 白名单是 `design.md` §10.4 点名的加固项
  （「spawn 任意 CLI = 任意代码执行」的缓解）。两处比较都在 `realpath` 之后做，
  所以 macOS 上 `/tmp` → `/private/tmp` 这种软链别名不能绕过；`maxConcurrent`
  超限**同步拒绝、绝不排队**，因为排队会先烧掉调用方自己的超时预算再失败。
- **尺度**：这套东西是「防模型手滑把 `cwd` 指到 `/`」，**不是沙箱**（§10.4 原话）。
- **纯增量**：五个旋钮全部可选，`RunRejectionCode` / `AgentRunRejectedError` 是新增
  导出。按老样子构造 `ManagerOptions` 的调用方行为一字不变，既有测试零改动通过。

**被否决的替代方案（P2 加固）**：① 用 `error.message.includes('cwd')` 这类字符串匹配
在工具层区分拒绝类型（文案一改就静默失效）；② 把白名单做成「拒绝时抛裸 `Error` +
不同文案」（调用方没有稳定契约，测试只能锁散文）；③ 超并发时**排队**等一个槽位
（会先耗尽工具调用自己的超时预算，最后失败得更难解释）。

## 工作流 G — client half 补上 ModuleLoader 包装（D30，2026-09-17）

**症状。** `dsh-plugin-studio` 技能自带的合同校验器
（`/Users/example/.agents/skills/dsh-plugin-studio/scripts/verify_plugin.py`，stdlib-only，
本机就有）对合并后的树给出 `[FAIL] client 合同（dsh.client + exports + ModuleLoader id）
— lib/client.js 未以正确的 ModuleLoader id 注册（id 必须等于包名）`，**1/11 未通过**。

**这不是校验器的洁癖，是真的装不上。** 宿主侧的客户端加载契约（DSH 自带文档原文）：

> 浏览器插件包在其 `package.json` 中以 `platform: 'web'` 声明 `dsh.client`，导出
> `./client` bundle……**application combo 脚本在启动时注册插件 factory**；模块主体仍保持
> 惰性，只在首次 import 或物化时运行。

即宿主不会 `import('./client.js')` 然后读 exports —— 它靠
`window.__ModuleLoader__.load({ id, factory })` 在启动时注册。而我们的 `lib/client.js`
是**裸 esbuild CJS 产物**（`"use strict"; var __defProp = …`），**全文 `ModuleLoader`
出现 0 次**：宿主永远不注册它。Node half 与 9 个工具照常工作，**UI 静默消失**——连错误
都没有，因为没有任何一方在找这个 bundle。本机参照物是
`~/.dsh/profiles/desktop/node_modules/dsh-history/lib/client.js`（bundle 形态，`id` 等于
包名）与同目录的 `lib/client-registry.js`（同 bundle，`id` 为 `dsh-external/<name>`）：
**我们是 `dsh.bundle.patch` 的 bundle 形态，所以 `id` 必须等于包名。**

**修复（三处，缺一不可）。**

1. `scripts/build-client.mjs` 改为两段式：esbuild 以 `write: false` 出内存 CJS，再由脚本
   把 `window.__ModuleLoader__.load({ id, factory: (require) => { … }});` 的头尾拼上去。
   `id` 来自 `package.json#name`（**不是字面量**）。CJS 主体**原样插入、不重新缩进**——
   重新缩进会把 `styles.ts` 里模板字符串的内嵌换行改成带 tab 的 CSS，那是改运行时行为。
   `factory` 的参数 `module`/`exports`/`require` 正是 CJS 主体需要的三个名字，所以主体的
   `require("react")` 落到**宿主的** `require` 上（react 仍 external，见不变量 6）。
2. `src/client/identity.ts`：包名经构建期 `define`（`__PACKAGE_NAME__`）注入，
   `PANEL_ID` / `INDICATOR_ID` / `registrant` 全部由它派生。三个名字都是宿主侧契约
   （模块表 key、slot 去重 key、归属插件名），写死任何一个都会在改包名后**静默**失配。
   **故意不留运行时 fallback**：define 缺失就该在 import 时抛 `ReferenceError`，那是最响的
   失败方式。`vitest.config.ts` 用**同一个** `package.json#name` 设同一个 define，所以单测
   里的值永远等于出厂的値。
3. `scripts/build.mjs` 成为「宿主提供哪些模块」的**唯一**声明处（`CLIENT_EXTERNALS`），
   `build-client.mjs` import 它而不是各写一份——第二个 React 不是体积问题，是**正确性**
   问题（自带 hooks dispatcher：轻则 invalid hook call，重则静默状态错乱）。

**护栏（本工作流最重要的产出）。** 既有 client 测试都把 `src/client/**` 当模块 import
进来测纯函数，**永远测不到「宿主能不能装上」**。新增
`tests/integration/client-bundle.test.ts`（8 个用例）自己扮演宿主：造假的
`window.__ModuleLoader__` → 在 `node:vm` 的隔离 realm 里**求值构建产物**
（**不 import**，import 会绕过包装，正是被测对象）→ 断言 `load` 恰好一次、
`entry.id === require('package.json').name`（**不写死字符串**）、`factory` 是函数、
用假 `require` 调 `factory` 后 `apply`/`inject` 就位、`apply(fakeCtx)` 的
`registrant`/`id` 与包名一致。

- **它必须依赖产物**：产物缺失时 `clientBundleSource()` 直接抛错并打印该跑哪条命令，
  **绝不静默跳过**（跳过 = 又变回测不到）。`package.json` 的 `pretest` 保证 `pnpm test`
  先 build。
- **已证明它真的会红**（两次负向对照）：① 把 `lib/client.js` 移走 → **8/8 失败**，
  失败信息是「lib/client.js is missing — … Run `pnpm run build` first」；
  ② 临时把构建脚本改回裸产物（`writeFileSync(outfile, output.text)`）→ **8/8 失败**
  （这正是本工作流要消灭的那个回归）。两次都恢复并复跑 8/8 通过。

**新门禁。** `package.json` 加 `"verify": "node scripts/verify.mjs"`。`scripts/verify.mjs`
在运行时**解析**校验器位置（`$DSH_PLUGIN_STUDIO_VERIFIER` → `$DSH_PLUGIN_STUDIO` →
`~/.agents/skills/…` → `~/.codebuddy/skills/…`），**不把绝对路径写进 package.json**
（那是把某台机器的 home 目录焊进构建配置）；找不到时列出所有尝试过的路径并给出设置
环境变量的方法、退出码非零 —— **校验器缺席是「门禁没跑」，不是「门禁通过」**。

**证据（本机真跑）。**

```
$ python3 /Users/example/.agents/skills/dsh-plugin-studio/scripts/verify_plugin.py .
  [PASS] package.json 存在且为合法 JSON
  [PASS] package.json 名称合法（小写连字符）
  [PASS] package.json 基础字段（type/main/exports）
  [PASS] 禁止声明 @deepseek-ai/* 依赖
  [PASS] bundle 合同（dsh.bundle.patch + exports + patch 文件）
  [PASS] client 合同（dsh.client + exports + ModuleLoader id）
  [PASS] 构建产物存在（lib/index.js / lib/client.js）
  [PASS] React 保持 external（client 形态）
  [PASS] 必需文件齐备（README/LICENSE/tsconfig/src）
  [PASS] inject 覆盖 ctx.* 服务调用（启发式）
  [PASS] 名称一致性：package name / patch id / client id 一致

[verify] PASS: 全部 11 项通过
```

**工作流 G 落地时的门禁输出（历史值；当前主干见「交付指标」）**：`pnpm exec vitest run` →
**704 passed / 1 skipped（42 个文件）**（基线 696/1、41 文件；G 新增 8 个用例）；`pnpm exec tsc
--noEmit` → 0 错误；`pnpm run build` → `lib/index.js` 310.1 KB + `lib/client.js` 59.5 KB（含包装）。
（此后工作流 H 新增 6 个、D31 新增 3 个、工作流 `node-shim-note` 新增 6 个，主干现为 **719 passed / 1 skipped**。）

**关于校验器的第 9 项（React 保持 external）**：它 grep 的是 `scripts/build.mjs` 里有没有
`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` 四个串，而本仓库的 client
构建在 `scripts/build-client.mjs` —— 这一项**只有**在 client 合同先通过（`has_client`
置位）之后才会执行，所以修好第 6 项之前它一直是**空过**。修好第 6 项后它立刻变成真实
断言。为避免「为过校验而摆一串注释」，client 的 external 列表被上移到 `scripts/build.mjs`
并成为 `build-client.mjs` 真正 import 的唯一来源（见上面修复第 3 条）：第 9 项现在是**事实
断言**，不是字符串摆设。产物侧的证据同在工作流 G 的测试里
（`keeps react external — the factory asks the host for it`：factory 确实向宿主
`require('react')`，且产物不含 `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`）。

**被否决的替代方案**：① 把 `id` 写成字面量（改包名即静默失配，且校验器有专门一条查
「package name / patch id / client id 一致」）；② 用 `dsh-external/<name>` 那个 id（那是
`client-registry.js` 的分发形态，我们不是）；③ 把 `react` 打进 client bundle（第二个 React，
见不变量 6）；④ 测试里「产物不存在就 skip」（等于回到测不到）；⑤ 在测试里跑 build
（慢，且让「产物缺失会失败」这条证明消失——改用 `pretest` + 硬断言）；⑥ 改
`verify_plugin.py` 或放宽断言（校验器是外部技能，且第 6 项报的是**事实**）。

## 工作流 H — 宿主 API 取不到 `webServer`，监工面板永远不挂载（2026-09-17）

**症状（协调者在真实 web 宿主上实测）。** 独立于桌面应用的 web 宿主加载本插件时打印：

```
[dsh-agents-bridge:surface] host has no webServer: the agent supervisor panel is unavailable, the nine tools are unaffected
[dsh-agents-bridge:surface] dsh-agents-bridge loaded {"tools":9,"configuredIds":[]}
dsh web: http://127.0.0.1:43121/?token=…
```

9 个工具全在（正确），但**宿主 API 根本没接上**：client half 即使已经带上正确的
`window.__ModuleLoader__.load` 包装（工作流 G），也拿不到任何数据，监工面板是个空壳。

**根因（实测定位，不是推测）。** `src/index.ts` 用一次性的 `ctx.get('webServer')` 取服务。
任务书给的判断是「Cordis 不允许访问未声明在 `inject` 里的服务」，**实测不成立**——
cordis 的 `reflect.get` 文档原文就是 *"Read a service from the store without the inject
requirement"*，未声明的服务照样取得到。真正的根因是**时序**：

- 用一个最小 cordis 复现脚本（真实 `@deepseek-ai/cordis@4.0.1`）确认：服务**已经**在时
  `ctx.get` 立刻返回它；服务**稍后**才被 provide 时，`ctx.get` 返回 `undefined`，
  而 `ctx.inject(['webServer'], cb)` 的回调会在服务出现时被调用，且父 fiber 全程 ACTIVE。
- 宿主的 web server 只是 loader 树里的**另一行**（`@deepseek-ai/dsh-host-webserver`），
  在真机 web 宿主上**比本插件晚 ~800 ms** 才 provide（临时打点实测
  `TIMING scope fired after ms {"ms":785}`）。

所以旧写法在**有** web server 的宿主上读到 `undefined` 并打出「host has no webServer」——
**谎报**；面板在任何宿主上都挂不上。D16（不把可选服务放进顶层 `inject`）依然正确，
但它只解决了一半：**不声明还不够，还得有个「等它出现」的机制**。

**修复（`src/index.ts`）。**

1. 工具面 + prompt 段 + smoke command 照旧在**父 fiber 的同一个 effect** 里无条件注册 ——
   没有 web server 的宿主照样拿到完整 9 个工具（D16 的初衷）。
2. HTTP API 改由 **`ctx.inject(['webServer'], (scoped) => …)` 作用域注入**挂载：回调只在
   服务可用时执行，服务出现时自动重跑，服务消失时自动卸载，**父插件从不因它缺席而失活**。
3. `webRuntime` 保持**真正可选**（`scoped.get('webRuntime')`）：它只把信任围栏放宽到本部署
   实际服务的非 loopback authority，缺席时降级为「只信 loopback」，**不因此不挂载**。
   `dsh-web-app` 本身 inject `webServer` 之后才 provide `webRuntime`，所以它必然可能晚到。
4. 路由 disposer 通过 `unmountHostApi` 发布给父 effect：**cordis 卸载一个 fiber 的 effects 是
   并发的**（`_unload` 里是 `Promise.all`），作用域不能指望自己的 teardown 赢得这场竞速，
   所以父 effect 的 disposer 在 `manager.dispose()` **之前**同步把路由摘掉。
5. 日志如实反映两种情形：挂上时 `host api route mounted {"path":"/agents-bridge/api"}`；
   没挂上时说明**状态**而不是替宿主下结论（`no webServer available yet: … is not mounted
   (it mounts as soon as the host provides one) …`）——「这个宿主没有 web server」在 apply
   那一刻**不可知**（服务可能正在挂），所以那句话不能再说。
6. **同一类 bug 在信任围栏里也有一个**：`createApiRouteHandler` 原本在**建路由时**快照
   `webRuntime.trustedHosts`，而实测该服务在作用域挂载的那一刻**仍不存在**
   （`PROBE webRuntime at mount {"present":false}`）——`dsh-web-app` 要等 `webServer` 才有
   `webRuntime`。于是绑定到 LAN 地址、配了 `trustedHosts` 的部署会被自己的围栏 403，而且
   403 本身是合法响应、**看起来什么都不像坏了**。改为**每个请求读一次** `deps.webRuntime`
   （2 行），并用「后到的 webRuntime」用例把它锁住。

**护栏（扩展既有测试，不另起一套）。** 假 ctx 现在实现了
`ctx.inject(deps, cb)` 的**双半契约**（依赖齐了就同步跑；`provide()` 之后补跑）以及
`provide(name, value)`。新增 5 个用例：① 服务**晚到**时路由确实挂上、9 个工具不受影响；
② 没有 `webRuntime` 也照挂（可选服务降级）；③ 晚挂的路由在插件 effect 被 dispose 时**确实
被摘掉**（`disposedRoutes === 1`）；④ web server 始终不出现时工具照常注册、零路由；
⑤ 负向日志只说「尚未挂载」，不得再出现 `host has no webServer`。
`tests/plugin-config.test.ts` 的假 ctx 补了 `inject`（该宿主没有 web server，回调不跑）；
`tests/host/api.test.ts` 新增 1 个用例：路由**挂载之后**才出现的 `webRuntime` 必须被围栏
采纳（先 403，provide 之后 200）。

**证据（本机真跑）。**

```
# 修复前（协调者留在 43121 上的宿主，日志 logs/web-run2.log）
[dsh-agents-bridge:surface] host has no webServer: the agent supervisor panel is unavailable, the nine tools are unaffected
[dsh-agents-bridge:surface] dsh-agents-bridge loaded {"tools":9,"configuredIds":[]}

# 修复后（同一条命令，插件行换成工作树产物：--patch /tmp/wb-h-overlay.yml）
[dsh-agents-bridge:surface] no webServer available yet: the agent supervisor panel is not mounted (it mounts as soon as the host provides one), the nine tools are unaffected
[dsh-agents-bridge:surface] dsh-agents-bridge loaded {"tools":9,"configuredIds":[]}
[dsh-agents-bridge:surface] host api route mounted {"path":"/agents-bridge/api"}
dsh web: http://127.0.0.1:43121/?token=…
```

```
$ curl -s -X POST -d '{}' http://127.0.0.1:43121/agents-bridge/api/status
{"ok":true,"value":{"sessions":[],"concurrency":{"running":0,"limit":200},"now":1789614075890}}
$ curl -s -X POST -d '{"refresh":false}' …/api/probe   → {"ok":true,"value":{"available":true,…}}
$ curl -s -o /dev/null -w '%{http_code}' -X POST -H 'sec-fetch-site: cross-site' …/api/status → 403
```

**工作流 H 在自己的工作树里的门禁输出**（该树基线 704/1，**不含** D31）：`pnpm exec vitest run`
→ **710 passed / 1 skipped（42 个文件）**（H 新增 6 个：wiring 5 + api 1，零删除、零跳过）；
`pnpm exec tsc --noEmit` → 0 错误；`pnpm run build` → `lib/index.js` 310.4 KB + `lib/client.js`
59.2 KB；`verify_plugin.py` → **11/11 PASS**。
**合并到主干后同一组门禁的真跑输出**（H + D31 同在树上）：**713 passed / 1 skipped（42 个文件）**、
`tsc` 0 错误、`lib/index.js` 311.4 KB + `lib/client.js` 59.5 KB。

**被否决的替代方案**：① 把 `webServer` 放进顶层 `inject`（D16：没有该服务的宿主会把**整个
插件**判为 INACTIVE，9 个工具一起丢）；② 保留 `ctx.get` 只在有服务时挂（就是本 bug）；
③ 把 `webRuntime` 也写进 `inject`（`dsh-web-app` 晚于 `webServer` provide 它，等于把面板
赌在一个更晚的服务上）；④ 在 apply 时同步判断「没挂上」并打日志（服务 800 ms 后才到，
那句话在真机上就是谎报）；⑤ 依赖作用域 fiber 自己的 teardown 摘路由（cordis 并发卸载，
与 `manager.dispose()` 无先后保证）。

## 工作流 `node-shim-note` — claude / codex / codebuddy-code 行上的 `env: node: No such file or directory`（D32–D33，2026-09-17）

**症状。** GUI 启动的宿主里（子进程 PATH = `…/runtime-commands/generations/<hash>/bin:/usr/bin:/bin:/usr/sbin:/sbin`，
**没有任何 node**），`claude` / `codex` / `codebuddy-code` 三个身份行上各带一句
`env: node: No such file or directory`；桌面轨道三个身份（`workbuddy` / `workbuddy-ai` / `autoclaw`）没有。

**结论：那不是一句日志，是一个被塞进 `version` 字段的错误文本。** 两个缺陷叠加，缺一不可：

1. **探测自己拼 argv。** `registry.ts:509`（修复前）
   `[...(resolved.interpreterPath ? [resolved.interpreterPath] : []), resolved.executablePath ?? '', '--version']`
   —— `interpreterPath` **只在描述符自己钉了 `interpreter` 时才有值**（桌面轨道，`registry.ts:437`），
   而 CLI 轨道对 `#!/usr/bin/env node` shim 的修复写的是 `command.interpreter`
   （`tracks/cli/index.ts:177-193`）。于是探测把**裸 shim** 交给内核。跑路径没这个问题：
   `manager.ts:316` 传 `resolved.command`，`drivers/argv.ts#buildCommandLine` 读的正是
   `command.interpreter`。
2. **stdout 与 stderr 被拼在一起再解析。** 子进程 stdout 全空、stderr 是那句错误；
   `parseVersion` 找不到 semver 就回退到「第一行非空文本」→ **错误信息成为版本号**，
   而该身份仍是 `available: true` / `health.launch: 'ok'`。这是操作员**看到**它的直接原因。

**桌面身份为什么免疫**：它们的描述符**自己钉了** `interpreter: '/opt/homebrew/bin/node'`
（`tracks/desktop/catalog.ts:61,72,90`），`interpreterPath` 有值，同一行手工 argv 恰好是对的
—— **同一行代码、两条轨道命运不同**，正是「冻结规则被实现两次」的症状。

**全树 spawn 站点审计（任务书假设 H3）。** 重推导 `[interpreter, executable, …]` 的只有两处：
`registry.ts:509`（缺陷本体）与 `kernel/spawn.ts:79` 的 `buildArgv`（第二份实现，当时未出错但就是该 bug 类）。
其余全部合规：五个 driver（claude `:892` / codex `:632` / openclaw `:703` / acp `:1595` /
generic `:170`）都走 `buildCommandLine`；`integrate.ts:62` 传裸 `CommandSpec`（上游已折叠 interpreter）；
`acp.ts:1386` 是 ACP `terminal/*` 回调，替**被驱动的 agent** 起进程，根本没有 `CommandSpec`，不适用。

**修复。** ① 新增 `src/kernel/command-line.ts`，**唯一**的 `buildCommandLine`；放在 `kernel/`
是因为 `kernel/**` 不许 import `drivers/**`（D3），而反向依赖早已存在。`drivers/argv.ts:181`
改为再导出（五个 driver 与既有单测一行未改），`kernel/spawn.ts:88` 的 `buildArgv` 改为委托。
`registry.ts:574` 的探测改为 `buildCommandLine(resolved.command, ['--version'])` ——
探测本来就在 `resolve()` 之后跑，所以 CLI 轨道的修复**先于**探测生效，不必抄第二遍。
② `VersionProbeOutcome{version?, diagnostic?}`（纯放宽，既有注入器照旧编译）；
`defaultVersionProbe` 分开收 stdout/stderr，**版本只从 stdout 解析**；失败时 `probeOne`
往 `notes` 写一行自解释的 `[probe] --version failed: …`（沿用 `[scan] …` 前缀约定）。
**不占用 `health.detail`**（那里已承载凭据说明，覆盖会丢掉真正的解释）。契约不变：
探测实现永不能让 `probe()` 失败；**未知版本不是错误**。

**H2 · 操作员在哪看到它。** 在 `agents_probe` 的工具输出（`tools/definitions.ts:198-200`
渲染 `… path=<exe> v<version>`，`version` 也在 `output.schema` 里）。**监工 UI 已排除**：
`ClientProbeResult`（`client/util.ts:57-69`）**没有 `version` 字段**，`engineRow()`
（`client/panel.ts:70-86`）只渲染 track / credential / models 数 / `reason`。
**也没有被吞掉** —— 失败没有变成 `version: undefined`，而是变成一句看起来像版本号的错误文本，
所以「不留没人解释的 caveat」是必须做的（D33）。

**真机证据（同一段脚本，注入无 node 的 PATH，真实 registry）。**
修复前 `claude`/`codex`/`codebuddy-code`/`codebuddy-code-acp` 的 `version` 全是
`"env: node: No such file or directory"`；修复后分别是 `2.8.4` / `0.154.0` / `2.151.0` / `2.151.0`，
桌面三个身份 `2.137.1` / `2.137.1` / `2026.6.8` **前后一致**（免疫的直接证据）。
裸 shim 的 stderr 逐字复现（退出码 **127** 而非 spawn 失败 —— `/usr/bin/env` 存在，
exec 成功，是 `env` 找不到 `node`，所以 `child.on('error')` 不触发，这才让错误文本有机会被当版本解析）：

```
$ env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' /usr/local/bin/claude --version
env: node: No such file or directory      # exit=127
```

**护栏（两个新文件 / 一个新 describe，都验证过「会真红」）。**

- `tests/kernel/registry-node-shim.test.ts`（5 个用例）：夹具 shim
  `tests/fixtures/node-shim-cli.mjs`（`#!/usr/bin/env node`，打印 `9.9.9 (fixture-node-shim)`）
  + 无 node 的 PATH + **真** `defaultVersionProbe`，断言版本**必须**读得到；
  另一条断言不可修复的 shim **不会**把 stderr 当版本，而是给出解释过的 `notes`。
  **负向对照**：`git stash` 掉 `src/` 改动后 **4/5 失败**，关键两条正是
  `expected 'env: node: No such file or directory' to be '9.9.9'` 与 `… to be undefined`。
- `tests/integration/argv-shape.test.ts` 新 describe：**捕获**一次真实 `probe()` 实际 spawn 的 argv，
  与「跑路径用同一份 `CommandSpec` 推出来的向量」逐元素比对。手工拼 argv 的实现**不可能**满足它。
  **负向对照**：同样 stash 后 **1/6 失败**，收到的向量是 `[<tmp>/claude, --version]`（缺解释器）。
- 夹具与测试**不碰本机真实 CLI**：解释器用 `process.execPath`（跑测试的那个 node）注入。
- **没有 ABI 变更**：`src/kernel/types.ts` 一行未改（只动了 `registry.ts` 自己的注释与
  `ResolvedIdentity.interpreterPath` 的说明，提醒「不要只拿它拼 argv」）。

**被否决的替代方案**：① 只修 argv、不管 stderr（换个失败形态继续骗人，且操作员看到的字仍在）；
② 把 stderr 直接丢掉（等于吞掉原因，违反「不留无人解释的 caveat」）；
③ 把 diagnostic 塞进 `health.detail`（会覆盖凭据说明，那是该字段现在的唯一用途）；
④ 改宿主 PATH / 动 `~/.dsh/**`（任务书非目标；且 CLI 轨道的 shim 修复本来就是为此存在的）；
⑤ 把 CLI 轨道的 `detail` 接到 `CommandSpec`（需要 ABI 变更，本工作流不动冻结 ABI ——
  同一事实已由 `[probe]` 行覆盖，见 `docs/findings-node-shim.md` §6.3）。

## 工作流 `settings-surface` — 在 DSH 设置里配置本插件（D34，2026-09-17）

**需求（操作员原话）**：「给我增加一个功能，在 DSH 设置里增加该插件的一些相关配置」。

**先查契约，再写代码**（配方文档只说"插槽名以目标版本为准，常见：settings"，照抄会得到一个
构建通过、门禁全绿、界面上什么都没有的交付 —— 这个项目已经被同一形状坑过一次，见工作流 G）：

- **持久化**：`@deepseek-ai/dsh-settings-file` 由 `dsh-base` 挂载，用户层就是
  `$DSH_HOME/settings.yaml`（里面已经有 `dsh-better-sidebar:` 等别人家的节）。
- **Node API**：`ctx.settings.register(ns, schema, { base })` → scope（`get/update/replace/watch`）；
  `installSection` 是**只读**的糖，不返回 scope（读过 `dsh-agent-default-model` 与
  `dsh-settings/README.zh.md` 才确认这一点）。
- **客户端**：一方 `ConfigurablePluginsTab` 枚举宿主服务的命名空间，再按命名空间
  `renderSlot('settings.plugin.item', {}, { entryKey: ns })`——**卡片必须我们自己做**，
  而且必须**带 key 注册**，否则静默不渲染。slot 契约源：`ui-settings-plugins/src/client/slot-contract.ts:19`。

**实现。** ① 新增 `src/settings.ts`：命名空间 + 无默认值的 schema + 字段表（每字段
`effect` 与 `file:line` 依据）+ 把解析值**写回 manager 已经持有的那个 options 对象**
（引用同一性 = 实时性的全部机制）；`src/namespace.ts` 只有一行字符串，让客户端不必把
schema 库拖进浏览器包（实测客户端产物 0 次 `schemastery` / `node:fs`，React 仍 external）。
② 宿主 API 增两条 POST：`settings`（读）与 `settings-write`（`{patch}` 保存 / `{field}` 重置）。
③ `src/client/settings.ts`：卡片（内联样式、四态不空屏：加载中/可写/只读部署/被拒绝），
注册到 `settings.plugin.item`，键 = 命名空间。

**活体验证（隔离 `DSH_HOME`，绝不碰操作员的 `~/.dsh`）。** `DSH_HOME=/tmp/wb-settings-home`
+ 只挂本插件的最小 profile：

```
读   → writable: true, 5 个字段全部 (未设置)/inherited
写   → settings-write {patch:{defaultCwd,maxConcurrent,allowedCwd}} → ok:true
落盘 → /tmp/wb-settings-home/settings.yaml:
         dsh-agents-bridge:
           defaultCwd: /tmp/wb-settings-home/work
           maxConcurrent: 7
           allowedCwd: [/tmp/wb-settings-home, /Users/example/BigModel]
回读 → 三个字段 overridden，两个 inherited
拒绝 → {maxConcurrent: 0} → "maxConcurrent must be a positive integer (got 0)"，且未写入
重置 → {field:"maxConcurrent"} → settings.yaml 里该键消失
边界 → ~/.dsh/settings.yaml 的 sha256 前后一致（未改动）
```

**第一次活体跑抓到的 bug，和第二次活体跑证明「第一次修错了层」** —— 这段记录两次，因为第二次才是
真正定性的那次：

- **第一次**（隔离 home）：以为问题是"回退分支用 `!==` 比数组"，于是加了结构化比较 `sameValue`，
  并让 `describe` 的键按 `ns ?? namespace ?? name` 三种形状试。单测绿了。
- **第二次**（操作员真实 `DSH_HOME`，重启到新构建的宿主）：**三个列表字段仍然报"已被用户覆盖"**，
  而那份 `settings.yaml` 里根本没有 `dsh-agents-bridge` 节。查真实 provider 源码才发现真正的原因：
  它对**没有存过 section** 的命名空间**省略 `user` 键**（`dsh-settings/lib/index.js:360-374` 的
  `...detachedUser === void 0 ? {} : { user: detachedUser }`），而代码把"没有 `user` 键"与
  "这个 provider 不描述命名空间"**混成了同一个 `undefined`** → 永远走回退分支 → 回退再拿
  `entry`（列表键是 `undefined`）当基准去比 provider 物化出来的 `[]`，必然误报。
  修法是**三态**（`known:false` / `known:true, user:{}`）＋ 回退基准改成 **schema 解析结果**（D35）。
- **同一次核对还发现一个更严重的东西**：provider 的 scope `update`/`replace` 是 `async`
  （`:410,424`），而已有代码**丢掉了返回的 promise** —— 写入失败会**报 `ok: true`**，
  并留下 unhandled rejection，而 Node 默认 `--unhandled-rejections=throw`，**那会打死整个宿主进程**。
  两个都补了"先真红后真绿"的用例。
- **教训**：第一次那个修法不是白修（结构化比较本身是对的），但它修的是**回退分支内部**，
  而缺陷在**进入回退分支的条件**上。单测的 fake 两种形状都没模拟（它总是给 `user`、
  且 `get()` 不做 schema 物化），所以两种修法都能骗过单测 —— **"测试替身与真身形状不一致"本身
  就是一类缺陷**，这轮把 fake 换成了照抄真实 provider 行为的 `fileProviderFake`。

**浏览器渲染：已由操作员在真机确认（2026-09-17 16:2x）**，并且**这一眼又暴露了一个我自己造的缺陷**（D36）：

- 操作员在 43121 的浏览器里打开 设置 → 插件，看到了卡片，但**来问我「监督桥设置 这个是你的吗」**。
  那句标题确实是本插件的（`src/client/i18n.ts:172` `settingsTitle`）。同时他看到了会话头右上角的
  **「无运行」**（`indicatorIdle`，:120）—— 也就是说**客户端半边在真实浏览器里确实挂载了**：
  ModuleLoader 包装、槽位注册、locale/主题跟随全都真的工作。这一条以前只有产物求值作证，现在有眼睛作证。
- **但他不得不问，说明卡片不合格**：设置页把每个插件的卡片并排列出，而我的卡片只给了一个人类名字
  （「监督桥设置」），没有任何东西能把它和**包/命名空间**对上；更糟的是 `src/client/settings.ts` 的
  模块注释里把 key 写成了 `agents-bridge`（漏了 `dsh-` 前缀）—— 连源码都在暗示一个错的标识。
  **修法（D36）**：卡片在**所有四个状态**里都打印一行等宽标识 `插件标识： dsh-agents-bridge`，
  取自共享常量而不取自宿主数据，所以加载中/失败态也带着身份；顺带改掉那句错的注释。
- **护栏不是空跑的**：新用例在桩渲染器可触及的**首屏状态**断言标识存在；把标识从该状态拿掉后
  2/2 真红（`expected '这些值只影响本插件…' to contain 'dsh-agents-bridge'`）。
- **仍未由眼睛验证的**：在浏览器里**保存/重置一次**（写路径本身在隔离开与单测里都已证，但没人点过「保存」按钮）。

## 工作流 D39 — Hermes Agent CLI（`hermes acp`）接入为 ACP 身份（2026-09-17）

任务书 `docs/findings-hermes-acp.md`（含本机 live `initialize` 抓包）是权威依据。本节记录**实测到的**、
以及**如实记录的负面结果**。

### 1. 命中的事实（全部本机实测，`hermes-agent` 0.21.3）

- `hermes` → `~/.local/bin/hermes` → symlink → `~/.hermes/hermes-agent/venv/bin/hermes`，
  是一个 `#!/bin/sh` 的 shim（**不是** `#!/usr/bin/env node`），所以 CLI 轨道的 node-shim 修复
  **必须不触发** —— 这一条由 `tests/tracks/cli.test.ts` 的「without repairing anything」用例钉住
  （把 fixture 改成 node shim 后该断言真红，见负控 F）。
- `hermes acp --version` **精确输出 `0.21.3`**（`exit=0`），与 `hermes acp` 的 run argv 只差一个
  `--version`，所以 §D32 的「探测 argv == 跑路径 argv」护栏按构造成立（argv-shape 的通用遍历覆盖）。
- `hermes acp` = 无头 NDJSON JSON-RPC；**stdout 干净**（适配器体积很大的 INFO 日志全部走 stderr）。
  这意味着 `findings-hermes-acp.md` §2 里那条「boot 噪声可能落在 stdout」的风险在 ACP 路径上
  **没有被观察到** —— 因此**不**去伪造一条 banner fixture 假装验证过（如实登记为 UNPROBED 风险）。
- **`session/new` 探针（本次的关键动作，throwaway 脚本在 `/tmp/hermes-acp-probe.mjs`）**：
  - `initialize` 回 `protocolVersion: 1`、`agentInfo{name:"hermes-agent",version:"0.21.3"}`、
    `authMethods = ["openrouter","hermes-setup"]`、
    `agentCapabilities = {loadSession:true, promptCapabilities:{image:true}, sessionCapabilities:{fork,list,resume}}`；
  - `session/new` 回 `sessionId` + `models.{availableModels(252), currentModelId}` + `modes`，
    **完全没有 `configOptions`**。
- **模型参数被忽略（决定了 `model: false`）**：`session/new` **广播** 252 个模型，但把模型塞进
  `session/new` 参数（`model` 与 `modelId` 两种拼法都试过）**被静默忽略** ——
  `currentModelId` 前后都是 `openrouter:minimax/minimax-m3:free`（探针 `/tmp/hermes-acp-model-probe.mjs`、
  `/tmp/hermes-acp-probe3.mjs`）。驱动的**唯一**模型杠杆就是这个参数，所以抄 codebuddy 的
  `model: true` 会承诺一个引擎根本不认的旋钮。
- **`session/resume` 真的可用（决定了 `resume: true`）**：实测返回正常结果（`models`+`modes`，无 JSON-RPC 错误），
  但结果里**没有 `sessionId`**；驱动的 `extractSessionId(resumed) || opts.resumeSessionId` 回退路径
  正好接住它。
- **`effort: false`**：`session/new` 不回 `configOptions`，所以 `extractEffortOption` 在真字节上返回
  `undefined`（这也是 `tests/drivers/hermes-acp.test.ts` 里与抓包**联动**的那条断言）。
- **`mcpConfig` 不声明**：`mcpServers: []` 被接受但不报错**不等于**支持 —— 没拿真 server 验过就不声明。

### 2. 交付物

- `src/tracks/cli/catalog.ts`：新增 `hermes`（`family: acp`、`protocolArgs: ['acp']`、
  `envPrefix: HERMES`、无 `searchPath`），能力行 `{resume:true, model:false, effort:false, clientTools:false}`，
  `notes` 里写明版本+日期、两个实测负面、验收如实形态、以及 UNPROBED 风险。
- `tests/fixtures/hermes-acp-handshake.ndjson`：**真机抓包**（`initialize` + `session/new` 两帧；
  **唯一被节流的字段**是 `models.availableModels` 252→6，其余逐字），
  provenance 记在 `tests/fixtures/ACP-PROVENANCE.md` 的**追加**小节，既有内容一字未改。
- `tests/drivers/hermes-acp.test.ts`（11 条）：用**驱动自己的** `extractAuthMethods` /
  `extractSessionId` / `extractCurrentModelId` / `extractEffortOption` 解析真帧，并断言描述符的
  能力位与抓包**一致**（`resume` 由 `sessionCapabilities.resume` 派生、`effort` 由
  `extractEffortOption !== undefined` 派生）。里面还有一条**反向自证**：手写一个带 `thought_level` 的
  `configOptions` 时 `extractEffortOption` 必须找得到 —— 否则「找不到」这个断言就是空跑的。
- 枚举型测试更新：`tests/tracks/cli.test.ts`（新增 hermes describe：身份字段、HERMES 命名空间唯一、
  `~/.local/bin` 已在 `CLI_SEARCH_PATH`、`#!/bin/sh` **不被修复**、HERMES_PATH/INTERPRETER 逃生门、
  能力行逐字段）、`tests/kernel/registry.test.ts`（必备 id 列表加 `hermes`）、
  `tests/integration/argv-shape.test.ts`（fixture bin 里加一个 `#!/bin/sh` 的 `hermes`；
  通用穷尽遍历自动覆盖新身份）。

### 3. 真机验收（`scripts/acceptance.ts hermes`，一次，逐字）

```
probe  hermes: track=cli available=true
       executable=/Users/example/.local/bin/hermes version=0.21.3 reason=-
run    session=sess_756d58a0-4ada-4fbf-be18-968762c57554 status=running

events (6):
  [status] engine requires authentication; it accepts: openrouter, hermes-setup. Set DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD to one of these to have the bridge authenticate.
  [status] session eeac6539-f93a-4a48-8222-7acd1258e467 ready
  [status] running
  [status] available commands update: 9 commands
  [status] session info update
  [text] OpenRouter didn't answer after 3 attempts — it looks temporarily unavailable. Wait a minute and send /retry, or switch models with /model. To avoid this in future, add a backup provider with `hermes fallback add`.  Provider said: HTTP 404: This model is unavailable for free. The paid version is available now - use this slug instead: minimax/minimax-m3

result status=completed exit=0 durationMs=18739
backendSessionId: eeac6539-f93a-4a48-8222-7acd1258e467
```

**如实的结论（不美化）**：这是一次**落地干净的解析终态**（18.7s、`exit=0`、拿到 `backendSessionId`、
**没有挂起**），但**不是一个成功的回合** —— 唯一的文本是引擎自己转述的上游 404，**模型的回答一个 token 都没有**。
形态上它属于任务书警告的那一类「假的成功」：`status=completed` 而实际没有模型输出。
根因在引擎侧（把上游失败当普通 assistant 文本 + 正常 end-of-turn），驱动的 `stopReason` 映射**按协议是对的**，
因此本次**不改驱动、不加启发式**；上游模型档位（免费 slug 已失效）按 §0 记入
`docs/handoff-blockers.md` **记录 9**，人工在 hermes 自己的配置里处置。
桥在这个身份上**没有换模型的杠杆**（`session/new` 忽略模型参数），这正是描述符声明
`model: false` 的意义 —— 不向模型/使用者承诺一个做不到的旋钮。

### 4. 负控（每条都真的先红后绿）

| # | 移除的行为 | 结果 |
|---|---|---|
| A | `capabilities.effort: false` → `true` | `hermes-acp.test.ts` 1 红 + `cli.test.ts` 1 红 |
| B | `capabilities.model: false` → `true` | 同上 2 红 |
| C | `capabilities.resume: true` → `false` | `hermes-acp.test.ts` 1 红 |
| D | 给描述符加 `argsPrefix: ['acp']` | `argv-shape.test.ts` 红：`hermes: argv repeats "acp" at positions 1 and 2: /fake/bin/hermes acp acp` |
| E | 把身份移出 catalog（id 改名模拟未注册） | `hermes-acp.test.ts` + `cli.test.ts` 共 **11 红** |
| F | 把「不修复 node shim」用例的 fixture 改成 `#!/usr/bin/env node` | 该断言红：`expected '/opt/homebrew/bin/node' to be undefined` |

## 阶段状态

- [x] 仓库创建 + git init + 骨架（package.json / tsconfig / cordis.patch.yml / build.mjs / types.ts）
- [x] **A · kernel 完成**：7 个模块 + 6 个测试文件，**50/50 单测通过**（修掉了 Clock 契约漂移：`Clock.now` 是方法，须经 `clock` 调用）
- [x] **C · 工具面完成**：入口 + 6 个 defineTool（E 之前；现为 9 个）+ 冒烟命令 + README；`tsc` 零错误；`pnpm run build` → `lib/index.js`
- [x] **B · drivers**：4 个方言 driver + argv 工具 + fixtures；两个遗留断言（`generic-argv` 的 argv、`openclaw` 无输出时的错误文案）已由后续工作流收敛 —— 当前 `vitest run` 全绿（见「交付指标」）
- [x] 集成：入口已接线 `installDriverRuntime()`；**端到端集成测试 5/5 通过**（真子进程 + 真 stream-json 解析 + 取消 + usage + resume 指针）
- [x] 合同校验：**`verify_plugin.py` 11/11 PASS（2026-09-17，工作流 G）**。更正上一轮的记录：
  脚本本机就有，只是当时的 `find` 只搜了 `~/.dsh` 与 `~/BigModel/LLM/tools`，**没搜 `~/.agents`**
  —— 真实位置是 `/Users/example/.agents/skills/dsh-plugin-studio/scripts/verify_plugin.py`
  （`dsh-plugin-studio` 技能自带，stdlib-only）。它对本仓库给出 1/11 FAIL，且**报的是事实**：
  `lib/client.js` 没有 `window.__ModuleLoader__.load({ id: "<包名>" … })` 包装，宿主根本不会注册
  这个 client half（详见「工作流 G」）。修复后 **11/11 PASS**，命令与原始输出见该节。
  仍然保留协调者的可复现自检（`.wb-harness/check-contract.mjs`，监理工具、不入交付物，
  合并后的树上 **19/19**；它import 构建脚本导出的 `HOST_EXTERNALS` / `CLIENT_EXTERNALS` 常量而不是
  字符串匹配源码——G 把这两个常量抽成共享导出后，旧的字面量匹配曾误报一次失败），
  覆盖且逐条标注所依赖的决策：`exports['.']` 必须是字符串（D17）、
  `exports['./client']` 存在、`dsh.bundle.patch` 指向真实文件、`dsh.client.{inject,platform}`、
  两个 build 产物**同时**出现在 `files[]` 与磁盘上、`types` 入口、两个 bundle 都保持
  `@deepseek-ai/*` external 且 client 侧 `react` 系列也 external（不变量 4 / 双 React 会崩 slot）、
  注册都在 `ctx.effect()` 内（不变量 3）、`agents_run` 不 await 会话结束（不变量 1）。
  **仍未核验**（需把插件真装进 profile 并让浏览器挂载）：DSH 版本兼容区间、loader 启动、
  cordis schema 一致性、以及 client half 在真实浏览器里的挂载 —— **这几项不得当作已通过**。
- [ ] 安装冒烟：装进 `desktop` profile → 重启 DSH → `/agents-bridge-hello` 与 `agents_probe` 可见（**待用户确认，因为需重启正在运行的会话**）
- [ ] **P1 验收：WorkBuddy 跑通一次真实任务（证据：agents_output 事件流）** — 前置已证：codebuddy headless 实测可跑（findings §5.1）。**注**：国内版 `workbuddy` 的上游当时 ETIMEDOUT（见 `docs/handoff-blockers.md` 记录 1）；国际版 `workbuddy-ai` 已用同一命令栈跑通（`status=completed`，`text: OK1`，11.6s，证据见 handoff-blockers §1.2）。两者是不同身份/不同上游，不能互相顶替，故国内版这一条仍留未勾。
  - **协调者在合并后的树上复跑（2026-09-17）**：`scripts/acceptance.ts workbuddy-ai "Reply with exactly: FINAL_OK" --model=deepseek-v4.1-flash`
    → `probe workbuddy-ai: track=desktop available=true` / `run session=sess_…  status=running`（**立即返回**）
    / `[text] FINAL_OK` / `result status=completed exit=0 durationMs=6273`。即 **probe → 立即返回 → 事件流 → 终态文本** 四段全通。
  - **人工待办**：国内版 `workbuddy` 的 `copilot.tencent.com` 可达性（不是插件问题，按 §0 只记录不修）。
- [x] **P1 验收：AutoClaw 跑通一次真实任务（证据：同上）** — **2026-09-17 通过**（工作流 F 修掉 argv 重复子命令后）。
  - 命令（`PATH=/opt/homebrew/bin:$PATH`）：
    ```bash
    node --experimental-strip-types scripts/acceptance.ts autoclaw "Reply with exactly: AUTOCLAW_OK"
    ```
  - 原始输出（两次独立运行结果一致，下为第二次全文，exit=0）：
    ```
    probe  autoclaw: track=desktop available=true
           executable=/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs version=2026.6.8 reason=-
    run    session=sess_0ecacf5a-8612-4fa2-bfa4-acc0e5f9f08d status=running

    events (1):
      [text] AUTOCLAW_OK

    result status=completed exit=0 durationMs=6827
    text: AUTOCLAW_OK
    usage: {"inputTokens":14268,"outputTokens":23,"cacheReadTokens":15104,"cacheWriteTokens":0}
    backendSessionId: 95b07772-8779-4e5e-80ef-e0e70445185d
    ```
  - 第一次运行：`session=sess_02da3568-… status=running` → `result status=completed exit=0 durationMs=7166`，`text: AUTOCLAW_OK`，`backendSessionId: 5ca9ade7-…`。
  - 修复前同一命令的失败形态（审查者实测，留作回归对照）：`status=failed exit=1 durationMs=1171`，`error: openclaw returned no parseable output: Too many arguments for this command.` —— 根因是最终 argv 里的 `… agent agent …`。
  - 另有一次**不经插件栈**的裸跑对照（证明 argv 形状本身可用）：`node <AutoClaw>/…/openclaw.mjs --profile autoclaw agent --local --json --session-id probe-test-1 --message "Reply with exactly: AUTOCLAW_OK"` → `"text": "AUTOCLAW_OK"`，`meta.durationMs: 3972`，`provider=zai`，HTTP `status=200`。
- [x] **两条实现落地（D21）**：ABI v2（`track` 必填）+ CLI/桌面两个 catalog 与 policy + 15 个新测试；`tsc` 0 错误，**159/159 通过**
- [x] **真机探测**：claude 2.8.4(/usr/local/bin，GUI PATH 下不可见)、codex 0.154.0(~/bin)、workbuddy 2.137.1、autoclaw 2026.6.8
- [x] **桌面轨道真机跑通**：WorkBuddy + `deepseek-v4.1-flash` 完成一次真实任务（`scripts/acceptance.ts`：10.4s，text=OK，usage + backendSessionId）
- [x] **CLI 轨道真机跑通（到引擎边界）**：claude 被搜索路径找到 → 子进程 → stream-json 解析 → 终态失败=引擎自己的上游 401（凭据不归桥管）
- [x] **D22 codex driver 完成**：`src/drivers/codex.ts` + 33 测试 + **真实抓包 fixtures**（本地 Responses stub 驱动真二进制）；真实端到端跑通（成功 / resume / 凭据失败三条路径）。三个关键发现：位置参数仍读 stdin 且不关就**永久阻塞**（与 claude 相反）、`turn.failed` 才是终态失败事件、`-c model_providers.OpenAI.*` 被拒为保留 id
- [x] **probe health / 模型发现（D20）**：`src/tracks/{health,models,host-files}.ts` + 60 个测试，已接进 `probe()`；真机输出 claude ok/6、codex ok/2、workbuddy n-a/51、autoclaw n-a/6、openclaw missing/未发现；关闭两个泄露面（V8 解析错误会回显输入、autoclaw 配置里存着 JWT）
- [x] **D23 codebuddy-code 完成**：`family: codebuddy`（真实字节决定，非照文档猜）+ 20 测试 + 真实抓包 fixture；已接进 `agents_probe`（avail=true 2.151.0）。抓的是一次**鉴权失败**——退出码 0、stderr 空、错误只在 `errors[]`/assistant 文本里，正是最有价值的证据
- [x] **桌面轨道新增 WorkBuddy AI（国际版）身份**：`workbuddy-ai`，与国内版是**两个 bundle、两个身份**（同一份字节相同的 launcher，靠各自 `product.json` 的 `dataFolderName` 选 `~/.workbuddy-ai` / `~/.workbuddy`）；`tests/tracks/desktop.test.ts` 11 个测试（含宿主相关断言：两份 product.json 的 dataFolderName 必须不同、launcher 字节相同）
- [x] **`workbuddy-ai` 的 health / models 两行补齐**（P3）：health = `not-applicable`（桌面登录，桥不持有凭据；实测 `~/.workbuddy-ai/security/` 下有 UUID 命名的凭据目录，而 `src/` 全树**不含 `security` 字样**，测试用 tripwire reader 断言"一个路径都没碰"）；models 读 `~/.workbuddy-ai/cache/acc-product-config-v3.json`（真机 22 个 id，含 `deepseek-v4.1-flash-sg` / `gpt-6-astra` / `gemini-3.5-flash`），**不读**国内版的目录；读失败（缺失/不可读/非法 JSON）一律降级为 "not discovered" 而非抛错（D19：服务端下发缓存，缺席是常态）
- [x] **P3 probe 泛化（app bundle 扫描 + 端口指纹）**：`src/tracks/desktop/{scan,port-probe}.ts` + 50 个测试
  - **扫描**：只读 `app.asar.unpacked/` 下的真实文件，**绝不读 `app.asar`**（297MB 存档）；身份来自 `product.json` 的 `applicationName`/`dataFolderName`/`isOversea`/`darwinBundleIdentifier`，**不靠 bundle 名猜**（实测 `WorkBuddy.app` 与 `WorkBuddy AI.app` 的 launcher 字节相同，只有 product.json 不同）；深度/单目录条目/单文件大小/整轮墙钟四重上限，任何异常降级为 "bundle unrecognized"；id 只由 bundle 相对路径与文件内容派生（无随机数、无时间戳、无绝对路径），可复现
  - **合并语义**：内置表优先（`mergeScannedIdentities`），扫描只做补充；被遮蔽的 bundle 进 `scanDiagnostics()`，不静默丢弃
  - **缓存**：复用 `registry.ts` 既有的 TTL probe 缓存，未新增第二套缓存机制（扫描结果额外 memoise：装了哪些 bundle 不随 60s TTL 变化）
  - **端口指纹**：只探 `127.0.0.1` / `::1`（`localhost` 明确拒绝，避免走 resolver）；连接超时 ≤300ms、并发封顶、整轮墙钟预算；失败一律静默降级。**只有端口 + 响应签名同时命中才算 `confirmed`**，否则只是**疑似**，且**两者都不得影响 `available`**（`available` 仍只由"能不能真启动"决定）。默认期望表为**空**：本机没有已验证的 gateway 端口，猜一个等于往探测输出里塞假事实
  - **扫描真机实测**：29ms 扫完 `/Applications` 的 64 个 bundle，识别出 AutoClaw 的 gateway（`Resources/gateway/openclaw/openclaw.mjs` + bundle 内 `Resources/node/darwin-arm64/node`），并按内置优先规则正确遮蔽
- [x] **P2 取消/续接/watchdog 打磨**：三段式取消（SIGTERM → grace → **进程组** SIGKILL）配孤儿证明测试（假 CLI fork 出孙进程 + 故意忽略 SIGTERM，cancel 后断言两个 pid 都 ESRCH）；watchdog 硬超时/idle 各自独立、终态 `timeout`、终态后定时器归零；`send` 对终态会话给可执行错误；`cwd`/agent 白名单（`realpath` 后比较）+ `maxConcurrent`（同步拒绝，不排队）；store 并发写者不再撞临时文件名（原 bug：per-instance 计数器 → 丢记录）。新增 81 个测试
- [x] **D27 ACP driver 完成**：ABI v4（`ProtocolFamily += 'acp'` + 三个可选字段，纯加法）+ `src/drivers/acp.ts` + CLI 轨道新身份 `codebuddy-code-acp` + `tests/fixtures/fake-acp-cli.mjs`（DERIVED，见 `tests/fixtures/ACP-PROVENANCE.md`）+ 44 个 ACP 测试。**真实端到端**（`DSH_ACP_E2E=1`，`@tencent-ai/codebuddy-code` 2.151.0）：走完 `initialize` → `session/new`（拿到真实 `backendSessionId` `01a0abca-7768-79fd-bb1e-d44abfb0125d`）→ `session/prompt`，通知流被正确归一化成 `status`（`session info update`、`available commands update: 49 commands`/`60 commands`），终态是**鉴权失败**（退出码 0、stderr 空、`stopReason:"refusal"`、401 只在 `result._meta["codebuddy.ai/errorMessage"]` 里）——与 D23 同款最有价值证据，且证明 `refusal`→failed 的映射真的生效（否则会把死凭据报成「模型拒答」）。五个实测发现：帧格式是无头的 NDJSON；对端会发**没有 `id` 的请求**（`_codebuddy.ai/command`）；`refusal` 不是「模型拒答」而是失败态；**引擎是常驻服务、不主动关 stdin 就永不退出**（见 D27 正文）；客户端能力是 multica 没做过的**有意增量**。安全红线：`fs/*`、`terminal/*` 全部限制在 `opts.cwd` 内（含 realpath 反软链穿越），且默认关闭、需 env 显式开启
- [x] **client half（监工 UI）落地**（工作流 A）：`src/client/**` + `src/host/api.ts` —— 宿主 HTTP 路由 `kind:"prefix"`、POST-only、复用 better-sidebar 的 `fence` 语义；`webServer` 用 `ctx.get` 惰性取而不进 `inject`（否则没有该服务的宿主会把整个插件判为 INACTIVE，D16），取不到只少 UI、工具面照常注册。client 侧按 slot 注册（`conversation.session.header.utilities` 常驻计数 + `sidebar.right.pane.tab` 完整面板，独立降级），增量读取回传 `nextIndex`，无会话时停轮询，中英双语 + 跟随宿主主题变量。`package.json` 加 `dsh.client` 与 `exports["./client"]`，`exports["."]` 保持字符串（D17）。新增 `lib/client.js` 产物与 `vitest.config.ts`（`tests/**` 锚定，避免 vitest 扫到兄弟 worktree——这个坑在合并期真实发生过）。**2026-09-17 更正（工作流 H）**：上面「`webServer` 用 `ctx.get` 惰性取」那一半是错的 —— 宿主的 web server 比本插件晚到 ~800 ms，一次性读永远是 `undefined`，面板在**任何**宿主上都挂不上；已改为 `ctx.inject(['webServer'], …)` 作用域注入，详见「工作流 H」。
- [x] **P4 并行 fan-out（工作流 E）**：工具面 6 → 9。`agents_wait`（有界等待：全部 / 任一（`until:"any"`）终态或超时即返回；**超时是正常返回**，`timedOut: true`，什么都不取消；`timeoutMs` 缺省 20s、上限硬编码 60s、超了**钳位并在 render 里说明**）+ `agents_run_many`（一次起 ≤16 个；**单项被拒不影响其余**，错误带 `runs[i]` 前缀；超 `maxConcurrent` **不排队**、该项直接报错）+ `agents_usage`（逐会话 + 汇总；`reasoningTokens` 单列、**不计入 `totalTokens`**，因为它已被引擎算在 `output` 之内）。同一次交付还收了：**错误文案人因化**（`describeRunFailure` 就地增强 v3 的类型化拒绝、`unknownSessionMessage` 列出已知会话；`tests/tools/error-copy.test.ts` 11 个用例把「说了下一步」锁住）、**系统提示段重写**（何时委派 / prompt 必须自包含 / 先 `agents_wait` 再 `agents_output` 且回传 `nextIndex` / 并行用 `agents_run_many` / 方向错了 `agents_cancel` / 只看得到归一化事件）。**不变量 1 未被触碰**：`agents_run.execute()` 依旧立即返回（`tests/tools/wait.test.ts` 有用例锁住）。**证据**：`pnpm exec vitest run` → **691 passed / 1 skipped（40 个文件）**；`pnpm exec tsc --noEmit` → 0 错误；`pnpm run build` → `lib/index.js` 309.1 KB + `lib/client.js` 59.1 KB。（P4 的另外两件 —— ACP driver 与监工 UI —— 见上面两行，均已合并。）

  - [x] **工作流 F · openclaw/autoclaw argv 重复子命令修复（2026-09-17）**：两个身份都跑不起来 —— `buildOpenclawArgs()`（`src/drivers/openclaw.ts:187`）**无条件**把 `agent` 放在 argv 最前，而 `spawn.ts:81` 的 `buildArgv()` 只是把 `argsPrefix` 拼在它前面，于是两个描述符里的 `argsPrefix: ['agent']` 把子命令变成了 `… agent agent …`，CLI 回 `Too many arguments for this command.`（审查者实测 `exit=1 durationMs=1171`）。
    - **修复**：`src/tracks/desktop/catalog.ts` 的 `autoclaw` → `argsPrefix: ['--profile','autoclaw']`（原来**连 profile 都没有**，会去读 `~/.openclaw/openclaw.json` stub 报 config invalid）；`src/tracks/cli/catalog.ts` 的 `openclaw` → **删掉整个 `argsPrefix`**（driver 自己会给 `agent`）。两个身份的 `notes` 一并改正：profile 由**描述符**提供，driver 只在 `openclawProfileFromArgsPrefix()` 里**读**它。
    - **护栏（本次最重要的产出）**：新增 `tests/integration/argv-shape.test.ts`（5 个用例）—— 对**每一个内置身份**用注入假 resolver 的 registry 解析出 `command`，再用 `spawn.ts` 的 `buildArgv()` 拼出最终 argv，断言：① 通用不变量「无相邻重复 token」；② 每个 openclaw 引擎的 `agent` **恰好出现一次**；③ `autoclaw` 的 `--profile` 值为 `autoclaw` 且**早于** `agent`；④ 没有身份的 `argsPrefix` 里出现 driver 独占的子命令（`agent`/`exec`）。**已验证它真的会红**：把两个描述符改回 bug 值后，5/5 全部失败（失败信息里能直接看到 `[ 'agent', 'agent', '--local' ]`）。测试不依赖宿主机安装（`scan: false` + `PATH: ''` + 注入 resolver）。
    - **修断言（不删测试）**：`tests/kernel/registry.test.ts`、`tests/tracks/scan.test.ts`、`tests/tracks/desktop.test.ts` 三处把 bug 值当期望值的断言改成正确值（`['--profile','autoclaw']` / `toBeUndefined()`）。`tests/drivers/openclaw.test.ts` 里 `openclawProfileFromArgsPrefix(['--profile','autoclaw','agent'])` 是 helper 单测，保留。
    - **真机验收通过**：`scripts/acceptance.ts autoclaw "Reply with exactly: AUTOCLAW_OK"` → `status=completed exit=0 durationMs=6827`，`text: AUTOCLAW_OK`（原始输出见上方 P1 验收条目）。
    - **证据**：`pnpm exec vitest run` → **696 passed / 1 skipped（41 个文件）**；`tsc --noEmit` → 0 错误；`pnpm run build` → 见交付指标。

  - [x] **工作流 G · client half 补上 ModuleLoader 包装（2026-09-17）**：`lib/client.js` 是裸 esbuild CJS 产物，全文 0 次 `ModuleLoader` → 宿主不注册 → **UI 静默不出现**（Node half 与 9 个工具照常）。修复 = 构建脚本包一层 `window.__ModuleLoader__.load({ id: 包名, factory })`（id 从 `package.json#name` 派生）+ `src/client/identity.ts` 把 slot 的 `id`/`registrant` 也从包名派生（构建期 `define`）+ client external 列表上移为 `scripts/build.mjs` 的唯一声明。**护栏**：`tests/integration/client-bundle.test.ts`（8 个用例）自己扮演宿主，在 `node:vm` 里求值**构建产物**（不 import），断言 `load` 恰好一次 / `id === package.json#name` / factory 形状 / `apply` 后 slot 的 `registrant`·`id` 与包名一致。**两次负向对照都真红**：产物移走 → 8/8 失败；临时改回裸产物 → 8/8 失败。**新门禁**：`pnpm run verify`（`scripts/verify.mjs` 运行时解析校验器路径，找不到就非零退出并给出提示）。**证据**：`verify_plugin.py` **11/11 PASS**；`pnpm exec vitest run` → **704 passed / 1 skipped（42 个文件）**；`tsc --noEmit` → 0 错误；`pnpm run build` → `lib/index.js` 310.1 KB + `lib/client.js` 59.5 KB（含包装）。详见「工作流 G」一节。

  - [x] **工作流 H · 宿主 API 取不到 `webServer`，监工面板永远不挂载（2026-09-17）**：真机 web 宿主上插件打印 `host has no webServer` —— 9 个工具全在，**宿主 API 一个都没接上**（client half 即使已带上 ModuleLoader 包装也拿不到数据）。根因**不是**「未声明就不能取」（cordis `reflect.get` 文档明确写着不需要 inject），而是**时序**：宿主的 web server 是 loader 树的另一行，真机比本插件晚 **~800 ms** 才 provide（临时打点实测 `785`），一次性 `ctx.get('webServer')` 于是在**有** web server 的宿主上读到 `undefined`。修复 = **作用域注入** `ctx.inject(['webServer'], scoped => …)`：只在服务可用时挂路由、服务出现自动重跑、服务消失自动卸载，**父 fiber 从不失活**（D16 的 9 个工具一个不少）；`webRuntime` 保持可选（缺席降级为只信 loopback）；路由 disposer 发布给父 effect，在 `manager.dispose()` 之前同步摘掉（cordis 卸载 effects 是并发的）；日志改为陈述状态而非替宿主下结论。**护栏**：`tests/host/wiring.test.ts` 假 ctx 实现 `ctx.inject` 双半契约 + `provide()`，新增 5 个用例（晚到挂载 / 无 webRuntime 照挂 / 晚挂路由可摘 / 服务永不到场工具照常 / 负向日志不得谎报）。同一类 bug 在信任围栏里也有一处：`createApiRouteHandler` 建路由时快照 `trustedHosts`，而 `webRuntime` 在那一刻**仍不存在**（实测 `present:false`），配了 `trustedHosts` 的 LAN 部署会被自己的围栏 403；改为每请求读一次。**证据**：真机前后对比、`POST /agents-bridge/api/status` 真实响应、跨站 403；`pnpm exec vitest run` → **710 passed / 1 skipped（42 个文件）**；`tsc --noEmit` → 0 错误；`pnpm run build` → `lib/index.js` 310.4 KB + `lib/client.js` 59.2 KB；`verify_plugin.py` **11/11 PASS**。详见「工作流 H」一节。

  - [x] **工作流 D39 · Hermes Agent CLI（`hermes acp`）接入为 ACP 身份（2026-09-17）**：`hermes`（`~/.local/bin/hermes` → venv，`#!/bin/sh` shim）复用既有 `acp` family —— **加一个身份 = 加一条描述符**，没有新方言、没有 driver 改动、没有 ABI 变更。能力**逐字段来自真机 `session/new` 探针**而不是抄 `codebuddy-code-acp`：`{resume:true, model:false, effort:false, clientTools:false}`（`session/new` **广播** 252 个模型但**忽略**模型参数；完全不回 `configOptions`），`mcpConfig` 不声明（没拿真 server 验过）。**真机验收如实记录为「干净落地但非成功回合」**：`status=completed exit=0 durationMs=18739`，唯一文本是引擎转述的上游 `HTTP 404: This model is unavailable for free`（默认免费 slug 失效），**零模型输出** —— 不改驱动映射、不加启发式，上游档位问题进 `docs/handoff-blockers.md` 记录 9。**6 条负控全部先红后绿**（能力位三项、`argsPrefix` 重复 token、身份移出 catalog、node-shim 修复误触发）。**证据**：`pnpm exec vitest run` → **779 passed / 1 skipped（47 passed \| 1 skipped 文件）**；`tsc --noEmit` → 0 错误；`node scripts/build.mjs` + `node scripts/build-client.mjs` → 341.3 KB + 73.8 KB；`verify_plugin.py` **11/11 PASS**。详见「工作流 D39」一节。

## 交付指标（当前）

> 下表所有数字来自**合并工作流 H、D31、`node-shim-note` 与 `settings-surface` 之后的树**（主干）**本机真跑**：`pnpm exec vitest run` / `pnpm exec tsc --noEmit` / `pnpm run build` / `verify_plugin.py`。

| 指标 | 值 |
|---|---|
| TS 文件 | **116** 个 `.ts`（src 50 / tests 65 / scripts 1；另有 `scripts/*.mjs` 3 个）—— `find src tests scripts -name '*.ts' \| wc -l`（快照 `bd55dfd`） |
| 测试 | **944 个通过 + 1 skipped（59 passed \| 1 skipped 文件，共 60 个测试文件）**（快照 `bd55dfd`，2026-09-18 夜）—— 基线 704/1；工作流 H 新增 6 个、D31 新增 3 个、`node-shim-note` 新增 6 个、`settings-surface` 新增 15 个（`tests/settings/settings.test.ts` 10 + `tests/host/settings-route.test.ts` 4 + `tests/client/plugin.test.ts` keyed 槽位 1）、**D35 新增 6 个**（同一文件 10 → 16）、**D36 新增 2 个**（`tests/client/components.test.ts` 20 → 22）、**D37 新增 3 个**（同一文件 22 → 25，已验证会真红）、**D38 新增 18 个**（`tests/drivers/zcode.test.ts`，另加 fixtures 两枚 provenance 分级）、**D39 新增 16 个**（`tests/drivers/hermes-acp.test.ts` 11 + `tests/tracks/cli.test.ts` 的 hermes describe 5；另加真机握手 fixture 一枚；跳测共**三种机制**且是**宿主条件**，不是固定 1 例：① `tests/drivers/acp-e2e.test.ts` 的 `DSH_ACP_E2E=1` 选项（`describe.runIf`，1 例）；② `tests/tracks/desktop.test.ts` 与 ③ `tests/tracks/scan.test.ts` 的 `describe.skipIf` 宿主探测各 2 例 —— 只有同时装了 `/Applications/WorkBuddy.app` 与 `/Applications/WorkBuddy AI.app` 才运行。**本机两套 bundle 都在，故只跳 1 例；干净机器上是 +4 skipped（vitest 如实记为 skipped，不是 4 个幽灵通过）**），零删除。**779 → 944 之间**：修复复核各批（A/B/C）+ 记录的「调用记录页签 / rescan」批（+11）+ 「终态主动通知」批（+14）。命令：`node node_modules/vitest/vitest.mjs run` |
| `tsc --noEmit` | 0 错误 |
| 构建产物 · `lib/index.js` | 379.5 KB（esbuild，`@deepseek-ai/*` 全部 external） |
| 构建产物 · `lib/client.js` | 78.5 KB（web platform，`react` 系列 external；带 `window.__ModuleLoader__.load({ id: <包名>, factory })` 包装）。**注意中文以 `\uXXXX` 转义写进产物**（esbuild ASCII charset）：任何「用中文字面量 grep 产物」的检查都是无效检查 —— 要查得先解码，本仓库出现过这个坑 |
| 工具面 | **9 个**（`agents_probe` / `run` / `run_many` / `status` / `wait` / `output` / `usage` / `cancel` / `send`） |
| 合同校验 | **`verify_plugin.py` 11/11 PASS**（`pnpm run verify`；等价命令 `python3 /Users/example/.agents/skills/dsh-plugin-studio/scripts/verify_plugin.py .`，原始输出见「工作流 G」）。另有监理自检 `.wb-harness/check-contract.mjs` **19/19**（工具，不入交付物） |
| 端到端集成 | `tests/integration/pipeline.test.ts`（真子进程 + 真 stream-json 解析 + 取消 + usage + resume 指针）全绿；`tests/integration/argv-shape.test.ts`（每个内置身份的最终 argv 形状，5 个用例）全绿 |
| 真机验收 · web 宿主 API | `dsh --profile web`（standalone harness，127.0.0.1:43121）实测：`host api route mounted {"path":"/agents-bridge/api"}`，`loaded` 仍报 `"tools":9`；`POST /agents-bridge/api/status` 与 `/probe` 返回真实数据，跨站请求 403。命令与原始输出见「工作流 H」一节 |
| 真机验收 · **无 node 的宿主 PATH**（本缺陷的原始症状） | 协调者在**合并后**的树上复跑：`env PATH=/usr/bin:/bin:/usr/sbin:/sbin ./bin/dsh --profile web --no-open` → `claude` 2.8.4 / `codex` 0.154.0 / `codebuddy-code` 2.151.0 / `codebuddy-code-acp` 2.151.0（修复前这四行是 `version: "env: node: No such file or directory"`），桌面三身份 `workbuddy` 2.137.1 / `workbuddy-ai` 2.137.1 / `autoclaw` 2026.6.8 前后一致；同一宿主上 `host api route mounted` 照常 |
| 真机验收 · **设置面板数据面**（隔离 `DSH_HOME`） | `DSH_HOME=/tmp/wb-settings-home` + 最小 profile：读 → 写 → 回读（`overridden` 正确）→ 非法值被指名拒绝 → reset 后 `settings.yaml` 中该键消失；`~/.dsh/settings.yaml` 的 sha256 前后一致（未触碰）。**浏览器渲染已由操作员确认**（2026-09-17：在 43121 看到卡片「监督桥设置」与会话头右上角指示器「无运行」）—— 但**没人点过「保存」按钮**，浏览器内的写路径仍未由眼睛验证 |
| 真机验收 · **`overridden` 不再误报**（D35，操作员真实 `DSH_HOME`，只读） | 重启到修复后构建的 web 宿主：`POST /agents-bridge/api/settings` → `writable: true`、**`overridden` 命中的字段列表为 `[]`**（修复前是 `allowedCwd`/`deniedCwd`/`allowedAgents` 三个），列表字段 `value: []`（provider 物化）、`defaultCwd`/`maxConcurrent` 为 `undefined`；`{"patch":{"maxConcurrent":0}}` 回 `ok:false, "maxConcurrent must be a positive integer (got 0)"` 且 `~/.dsh/settings.yaml` sha256 不变（`02c15fdf6a3db339…`，无 `dsh-agents-bridge` 节）|
| 真机验收 · AutoClaw | `status=completed`、`text: AUTOCLAW_OK`、8404 ms（**合并后的树上复跑**，`scripts/acceptance.ts autoclaw`） |
| 真机验收 · WorkBuddy | 国际版 `workbuddy-ai`：`status=completed`、`text: FINAL_OK`、6273 ms（**合并后的树上复跑**）。国内版 `workbuddy` 上游 ETIMEDOUT，见 `docs/handoff-blockers.md` 记录 1 |

## B4 · scan 轨道信任契约（IM-1 + IM-10 同批，IM-11/12/13 + MI-9）（2026-09-17）

**这一节是扫描行为的契约记录，改 `src/tracks/desktop/scan.ts` 前先读它。**

### 契约（逐字）

> **扫描根下的任何 bundle 都会在 probe 时被执行，除非操作员显式声明它的身份。**

反过来说，本批之后默认行为是：**扫描发现的任何 bundle 都不会在 probe 时被执行，也不会被 run**；唯一的
启用方式是操作员在 `config.descriptors`（`src/index.ts:74`）里为**同一个 id** 声明一条描述符。这条声明
在 `mergeDescriptors()` 里先于扫描进入表，`mergeScannedIdentities()` 的「内置/已声明优先」规则因此让声明
遮蔽（shadow）扫描候选，此后它才像任何普通身份一样被 probe 和 run。

### 机制（为什么是这三行，而不是各自打补丁）

1. `bundledCliDescriptor()` 无条件带 `unsupported`（引擎候选、解释器候选本来就带）。`registry.resolve()`
   在 `descriptor.unsupported` 时**先于** track policy 返回 `reason`（`registry.ts:523-524`），`probeOne()`
   因此在 `buildCommandLine` / `probeVersion` **之前**返回 `available:false`；`manager` 在 `manager.ts:576-579`
   抛 `unsupported-agent`。run 与 `--version` 探针走的是**同一个** `resolve()`，所以「探针要过与 run
   同一套允许清单」是**一个函数**的性质，不是两处调用点要各自记得对齐。
2. 家目录根的显式 opt-in 由此**被这条契约涵盖**：`~/Applications` 与 `/Applications` 都不自动可信，
   「用户可写根需要显式选择」不再是单独开关，而是默认姿态。
3. 来源校验（`CFBundleIdentifier` vs `product.json` 的 `darwinBundleIdentifier`）**被计算并写进 `notes`**
   （`provenance consistent` / `provenance INCONSISTENT` / `provenance unknown`），用于让操作员的 opt-in
   决策有依据；它**本身不翻这个闸** —— 两个字段敌意 bundle 都能写，**本桥不做代码签名校验**（已在 notes
   里逐字说明，不假装做了）。

### IM-10 为什么必须同批

`findBundles()` 原先用**共享** `out.length` 判 `MAX_BUNDLES_PER_ROOT`：根 1 满了之后每个后续根立即返回。
生产根序是 `/Applications` → `~/Applications`，本机 `/Applications` 有 100 个 `.app`，于是**用户可写根从来
没被扫过** —— 这既丢掉了家目录里的身份，也**掩盖了 IM-1**（那条执行路径当时根本没被走到）。改成按根快照
`startLen` 后该路径被打开，所以信任闸必须在同一批落地，否则修好上限 bug 的净效果是**放大执行面**。
上限仍是**每根 64**、墙钟预算仍全局。

### 与本契约冲突的旧断言（已改，不删）

- `tests/tracks/scan.test.ts` 的 `produces a descriptor a scanned bundle can actually be launched from`
  → 改为 `keeps a scanned bundle a candidate through the merge, and the policy pure`：desktop policy 只是
  接线（声明过的描述符它照样放行），闸不在 policy 而在 `registry.resolve()`。
- 同文件的 `resolves a discovered identity against its real bundle path` → 改为
  `resolves a discovered identity to its real path but refuses to launch it (IM-1)`：路径照给（操作员要它），
  `reason` 必须指向 `config.descriptors`。

### IM-11/12/13 与 MI-9 的落地要点

- **IM-11**：两处 `unsupported.reason` 的伪 remedy（「设 `<PREFIX>_PATH` … 并配 driver family 来 enable」）
  改为指向 `config.descriptors`。理由：`registry` 先于 policy 返回 unsupported、`manager` 一律拒跑，
  env 覆盖**永远无法**启用该身份。测试断言 reason 含 `config.descriptors` 且**不匹配** `/_PATH[\s\S]*enable/i`。
- **IM-12**：`parseProductIdentity` 的每个字符串字段在**唯一入口**过 `safeFact()`（`redactSecrets(oneLine(v))`，
  200 字符钳）；`slugify()` 输出钳到 64 字符（id / env prefix / settings key 同源）；`notes`/`displayName`/reason
  过 `oneLineText()`（折叠为一行 + 脱敏 + 800 字符钳）。**有意偏离台账字面**：台账说 notes 过 `oneLine`（200 钳），
  实测 200 会把 `dataFolderName` / `isOversea` 等可诊断事实整段截掉（`puts the product.json facts into notes`
  这条既有断言正是要求它们在场）；本批取「必须是一行」这一性质，长度钳值放宽到 800，事实级仍按 200 钳。
  想回到字面 200 只需改 `MAX_DESCRIPTOR_TEXT_CHARS` 一个常量，但那条诊断断言需同时改。
- **IM-13**：`readBundleIdentifier` 不再裸 `readFileSync`：先用已 stat 的 `plist.size > MAX_FILE_BYTES` 早拒，
  再走 `readBounded`（其 stat 正是为了不让 FIFO/设备节点挂死遍历而存在的）。
- **MI-9**：desktop policy 重建 command 时补 `protocolArgs` 的 spread，与 `tracks/cli/index.ts:186-188` 对称。

### 负控（撤掉修复的真红，全部实测）

| 项 | 负控 → 观测失败 |
|---|---|
| IM-1（候选姿态） | 修复前跑新测试：`expected undefined to be defined`（`descriptor.unsupported`） |
| IM-1（执行面，台账 oracle） | 修复前：种一个 `bin/codebuddy` 为 `touch <marker>` 的 bundle → probe 后 `expected true to be false`（**marker 真被创建**）；修后同一 bundle 由操作员声明时 marker 出现 → oracle 非空跑 |
| IM-1（探针同闸） | 修复前：`expected true to be false`（未声明的 house-agent `available:true`，即探针真执行了它） |
| IM-10 | 修复前：`expected [ 'bulk-0', … ] to include 'needle'`（根 2 从未被走） |
| IM-11 | 修复前：reason 不含 `config.descriptors` |
| IM-12 | 修复前：`expected '[scan] bundled CodeBuddy CLI discover…' not to contain '\n'`；id 未钳长 |
| IM-13 | 修复前：4 MB `Info.plist` 仍返回 `'com.huge.app'` |
| MI-9 | 修复前：`expected undefined to deeply equal [ '--acp' ]` |
