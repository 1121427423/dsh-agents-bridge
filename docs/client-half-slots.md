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

| slot 名 | 我们注册的 id | order | props（我们实际读的字段） | 来源 |
|---|---|---|---|---|
| `sidebar.right.pane.tab` | `dsh-agents-bridge` | 30 | `sessionId`（该 pane 当前会话的 id） | better-sidebar |
| `conversation.session.header.utilities` | `dsh-agents-bridge:indicator` | 40 | `sessionId?`（顶层 active 会话） | better-sidebar |

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
| `locale`（宿主语言） | `ctx.get('locale')` | 回退到 `navigator.language`，取 `zh*` → 中文，否则英文。**它的注册器是 try/catch 包住的**：`locale.register` 的具体签名在宿主版本间有差异，失败只丢翻译。 |
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
