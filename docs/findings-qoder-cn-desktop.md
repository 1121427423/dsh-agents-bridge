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

**这一段仍然成立**：`session/new` 的 `model` 参数确实被忽略，而它**曾经是 driver 唯一的模型杠杆**。
所以 `model: false` 对**当时的代码**是对的。但它证明的只是「桥这条路不通」，
**不是**「引擎没有模型选择」—— 后者在 §5.5b 被实测否掉。

> **后续（2026-09-19）**：driver 后来**长了第二根杠杆**，`model` 也随之翻成 `true`。
> 本段描述的「唯一杠杆」已不是现状，见 §11（D42）。留着不改，是因为它是那次误判的现场记录。

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

**这条后续的侦察已经做完了，结果在 §10**（不是设想，是实测）：CLI 说 ACP、能跑完整回合，
能力行与桌面版逐字段相同（包括 `model: false` 是**桥侧**缺口这件事），**退出形状也相同**
（`exit=143`，见 §10.4 的更正）。操作员随后拍板要它，于是**身份已注册**，见 §10.7。

---

## 10. 附：独立 CLI（`qoderclicn`）—— 侦察 + 身份注册 [proven]

§9（二）那条后续。侦察于 2026-09-19 完成，**身份随后由操作员拍板注册**（§10.7）。
侦察本身无副作用（不写仓库、不碰应用状态）；注册只是加一条描述符 + 测试 + fixture。

### 10.1 它在哪：npm 全局包，不在 PATH 上，也不在 `~/.qoder-cn/bin`

`which qoderclicn / qodercn / qoder` 在非登录 shell 里**全部 not found**，npm 全局列表里也没有
`qoder` 字样 —— 因为它装在 **nvm 的全局前缀**下：

```
~/.nvm/versions/node/v22.22.3/lib/node_modules/@qodercn-ai/qoderclicn/package.json
  name @qodercn-ai/qoderclicn   version 1.1.56   bin { qoderclicn, qodercn }
~/.nvm/versions/node/v22.22.3/bin/qoderclicn -> ../lib/node_modules/@qodercn-ai/qoderclicn/bundle/qoderclicn.js
~/.nvm/versions/node/v22.22.3/bin/qodercn    -> ../lib/node_modules/@qodercn-ai/qoderclicn/bundle/qodercn-npm-dispatcher.cjs
```

bundle 目录 67 MB：`qoderclicn.js` 33.6 MB、`qoder-worker-runtime.mjs` 35.0 MB、`builtin/`、
`proto/`、`vendor/` —— 与 app 里那个 `qoder-worker-runtime.obf.mjs` **同族但不是同一个文件**。

**版本差是要记一笔的：CLI 1.1.56，app bundle 里那个是 1.1.53。**

另有一层 **PATH 分发器**，容易误认成引擎本体：`~/.qoder-cn/entry/{qodercn,qoder-cn}`，两个文件
4222 B、**内容逐字节相同**（`diff` 无输出），是 `#!/usr/bin/env bash` 脚本，由安装器写进
`~/.zshrc` / `~/.zprofile` / `~/.zshenv`（`# QODERCN_DISPATCHER_PATH v1` 标记）。它按第一个参数路由：

| 首参 | 去向 |
|---|---|
| 无 | CLI |
| `ide` | IDE（去掉 `ide` 再转发） |
| `chat` / `serve-web` / `tunnel` | IDE |
| 以 `-` 开头 | CLI |
| 其它 | 该路径**存在**则 IDE，否则 CLI |

CLI 的解析顺序是 `type -P qoderclicn` → `~/.local/bin/qoderclicn` → `~/.qoder-cn/bin/qoderclicn/qoderclicn`，
三条在本机都**不存在**（`~/.local/bin` 里没有、`~/.qoder-cn/bin/` 下只有 `qoder-cn-computer-use/`）——
分发器只靠 PATH 里那条 nvm 软链命中，所以**它只在登录 shell 里能用**，这正好落在 CLI 轨道的
`CLI_SEARCH_PATH`（`~/.nvm/versions/node/*/bin` 是第一条）覆盖范围内。

### 10.2 它说 ACP，`--acp` 同样是隐藏选项

`qoderclicn --help` 共 107 行，**没有** `--acp`、也没有 `--yolo`；但 bundle 里 `--acp` 出现 2 次，
且 `acp` 与 `tui` / `headless` / `sdk` 并列出现在一张**运行模式表**里
（`["tui","headless","acp"]`、`getAcpMode()`、`acpMode=!1` 字段）。实测 `--yolo --acp` 两个都收
（§10.4 用例 F），与桌面版同一套 argv 形状。

### 10.3 握手实录（原始帧，`/tmp/qoderclicn-acp-probe.ndjson`）

```
initialize  -> protocolVersion 1
               agentInfo { name "qoder-cli-cn", title "Qoder CLI CN", version "1.1.56" }
               authMethods [ { id "qoderclicn-login",
                               description "Use your existing qoderclicn login for this agent. …" } ]
               agentCapabilities { loadSession: true,
                                   sessionCapabilities { additionalDirectories, close, delete, fork, list, resume },
                                   promptCapabilities { image, embeddedContext },
                                   mcpCapabilities { http, sse } }
session/new -> sessionId + modes + models + configOptions     ← 没有认证墙
```

`session/new` 的三个字段块，逐字：

| 块 | 内容 |
|---|---|
| `modes` | 5 个：`default` / `acceptEdits` / `auto` / `dontAsk` / `yolo`，`currentModeId: "default"` |
| `models` | **14 个** `availableModels`，`currentModelId: "qfmodel"` |
| `configOptions` | `mode`（5 值）、**`model`（14 值）**、`reasoning_effort`（`xhigh/low/medium/none`，current `xhigh`） |

14 个模型与桌面版**完全一致**，`qfmodel` 就是 `Qwen3.8-Flash`（§5.6 的更正在这里得到第二次独立确认）。

完整回合：`session/prompt` → 12 帧 `agent_thought_chunk` + 1 帧 `agent_message_chunk`（文本 `OK`）
→ `{ stopReason: "end_turn", userMessageId, usage, _meta.quota.model_usage[0].model: "qfmodel" }`。
**stdout 干净**，唯一的 stderr 是 `1 warning loading skill configs. Use /skills to see details.`。

### 10.4 模型：`session/new` 的参数不通，但 `set_config_option` 的旋钮**通**

`session/new` 的 `model` 参数是桥唯一能 SET 模型的杠杆（`src/drivers/acp.ts:2091`），
所以问题只有一个：**它动不动 `currentModelId`？** 六组对照：

| 用例 | argv | `session/new` params | `currentModelId` |
|---|---|---|---|
| A | `--acp` | — | `qfmodel` |
| B | `--acp` | `model: "qmodel"` | `qfmodel` ← **没动** |
| C | `--acp` | `model: "bogus-model-xyz"` | `qfmodel` ← 假 id 也被**静默接受** |
| D | `--acp` | `modelId: "qmodel"` | `qfmodel` ← 另一种拼法同样没动 |
| E | `--acp --model qmodel` | — | **`qmodel`** ← CLI 自己的旗标**有效** |
| F | `--yolo --acp` | — | `qfmodel`（`--yolo` 被接受，无报错） |

B/C/D 合起来就是「参数被**忽略**」而不是「参数被拒绝」：真 id 与假 id 给出**完全相同**的结果，
而假 `configId` 在桌面版那边会回 `-32602 "Unknown config option"`（§5.5）—— 同一个引擎族对
「不认识的东西」是会说真话的，这里不说，说明它压根没看这个字段。

**E 是 argv 侧唯一能改模型的入口**，走的是 CLI 自己的旗标，不是 ACP 线。桥的 `--model` 不在
`ACP_BLOCKED_ARGS` 里，所以调用方**能**通过 `extraArgs` 传 —— 那是调用方的事，不是描述符能力。
**ACP 线上还有一根旋钮，见 §10.4b。**

### 10.4b CLI 的 `model` 旋钮也是通的，而且和桌面版一样被校验 [proven]

`session/new` 的 `configOptions` 里那条 `model`（14 值）不是装饰。四组实测
（`/tmp/qoderclicn-configoption-probe.mjs` + `/tmp/qoderclicn-modelvalue-probe.mjs`）：

| 请求 | 结果 |
|---|---|
| `{configId:"model", value:"qmodel"}` | **ACCEPTED**，`config_option_update` 确认 `model.currentValue = "qmodel"` |
| `{configId:"model", value:"auto"}` | **ACCEPTED** |
| `{configId:"model", value:"bogus-model-xyz"}` | **REJECTED** `-32602 Invalid params: Invalid value for config option model: bogus-model-xyz` |
| `{configId:"model", value:"Qwen3.8-Flash"}`（显示名） | **REJECTED** 同上 |
| `{configId:"nope-xyz", value:"qmodel"}`（负控） | **REJECTED** `-32602 Unknown config option: nope-xyz` |

> **一处装置教训**：第一版探针里 `bogus-model-xyz` 那一格报的是
> `-32602 … sessionId: expected string, received undefined` —— 它根本没带上 session id，
> 于是引擎拒的是**形状**，这一格**什么也没证明**。**失败原因不对的负控不是负控**，
> 所以重写了探针（发之前先断言 session id 是真字符串），才有上表。记在这里是因为
> 「负控红了」很容易被当成结论收下，而它红的原因可能完全无关。

真回合验证（`/tmp/qoder-model-turn-proof.mjs`，与桌面版同一脚本）：
`requested=qmodel → set=ACCEPTED → currentModelId: qfmodel -> "qmodel" → billed="qmodel"
→ stopReason="end_turn" → text="OK"`。**计费模型跟着变**。

同样地，`reasoning_effort` 的档位表随模型变：`qfmodel` 4 档，切成 `qmodel` 后只剩 `none`。

**结论：CLI 身份的能力行与桌面版逐字段相同** —— 当时包括 `model: false` 是**桥侧缺口**这件事。

> **后续（2026-09-19）**：这一行**已改**。两个 Qoder 身份的 `model` 都翻成 `true`，
> 因为 driver 补上了 `set_config_option {configId:"model"}` 这根杠杆；下面的代码块与
> `model: false` 那条子弹是**改动前**的记录，见 §11（D42）看现状与理由。

```ts
capabilities: { resume: true, model: false, effort: true, mcpConfig: false, clientTools: false }
```

- `resume: true` — `initialize` 明说 `loadSession` + `sessionCapabilities.resume`。
- `effort: true` — `configOptions` 里 `reasoning_effort` 命中 `EFFORT_OPTION_IDS`，档位
  `xhigh/low/medium/none`（**没有 `high`**，与桌面版同）。
- `model: false`（**已由 §11 / D42 改为 `true`**）— 与桌面版同因同果：**桥侧缺口，不是引擎否定**。`session/new` 的 `model`
  参数被静默忽略（§10.4 的 B/C/D），而引擎自己那条 `set_config_option {configId:"model"}`
  旋钮**是通的**（§10.4b 实测：假值报 `-32602`、真值改计费模型）。driver 当时没有这根杠杆，所以 `false`。
- `mcpConfig: false` — 引擎**广播** `mcpCapabilities { http, sse }`，但从没拿真 server 验过，
  广播 ≠ 被遵守（§6 的口径）。

**更正：我一开始以为「退出路径不同」，那是错的 —— 探针骗了我。**

裸探针里 CLI 看着是「stdin EOF 上自己以码 0 退出」（`exit=0 signal=null`，六组用例一致），
于是我先写下「它根本走不到 §8.2 那条 `exit 143` 分支」。**全栈验收推翻了它**：

```
$ node --experimental-strip-types scripts/acceptance.ts qoderclicn "Reply with exactly: OK"
result status=completed exit=143 durationMs=38532
```

`exit=143` —— 与桌面版**同一个形状**：桥等满宽限期后自己 SIGTERM，引擎的 shutdown handler
`process.exit(143)`。所以这个 CLI 也**不**在 EOF 上可靠退出，`exit 143` 那条分支对**两个**
Qoder 身份都是载荷。

**为什么裸探针会得出相反的结论（这条比结论本身重要）**：我的探针在 `stdin.end()` 之后挂了
一个 3 秒的兜底 `SIGKILL`，而它**同时**在等 `exit` 事件。EOF 之后引擎有时很快就退、有时不退，
谁先到取决于时序 —— 第一次探针里 `exit` 先到（报 `code=0`），捕获脚本那几次 `SIGKILL` 先到
（报 `signal=SIGKILL`）。**同一个进程、同一段代码，三次观测出三种退出形状**，而我拿其中一次的
结果当成了性质。教训与 §5.6 同源：**一次观测不是性质**，而「跑过一遍」尤其不是 —— 验收脚本
跑的是**真桥的完整生命周期**（含宽限期与信号），裸探针跑的是我手写的近似，两者不一致时，
该信的是前者。

（附带的好消息：§8.2 那个修复因此**同时**覆盖了两个 Qoder 身份 —— 没有它，这个身份的首跑
也会被报成 `failed` 并把已经拿到的 `[text] OK` 清空。）

### 10.5 凭证：CLI 自己维护 `~/.qoder-cn/.auth/`，且**没有认证墙**

`authMethods` 只有一条 `qoderclicn-login`，措辞是「**复用你已有的 qoderclicn 登录**」——
是**本地登录复用**，不是设备流。这与桌面版的处境是两回事：桌面版那个 worker 拿不到应用的
登录（应用按 job 现签 token 经 `QODER_SDK_AUTH_PAYLOAD_FILE` 推给它，不落盘，§4/§5.2），
而 CLI 的 `.auth/user`（1280 B，本次 05:16 更新）是它**自己写的**。

`.qoder-cn/` 下的旁证：`logs/runs/` **532 个 run**、`logs/sessions/` 里有以
`-Users-king-BigModel-LLM-tools-dsh-plugins-dsh-agents-bridge` 命名的会话目录、
`settings.json` 的 `model.name = "qfmodel"` 与 `security.auth.selectedType = "qoder-browser"`、
`state.json` 的 `lastLoginMethod = "browser"`。**同一台机器、同一个 home**，IDE 与 CLI 共用
`~/.qoder-cn/`，但**凭证的产生方式不同** —— 这正是它们该是**两个身份**的理由。

### 10.6 复现命令

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
qoderclicn --version                                   # 1.1.56
node /tmp/qoderclicn-acp-probe.mjs /tmp/out.ndjson      # 握手 + 完整回合
node /tmp/qoderclicn-lever-probe.mjs                    # §10.4 六组对照
node /tmp/qoderclicn-configoption-probe.mjs             # §10.4b 旋钮四组
node /tmp/qoderclicn-mode-probe.mjs                     # §10.7 模式三组
node /tmp/qoderclicn-permission-probe.mjs               # §10.7 带内权限
```

这些脚本都在 `/tmp`，**没有进仓库**：它们只承担验证职责，而**结论**已经落进 fixture
（`qoderclicn-acp-handshake.ndjson` + `ACP-PROVENANCE.md` 一行）与描述符注释里。
把探针本身也签进去会让仓库背上一堆一次性脚本。

### 10.7 身份注册（D41）：一处刻意的差异，和它凭什么

**`protocolArgs` 只带 `--acp`，不带桌面版的 `--yolo`。** 这是本轮唯一一处两个 Qoder 身份
不一致的地方，所以它必须是**测出来的**，不是抄的。

`--yolo` 不是装饰：三组实测（`/tmp/qoderclicn-mode-probe.mjs`）——

| argv | `modes.currentModeId` |
|---|---|
| `--acp` | `default` |
| `--yolo --acp` | `yolo` |
| `--permission-mode accept_edits --acp` | `acceptEdits` |

所以把它钉进 `protocolArgs` 等于**把权限绕过写进身份数据** —— 一个比「让这一回合跑完」
大得多的授权，而且它会被每一个用这个身份的人继承，包括不想要它的人。

那**不钉它会不会卡住**？这是唯一要紧的问题，于是拿一个必须动文件的任务实测
（`/tmp/qoderclicn-permission-probe.mjs`，模式 `default`，按 driver 自己的
`selectPermissionOption` 规则应答）：

```
mode = "default"
[permission] offered ["allow_always","allow_once","reject_once"] -> answering allow_once
permission requests: 1  [["proceed_always:allow_always","proceed_once:allow_once","cancel:reject_once"]]
stopReason = "end_turn"
probe.txt exists = true     content = "hi"
final text = "Created `probe.txt` in the working directory containing `hi`."
```

**带内握手是够的**：整轮只发 1 次权限请求，driver 的规则选中了 `allow_once`，回合正常收尾、
文件真的写出。于是 `--yolo` 是**策略选择**而不是**协议数据**，不该进描述符 ——
这正是 `src/drivers/acp.ts:154-157` 早就写下的原则（「模式是 run 的选择，不是桥必须强制的」），
也是 `codebuddy-code-acp` / `hermes` 两行的做法。想要绕过的调用方仍可经 `extraArgs` 传
`--permission-mode bypass_permissions`，它**刻意没有被 block**。

**顺带钉死的两件事**：

1. **能力行与桌面版逐字段相同，但这是巧合而不是复制**：两套捕获各自解析、同一批 driver
   提取器、同一批负控。测试文件里专门断言了两者在**版本**（1.1.56 vs 1.1.53）、**模式**
   （`default` vs `yolo`）、**二进制**、**env 命名空间**、**argv** 上不同 —— 如果有人把它们
   合成一行加个开关，这几条会同时红。
2. **fixture 用的是描述符的精确 argv**：第一次捕获时我用了 `--yolo --acp`，于是
   `currentModeId` 是 `yolo`，与描述符对不上。**一份 argv 与描述符不一致的捕获不是这个身份的
   证据**，所以重新捕获了一次（`--acp`，`currentModeId=default`，5 帧 / 5584 B）。
   `ACP-PROVENANCE.md` 里写明了这一点。

### 10.8 全栈验收（真机，2026-09-19）

```
$ node --experimental-strip-types scripts/acceptance.ts qoderclicn "Reply with exactly: OK"
probe  qoderclicn: track=cli available=true
       executable=/Users/king/.nvm/versions/node/v22.22.3/bin/qoderclicn version=1.1.56 reason=-
run    session=sess_343bc536-f449-427a-9303-a0fe78ad4d08 status=running
       acp engine advertises auth methods {"authMethods":["qoderclicn-login"]}

events (5):
  [status] engine requires authentication; it accepts: qoderclicn-login. …
  [status] session c6e3936d-1095-4b1f-afaa-ce04297c2413 ready
  [status] running
  [status] available commands update: 269 commands
  [text] OK

result status=completed exit=143 durationMs=38532
text: OK
backendSessionId: c6e3936d-1095-4b1f-afaa-ce04297c2413
```

三点要读对：

1. **`status=completed` 且 `text: OK`** —— 这是**真实模型输出**，不是 §D39 那种「干净落地但零模型输出」。
2. **`exit=143`** —— 与桌面版同形（见 §10.4 的更正）。这条对桥是个**正面**结果：说明 §8.2 那个修复
   不是为 Qoder 桌面版打的补丁，而是覆盖了两个身份的真实分支。
3. **`[status] engine requires authentication …` 是噪声，不是故障。** driver 只要看到 `initialize`
   广告了 `authMethods` 就会推这条提示（`src/drivers/acp.ts:2050-2060`），它**不阻塞**：
   这一轮照样跑通。原因见 §10.5 —— 这条 `authMethods` 是「复用你已有的本地登录」，
   而不是「你必须先去登录」。**别把这条状态当失败**（桌面版那边它确实对应认证墙，这里不是）。

## 11. 模型旋钮接进 driver（2026-09-19，D42）

§5.5b 留了一个明确待办：`capabilities.model` 为 `false` 是**桥没有杠杆**，不是引擎不行；
要翻成 `true` 得改 driver。本节记录那次改动，以及**改之前必须先测的那件事**。

### 11.1 先测形状，再写代码：`set_config_option` 的**响应**里有什么

动手前有一个问题必须先回答，因为它**决定代码形状**：设完模型之后，驱动从哪里读
「新的 effort 档位表」？两条可能的路 —— 读响应，或者读紧随其后的 `config_option_update` 通知。
猜是不行的，所以测（`/tmp/qoderclicn-setmodel-probe.mjs`，独立 CLI 1.1.56）：

```
=== session/new ===
  configOptions ids: ["mode","model","reasoning_effort"]
  model:  {"current":"qfmodel","n":14}
  effort: {"current":"xhigh","values":["xhigh","low","medium","none"]}

=== response id=3  (set_config_option {configId:"model", value:"qmodel"}) ===
  error: null
  result keys: ["configOptions"]          ← 响应自己带完整的新档位表
  RESULT CARRIES configOptions: ["mode","model","reasoning_effort"]
    model: {"current":"qmodel","n":14}   effort: {"current":"none","values":["none"]}
    -3ms  NOTIFICATION config_option_update …（同样内容）
    +0ms  id=3                            ← 通知比响应早到 3ms
```

三点：

1. **响应就带**（`result keys: ["configOptions"]`），而且已经是**设完之后**的状态：
   `model.currentValue` 已是 `qmodel`，effort 已缩到 `["none"]`。
2. 通知比响应**早到约 3ms**，内容是同一份 —— 所以读响应**既充分又有序**，不必去拦通知。
   **这条决定了代码形状**：`optionSource = 响应`，不需要给 `AcpClient` 加捕获钩子。
3. 同一探针跑了**桌面引擎 1.1.53**（`/tmp/qodercn-desktop-setmodel-probe.mjs`），结果
   **逐字相同**（响应带 `configOptions`、通知早 11ms、档位同样缩到 `none`）。两个 Qoder
   二进制在这一点上一致 —— 所以这条不是「CLI 的怪癖」，而是这个引擎族的形状。

### 11.2 那条耦合现在是**可执行的实测**，不再是预测

同一探针的 id=4/id=5 把 §5.5b 预测的顺序风险变成了实测（全部在 `qmodel` 已生效之后）：

| 请求 | 结果 |
|---|---|
| `{configId:"reasoning_effort", value:"xhigh"}` | **-32602** `Invalid value for config option reasoning_effort: xhigh` |
| `{configId:"reasoning_effort", value:"none"}` | **ACCEPTED** |
| `{configId:"NOPE_XYZ", value:"qmodel"}`（负控） | **-32602** `Unknown config option: NOPE_XYZ` |

**`xhigh` 在设模型之前是合法值，设完之后同一句话被拒。** 负控排除了「引擎现在什么都不校验」
这种解释。所以「先设模型、再读 effort」不是风格问题，是**正确性**问题：拿握手时的档位表去校验，
会发出一个引擎刚刚停止接受的值。

### 11.3 改动本身（`src/drivers/acp.ts`）

- 抽出 `readSelectOption(result, predicate)`，`extractEffortOption` 与新的 `extractModelOption` 共用。
- **`extractModelOption` 只按 `id` 匹配，绝不按 `category`** —— 因为**本仓库两份 Qoder 捕获里
  `reasoning_effort` 的 `category` 就是 `"model"`**。按 category 匹配会把 effort 拨盘当成模型拨盘，
  然后拿一个模型 id 去喂 `reasoning_effort`，必然 -32602。这是实测约束，不是风格偏好；
  测试里有一条专门的断言把这两个捕获字段钉住。
- 新增步骤 **2b（模型）**，并把步骤 **2c（effort）** 的读取源从 `sessionResult` 换成 `optionSource`：
  初值是握手结果，模型设成功且引擎回了 `configOptions` 时换成**响应**；引擎不回时退回握手副本，
  并**打一条 debug 说明这件事**（不假装重读过）。
- **协议层不变**：`session/new` 的 `model` 参数**保留** —— 它是 ACP 标准字段，遵守它的引擎不需要
  别的。模型拨盘是在此之外**追加**的一根杠杆，不是替换。

### 11.4 一处自证：改动**第一次没生效**，是端到端测试抓出来的

值得记下来，因为它是本项目「负控先红后绿」纪律的又一次兑现，而且**第一次写的测试还不够**。

`optionSource` 一开始**只被赋值、从没被读**：`let optionSource = sessionResult` 与
`optionSource = applied` 都在，但 effort 那行仍是 `extractEffortOption(sessionResult)`。
`tsc` 不报（那是合法赋值），读代码也像对的。

抓到它的是端到端测试，但**第一版断言是空跑的**：

- 断言写成 `dials.filter(d => d.startsWith('thought_level='))` 为空，而 fixture 的拨盘日志
  **只记成功的拨盘**。坏代码把 `xhigh` 发出去、引擎回 -32602、驱动吞掉 —— 日志里**什么都没有**，
  于是「根本没发」和「发了被拒」长得一模一样，测试**在坏代码上照样绿**。
- 修法是改**证据本身**，不是改断言：fixture 改成在**收到** `set_config_option` 时就记一行
  `<configId>=<value> accepted|rejected`，**在校验之前**。
- 改完再回退一次 driver，测试**按线路证据变红**：
  `expected [ 'thought_level=xhigh rejected' ] to deeply equal []`。

**教训**（与 §5.6、§10.4 同源，这是第三次）：**测试绿不等于修复在。** 要证明一个测试是载荷，
必须把修复回退掉看它红不红；而要证明它**红得对**，日志必须记**尝试**，不能只记**成功** ——
否则「被拒绝」会被记成「没发生」。

### 11.5 能力位的改动

| 身份 | `model` | 依据 |
|---|---|---|
| `qoder-cn`（桌面 1.1.53） | `false` → **`true`** | 捕获的 `configOptions` 含 `model`（14 值）；引擎**校验**它并确认；driver 现在会驱动它 |
| `qoderclicn`（CLI 1.1.56） | `false` → **`true`** | 同上，且 §11.1 证明两个二进制的响应形状逐字相同 |
| `codebuddy-code-acp` | `true`（**不变**） | `ACP-PROVENANCE.md` 记录其真实 `session/new` 的 `configOptions[]` 有五条、**含 `model`**；但**本机未登录，拨盘从未被真正拨过** —— 这条仍未验证，notes 里写明 |
| `hermes` | `false`（**不变**） | `session/new` **完全没有 `configOptions`**，所以新杠杆也够不着：没有可寻址的 id。`tests/drivers/hermes-acp.test.ts` 里有一条断言把这件事钉住 |

`codebuddy-code-acp` 那一格值得强调：**我没有动它**。它的 `model: true` 在这次改动**之前**
就存在，依据只是「广告了 `models` 和 `configOptions`」。现在驱动有了真杠杆，这个 `true`
才第一次有了实现支撑 —— 但「这台机器上引擎真的接受某个 model 值」仍然**没测过**（本机没登录），
所以 notes 里把它记成未验证，而不是假装它已经被验证。

### 11.6 复核

**真机全栈验收**（`node --experimental-strip-types scripts/acceptance.ts qoderclicn "Reply with exactly: OK" --model=qmodel`）：

```
probe  qoderclicn: track=cli available=true
       executable=/Users/king/.nvm/versions/node/v22.22.3/bin/qoderclicn version=1.1.56
run    session=sess_170842ee-… status=running
[debug] acp model selector driven {"configId":"model","requested":"qmodel","optionSetEchoed":true}
events (9): … [status] available commands update: 285 commands … [text] OK
result status=completed exit=143 durationMs=38479
backendSessionId: 3a2612e8-4bff-45ff-a25d-29dbe47ed003
```

**`optionSetEchoed:true` 是这条链路的正面证据**：驱动真的拨了引擎自己广告的 `model` 选择器，
且引擎回了新档位表。这就是 §11.4 那条 debug 行存在的理由 —— 成功路径不产生任何帧，
没有它，一次全栈验收只能证明「没崩」，不能证明「拨了」。

**一个必须诚实记录的插曲**：这一轮**第一次跑失败了**，报的是
`acp session/new failed: … -32603 … [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":80,"threshold":50,…"~/.qoder-cn/security-resources/.security-scan-*.previous"}`。
那是**宿主侧的 safe-delete 钩子**拦下了引擎自己的安全扫描清理（80 个文件超过阈值 50），
与模型拨盘无关。**但我没有凭一次观测就下结论** —— 同一条命令紧接着**不带 `--model`** 跑成功
（`status=completed exit=143`，`text: OK`），再**带上 `--model`** 又跑成功（上面这次）。
三次两结果、且失败信息指向引擎自己的目录清理，所以判定为**宿主瞬时状态**，不是本改动的性质。
这正是 §5.6 与 §10.4 的教训第四次生效：**一次观测不是性质。**

- `tsc` src + tests：**0 错误**。
- 受影响测试：`tests/drivers/acp.test.ts`（新增 6 条拨盘端到端）、`qoder-cn-acp`、
  `qoderclicn-acp`、`hermes-acp`、`codebuddy-code`、`tracks/cli`、`tracks/desktop`、
  `kernel/registry`、`integration/argv-shape` —— **204 passed**。
- `verify` 与全量 `vitest run` 的结果见 D42 决策行。

### 11.7 桌面版也重跑了一遍：同一条拨盘链，同一个结果 [proven，2026-09-19 06:59]

§11.6 验的是 CLI（`qoderclicn` 1.1.56）。**桌面版必须单独验**，因为它是另一个二进制、
另一个版本（1.1.53）、且 §8.1 那次「跑通」发生在驱动改动**之前**。同一条命令跑两遍，原始输出：

```
########## A) qoder-cn, no model ##########
events (16): … [status] available commands update: 270 commands … [text] OK
result status=completed exit=143 durationMs=36662
backendSessionId: 8d9bc291-d1df-4259-a214-b7b438455b1c

########## B) qoder-cn, --model=qmodel ##########
probe  qoder-cn: track=desktop available=true  version=1.1.53
[debug] acp model selector driven {"configId":"model","requested":"qmodel","optionSetEchoed":true}
[debug] acp: engine ignored stdin EOF; forcing shutdown {"graceMs":2000}
events (9): … [status] available commands update: 270 commands … [text] OK
result status=completed exit=143 durationMs=31955
backendSessionId: 53716d83-c153-42cf-bc9e-7d6ffef52682
```

四点：

1. **桌面身份在新驱动下依然通**（A 组：`completed` + `text: OK`），所以 §11 的改动没有把它弄坏。
2. **桌面引擎也接受拨盘**（B 组：`optionSetEchoed:true`），与 §11.1 的探针结论一致 ——
   §11.1 测的是响应**形状**，这里测的是**穿过整条栈之后它仍然成立**。
3. `[status] engine requires authentication …` 照旧出现，照旧是**噪声**：`session/new` 紧接着就
   回了真实 `sessionId`。判断依据见 §8.1 第 1 条。
4. **仍然需要一个带外步骤**：`~/.qoder-cn/.auth/user`（1280 B）必须已存在，也就是操作员得先
   `qoderclicn login` 过一次。桥自己**不会**驱动这个登录（§5.3 是那件未做的工作）。
   「桌面版通了」的准确含义是：**凭证就位之后，它通了**。
