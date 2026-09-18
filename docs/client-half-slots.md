# dsh-agents-bridge — client half slot contracts

> 这份文档是 `src/client/**` 的**施工前契约**：先固定 slot 名、props 形状、
> 服务可用性与降级规则，再写组件。所有事实来自本机两个**已安装可运行**的
> client-half 参照插件的产物，不是推测：
>
> - `~/.dsh/profiles/desktop/node_modules/dsh-history/`（最小完整例子）
> - `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/`（复杂例子）
>
> 对应决策：D4（「P4 加 UI 时直接加 client half」）、D16（可选服务**不进
> `inject`**，否则无该服务的宿主会把整个插件判为 INACTIVE）、D17（`exports['.']`
> 保持字符串）。

## 1. client half 的模块形状

参照 `dsh-history/lib/client.js` 末尾（未压缩，带注释）：

```js
exports.inject = ['slots']
function apply(ctx) {
  ctx.effect(() => injectStyles(), 'dsh-history: stylesheet')
  const slots = ctx.get('slots')          // 惰性取，取不到就安静降级
  if (slots === undefined) return
  slots.inject('conversation.input.dock', () => slots.register(
    { name: 'conversation.input.dock', id: 'dsh-history', order: 30 },
    (props) => React.createElement(HistoryDock, props),
  ))
}
```

**这份 tail 外面还有一层包装，缺了它整块 UI 静默消失**（工作流 G 的缺陷正在这里）：
整个产物被 `window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { … } })`
包着 —— 宿主在**启动时注册 factory**（模块主体保持惰性），**不是** import 产物后读
`exports`。所以 `exports.inject` / `apply` 必须出现在 factory 的**返回值**上，`id` 必须
**等于包名**（我们是 `dsh.bundle.patch` 的 bundle 形态；`dsh-external/<name>` 是
`client-registry.js` 那种分发形态的 id）。包装由 `scripts/build-client.mjs` 生成，
`react` 通过 factory 的 `require` 从宿主取。见 D30。

要点（三条都照抄）：

1. **`slots` 是唯一放进 `inject` 的服务**。它是客户端运行时的基础服务，缺失
   说明整块 UI 都无处可挂。其余一律 `ctx.get(...)` 惰性取。
2. `slots.inject(name, cb)` 是**等该 slot 出现**的注册器（返回 disposer，cordis
   在 fiber 释放时自动调用）；`slots.register(meta, component)` 是真正的注册。
3. 样式走 `ctx.effect(() => injectStyles(), '...')`：插一个
   `style[data-plugin-css="<id>"]` 到 `document.head`，disposer 负责摘掉。

`dsh-better-sidebar/lib/client.js` 的 `inject` 是
`['slots','sessions','locale','modules','connection']` —— 它把 `sessions` / `locale`
也放了进去，因为**它的 UI 完全依赖这两者**（没有 locale 就没有文案、没有
sessions 就没有会话绑定）。我们**不**这么做：见 §4 的降级矩阵。

## 2. 本工作流用到的 slot

| slot 名 | 我们的注册键 | kind | order | props（我们实际读的字段） | 来源 |
|---|---|---|---|---|---|
| `sidebar.right.pane.tab` | `key` = `dsh-agents-bridge`（= 类型 `id`） | **keyed** | 30 | `sessionId`（该 pane 当前会话的 id） | better-sidebar |
| `conversation.session.header.utilities` | `id` = `dsh-agents-bridge:indicator` | **list** | 40 | `sessionId?`（顶层 active 会话） | better-sidebar |

**注册键随 kind 变**：keyed 要 `key`，list 要 `id`，single 两者都不要 —— 给错字段的
后果是**抛错且面板消失**，不是降级。详见 §2.1 末尾。

### 2.1 `sidebar.right.pane.tab` — 完整监工面板

参照实现（`dsh-better-sidebar/lib/client.js:17010`）：

```js
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: id,                       // 稳定 key，同一 key 重复注册会被去重
  inject: (sessionId) => ({ ...injected, sessionId }),
}, NativeTabBody))
```

- **`inject` 是本次注册最关键的字段**：宿主为每个 pane 调用它是为了拿到
  **该 pane 的会话作用域**（`sessionId`）。它是 `(sessionId) => props` 的形状，
  注册器拿到的 props 会与它展开合并。
- **谁提供这个 slot**：`@deepseek-ai/dsh-client-ui-sidebar-right`（better-sidebar
  的 package.json 里该包是 `peerDependenciesMeta.optional: true`）。它**可能不存在**。
- **我们的用法**：面板是**全局**视角（列出本插件拥有的全部会话，不只当前
  pane 的），因此 `sessionId` 只用于显示「本 pane 的会话」高亮，缺失不影响渲染。
- **独立降级**：`ctx.get('slots')` 拿得到但该 slot 在宿主里从未被创建时，
  `slots.inject` 的回调**永远不会被调用** —— 注册自然不存在，不抛错。这就是
  「`sidebar.right` 那套服务不存在时只保留头部指示器」的实现方式：不做额外判断。

#### ⚠️ tab 是**两阶段**注册，且这是 KEYED slot

只做上面那一步**不够**，面板会静默消失：

1. **类型**（本仓 `registerPanelTabType`，`src/client/index.ts`）：
   `ctx.get('sidebarRightTabs').register({ id, kind, title, guide })` —— 静态声明，
   命名 kind、给 chip 文案、在 guide 页放一个入口。
2. **正文**：`slots.register({ name: 'sidebar.right.pane.tab', key: <上面那个 id> }, Body)`。

`key` 必须**等于类型 `id`**：侧栏对每个 tab 的派发是
`renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind })`。

而且 `key` 不是可选项 —— slot 核心对 keyed slot 有硬校验
（`@deepseek-ai/dsh-client-ui-slots/lib/index.js`）：

```js
case "keyed": { if (options.key === void 0) throw new Error(`keyed slot "${options.name}" requires options.key`); … }
case "list":  { if (options.id  === void 0) throw new Error(`list slot "${options.name}" requires options.id`); … }
```

**2026-09-19 的教训（真实事故）**：本仓曾把 panel 注册成 `id: PANEL_ID`（无 `key`），
于是它在挂载时抛错、**面板从未出现过，而且没有任何报错浮到表面**。
对照另两个 slot：`conversation.session.header.utilities` 是 **list** 型（要 `id`），
`settings.plugin.item` 是 keyed（要 `key`）—— 当时两者都是对的，只有面板错了。
所以 `tests/client/plugin.test.ts` 现在**同时**断言「正文的 `key` == 类型的 `id`」，
而不是分开断言两半。

参考实现：`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（两步都做了）、
`@deepseek-ai/dsh-client-ui-sidebar-right` 自带的 guide 类型
（`slots.register({ name: 'sidebar.right.pane.tab', key: GUIDE_ID, … }, GuideBody)`）。

**guide 入口的字段形状**（`guide: [{ order, title: () => string, description?: () => string, icon? }]`）：
`title`/`description` 是**函数**，侧栏在渲染时调用（这样换语言不用重新注册）。
只有**一个** guide 入口时，那个类型会成为侧栏的默认页**自动打开**；有多个时默认页是 guide 本身。

### 2.2 `conversation.session.header.utilities` — 常驻指示器

参照实现（`dsh-better-sidebar/lib/client.js:17130`）：

```js
ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
  name: 'conversation.session.header.utilities',
  id: 'dsh-better-sidebar:bottom-toggle',
  order: 10,
  registrant: 'dsh-better-sidebar',
}, () => React.createElement(BottomDockToggle, { store })))
```

- 这个 slot 的 component 是**无参**调用的（`() => jsx(...)`），宿主不传 props。
  我们的指示器组件因此**自己读会话**（见 §3），不依赖 props。
- `order: 10` 是 better-sidebar 的取值；我们取 `40`，把左侧位置让给宿主的
  会话日志下载按钮和 better-sidebar 的开关（两者都更靠近右边/更早注册）。
- 该 slot 由客户端会话 UI（`@deepseek-ai/dsh-client-ui-conversation`，随运行时
  提供）声明，可用性高于 `sidebar.right.pane.tab`。
- **它负责「打开面板」**：指示器的 tooltip 写着「点击查看」，所以点击必须真的
  把侧栏展开到我们的 tab 上。做法是 `ctx.get('sidebarRight').openTab(PANEL_KIND)`
  （`src/client/index.ts` 的 `revealPanelTab` / `indicatorNavigation`）。
  三条注意：
  1. `openTab` **需要一个已挂载的会话停靠面**，没有时**抛错**（不是静默 no-op），
     所以必须 try/catch 成 `false`。
  2. **每次点击重新解析**控制器，不能在挂载时捕获 —— 它由可选 peer 提供，可能
     比本插件晚挂载。
  3. 不传 `options`：不带 `replaceTab` 时 tab 落在活跃格且**按格去重**，所以连点
     两次是聚焦而不是把用户原本开着的 tab 关掉。

### 2.4 打开面板的三条路（都由上面的接线提供）

| 路径 | 触发 | 说明 |
|---|---|---|
| **guide 页入口** | 展开侧栏 → 点「Agent 监工」 | 我们的类型注册了 `guide` 条目；侧栏默认页在有多个 guide 条目时就是 guide 页 |
| **头部指示器** | 会话头部工具区点一下 | `openTab(PANEL_KIND)`，会**自动展开**侧栏 |
| 自动成为默认页 | 首次展开 | **仅当**全部注册类型里只有一个带 `guide` 条目时；harness 自带 `ui-sidebar-files` 也有一条，所以实际走不到 |

### 2.3 不采用的 slot（记录理由）

| slot | 为什么不采用 |
|---|---|
| `conversation.input.dock` | dsh-history 用它做「我的消息」一行。位置在输入框正上方，是**常驻占用输入视觉焦点**的行；监工信息是次要信息，不该抢这个位置。作为兜底备选记录在此。 |
| `settings.section` | better-sidebar 用它做「侧边卡」设置分区。我们只有「轮询间隔」一个可调项，为此增加一个设置分区不划算；轮询间隔做成面板内的一个下拉，留在 `sidebar.right.pane.tab` 里。 |

## 3. 服务可用性与降级矩阵

| 服务 | 声明方式 | 缺失时的行为 |
|---|---|---|
| `slots` | `inject: ['slots']` | 整块 UI 不挂载（`ctx.get('slots') === undefined` 时 `apply` 直接 return）。Host half 的 9 个工具与 HTTP 路由**完全不受影响**。 |
| `sidebar.right.pane.tab` slot | 不判断，`slots.inject` 等它 | 面板不出现；头部指示器照常。**不抛错、不白屏**。 |
| `conversation.session.header.utilities` slot | 同上 | 指示器不出现；面板照常。 |
| `locale`（宿主语言） | `ctx.inject(['locale'])` | 回退到 `navigator.language`，取 `zh*` → 中文，否则英文。**它的注册器是 try/catch 包住的**：`locale.register` 的具体签名在宿主版本间有差异，失败只丢翻译。 |

### ⚠️ 激活顺序：`slots` 来自 shell 核心，所以我们**跑在几乎所有插件之前**

这是 2026-09-19 面板打不开的**真正根因**，值得单独记：

- **`slots` 由 shell 核心提供**（不在任何 `@deepseek-ai/*` 客户端产物里 —— 全仓 `grep 'provide("slots"'` 无命中）。
- 而 `locale`（`dsh-client-locale`）、`sidebarRightTabs` / `sidebarRight`（`dsh-client-ui-sidebar-right`）都由**插件条目**提供，它们自己还有更深的依赖链
  （`ui-sidebar-right` 依赖 session controller → resources → conversation → layout → session）。
- 我们的 `inject` 只有 `['slots']` → **`apply` 在 `slots` 一出现就跑**，此时那些可选服务**还没发布**。

**后果**：任何在 `apply` 里做的 `ctx.get('可选服务')` **一次性查询**都会读到 `undefined`，然后**永不重试**。
面板因此从未声明 tab 类型 → 没有 kind 可开 → 面板不出现，**而且控制台没有任何报错**。

**正确做法**：`ctx.inject([...], (scoped) => { scoped.effect(...) })`。
cordis 文档原文：*"Start a callback **once the requested dependencies are available**"* ——
服务已存在就立刻跑，晚到就等它，永不到就永不跑（正是"可选 peer"该有的语义）。
**注意**：它**不是**插件级 `inject` 的替代 —— 把可选服务写进插件级 `inject` 会让宿主把它当成
**激活前提**，缺该服务的宿主会把整个插件判为 INACTIVE，连头部指示器和设置卡片一起丢掉（D16）。

**怎么发现同类问题**：看 `apply` 里每一个 `ctx.get('X')`，问一句「X 由谁提供、那一刻存在吗」。
由 shell 核心提供的（`slots`）安全；由插件条目提供的（`locale`、`sidebarRightTabs`、`sidebarRight`）
必须走 `ctx.inject`。**唯一例外**是"每次点击/每次渲染才查"的场景（如
`revealPanelTab` 里按次查 `sidebarRight`）——那时所有插件早已挂载完毕。
| `sessions`（客户端会话列表） | `ctx.get('sessions')` | 指示器仍显示全局 running 数（无「本会话」高亮）；面板不受影响。 |
| HTTP 路由 `/agents-bridge/api/*` | `fetch` | 统一走 `apiClient`，任何失败（404 插件未装 / 403 拦截 / 网络断）→ `{ ok: false, error }`，UI 显示可读的错误条 + 「重试」，**不显示裸 JSON 或堆栈**。 |

**红线**：任何客户端服务的缺失都不能让 `apply` 抛错。整个 `apply` 体包在
try/catch 里，失败只 `console.warn` 一行（前缀 `[dsh-agents-bridge]`）。

## 4. 主题与样式

颜色一律用宿主 token（从 better-sidebar 产物里提取的真实变量名），**不写死
浅色背景**：

| 用途 | token |
|---|---|
| 主文本 / 次要 / 三级（弱化） | `--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-label-dimmed` |
| 底色（面板 / 卡片 / 悬浮） | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2` |
| 分隔线 | `--dsw-alias-border-l1`、`--dsw-alias-border-l2` |
| 交互态 | `--dsw-alias-interactive-bg-hover`、`--dsw-alias-interactive-bg-active` |
| 状态：运行 / 成功 / 失败 / 警告 | `--dsw-alias-accent`、`--dsw-alias-state-success-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-warn-primary` |
| 等宽（sessionId、token 数） | `--dsw-font-mono` |
| 字号 | `--dsw-font-xxxs-11`、`--dsw-font-xxs-12`、`--dsw-font-xs-13` |
| 圆角/阴影 | `--dsw-shadow-lv2` |

每个 `var(--dsw-…)` 都带**回退值**（`var(--dsw-alias-label-primary, currentColor)`），
所以宿主换 token 名也只是掉回可读的默认色，而不是黑底黑字。

## 5. Node half ↔ client half 的唯一通道

Node half（`src/host/api.ts`）注册前缀路由：

```js
ctx.webServer.register({ kind: 'prefix', path: '/agents-bridge/api', handler })
```

client half：

```js
fetch('/agents-bridge/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
```

**`req` / `res` 是原生 Node `http` 对象**（`IncomingMessage` / `ServerResponse`），
不是 express。响应信封与 better-sidebar 完全一致：

```json
{ "ok": true,  "value": … }
{ "ok": false, "error": { "code": "forbidden", "message": "forbidden" } }
```

方法名在 pathname 后缀里（`/agents-bridge/api/<method>`），入参是 POST 的 JSON body。

## 6. 三个 `inject`，别再搞混（2026-09-19 补充）

这个仓库里有**三个**叫 inject 的东西，语义完全不同。它们混淆过一次（导致面板从未挂载），
也被误判过一次（以为是解析失败导致 UI 不出现）。

| # | 位置 | 名称 | 语义 | 缺失时 |
|---|---|---|---|---|
| 1 | `src/client/index.ts` | `export const inject = ['slots']` | **cordis 服务注入**。激活门控：服务不存在时本插件条目停在 `pending`，`apply` 根本不跑 | 插件 INACTIVE（所以只放 `slots` 这种"没有它就没地方渲染"的基础服务） |
| 2 | `package.json` | `dsh.client.inject` | **浏览器模块的软预加载提示**："这些若在模块图里，先加载它们" | **静默跳过** |
| 3 | `package.json` | `dsh.client.external` | **硬模块依赖** | 宿主拒绝整张图 |

### #2 是软提示 —— 实现原文（`@deepseek-ai/dsh-client-modules/lib/client.js`）

```js
for (const packageName of row.inject) {
  const dependency = this.graphRows.get(packageName);
  if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited);
}
```

**不在模块图里的条目被直接跳过**，不抛错、不等待。所以像
`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives` 这类**纯库**（没有 `./client` 出口，永远不会成为图行）
写在这里是**无操作**的。

**本仓的取值保持不动**，理由：
- 与生态惯例一致 —— `dsh-history`（本仓文档引用的最小 client-half 范例）、`dsh-keyboard-history`、
  `dsh-peak-indicator`、`dsh-config-manager` 等都声明同样的两个库；`dsh-better-sidebar` 也声明了
  `dsh-client-ui-slots`。
- 本插件**真正的顺序保证**来自 #1（`inject: ['slots']`），不是 #2。
- 而本插件的产物**只 `require("react")`**（见
  `tests/integration/client-bundle.test.ts` 的 "asks the host for react and for NO other module"），
  没有任何模块依赖 —— 所以 #2 无论写什么都不会有行为差别。

### ⚠️ 但 #3 是真陷阱，而且 `CLIENT_EXTERNALS` 让它更容易踩

`scripts/build.mjs` 的 `CLIENT_EXTERNALS` 含 `'@deepseek-ai/*'` 通配。这在 Node 半边是对的，
在客户端却是隐患：客户端代码一旦 `import` 了某个 `@deepseek-ai/*` 包，esbuild 会**保留**
`require("@deepseek-ai/…")`，而它在模块系统里会落到最后一个分支 ——
「anything else → **throw**（loud，构建期 bundle purity 门的运行时镜像）」，
**整个客户端半边在物化时就挂了**。

所以：**客户端代码只能把 `@deepseek-ai/*` 当服务取（`ctx.get`），永远不要 import。**
上面那条测试就是钉这个不变量的。
