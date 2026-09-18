# Findings — Qoder CN 桌面版作为 bridge 引擎（`qoder-cn` 身份）

Date: 2026-09-19，本机实测。对象：`/Applications/Qoder CN.app` 0.3.3
（`com.qodercn.app`，Electron/VS Code 系），**应用已登录且正在运行**（PID 6565，
`SingletonLock` 指向本机，loopback `127.0.0.1:62481` 在听）；应用数据目录
`~/Library/Application Support/com.qodercn.app.stable`。

标记约定沿用 `docs/findings-zcode-headless.md`：**[proven]** = 在本机执行/观测；
**[inferred]** = 从包内字符串或最小化的代码读出，未执行验证。测试只允许把
[proven] 当 oracle。

---

## 1. 引擎在哪：不在 PATH，不在 `bin/`，在 app 私有的 node_modules 里 [proven]

```
executable:   /Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs
interpreter:  /opt/homebrew/bin/node          （33 MB 的 ESM bundle，没有 shebang）
protocolArgs: ['--yolo', '--acp']
```

- **PATH 上没有 CLI**：`which qodercli` / `qoderclicn` 都不存在，`/usr/local/bin`、
  `/opt/homebrew/bin`、npm 全局 prefix、`~/.nvm`、`~/.local/bin` 里都没有 qoder 形状的可执行文件。
  `~/.qoder/logs/qodercli_install*.log` 说明这台机器**以前**装过独立 CLI（2026-04），
  现在只剩下日志。
- **`Contents/Resources/bin` 是个陷阱**：里面是 `keytar` / `node-pty` / 麦克风监听等
  **原生 helper**，没有任何 launcher。
- **真身是 Agent SDK 的 worker runtime**：`runtime-info.json`（与入口同目录）逐字写着
  `{"name":"qoder-worker-runtime","version":"1.1.53","profile":"platform",
  "target":"darwin-arm64","build":{"site":"cn","productName":"qoderclicn","buildEnv":"prod"}}`。
  即：这个 bundle 就是**国内版 `qoderclicn`** 本体。
- **`node <path> --version` → `1.1.53`**；`--help` 自称 `Qoder CLI CN`。
- **应用自己就是这样启动它的**，不是我们猜的 —— 应用运行日志
  `~/Library/Application Support/com.qodercn.app.stable/logs/<session>/qodercli/qoder-agent-sdk.log`
  里逐字记着：

  ```
  [WorkerTransport] Using asar-unpacked worker runtime: /Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs
  [WorkerTransport] Starting: …/qoder-worker-runtime.obf.mjs
  [WorkerTransport] Args: --print --output-format stream-json --input-format stream-json --no-session-persistence --permission-mode bypassPermissions --dangerously-skip-permissions --disallowed-tools * --tools Agent,AskUserQuestion,… --settings [redacted]
  ```

  注意差别：应用走的是 **SDK 自己的 stream-json 通道**（`--print --output-format
  stream-json --input-format stream-json`），**不是 ACP**。我们要的 ACP 是同一份二进制的
  另一张脸（§2）。

## 2. ACP 是隐藏面：`--help` 里没有，但解析器认识 [proven]

- `--acp` 与 `--yolo` **都不出现在 `--help`**（隐藏选项）。
- 两者都被**接受**：`node <runtime> --yolo --acp` 正常起来并在 stdin EOF 后干净退出。
- 这不是「未知参数被忽略」：作为负控，`--config-dir` 在 `status` 子命令上真的报
  `error: unknown option '--config-dir'`（退出码 1）。所以 `--yolo` / `--acp` 是解析器
  认识的拼写。
- 与参考实现一致：`multica` 的 `CLI_AND_DAEMON.md:361` 写明
  「launches Qoder and Qoder CN as `qodercli --yolo --acp` and `qoderclicn --yolo --acp`」，
  且 `agent.go:519` 的 argv 表是 `"qoder": "qodercli --acp"`。本桥沿用同一拼写，并把它
  放在 `command.protocolArgs`（driver 不硬编码 wire 开关，ABI v4 的硬要求）。

## 3. 握手实录：initialize 通过，session/new 撞认证墙 [proven]

> **状态更新（2026-09-19 05:00）**：本节记录的是**登录前**的握手，也是入库 fixture 的来源。
> 认证墙**已解除** —— 操作员在本机装了独立 `qodercn` CLI 并用**同一账号**登录后，
> `~/.qoder-cn/.auth/` 出现了真实凭证，`session/new` 通过、完整回合跑通（§3.1）。
> 本节**保留不删**：「无凭证时引擎长什么样」是驱动必须正确处理的一个真实分支，
> 且 `tests/fixtures/qoder-cn-acp-handshake.ndjson` 正是它的逐字来源。

捕获方式：以 `--yolo --acp` 真实 spawn，经 stdio 裸 NDJSON 驱动
`initialize` → `session/new`，原始字节已入库为
`tests/fixtures/qoder-cn-acp-handshake.ndjson`（2 帧），解析测试见
`tests/drivers/qoder-cn-acp.test.ts`。

**`initialize` 结果**（逐字，abridged 仅省略无关的 `_meta` 内部字段）：

```json
{"protocolVersion":1,
 "authMethods":[{"id":"qoderclicn-login","name":"Use qoderclicn login",
   "description":"Use your existing qoderclicn login for this agent. If needed, sign in from qoderclicn first."}],
 "agentInfo":{"name":"qoder-cli-cn","title":"Qoder CLI CN","version":"1.1.53"},
 "agentCapabilities":{"_meta":{"qoder":{"promptQueueing":true}},"loadSession":true,
   "sessionCapabilities":{"additionalDirectories":{},"close":{},"delete":{},"fork":{},"list":{},"resume":{}},
   "promptCapabilities":{"image":true,"embeddedContext":true},
   "mcpCapabilities":{"http":true,"sse":true}}}
```

**`session/new` 结果**：

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required: Authentication is required."}}
```

结论（**登录前**的事实）：**裸启动不继承桌面登录**。应用明明登录着、明明在跑，
被我们 spawn 出来的同一个二进制却是无凭证的。这与 `workbuddy-ai` 那条 401 记录是同一类
边界，不是本桥的接线错误。

### 3.1 登录后：认证墙解除，完整回合跑通 [proven]

操作员动作只有一步（见 `docs/handoff-blockers.md` 记录 11）：在本机装了独立 `qodercn` CLI，
用**同一账号**在浏览器里点完设备流。之后引擎自己的凭证存储立刻变了样：

```
$ ls -la ~/.qoder-cn/.auth/
-rw-------  1 king staff  1280 2026-09-19 04:49 user        ← 登录前不存在
$ node <runtime> status -o json
{"logged_in":true,"auth_source":"local","login_method":"browser",
 "username":"不会呼吸的哈士奇","user_type":"personal_standard"}
```

`session/new` 不再回 `-32000`，而是给出真实 `sessionId`，一个完整回合跑通（逐字见 §8.1）：

```
[status] session 133cf9da-964d-4af3-b455-bba117121d45 ready
[text] OK
result status=completed exit=143 durationMs=46412
```

**本节最重要的教训：认证墙解除后，验收并没有立刻变绿。** 第一跑拿到的仍然是
`status=failed`，而元凶**不是**上游、不是凭据、也不是引擎 —— 是**桥自己的缺陷**：
引擎不理会 stdin EOF，桥等满宽限期后自己把它杀了，又拿自己这一刀造成的退出码去归罪引擎，
把一个已经交付了答案的回合判成失败、并把 `text` 清空。完整根因与修法见 §8.2。

## 4. 桌面登录为什么拿不到 [proven，机制部分 inferred]

- 应用的凭证是**它自己的**：`~/Library/Application Support/com.qodercn.app.stable/auth.v1.dat`
  （二进制、加密），与 CLI 的 `~/.qoder/.auth` 不是一回事。
- 应用给**每个 worker** 注入一份 **jobToken payload**：日志逐字有
  `Auth payload created: type=jobToken, path=/var/folders/…/T/qoder-sdk-auth-XXXXXX/payload.json`，
  环境变量名从包内字符串读出为 **`QODER_SDK_AUTH_PAYLOAD_FILE`** [inferred]；payload 文件
  `mkdir 0700` + `chmod 0600`，用完即删（实测：目录还在，`payload.json` 已被清掉）。
- worker 侧对应分支 [inferred]：`case "jobToken"` → `{storagePolicy:"memoryOnly",
  refreshStrategy:"hostJobToken"}`、`loginWithJobToken()`、`/api/v1/jobToken/refresh`、
  `/api/v1/jobToken/exchange`。也就是说 token 是**按 job 现签、可续期**的，桥没有 mint 它的途径。
- 应用另有一个 loopback 服务（`127.0.0.1:62481`），任何路径都回 `401 Unauthorized`
  [proven]，它不是给桥发 token 的入口。
- 包内另有 `QODER_PAT` / `QODER_ENV_PAT` / `QODER_ACP_PAT_METHOD_ID` 字符串 [inferred]，
  暗示存在 PAT（个人令牌）登录路径；本次用 `QODER_PAT=dummy` 复跑握手，`session/new`
  **仍是** `-32000 Authentication required` [proven 的负结果] —— 未证明可用，故不写进描述符。

### 4.1 凭证解析链：它自己读哪里 —— 决定性实验 [proven]

问题问对了：桥只是 spawn 它，凭证该由它自己读。**它确实自己读 —— 读的是 `~/.qoder-cn/.auth/`，
而那个目录里没有任何凭证文件。** 这不是猜的，是三个实验测出来的：

**实验 C（决定性）** —— 把 `HOME` 指向空目录，看它在哪里建自己的存储：

```
$ HOME=/tmp/qhome node <runtime> status
Version: 1.1.53
Account: Not logged in

$ find /tmp/qhome -maxdepth 4
/tmp/qhome/.qoder-cn/.auth/.credential-transaction
/tmp/qhome/.qoder-cn/.auth/machine_id
/tmp/qhome/.qoder-cn/logs/…
```

即凭证根是 **`$HOME/.qoder-cn/`**，`$HOME/.qoder-cn/.auth/` 是它自己的登录存储。

**实验 A / B（负结果）** —— 两条常见的「指路」环境变量都不改结论：

```
$ QODER_SDK_AUTH_PAYLOAD_FILE=/tmp/missing.json node <runtime> status  → Not logged in
$ QODER_SDK_AUTH_CONFIG_DIR=/tmp/qcfg      node <runtime> status  → Not logged in，且 /tmp/qcfg 为空
$ QODER_CONFIG_DIR=/tmp/qcfg2              node <runtime> status  → Not logged in，且 /tmp/qcfg2 为空
```

**实测本机那两份「凭证根」**：

| 路径 | 内容 | 结论 |
|---|---|---|
| `~/.qoder-cn/.auth/` | `machine_id`(36B) + `dynamic-error-codes.json` + `dynamic-texts.json` + **空的** `.credential-transaction`；mtime 全是 8 月 | **没有凭证文件** —— 这就是 `Not logged in` 的直接原因 |
| `~/.qoder/.auth/` | `id` / `models` / `user`（800B 高熵 blob），mtime **2026-04-14** | 另一套（旧独立 CLI）的遗留，**运行时根本不读它**：实验 C 在假 HOME 下建的是 `.qoder-cn` 而非 `.qoder`；真 HOME 下这份文件在，status 照样 `Not logged in` |

**机器可读的验证**（本次新增）：

```
$ node <runtime> status -o json
{ "logged_in": false, "version": "1.1.53", "allow_byok": 0 }
```

而**应用**同时在自己的数据目录里发布了一个**状态位**（不是凭证）：

```
$ cat ~/.qoder-cn/.qoder-app-status.json
{ "logged_in": true, "name": "不会呼吸的哈士奇", "product": "qodercn", "writer": "main", … }
```

两个 `logged_in` 一真一假，把边界钉死了：**应用登录着 ≠ CLI 登录着**。应用把它的登录留在
自己的加密存储里（§4），CLI 的存储从没被写过。

### 4.2 应用自己的凭证存在哪、能不能取 [proven / 部分需人工确认]

- **加密存储**：`~/Library/Application Support/com.qodercn.app.stable/auth.v1.dat`（403B，
  Chromium `v10` 前缀 = safeStorage 密文）。它的密钥在**钥匙串**里，条目确实存在：
  `svce="Qoder CN App Safe Storage"`, `acct="Qoder CN App Key"`（2026-08-28 创建）。
- **取密钥需要用户点一次授权**：`security find-generic-password -s "Qoder CN App Safe Storage" -w`
  在本机**阻塞 8 秒后被超时杀掉**（GUI 授权弹窗在等点击）[proven 的负结果]。
- **数据库里没有明文 token** [proven]：`main.sqlite` 里两张凭证表
  `byok_model_credentials`（0 行）、`mcp_oauth_credentials`（0 行）都是空的，且字段是
  `encrypted_payload BLOB`；`account_profiles` 只有一行
  `qoder:prod:cn:<sha256>`（账号标识，不是凭证）。
- **payload 是「推」进来的，不是「拉」的**：应用每个 job 现建一个**新的随机目录**
  `$TMPDIR/qoder-sdk-auth-<6位>/payload.json`，把路径经 `QODER_SDK_AUTH_PAYLOAD_FILE` 交给
  worker；目录留下、文件被清掉。日志逐字可查：
  `[WorkerTransport] Auth payload created: type=jobToken, path=…/qoder-sdk-auth-zPHnDE/payload.json`。
  应用侧的实现代码也逐字取到了（`app.asar` 内），确认了权限与生命周期：

  ```js
  async createAuthPayloadFile(e){
    let t = this.buildAuthPayload(e),
        s = await _o(L(Bn(), "qoder-sdk-auth-"));      // mkdtemp(prefix)
    try {
      await Un(s, 448);                                // chmod 0700 (448 = 0o700)
      let r = L(s, "payload.json");
      await Ro(r, JSON.stringify(t), { mode: 384 });   // 0600 (384 = 0o600)
      await Un(r, 384);
      this.diagnostics?.record(`${this.logPrefix} Auth payload created: type=${t.type}, path=${r}`);
      return r;
    } catch(r) { throw await Ln(s, { recursive: true, force: true }).catch(() => {}), r }  // 失败才整目录清掉
  }
  ```

  注意 `catch` 只清**失败**的情况；成功时目录与文件都留着 —— 所以文件是被 **worker 读完自己
  unlink 的**，这正是我们观测到「目录在、`payload.json` 没了」的原因。
  环境变量名在两侧都是同一个常量，双向确认：SDK 侧 `Qn="QODER_SDK_AUTH_PAYLOAD_FILE"`、
  应用侧 `bit="QODER_SDK_AUTH_PAYLOAD_FILE"` [proven]。
- **它接受哪些凭证通道** [inferred，从 runtime 里的环境变量白名单读出]：
  `["QODER_AUTH_STDIN","QODER_WORKSPACE","QODER_CONFIG_DIR","QODER_CLI_VERSION","QODER_CLI_BIN","QODER_EXTERNAL_COMMAND_NAME",…]`
  —— 即除 payload 文件外，还有 **`QODER_AUTH_STDIN`**（走 stdin 递凭证）这条路。
- **`login` 子命令确实存在** [proven]：`--help` 的 Commands 里有
  `login   Sign in to your account`，且 `login --help` 除 `-h` 外**没有任何选项** —— 纯交互式设备流。

## 5. CLI 自己的登录态：曾经为空，登录后有了真实凭证 [proven]

**登录前**：

```
$ node <runtime> status            $ node <runtime> status -o json
Version: 1.1.53                    { "logged_in": false, "version": "1.1.53", "allow_byok": 0 }
Account: Not logged in
```

原因已在 §4.1 定死：**`~/.qoder-cn/.auth/` 里没有凭证文件**（不是「有但过期」）。
`~/.qoder/.auth/user` 那份 2026-04 的加密 blob 属于另一套旧 CLI，运行时**不读它**。
**出路只有一条**：跑一次 `login`（设备流，写 `~/.qoder-cn/.auth/`）—— 需要用户在终端/浏览器
完成一次；这是**唯一**能把「裸启动可用」变成真的办法，也是桥不需要改代码的那条路。

曾经设想过的第二条路（抓应用现签的 jobToken 再经 `QODER_SDK_AUTH_PAYLOAD_FILE` /
`QODER_AUTH_STDIN` 注入）已被 §5.2 的九通道实验否定，不再是候选。

**登录后（2026-09-19 04:49 起，已解决）**：操作员装了独立 `qodercn` CLI 并用同一账号完成
设备流，`~/.qoder-cn/.auth/user`（1280 B）出现，`status -o json` 变为
`{"logged_in":true,"auth_source":"local","login_method":"browser","username":"不会呼吸的哈士奇",
"user_type":"personal_standard"}`。`session/new` 随之通过（§3.1）。

**这条结论值得单独记住**：桥**从头到尾没有为此改一行代码**。它只是 spawn 引擎，
引擎自己去读 `$HOME/.qoder-cn/.auth/` —— 这正是「不绕过」的回报：诊断指向的是
**账号侧的一步人工动作**，而不是一个需要绕过的技术障碍。

登录前，`qoder-cn` 是一个**能启动、会说 ACP、但每一轮都停在 `session/new`** 的身份。
driver 会把这当成**失败的一轮**（JSON-RPC error），绝不会当成「空的成功」—— 与
`workbuddy-ai` 的 401 同一处理口径。

### 5.1 `login` 子命令会打印设备流 URL；但 ACP 的 `authenticate` 不会 [proven]

这两件事必须分开看，它们**不是同一个入口**：

**（a）CLI 子命令 `login`：会打印 URL** —— 这是可用的入口：

```
$ node <runtime> login
Starting browser login...

Please open the following URL in your browser to sign in:

  https://qoder.cn/device/selectAccounts?challenge=<…>&challenge_method=S256&nonce=<…>&machine_id=44433656-…&client_id=e883ade2-…

Waiting for browser authorization...
```

URL 逐字出现在 **stdout**，且 `challenge`/`nonce` 是**每次请求现生成**的（进程被杀后即失效）。
`machine_id` 就是 `~/.qoder-cn/.auth/machine_id` 那个值。

**（b）ACP 的 `authenticate` 请求：URL 不会出现** —— 这是桥现在走的入口，也是它不通的原因：

```
spawn --yolo --acp → initialize（拿到 authMethods:["qoderclicn-login"]）
                   → authenticate {methodId:"qoderclicn-login"}
→ 40s 内 stdout/stderr 一个字都没有；id:2 帧从未回答
```

判别脚本把两路都跑了：`device-flow URL surfaced over ACP stdio: NONE`、
`authenticate response frame: (never answered)`。

结论：driver 有 `DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD`（`src/drivers/acp.ts:224`），设了就会发
`authenticate`，但 qoder 在这一帧上**既不返回、也不吐 URL**，桥没有任何东西可以呈现给人。
所以**这条路不能用**。可用的只有 (a) —— 而且 (a) 是**可以被桥自己驱动的**（见 §5.3）。

### 5.2 注入凭证：九条通道全部无效 [proven 的负结果]

假设「抓到 / 伪造一份凭证注入进去就能过认证」，实测否定。以 ACP 的真实消费者
`session/new` 为判据（**`status` 不消费 payload，不能当探针**），先跑凭证**路径**类变量：

| 变体 | `session/new` 结果 |
|---|---|
| baseline（不设任何 env） | `-32000 Authentication required` |
| `QODER_SDK_AUTH_PAYLOAD_FILE` → 存在的 payload 文件（0600，`{"type":"jobToken",…}`） | **同上，逐字相同** |
| `QODER_SDK_AUTH_PAYLOAD_FILE` → 不存在的路径 | **同上，逐字相同** |
| `QODER_AUTH_DATA_PATH` → 同一 payload 文件 | **同上，逐字相同** |

再把二进制里出现过的**所有 token 形状的环境变量**逐个喂 dummy 值（`/tmp/qoder-token-env-probe.mjs`）：

| 变体 | `session/new` 结果 |
|---|---|
| `QODER_SDK_ACCESS_TOKEN` | `Authentication required` |
| `QODER_ENV_JOB_TOKEN` | 同上 |
| `QODER_AUTH_MANAGED_TOKEN` | 同上 |
| `QODER_DEVICE_TOKEN` | 同上 |
| `QODER_PAT` | 同上 |
| `QODER_ENV_PAT` | 同上 |

**九条通道（2 个路径变量 + 7 个 token 变量）在裸 spawn 下全部是 no-op** —— 既不通过，
也不报「token 无效」这类可区分的错。结论很硬：**认证状态只能来自引擎自己的存储
`~/.qoder-cn/.auth/`，而只有 `login` 会写它**。任何「把凭证喂进去」的捷径都不成立，
包括「抓应用现签的 jobToken 再注入」这条路。

（二进制里确实存在 `auth_access_token_env_var_not_configured` 这个错误类，说明 SDK 有一条
access-token 环境变量通道 —— 但它属于 SDK 被当作**库**调用时（`auth.accessToken`）的路径，
不是 ACP 子进程的路径。本次未在 ACP 下激活它。）

### 5.3 桥可以自己驱动登录（有证据支持的后续）

既然 `login` 子命令把 URL 打到 stdout（§5.1a），桥就**有能力**把「带外登录」做成产品功能：
spawn `node <runtime> login` → 从 stdout 解析出 URL → 作为 `status` 事件抛给上层 → 等进程退出
→ 再走正常握手。这是把 `qoder-cn` 从 unproven 变可用**唯一不需要人预先在终端里操作**的路径。

本次**没有实现**它（超出「接入一个身份」的范围，且会引入一条新的进程生命周期），只把它记录为
有实测依据的后续项。当前交付仍是「身份声明 + 证据分级 + 诚实的失败」。`model` 能力同理：
要翻转它，先完成一次登录，再重捕有凭证的 `session/new`。

### 5.4 bridge 自己的 `authenticate` 通道在这里不通 [proven 的负结果]

driver 有 `DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD`（`src/drivers/acp.ts:224`），设了就会在
`session/new` 之前发 `authenticate {methodId}`。实测：

```
DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD=qoderclicn-login node … scripts/acceptance.ts qoder-cn "…"
→ acp engine advertises auth methods {"authMethods":["qoderclicn-login"]}
→ （此后 95s 无任何输出，进程被杀）
```

即 `authenticate` **不返回**：qoder 的登录是带外设备流（要去别处完成），引擎在等那个结果，
而 ACP 的这一帧既没有带出登录 URL（§5.1b 实测确认），也没有在 stdout/stderr 上打印任何提示，
桥无法把它呈现给人。所以这条路**不能用**，出路是 §5 的第 1 条。

### 5.5 选模型：`session/new` 的 `model` 参数被静默忽略 —— 但引擎**有**一个能用的模型旋钮

> **更正（2026-09-19 05:55）**：本节原来下的结论是「模型可以**读**，但不能**选**」。
> **那句话说错了，而且错得不小。** 错的根源是**只测了 driver 已有的那一根杠杆**，
> 就把「这根杠杆不通」写成了「引擎不能选模型」。同一轮里我已经在测
> `set_config_option` 的**负控**（假 configId / 假 effort 值），却没有去试
> `configId:"model"` —— 而那正是 ACP 标准的模型旋钮，也是 driver 为 **effort**
> 已经在用的同一根。补测之后结论反过来：**引擎能选，桥不能。** 详见 §5.5b。

`--help` 里有两项，但**都需要登录**（登录前实测）：

```
$ node <runtime> --list-models
Not logged in. Run `qoderclicn login` to authenticate.   (exit 1)
```

登录后拿到了成功帧，于是这个问题有了确定答案：**引擎广播模型清单、也报告当前模型，
但 `session/new` 的 `model` 参数被静默忽略**。三次对照（2026-09-19，真实引擎）：

| # | 请求 | 返回的 `models.currentModelId` | 结论 |
|---|---|---|---|
| A | `session/new {cwd, mcpServers:[]}` | `"qfmodel"` | 基线 |
| B | `session/new {…, model:"gmodel"}` | `"qfmodel"` | **没变** → 参数未被采用 |
| C | `session/new {…, model:"NOT-A-REAL-MODEL-xyz"}` | `"qfmodel"`，**无报错** | 假 id 被静默接受 → 参数根本没被读 |

C 是关键的一刀：如果参数真的被消费，一个不存在的 id 应当报错。为排除「这个引擎本来就什么都不校验」，
同一轮里还测了它**确实校验**的那一半：

```
session/set_config_option {configId:"NOT_A_REAL_CONFIG"}                          → -32602 Unknown config option
session/set_config_option {configId:"reasoning_effort", value:"NOT_A_REAL_LEVEL"} → -32602 Invalid value
```

所以沉默是**这个参数专属**的，不是普遍宽松。

**这一段仍然成立**：`session/new` 的 `model` 参数确实被忽略，而它**是 driver 唯一的模型杠杆**。
所以 `model: false` 对**当前代码**是对的。但它证明的只是「桥这条路不通」，
**不是**「引擎没有模型选择」—— 后者在 §5.5b 被实测否掉。

引擎 CLI 自己的 `-m/--model` 是第三条路 —— 应用给 worker 传的就是 `--model qfmodel`，
走的是 SDK 的 stream-json 通道（§1），不是 ACP。

### 5.5b 引擎**有**一个被校验、且真的生效的模型旋钮：`set_config_option {configId:"model"}` [proven]

`session/new` 的 `configOptions` 里除了 `mode` 和 `reasoning_effort`，**还有一条 `model`**
（`category: "model"`，`currentValue: "qfmodel"`，14 个值）。它是标准 ACP 旋钮，driver 为
effort 用的就是同一个调用。四组实测（桌面引擎 1.1.53，`/tmp/qoder-cn-desktop-model-probe.mjs`）：

| 请求 | 结果 |
|---|---|
| `{configId:"model", value:"qmodel"}` | **ACCEPTED**，`config_option_update` 确认 `model.currentValue = "qmodel"` |
| `{configId:"model", value:"auto"}` | **ACCEPTED** |
| `{configId:"model", value:"bogus-model-xyz"}` | **REJECTED** `-32602 Invalid params: Invalid value for config option model: bogus-model-xyz` |
| `{configId:"model", value:"Qwen3.8-Flash"}`（显示名而非 id） | **REJECTED** 同上 |

第三、四行是**负控**，也是这一节比 §5.5 有力的地方：引擎**校验**这个值，只收真实 `modelId`，
而 §5.5 里同一个参数喂假 id 是**静默通过**的 —— 两根杠杆的区别由此一目了然。

**「旋钮动了」还不够，得证明它真的换模型**，否则可能只是个标签。独立证人就在
`session/prompt` 的结果里：`_meta.quota.model_usage[0].model` 是引擎自己的计费口径。
走一个真回合（`/tmp/qoder-model-turn-proof.mjs`）：

```
requested=qmodel   set=ACCEPTED   currentModelId: qfmodel -> "qmodel"
                  billed="qmodel"   stopReason="end_turn"   text="OK"
```

**计费模型跟着变了**，所以这根旋钮是真的。同一脚本对独立 CLI（1.1.56）跑出**完全相同**的结果。

**一个必须记下来的耦合**：`reasoning_effort` 的可选值**随所选模型变化**。
默认 `qfmodel`（Qwen3.8-Flash）给 4 档 `xhigh/low/medium/none`；把模型切成 `qmodel`
（Qwen3.7-Plus）之后，`config_option_update` 里 `reasoning_effort` 只剩 `[{"value":"none"}]`。
所以将来真接上模型旋钮，**顺序必须是先设模型、再读 effort 档位** —— 反过来会拿着上一个模型的
档位表去校验。

**边界**：这一条**没有**改变 `capabilities.model`，它仍是 `false`。理由是 `capabilities` 描述
**桥能不能**，不是**引擎能不能**（§6 开头那段口径）。driver 里没有任何一行会给
`set_config_option` 发 `configId:"model"`，所以今天**没有调用方**能在这条身份上选模型。
要把 `false` 翻成 `true`，得改 driver（加一个与 `extractEffortOption` 对称的 model 版），
那是**另一件工作**，会同时影响 `qoder-cn`、`qoderclicn` 和 `codebuddy-code-acp` 三个身份 ——
本轮的交付范围不含它，记录在此备查。

### 5.6 模型清单：**更正** —— 此前转录的是另一套旧 CLI 的过期缓存 [proven（真实帧）]

> **更正（2026-09-19 05:20）**：本节原先把 `~/.qoder/.auth/models`（2026-04-04 的快照）
> 当作 Qoder CN 的模型清单，据此写下「`Qwen3.8-flash` 不存在」。**那是错的。**
> `~/.qoder/.auth/` 属于**另一套旧 CLI**，本引擎运行时**根本不读它**（§4.1 已用假 HOME
> 实验证明凭证根是 `~/.qoder-cn/`）—— 我拿**一个被弃用存储里的 5 个月前快照**当权威，
> 而没有去问引擎自己。登录后 `session/new` 直接给出权威清单，**`qfmodel` 就是 Qwen3.8-Flash**。
> 下表已按真实帧逐字重写。

登录后 `session/new` 的 `models.availableModels` 逐字（14 项，`modelId` → `name`）：

| modelId | name | 备注 |
|---|---|---|
| `auto` | Auto (default) | 引擎默认档 |
| `qmodel_38max` | Qwen3.8-Max | |
| **`qfmodel`** | **Qwen3.8-Flash** | **引擎当前的 `currentModelId` 默认值** |
| `qmodel_latest` | Qwen3.7-Max | |
| `qmodel` | Qwen3.7-Plus | |
| `q37fmodel` | Qwen3.7-Flash | |
| `dmodel` | DeepSeek-V4-Pro | |
| `dfmodel` | DeepSeek-Flash | |
| `gmodel` | GLM-5.3 | |
| `gfmodel` | GLM-5.3-Flash | |
| `gm51model` | GLM-5.2 | |
| `kmodel_latest` | Kimi-K3 | |
| `kmodel` | Kimi-K2.8-Preview | |
| `mmodel` | MiniMax-M2.7 | |

与此前那张表的差异全部记在这里以便对照：`qmodel` 是 **Qwen3.7-Plus**（不是 3.6-Plus）、
`gmodel` 是 **GLM-5.3**（不是 GLM-5）、`kmodel` 是 **Kimi-K2.8-Preview**（不是 K2.5）；
而 `ultimate` / `performance` / `efficient` / `lite` 这些 Qoder 自有档位**不在**当前清单里，
只剩 `auto`。**缓存会过期，帧不会。**

三点结论：

1. **`Qwen3.8-flash` 确实存在**，标识符是 **`qfmodel`**（显示名 `Qwen3.8-Flash`，0.00x Credit）。
   用户最初问的「能否用 Qwen3.8-flash」——**模型存在，而且是引擎当前的默认模型**。
   选它这条路在**引擎侧是通的**（§5.5b 实测计费模型跟着变），不通的是**桥侧**：
   driver 只会把模型塞进 `session/new` 的 `model` 参数，而那个参数被忽略。
2. **`--list-models` / `-m` 与 ACP 是两条不同的路**：前者在 CLI 通道，后者才是桥走的路。
3. **桥侧管道接错了线**：driver 确实会在 `session/new` 里带上 `model`，引擎忽略它 ——
   但引擎在 `configOptions` 里**另外**广告了一条 `model` 旋钮，走 `set_config_option`，
   被校验、且真的生效（§5.5b）。driver 对 effort 用的是同一个调用，对 model **一行都没写**。
   所以正确的说法不是「这条线在引擎侧不通」，而是**桥把线接到了引擎不读的那个端子上**。

## 6. capabilities 的证据分级（三项 false，一项由 unproven 翻成 true）

规则：只有出现在**捕获到的帧**里的事实才算证据；而「能**读**到」与「能**设置**」是两件事。

**先说清 `capabilities` 是什么**：它是经 `agents_probe` **披露给模型的建议**
（`src/kernel/registry.ts:612` 把 `descriptor.capabilities` 原样放进 `ProbeResult`），
**不拦截 driver** —— driver 只要收到 `effort`/`model` 就会照发（effort 再按运行时广告的档位校验）。
所以翻这一位**不改变任何运行时行为**，改变的是**模型会不会去用那个旋钮**：
说 `true` 而其实不通，等于指使模型去踩一个静默失败；说 `false` 而其实可用，等于白白藏起一个能力。
两边都是错误，所以这一位必须由证据决定。

> **状态更新（2026-09-19 05:20，本表已按新捕获重判）**：认证墙解除后补了一次**有凭证**的捕获
> （`tests/fixtures/qoder-cn-acp-authed-session.ndjson`），`session/new` 返回真实会话，
> 同时带上 `models` 与 `configOptions`。据此：
> **`effort` 从 `false` 翻成 `true`（proven，端到端）**；
> **`model` 仍是 `false`，但含义从 unproven 升级为 disproven**（测过了，参数被忽略，§5.5）；
> `mcpConfig` / `clientTools` 仍 `false`（两份捕获里都没有对应流量）。
>
> **二次更正（2026-09-19 05:55）**：`model` 这一格的值**没变，但理由换了，而且原来的理由是错的**。
> 原文写「**disproven** —— 测过了，这条路不通」「模型可以读但不能选」。补测 §5.5b 之后：
> **引擎能选模型**（`set_config_option {configId:"model"}` 被校验、被 `config_option_update` 确认、
> 且**计费模型真的跟着变**），**是 driver 没有那根杠杆**。所以这一格的含义从「引擎不行」
> 改成「**桥不行**」—— 对 `capabilities` 的语义（它描述桥，不描述引擎，见本节开头）来说，
> `false` 仍然正确，但**不能再说 disproven**：那不是引擎的否定结论，是桥的实现缺口。

| capability | 值 | 依据 |
|---|---|---|
| `resume` | **true** | `initialize` 帧声明 `loadSession: true` + `sessionCapabilities.resume` [proven]；**仍未实际调用**（两次捕获都没走 `session/resume`） |
| `model` | false（**bridge-side 缺口，不是 engine-side 否定**） | 引擎**能读**（`models.currentModelId` = `qfmodel`，14 个模型）也**能选**（§5.5b：`set_config_option {configId:"model"}` 被接受、被 `config_option_update` 确认、假值报 `-32602 Invalid value`、**计费模型跟着变**）。但 **driver 没有这根杠杆**：它只把模型塞进 `session/new` 的 `model` 参数，而那个参数被静默忽略（§5.5）。`capabilities` 描述桥能不能，所以 `false` |
| `effort` | **true**（**proven，端到端**） | 会话广播 `reasoning_effort`（`xhigh`/`low`/`medium`/`none`）；driver 自己的 `extractEffortOption` 能读出它；`session/set_config_option {configId:"reasoning_effort", value:"low"}` 被接受并由 `config_option_update` 通知确认。**全栈真机复核**（`manager.run` + `effort`）：`effort=low` → `completed` 且**零条** effort 警告；负控 `effort=high`（本引擎不提供的档位）→ 恰好 1 条警告，逐字报出 `advertised: "xhigh,low,medium,none"`。**档位表随所选模型变化**（§5.5b 末段），所以将来接上模型旋钮后顺序不能反 |
| `mcpConfig` | false | `mcpCapabilities` 是声明了（http/sse），但 `mcpServers` 两份捕获里都只发过 `[]`，从未配过真 server |
| `clientTools` | false | 没有观测到 `fs/*` / `terminal/*` 回调，driver 默认也不声明 |

**为什么 `effort` 的判定要做全栈复核而不止于协议**：driver 的 effort 路径有三个失败点
（没广告档位 / 档位值不匹配 / 运行时拒绝），**三个都会打警告**（`src/drivers/acp.ts:2114-2143`）。
所以「跑完且没有警告」才是正面证据；`effort=high` 那一组负控就是用来证明这份沉默**不是**
「没走到那条路所以没记日志」。顺带钉死一个容易踩的值：本引擎的档位是 **`xhigh`**，
**没有 `high`** —— 传 `high` 会被静默降级为「不带 effort 跑」。

## 7. desktop track 适配

- 绝对路径 + 必填 interpreter：与 WorkBuddy / ZCode 同构（33 MB ESM、无 shebang）。
- **扫描不会发现它**，这是对的：`ENGINE_CANDIDATES`（`src/tracks/desktop/scan.ts:254`）
  里没有 `app.asar.unpacked/node_modules/@qoder-ai/...` 这条路径，也不该有 —— 那是 app
  私有实现细节且随版本改名（`dist/_worker/qoder-worker-runtime.obf.mjs`）。声明式身份
  比扫描猜测更准，也符合「扫出来的只是候选、不是引擎」的既有契约。
- 凭证状态不是 `not-applicable`，也**不是 `missing`**：**桌面登录没有被委托给裸启动**（§3），
  所以 `src/tracks/health.ts` 给它 `unsourced` → `unknown`。这个 `unknown` 的含义严格是
  **「桥没有 reader」**，不是「凭证不存在」—— 引擎自己读 `~/.qoder-cn/.auth/`，那是一个不透明的
  非 JSON blob，桥不解析、也不该解析。凭证现在**存在且可用**（§3.1），而桥依然诚实地报
  `unknown`：它没有读者，就不会假装读到了什么。
- **探测成本**：版本探针要 spawn 一个 33 MB 的 ESM bundle，冷启动实测 **~1.2 s**
  （`tests/tracks/desktop.test.ts` 里那条宿主机条件测试测的就是它）。这一个身份就让本机
  一次完整 `agents_probe` 慢约 0.5 s（热缓存，1.79 s → 2.29 s），冷缓存更多。这是
  「引擎体积」的真实代价，不是接线问题，改不掉 —— 只有不再 probe 它的版本才能省。

## 8. 复现命令

```bash
R="/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs"
N=/opt/homebrew/bin/node

"$N" "$R" --version          # → 1.1.53
"$N" "$R" --help | head -40  # → "Qoder CLI CN"，且 --acp/--yolo 不在其中；Commands 里有 login

# 登录态（§5）：同一条命令，登录前后两个答案
"$N" "$R" status             # 登录前 → Version: 1.1.53 / Account: Not logged in
                             # 登录后 → Account: 不会呼吸的哈士奇（personal_standard）
"$N" "$R" status -o json     # 登录前 → {"logged_in":false,"version":"1.1.53","allow_byok":0}
                             # 登录后 → {"logged_in":true,"auth_source":"local","login_method":"browser",
                             #            "username":"不会呼吸的哈士奇","user_type":"personal_standard"}

# 凭证解析链（§4.1）—— 决定性实验：它自己的存储在哪、有没有东西
rm -rf /tmp/qhome && mkdir -p /tmp/qhome
HOME=/tmp/qhome "$N" "$R" status
find /tmp/qhome -maxdepth 4          # → 建出 /tmp/qhome/.qoder-cn/.auth/{machine_id,.credential-transaction}

ls -la ~/.qoder-cn/.auth/            # 登录前 → 只有 machine_id + 两个 dynamic-*.json，无凭证文件
                                     # 登录后 → 多出 user（1280 B，不透明非 JSON blob，桥不解析）
cat ~/.qoder-cn/.qoder-app-status.json   # → {"logged_in":true,...}（状态位，不是凭证）

# ACP 握手（initialize 通过，session/new 撞墙）
node /tmp/qoder-cn-capture.mjs tests/fixtures/qoder-cn-acp-handshake.ndjson

# 凭证通道判别（§5.2）：四个变体的 session/new 逐字相同 → 注入无效
node /tmp/qoder-cred-channel-probe.mjs

# ACP authenticate 是否带出登录 URL（§5.1b）：NONE / never answered
node /tmp/qoder-acp-auth-probe.mjs

# 唯一可用的登录入口（§5.1a）：URL 打到 stdout，challenge/nonce 每次现生成
"$N" "$R" login

# 有凭证的捕获（§3.1 / §5.5 / §6）：initialize → session/new → session/prompt
# 入库的 fixture 是它去掉 77 KB 的 available_commands_update 之后的帧
node /tmp/qoder-cn-authed-capture.mjs /tmp/qoder-cn-authed-default.ndjson

# model 参数是否被接受（§5.5）：三组对照（无 / gmodel / 假 id）+ 两条校验负控
node /tmp/qoder-cn-lever-probe.mjs

# effort 全栈复核（§6）：low 应当 completed 且零警告；high 应当恰好一条警告
node --experimental-strip-types /tmp/qoder-cn-effort-e2e.ts

# 证据来源（应用自己的日志）
ls ~/Library/Application\ Support/com.qodercn.app.stable/logs/*/qodercli/qoder-agent-sdk.log
grep -o "Auth payload created: .*" ~/Library/Application\ Support/com.qodercn.app.stable/logs/*/qodercli/qoder-agent-sdk.log | tail -3
curl -sS -i http://127.0.0.1:62481/   # → 401 Unauthorized

# 应用自己的加密存储（会弹钥匙串授权）
security find-generic-password -s "Qoder CN App Safe Storage" -w
```

---

## 8.1 本机验收实录（完整栈，非单元测试）

`scripts/acceptance.ts` 走 registry → manager → driver → 真实子进程。同一个身份、同一条命令，
登录前后各跑一次，两次都留在这里 —— 第一次记录「被墙挡住时长什么样」，第二次记录「通了」。

**（a）登录前：认证墙**（原始输出逐字）

```
$ node --experimental-strip-types scripts/acceptance.ts qoder-cn "Reply with exactly: OK"
probe  qoder-cn: track=desktop available=true
       executable=/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs version=1.1.53 reason=-
run    session=sess_671c9e12-… status=running
       acp engine advertises auth methods {"authMethods":["qoderclicn-login"]}
events (1):
  [status] engine requires authentication; it accepts: qoderclicn-login. Set DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD to one of these to have the bridge authenticate.
result status=failed exit=null durationMs=1337
error: acp session/new failed: session/new: Authentication required: Authentication is required. (code=-32000)
```

要的就是这个形状：**身份可用（available=true、版本对）、接线正确（握手真的发生了），
而失败以引擎自己的话落地为 `failed`**，不是「completed 但没内容」。

**（b）登录后：完整回合跑通**（2026-09-19 05:00，原始输出逐字）

```
$ node --experimental-strip-types scripts/acceptance.ts qoder-cn "Reply with exactly: OK"
probe  qoder-cn: track=desktop available=true
       executable=/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs version=1.1.53 reason=-
run    session=sess_bf11c06e-3c6e-4a25-9cba-30f68c47fc6b status=running
       acp engine advertises auth methods {"authMethods":["qoderclicn-login"]}

events (17):
  [status] engine requires authentication; it accepts: qoderclicn-login. …
  [status] session 133cf9da-964d-4af3-b455-bba117121d45 ready
  [status] running
  [status] available commands update: 268 commands
  [thinking] The user has sent what appears to be a system setup message with context, …
  [text] OK

result status=completed exit=143 durationMs=46412
text: OK
backendSessionId: 133cf9da-964d-4af3-b455-bba117121d45
```

三条值得逐字记下来的：

1. `[status] engine requires authentication; …` **仍然出现**，但那**不代表这一轮会失败**。
   它来自 `initialize` 帧里的 `authMethods` 声明，driver 忠实地把「引擎提供了哪些登录方式」
   报给上层（它不替用户选登录流程）。紧接着 `session/new` 就返回了真实 `sessionId`。
2. `exit=143` **不是失败**。143 = 128 + SIGTERM，是桥在宽限期后自己发的那一刀的产物。
   详见 §8.2 —— 这是本分支唯一一处桥自己的缺陷。
3. `status=completed` 与 `text: OK` **同时**成立，才叫「这一轮真的交付了答案」。
   （对照记录 9：hermes 那种「`completed` 但没有任何模型输出」是本仓库明确要避免的形态。）

---

## 8.2 验收暴露的桥侧缺陷：`exit 143` 曾被误判为失败（已修复）

**这是本分支唯一一处「桥自己的缺陷」，单独记在这里 —— 因为它差一点被误记成上游/凭据问题。**

登录后第一跑，验收**仍然是红的**：

```
result status=failed exit=143 durationMs=43525
text:                                  ← 答案被清空
```

但引擎侧的证据说明这一轮**是成功的**：`stopReason: "end_turn"`、`[text] OK` 已经流出来、
`SessionEnd` hook 已经跑完。三条证据合起来指向桥自己：

| 证据 | 逐字 |
|---|---|
| 引擎自己的日志 | `process.exiting exit_code=143 reason="signal_term" message="SIGTERM received" source="cleanup.handleShutdownSignal"` |
| 桥侧 debug 日志 | `acp: engine ignored stdin EOF; forcing shutdown {"graceMs":2000}` |
| 退出码语义 | 143 = 128 + SIGTERM，即「被信号终止」，不是引擎自己选的码 |

**根因**：`src/drivers/acp.ts` 的收尾逻辑里，`client.shutdown(2000)` 在引擎不理会 stdin EOF 时
超时返回 `false`，桥随即**自己**调 `child.terminate()`（生产 runtime 是
SIGTERM → 宽限 5 s → SIGKILL，见 `src/drivers/argv.ts`）。引擎收到 SIGTERM，由自己的 shutdown
handler 执行 `process.exit(143)`。而状态归类那一段的最后一条分支是：

```ts
} else if ((exit.code ?? 0) !== 0) {      // ← 把「我自己杀的」也算在引擎头上
  status = 'failed'
```

于是**桥拿自己那一刀造成的退出码去归罪引擎**：一个已经交付了答案的回合被判成失败，
并按「失败不报正文」的既有约定把 `text` 清空。

**修法**（复用既有布尔，不新增变量）：

```ts
} else if (exitedCleanly && (exit.code ?? 0) !== 0) {
```

`exitedCleanly` 的语义严格等价于「引擎在 EOF 之后**自己**走的」：它为 `false` 时，桥一定已经
等满宽限期并自己动过手，那个退出码就是桥的产物，不能当判决。守卫刻意**不是**一张退出码白名单
—— 引擎主动以非零码退出时那是它在说真话，必须照样判失败。

**为什么这个 bug 一直没被测出来（这条比 bug 本身更重要）**：测试装置与生产**不一致** ——
`tests/drivers/acp.test.ts` 里的 runtime 用 **SIGKILL**，生产用 **SIGTERM**。被 SIGKILL 的子进程
报 `{code: null, signal: 'SIGKILL'}`，而自己处理了 SIGTERM 的报 `{code: 143, signal: null}`；
driver 只看 **code**，所以**唯一能走进那条分支的形状，恰好是测试装置造不出来的形状**。
修的时候把装置一并修了（runtime 改 SIGTERM，对齐 `argv.ts` 的契约），并补了两个 fixture 场景：

| 场景 | 引擎行为 | 期望 |
|---|---|---|
| `ignores-eof` | 忽略 stdin EOF（照实测的 Qoder CN），被信号后 `exit(143)` | `completed` + `text` 保留 + `exitCode=143` |
| `exits-nonzero` | 自己在 EOF 上以码 3 退出（**负控**） | `failed` + `error` 含 `exit status 3` |

先红后绿：`ignores-eof` 用例在旧实现下报 `expected 'failed' to be 'completed'`（而排在它前面的
`exitCode === 143` 断言**先通过**，证明强制杀死那条路真的走到了，不是空跑），改完后
`tests/drivers/acp.test.ts` **59/59** 通过。

**边界**：这一条**不属于** `docs/handoff-blockers.md` 的口径 —— 那份文件只记「模型 / 凭据 /
上游网络」类故障，且**只记不修**。这一条是桥自己的逻辑缺陷，所以修在代码里，并在这里留档。


---

## 9. 有意留下的两件事

**（一）捕获器只做验证，不做产品能力。** `/tmp/qoder-payload-watch.mjs` 是本次为回答
「注入 jobToken 这条路走不走得通」而写的验证脚本（`fs.watch` 盯 `$TMPDIR` 上新出现的
`qoder-sdk-auth-*` 目录，命中后 1ms 级忙读 `payload.json`，命中即 0600 复制到
`/tmp/qoder-capture/`）。**问题已经有答案了：走不通**（§5.2 九通道全 no-op），所以它连
「值得做成工具」都不成立，不进仓库：

- 那是另一个应用**按 job 现签、用完即删**的私有凭证，不是公开接口；
- 桥没有稳定获取途径（要么竞态偷看，要么依赖应用正在跑），拿它当依赖是错的架构；
- 就算抓到也没用 —— 注入进去 `session/new` 照样 `-32000`（§5.2 实测）；
- 它的 `refreshStrategy` 是 `hostJobToken` —— 续期要回应用那条 host 通道，桥接不上。

**（二）没有注册 CLI-track 的 `qoderclicn` 身份。** 独立 CLI 现在**已经装好且已登录**
（操作员为解开 §3 的认证墙而装，见记录 11），所以这条后续从「设想」变成了「一行就能做」。
它与桌面版是**两个身份**：同一套 ACP wire，但**不同的凭证根**（`~/.qoder-cn/.auth/` 由 CLI 自己
维护，桌面版那套 app 私有加密存储不参与），而且可执行文件不是 app bundle 里那个 33 MB 的 obf
bundle。届时照 CLI catalog 的 `codebuddy-code-acp` 先例加一行即可 —— **本次只做用户要的桌面版**，
不擅自扩大范围。


