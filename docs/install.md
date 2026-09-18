# 安装与实机验收（dsh-agents-bridge）

> ⚠️ **本机现状**：`/opt/homebrew/bin/dsh` 是**失效的 shim**（指向 `/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/lib/bin.js`，该文件在最近一次 app 更新后已不存在），所以 `dsh plugin add ...` **用不了**。下面走 profile 的 `package.json` 路由 —— 这正是 DSH 内部做的事（web profile 里的 `"dsh-claude-port": "link:../../plugins/dsh-claude-port"` 就是这个写法）。

## 安装（desktop profile）

**0. 先备份**（改的是你的日常 profile，出问题要能一键回退）：

```bash
cp ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/package.json.bak.$(date +%Y%m%d%H%M)
```

**1. 编辑 `~/.dsh/profiles/desktop/package.json`**，加两处：

```jsonc
{
  "dependencies": {
    // …已有…
    "dsh-agents-bridge": "link:/Users/example/BigModel/LLM/tools/dsh-plugins/dsh-agents-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …已有…
        "dsh-agents-bridge"
      ]
    }
  }
}
```

**2. 装依赖**（node 不在默认 PATH 上）：

```bash
export PATH=/opt/homebrew/bin:$PATH
cd ~/.dsh/profiles/desktop && pnpm install
```

**3. 重启 DSH**（Node 侧 bundle 变更必须重启，ESM 不会热更）。

## 验收（从弱到强）

**① 插件活着**（最快，证明加载链路通）：

```
/agents-bridge-hello 世界
```

期望：返回 `agents-bridge is alive: hello 世界. Tools agents_probe/run/status/… are registered…`

**② 探测本机引擎**：让模型调用 `agents_probe`，期望看到 `claude` / `workbuddy` / `autoclaw` / `openclaw` 的可用性；`mimo` 应为 `available:false` 并带原因（引擎封在 asar 内）。

**③ 真机跑通 WorkBuddy**：

```jsonc
// agents_run
{ "agent": "workbuddy", "prompt": "Reply with exactly: PONG", "cwd": "/tmp" }
// → { sessionId, agent: "workbuddy", status: "running" }
```

随后 `agents_output { sessionId, sinceIndex: 0 }` 轮询，期望看到 `[text] PONG` 且终态 `completed`。
> 已单独实测过该路径可跑：codebuddy 2.137.1、35s/3 turns、复用桌面端凭证、无需登录（`docs/findings-engines.md` §5.1）。

**④ 真机跑通 AutoClaw**：

```jsonc
{ "agent": "autoclaw", "prompt": "Reply with exactly: PONG", "cwd": "/tmp" }
```

期望同上（引擎 OpenClaw 2026.6.8，走 `--profile autoclaw` + 自动生成的 `--session-id`）。
若报「配置无效」，说明用错了 profile —— 正确配置在 `~/.openclaw-autoclaw/openclaw.json`。

**⑤ 取消**：对上面任一 `sessionId` 调 `agents_cancel`，期望 `cancelled: true` 且状态终态化（三段式：SIGTERM → grace → 进程组 SIGKILL）。

## 回退

```bash
rm ~/.dsh/profiles/desktop/package.json
mv ~/.dsh/profiles/desktop/package.json.bak.<时间戳> ~/.dsh/profiles/desktop/package.json
export PATH=/opt/homebrew/bin:$PATH && cd ~/.dsh/profiles/desktop && pnpm install
# 重启 DSH
```

## 已知边界

| 项 | 现状 |
|---|---|
| MiMo（小米） | `unsupported`：agent 循环封在 asar，无 CLI/ACP/daemon 入口 |
| openclaw `gateway` / `connect` 模式 | v1 未实现（抛明确错误，不静默降级） |
| `--mcp-config` | ABI 未暴露；用 `DSH_AGENTS_BRIDGE_MCP_CONFIG=<路径>` 环境变量传 |
| ACP 家族（12+ CLI） | v2：一个 ACP driver 可解锁 kimi/kiro/qoder/trae/grok/qwenpaw 等 |
