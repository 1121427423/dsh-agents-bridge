#!/usr/bin/env node
/**
 * Fake ACP engine for driver tests.
 *
 * Speaks the REAL wire protocol measured from `codebuddy-code --acp`
 * (@tencent-ai/codebuddy-code 2.151.0, 2026-09-17): JSON-RPC 2.0 framed as
 * NDJSON — one compact object per `\n`, NO `Content-Length` header (the LSP
 * framing is a different protocol and would deadlock here). See
 * `ACP-PROVENANCE.md` for which frames are captured verbatim and which are
 * derived.
 *
 * The scenario is picked with `--scenario <name>` (default `success`). Each
 * scenario is an independent turn so a test can exercise exactly one branch.
 *
 * Deliberate behaviours that the driver must survive:
 *
 *  - `session/new` is answered with the engine's `configOptions` and `models`,
 *    exactly as the real engine does, because the driver reads
 *    `thought_level` out of there to resolve `effort`.
 *  - `usage_update` notifications arrive BEFORE the prompt response and a
 *    partial one arrives AFTER it, so the accumulator's order-independence is
 *    actually exercised rather than assumed.
 *  - `deadlock` writes a large burst on stdout and THEN waits for a stdin
 *    write to complete before reading its own remaining output — the classic
 *    bidirectional pipe deadlock. A driver that does not read concurrently
 *    with writing hangs forever here.
 *  - An agent→client request with NO `id` (the real engine sends
 *    `_codebuddy.ai/command` that way) must not be answered, and must not
 *    crash the reader.
 *  - Teardown is NOT uniform across engines, and the difference decides
 *    whether a finished turn is reported as a success. The default scenario
 *    leaves on stdin EOF. `ignores-eof` refuses to (as the MEASURED Qoder CN
 *    engine does) and only leaves when signalled, with 128+SIGTERM — so the
 *    driver has to force the kill, and must not blame the engine for the exit
 *    code that kill produced. `exits-nonzero` is the control: an engine that
 *    leaves on EOF of its OWN accord with a failure code must still be
 *    reported as failed.
 */
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const scenarioAt = argv.indexOf('--scenario')
const scenario = scenarioAt >= 0 ? argv[scenarioAt + 1] : 'success'

const SESSION_ID = 'fake-acp-session-0001'
const PROTOCOL_VERSION = 1

let nextServerId = 100
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const respond = (id, result) => write({ jsonrpc: '2.0', id, result })
const fail = (id, code, message, data) =>
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
const notify = (update) =>
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update } })

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextServerId++
    pending.set(id, { resolve, reject, method })
    write({ jsonrpc: '2.0', id, method, params })
  })

const pending = new Map()

// ── Frame builders (shapes taken from the real capture) ──────────────────────

const INIT_RESULT = {
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    loadSession: true,
    delegateToolsSupport: true,
    mainAgentSupport: false,
    multitaskSupport: true,
  },
  authMethods: [
    { id: 'iOA', name: 'Login with iOA', description: null },
    { id: 'external', name: 'Login with Google/Github', description: null },
  ],
}

/** Trimmed to the two config options the driver reads: `thought_level`, `mode`. */
const CONFIG_OPTIONS = [
  {
    type: 'select',
    id: 'mode',
    name: 'Permission Mode',
    category: 'mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Always Ask', description: 'Prompts for permission' },
      { value: 'bypassPermissions', name: 'Bypass Permissions', description: 'Skips all prompts' },
    ],
  },
  {
    type: 'select',
    id: 'thought_level',
    name: 'Deep Thinking',
    category: 'thought_level',
    currentValue: 'enabled',
    options: [
      { value: 'minimal', name: 'Minimal', description: 'Briefest reasoning' },
      { value: 'low', name: 'Low', description: 'Light reasoning' },
      { value: 'medium', name: 'Medium', description: 'Balanced reasoning' },
      { value: 'high', name: 'High', description: 'Deep reasoning' },
      { value: 'xhigh', name: 'X-High', description: 'Very deep reasoning' },
      { value: 'max', name: 'Max', description: 'Maximum reasoning effort' },
      { value: 'enabled', name: 'On (default)', description: 'Use the model default effort' },
    ],
  },
]

const NEW_RESULT = {
  sessionId: SESSION_ID,
  models: {
    availableModels: [
      { modelId: 'default-model', name: 'Auto', description: 'x0.79 credits' },
      { modelId: 'fast-model', name: 'Fast', description: 'x0.34 credits' },
    ],
  },
  modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Always Ask' }] },
  configOptions: CONFIG_OPTIONS,
}

const textChunk = (text) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
})
const thoughtChunk = (text) => ({
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text },
})
const usageUpdate = (used, size) => ({ sessionUpdate: 'usage_update', used, size })

/** A completed tool call, in the shape the real engine emits. */
const toolCall = (id, title, kind, status, rawInput) => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title,
  kind,
  status,
  ...(rawInput === undefined ? {} : { rawInput }),
  content: [{ type: 'content', content: { type: 'text', text: `${title} output` } }],
})

const toolCallUpdate = (id, status) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status,
})

// ── Scenarios ────────────────────────────────────────────────────────────────

/** Notification bursts shared by every scenario, before the turn proper. */
function handshakeNoise() {
  notify({ sessionUpdate: 'config_option_update', configOptions: CONFIG_OPTIONS })
  notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'background' }] })
}

/** The id-less agent→client request the real engine actually sends. */
function idlessRequest() {
  write({
    jsonrpc: '2.0',
    method: '_codebuddy.ai/command',
    params: { sessionId: SESSION_ID, action: 'workspace_info', params: { isGitWorkspace: false } },
  })
}

async function runSuccess() {
  notify({ sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai/agentPhase': { phase: 'preparing' } } })
  notify(thoughtChunk('let me think about that. '))
  notify(textChunk('The answer is '))
  notify(usageUpdate(120, 176000))
  notify(textChunk('41.'))
  // Partial cumulative report BEFORE the terminal frame...
  notify({
    sessionUpdate: 'usage_update',
    used: 120,
    size: 176000,
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 20 },
  })
  return {
    stopReason: 'end_turn',
    // ...and the terminal frame adds a bucket the notification omitted.
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 20, cachedWriteTokens: 5 },
  }
}

async function runToolCalls() {
  notify(toolCall('call-1', 'Read file', 'read', 'pending', { path: 'README.md' }))
  notify(toolCallUpdate('call-1', 'in_progress'))
  // The engine asks the CLIENT to read a file — served from inside the cwd.
  try {
    const read = await request('fs/read_text_file', { path: 'README.md', sessionId: SESSION_ID })
    notify(toolCallUpdate('call-1', 'completed'))
    notify(textChunk(`Read it: ${JSON.stringify(read).slice(0, 40)}`))
  } catch (err) {
    notify(textChunk(`read failed: ${err.message}`))
  }
  // Then a write, and finally the answer AFTER the last tool call.
  await request('fs/write_text_file', {
    path: 'out/answer.txt',
    content: 'HELLO',
    sessionId: SESSION_ID,
  })
  notify(toolCall('call-2', 'Write file', 'edit', 'pending', { path: 'out/answer.txt', content: 'HELLO' }))
  notify(toolCallUpdate('call-2', 'completed'))
  notify(textChunk('Wrote out/answer.txt.'))
  return { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 40 } }
}

/** A tool call that escapes the cwd — the driver MUST refuse it. */
async function runEscape() {
  let detail = 'no error'
  try {
    await request('fs/read_text_file', { path: '../../../../etc/passwd', sessionId: SESSION_ID })
    detail = 'the driver ALLOWED an out-of-cwd read'
  } catch (err) {
    detail = err.message
  }
  notify(textChunk(`escape attempt: ${detail}`))
  return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
}

async function runTerminal() {
  let detail = 'no result'
  try {
    const created = await request('terminal/create', {
      command: 'echo TERMINAL_OK',
      cwd: '.',
      sessionId: SESSION_ID,
    })
    const terminalId = created.terminalId
    const exit = await request('terminal/wait_for_exit', { terminalId, sessionId: SESSION_ID })
    const out = await request('terminal/output', { terminalId, sessionId: SESSION_ID })
    detail = `exit=${JSON.stringify(exit)} output=${JSON.stringify(out.output)}`
    await request('terminal/release', { terminalId, sessionId: SESSION_ID })
  } catch (err) {
    detail = `error: ${err.message}`
  }
  notify(textChunk(detail))
  return { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 10 } }
}

async function runPermission() {
  const ask = (options) =>
    request('session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'call-perm', title: 'Write file' },
      options,
    })

  const results = []
  // 1. A session-scoped grant is offered and must win over allow_once.
  results.push(await ask([
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
  ]))
  // 2. Only a permanent grant + a single-use reject: the reject must win.
  results.push(await ask([
    { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
  ]))
  // 3. Permanent-only: must be a protocol error, never a fabricated optionId.
  try {
    results.push(await ask([{ optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }]))
  } catch (err) {
    results.push({ error: err.message })
  }
  notify(textChunk(`permissions: ${JSON.stringify(results)}`))
  return { stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 12 } }
}

async function runUpstreamError() {
  // MEASURED shape: the real host answers an unauthenticated prompt with exit
  // code 0 and stopReason "refusal", carrying the 401 only in `_meta`.
  return {
    stopReason: 'refusal',
    userMessageId: 'fake-user-message',
    _meta: {
      'codebuddy.ai/requestId': 'fake-request',
      'codebuddy.ai/errorMessage': JSON.stringify({
        code: -32000,
        message: 'Authentication required',
        data: {
          statusCode: 401,
          details: '401 Authentication required. Please use /login command to sign in to your account',
          code: 401,
          category: 'auth',
        },
      }),
      'codebuddy.ai/outcome': 'FAILED_MODEL_REQUEST',
    },
  }
}

async function runRpcError() {
  // The prompt call itself fails at the JSON-RPC layer.
  return { __rpcError: { code: -32603, message: 'Internal error: model unavailable' } }
}

async function runCancel() {
  notify(textChunk('starting a very long task...'))
  // Wait long enough that the driver's cancel has to land first.
  await new Promise((resolve) => setTimeout(resolve, 15_000))
  return { stopReason: 'cancelled' }
}

/**
 * The turn's FINAL chunk arrives AFTER the `session/prompt` response.
 *
 * multica has a dedicated test for this
 * (`TestHermesBackendDrainsLateFinalNotificationAfterPromptResponse`) because a
 * driver that concludes at the response boundary loses the user-visible answer
 * and reports a truncated transcript as complete.
 */
async function runLateChunk() {
  notify(textChunk('Let me check. '))
  return {
    stopReason: 'end_turn',
    usage: { inputTokens: 50, outputTokens: 8 },
    __lateChunks: ['The answer ', 'is 42.'],
  }
}

async function runDeadlock() {
  // Fill stdout HARD before doing anything that needs a stdin write back. A
  // driver that serializes "write stdin, then read stdout" deadlocks: the
  // engine blocks writing here, the driver blocks writing there, and neither
  // side ever drains. ~1 MB is comfortably past a 64 KiB pipe buffer.
  const filler = 'x'.repeat(4096)
  for (let i = 0; i < 256; i++) {
    notify(textChunk(filler))
  }
  // Only now does the engine need a reply from the client. The driver must
  // have been draining stdout while it wrote, or neither side makes progress.
  let detail = 'no result'
  try {
    await request('fs/write_text_file', { path: 'deadlock.txt', content: 'DRAINED', sessionId: SESSION_ID })
    const read = await request('fs/read_text_file', { path: 'deadlock.txt', sessionId: SESSION_ID })
    detail = `read ok: ${read.content}`
  } catch (err) {
    detail = `read failed: ${err.message}`
  }
  notify(textChunk(detail))
  return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } }
}

/**
 * A terminal whose OUTPUT the engine over-sizes (MI-19).
 *
 * `outputByteLimit` comes straight from the engine and the driver retains the
 * terminal's output in the HOST process, so an engine must not be able to size
 * that buffer: the driver clamps it to `ACP_MAX_OUTPUT_BYTE_LIMIT`. The command
 * prints 2 MB, comfortably past both the default (50 KB) and the cap, and the
 * turn reports how much the driver actually retained.
 *
 * `limit === undefined` omits the field entirely, which must still yield the
 * 50 000-byte default.
 */
async function runTerminalLimit(limit) {
  let detail = 'no result'
  try {
    const created = await request('terminal/create', {
      command: process.execPath,
      args: ['-e', "process.stdout.write('A'.repeat(2_000_000))"],
      cwd: '.',
      ...(limit === undefined ? {} : { outputByteLimit: limit }),
      sessionId: SESSION_ID,
    })
    const terminalId = created.terminalId
    await request('terminal/wait_for_exit', { terminalId, sessionId: SESSION_ID })
    const out = await request('terminal/output', { terminalId, sessionId: SESSION_ID })
    detail = `retained=${out.output.length} truncated=${out.truncated}`
    await request('terminal/release', { terminalId, sessionId: SESSION_ID })
  } catch (err) {
    detail = `error: ${err.message}`
  }
  notify(textChunk(detail))
  return { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 10 } }
}

/**
 * A terminal the engine creates and NEVER releases (IM-15).
 *
 * `terminal/release` is the only path the ENGINE controls, and each terminal is
 * spawned into its own process group, so an engine that "creates and forgets"
 * leaks one live process per terminal unless the DRIVER disposes the client on
 * the way out. The child reports its own pid and then parks forever (a 1s
 * interval, so the event loop never empties) — the caller asserts that pid is
 * gone once the run has settled.
 */
async function runOrphanTerminal() {
  let detail = 'no result'
  try {
    const pid = await createOrphanTerminal()
    detail = pid === null ? 'no pid' : `orphan pid=${pid}`
  } catch (err) {
    detail = `error: ${err.message}`
  }
  notify(textChunk(detail))
  return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
}

/** Create a never-released terminal and return the child's pid (or null). */
async function createOrphanTerminal() {
  const created = await request('terminal/create', {
    command: process.execPath,
    args: ['-e', "console.log(`ORPHAN_PID=${process.pid}`); setInterval(() => {}, 1000)"],
    cwd: '.',
    sessionId: SESSION_ID,
  })
  const terminalId = created.terminalId
  const deadline = Date.now() + 5_000
  let output = ''
  while (Date.now() < deadline) {
    const out = await request('terminal/output', { terminalId, sessionId: SESSION_ID })
    output = typeof out.output === 'string' ? out.output : ''
    if (output.includes('ORPHAN_PID=')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Deliberately NO terminal/release: the engine forgets this one.
  const match = /ORPHAN_PID=(\d+)/.exec(output)
  return match === null ? null : Number(match[1])
}

/**
 * The same leak on the CANCEL exit: the terminal is created and reported, but
 * the prompt never answers, so only `handle.cancel()` reaches the settle path.
 */
async function runOrphanTerminalCancel() {
  const pid = await createOrphanTerminal()
  notify(textChunk(pid === null ? 'no pid' : `orphan pid=${pid}`))
  await new Promise((resolve) => setTimeout(resolve, 60_000))
  return { stopReason: 'cancelled' }
}

/**
 * RR-IM-6 — a terminal created BEFORE the handshake fails.
 *
 * The engine asks the CLIENT for a terminal (the driver spawns it into its own
 * process group), then refuses `session/new`. `runAcp`'s pre-prompt failure path
 * used to skip `dispose()`, so that terminal's group outlived `handle.done`.
 *
 * The command writes its own pid to `orphan.pid` in the run cwd and then `exec`s
 * into a long sleep (same pid, so the pid the test watches IS the pid the driver
 * must kill). The fixture waits for the file BEFORE failing `session/new`, so the
 * pid is observable no matter how fast the driver cleans up.
 */
async function createTerminalBeforeSession() {
  await request('terminal/create', {
    command: 'echo $$ > orphan.pid; exec sleep 300',
    cwd: '.',
    sessionId: SESSION_ID,
  })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && !existsSync('orphan.pid')) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * RR-MI-7 — one stdout line past the 16 MB stream cap, during the handshake.
 *
 * The driver's reader detaches and rejects the pending `initialize`, but this
 * engine never exits and never answers: a driver that only rejects promises is
 * left in `await child.exited` forever. The run must settle on a real terminal
 * path instead. (The caller cancels it after the assertion in the RED case.)
 */
async function runOverflowHandshake() {
  process.stdout.write('x'.repeat(17 * 1024 * 1024))
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  return { stopReason: 'end_turn' }
}

/** The host-side fs cap, as a refusal the engine can actually observe. */
async function runReadLarge() {
  let detail = 'no error'
  try {
    await request('fs/read_text_file', { path: 'big.txt', sessionId: SESSION_ID })
    detail = 'the driver READ an over-cap file'
  } catch (err) {
    detail = err.message
  }
  notify(textChunk(`large read: ${detail}`))
  return { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } }
}

const SCENARIOS = {
  success: runSuccess,
  tools: runToolCalls,
  escape: runEscape,
  'read-large': runReadLarge,
  terminal: runTerminal,
  permission: runPermission,
  'upstream-error': runUpstreamError,
  'rpc-error': runRpcError,
  cancel: runCancel,
  'late-chunk': runLateChunk,
  deadlock: runDeadlock,
  // MI-19: an engine-sized terminal buffer, and the absent-limit control.
  'terminal-limit': () => runTerminalLimit(1e12),
  'terminal-default-limit': () => runTerminalLimit(undefined),
  // IM-15: a terminal the engine creates and never releases.
  'orphan-terminal': runOrphanTerminal,
  'orphan-terminal-cancel': runOrphanTerminalCancel,
  // The turn is a plain success in both; only the TEARDOWN differs (see the
  // bottom of this file). Registered explicitly so the names are discoverable
  // from here rather than only through the `?? runSuccess` fallback.
  'ignores-eof': runSuccess,
  'exits-nonzero': runSuccess,
}

// ── Protocol loop ────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let promptRunning = false
/** RR-IM-6: the in-flight pre-handshake terminal creation, if armed. */
let beforeSession = null

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let frame
  try {
    frame = JSON.parse(trimmed)
  } catch {
    return
  }

  // A response to a request WE sent (fs/*, terminal/*, permission).
  if (frame.method === undefined && frame.id !== undefined) {
    const entry = pending.get(frame.id)
    if (entry === undefined) return
    pending.delete(frame.id)
    if (frame.error !== undefined) {
      const err = new Error(frame.error.message)
      err.code = frame.error.code
      entry.reject(err)
    } else {
      entry.resolve(frame.result)
    }
    return
  }

  switch (frame.method) {
    case 'initialize':
      if (scenario === 'overflow-handshake') {
        // RR-MI-7: a single over-cap line INSTEAD of a response, and then park.
        void runOverflowHandshake()
        return
      }
      respond(frame.id, INIT_RESULT)
      if (scenario === 'orphan-before-session') beforeSession = createTerminalBeforeSession()
      handshakeNoise()
      idlessRequest()
      return
    case 'session/new': {
      if (beforeSession !== null) {
        // RR-IM-6: the terminal exists first; only then does the handshake fail.
        const armed = beforeSession
        beforeSession = null
        void (async () => {
          try {
            await armed
          } catch {
            /* fail the request below either way */
          }
          fail(frame.id, -32000, 'session/new refused by the fixture')
        })()
        return
      }
      respond(frame.id, NEW_RESULT)
      notify({
        sessionUpdate: 'usage_update',
        used: 0,
        size: 176000,
        _meta: { 'codebuddy.ai/usageByCategory': { systemPrompt: 0, conversation: 0 } },
      })
      return
    }
    case 'session/resume':
      respond(frame.id, NEW_RESULT)
      return
    case 'session/set_config_option':
      respond(frame.id, {})
      return
    case 'session/set_model':
      respond(frame.id, {})
      return
    case 'authenticate':
      respond(frame.id, {})
      return
    case 'session/cancel': {
      // A REAL engine answers nothing here; it ends the pending prompt with
      // stopReason "cancelled". Emulating that is the whole point.
      respond(frame.id, {})
      return
    }
    case 'session/prompt': {
      if (promptRunning) {
        fail(frame.id, -32600, 'a prompt is already running')
        return
      }
      promptRunning = true
      const run = SCENARIOS[scenario] ?? runSuccess
      void run().then(
        (result) => {
          promptRunning = false
          if (result !== undefined && result.__rpcError !== undefined) {
            const { code, message } = result.__rpcError
            fail(frame.id, code, message)
            return
          }
          respond(frame.id, result ?? { stopReason: 'end_turn' })
          // Emit any post-response chunks the scenario asked for, on a later
          // tick so they are strictly AFTER the response (a driver that stops
          // reading at the response boundary must lose them).
          const late = result?.__lateChunks
          if (Array.isArray(late)) {
            for (const text of late) setTimeout(() => notify(textChunk(text)), 30)
          }
        },
        (err) => {
          promptRunning = false
          fail(frame.id, -32603, `scenario ${scenario} failed: ${err.message}`)
        },
      )
      return
    }
    default:
      // Anything else (including `session/load` on a scenario that does not
      // implement it) gets a loud protocol error rather than silence.
      if (frame.id !== undefined) fail(frame.id, -32601, `method not found: ${frame.method}`)
      return
  }
})

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * How this engine reacts to the driver's shutdown, per scenario.
 *
 * MEASURED (Qoder CN 1.1.53, over ACP): the engine does NOT leave on stdin
 * EOF — it keeps running, the driver waits out its whole grace window and then
 * signals it, and its own shutdown handler calls `process.exit(143)`
 * (`cleanup.handleShutdownSignal`, `reason="signal_term"`). The exit code is
 * therefore an artefact of the DRIVER's kill, not a verdict on the turn: the
 * turn had already answered `stopReason: "end_turn"` with its text delivered.
 *
 * The default here leaves on EOF, which is the cheap path and keeps every
 * other scenario free of the grace-window delay. Only `ignores-eof` pays for
 * modelling the measured engine.
 */
const IGNORES_EOF = scenario === 'ignores-eof'
/** The control: leaves on EOF, of its own accord, with a failure code. */
const EXITS_NONZERO_ON_EOF = scenario === 'exits-nonzero'

if (IGNORES_EOF) {
  // A live handle, or node would drain the event loop and exit 0 the moment
  // readline closes — the exact opposite of ignoring EOF. Bounded well above
  // the driver's 2 s grace window so a leaked fixture still self-reaps instead
  // of outliving the suite.
  setInterval(() => {}, 60_000)
}

// The engine exits when stdin closes — unless this scenario is one that does not.
rl.on('close', () => {
  if (IGNORES_EOF) return
  process.exit(EXITS_NONZERO_ON_EOF ? 3 : 0)
})

// 128 + SIGTERM, as the measured engine reports when its handler runs.
process.on('SIGTERM', () => process.exit(143))
process.on('SIGINT', () => process.exit(143))
