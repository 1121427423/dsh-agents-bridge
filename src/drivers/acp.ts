/**
 * dsh-agents-bridge / drivers — the ACP (Agent Client Protocol) dialect.
 *
 * This is the one family here that is a **cross-vendor standard** rather than a
 * vendor dialect: `claude` / `codebuddy` / `codex` / `openclaw` are four ways of
 * reading four CLIs' output, while ACP is one wire protocol spoken by a dozen
 * engines (multica drives hermes / kimi / kiro / qoder / trae / grok / qwenpaw /
 * dim / zeroclaw / mcode / reasonix through it — `docs/multica-reference.md` §4).
 * One driver, twelve identities, and adding one is a descriptor (decision D27).
 *
 * Authoritative spec, ported line by line rather than from memory:
 * `~/BigModel/LLM/tools/multica/server/pkg/agent/` —
 *   `hermes.go`        the JSON-RPC transport, notification handling, permissions
 *   `acp_session.go`   resume-failure classification
 *   `acp_usage.go`     how token usage is recovered from ACP's two metering paths
 *   `acp_effort.go`    reasoning-effort discovery and application
 *   `acp_terminal.go`  the client-side `terminal/*` implementation
 *   `acp_deliverable.go` which text block is the answer
 *
 * ── FIVE THINGS THAT ARE MEASUREMENTS, NOT DOCUMENTATION ───────────────────
 *
 * 1. **Framing is bare NDJSON.** One JSON-RPC object per `\n`-terminated line,
 *    no `Content-Length` header (that is LSP). Confirmed against the real
 *    `codebuddy-code --acp` peer on this host — its own help text says
 *    "communication via stdin/stdout using ndJsonStream" — and against multica's
 *    `newAgentStreamScanner`. The same reader (`readLines`) the other dialects
 *    use is therefore the correct one, and writing an LSP-style length-prefixed
 *    reader would hang on this peer.
 *
 * 2. **The agent sends requests with NO `id`.** A live capture from
 *    `codebuddy-code --acp` contains
 *      {"jsonrpc":"2.0","method":"_codebuddy.ai/command",
 *       "params":{"sessionId":"…","action":"workspace_info",…}}
 *    — a request by shape, but JSON-RPC forbids id-less requests and the peer
 *    never waits for an answer. So the dispatch rule is "reply only when `id` is
 *    present; otherwise treat it as a notification". Replying to an id-less frame
 *    would emit `"id":null` and corrupt the peer's own response table.
 *
 * 3. **`stopReason:"refusal"` is a FAILURE, not a model refusing the prompt.**
 *    The same capture, on a host with no login, ends the turn with exit code 0,
 *    an empty stderr, and
 *      result: {"stopReason":"refusal","userMessageId":"…","_meta":{
 *        "codebuddy.ai/errorMessage":"{\"code\":-32000,\"message\":\"Authentication
 *          required\",…\"code\":401,\"category\":\"auth\"}",
 *        "codebuddy.ai/outcome":"FAILED_MODEL_REQUEST"}}
 *    Reading `refusal` at face value — the tempting choice, since ACP's schema
 *    describes refusal as a legitimate outcome — reports a dead credential as a
 *    successful turn in which the model declined. The engine's own words live in
 *    `_meta`, so they are dug out and surfaced (see `acpFailureDetail`).
 *
 * 4. **One binary, two protocols, and the flag that picks between them is
 *    identity data.** `codebuddy-code --acp` speaks ACP; bare `codebuddy-code`
 *    speaks the codebuddy stream-json dialect (D23). The `--acp` token therefore
 *    travels in `AgentDescriptor.protocolArgs`, not in this file — a driver that
 *    hard-coded it would be an ACP driver that can only ever drive one vendor.
 *
 * 5. **`session/update` is a fragmented stream, and the shapes vary.** The
 *    update discriminant arrives as `sessionUpdate` (ACP v1), as a raw `type`, or
 *    as an externally-tagged wrapper `{"agentMessageChunk":{…}}` depending on the
 *    runtime; multica's `normalizeACPUpdate` handles all three and so does
 *    `normalizeUpdate` here.
 *
 * ── THE SAFETY RED LINE (client-side capabilities) ─────────────────────────
 *
 * ACP inverts the usual direction of trust: the engine calls BACK into the
 * client to serve `fs/read_text_file`, `fs/write_text_file` and
 * `terminal/create|output|wait_for_exit|kill|release`. Serving those means a
 * driven agent can read this machine's files, write them, and start processes.
 * The policy here is deliberately the narrowest that is still useful:
 *
 *   - **Everything is confined to `opts.cwd`.** A path is resolved against the
 *     run's cwd, then `realpath`-checked against the cwd's own realpath, so a
 *     symlink pointing out of the tree cannot be used as a tunnel. Paths that
 *     escape are refused with a JSON-RPC error naming the path and the root.
 *   - **Off unless explicitly switched on.** `DSH_AGENTS_BRIDGE_ACP_FS` and
 *     `DSH_AGENTS_BRIDGE_ACP_TERMINAL` enable the two capability groups, and
 *     `initialize` advertises exactly the groups that are on. Advertising a
 *     capability and then refusing every call is worse than not advertising it:
 *     the engine has already made its plan around the answer.
 *   - **Capabilities stay bounded and non-delegable.** Text-file reads and
 *     writes are capped at 1 MiB and regular-file-symlink checked, and terminal
 *     creation filters credential-shaped environment values plus an optional
 *     `DSH_AGENTS_BRIDGE_ACP_TERMINAL_COMMANDS` allow-list. An argv-less shell
 *     line is refused under the allow-list unless the entire line is named.
 *   - **Permissions never auto-grant more than one action.** See
 *     `selectPermissionOption` — `allow_always` is never selected, because ACP
 *     v1 defines it as "remember this choice", which on some runtimes persists
 *     to the runtime owner's on-disk allowlist and outlives the task.
 *
 * ── CONCURRENCY (the `claude_deadlock_test.go` trap, which ACP has too) ────
 *
 * The reader is attached BEFORE the first write and never blocks on a write;
 * requests are correlated through a pending-RPC map that the reader resolves.
 * A peer that fills its stdout pipe while we are mid-`stdin.write` therefore
 * still gets drained. The other direction matters just as much and is the one
 * that is easy to miss: client-side capability responses are written FROM the
 * reader callback, so they go through the same serialised writer rather than
 * being awaited inline on the read path (a `terminal/wait_for_exit` that blocked
 * the reader would stall the very `terminal/output` polls it is waiting on —
 * multica handles that case by answering on a goroutine, `hermes.go:1113`).
 *
 * @module dsh-agents-bridge/drivers/acp
 */

import fs from 'node:fs'
import path from 'node:path'

import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentRunOptions,
  AgentSessionHandle,
  AgentUsage,
  BridgeLogger,
  DriverDeps,
} from '../kernel/types.ts'
import { isSensitiveKey, looksLikeSecret } from '../kernel/logger.ts'

import {
  DriverSession,
  asRecord,
  asString,
  buildCommandLine,
  clampTimerDelay,
  errorText,
  event,
  filterCustomArgs,
  filterLaunchPrefix,
  readLines,
  resolveRuntime,
  tryParseJson,
  type BlockedArgs,
  type DriverRuntime,
  type ProcessExit,
  type SpawnFn,
  type SpawnedProcess,
} from './argv.ts'

// ── Launch contract ─────────────────────────────────────────────────────────

/**
 * Flags the driver owns. Everything here is either the protocol itself or the
 * client-capability advertisement the driver has to keep consistent with what it
 * actually implements:
 *
 *  - `--acp` is the protocol. Blocking it is belt-and-braces: the descriptor
 *    already supplies it through `protocolArgs`, and if a caller could delete or
 *    duplicate it the run would silently become a stream-json conversation that
 *    this driver cannot read.
 *  - `--acp-transport` selects stdio vs streamable-http. This driver is a stdio
 *    implementation, so the value is the run's, not a caller's.
 *
 * `--permission-mode` is deliberately NOT blocked: unlike the stream-json
 * dialects, ACP has a real in-band permission handshake
 * (`session/request_permission`), so the engine's mode is a legitimate choice
 * rather than something the bridge must force.
 */
export const ACP_BLOCKED_ARGS: BlockedArgs = {
  '--acp': 'standalone',
  '--acp-transport': 'withValue',
}

/** Idle-watchdog default, matching the other 300s families. */
export const DEFAULT_ACP_IDLE_TIMEOUT_MS = 300_000

/** `initialize` protocol version. ACP v1 is the only one multica speaks. */
export const ACP_PROTOCOL_VERSION = 1

/** Bound on the stderr tail kept for diagnosis. */
const STDERR_TAIL_BYTES = 8 * 1024

/** Bound on a single terminal's retained output (multica `defaultACPOutputByteLimit`). */
export const ACP_DEFAULT_OUTPUT_BYTE_LIMIT = 50_000

/**
 * Hard cap on a single terminal's retained output, whatever the ENGINE asks for
 * (MI-19).
 *
 * `terminal/create.outputByteLimit` arrives on the wire and the retained buffer
 * lives in the HOST process, so adopting it verbatim lets the engine size host
 * memory (1e12 is a legal value on the wire). The default stays 50 KB — this is
 * only the ceiling for a caller that asks for more, and it is deliberately far
 * below anything that could pressure the host.
 */
export const ACP_MAX_OUTPUT_BYTE_LIMIT = 1024 * 1024

/**
 * Hard host cap for one client-served text file, read OR write payload.
 *
 * The engine chooses the path and content length while the HOST process pays
 * the I/O and JSON memory cost. Bounded reads also refuse FIFOs and every
 * other non-regular file: those are legal paths under a workspace but reading
 * them can block the request forever.
 */
export const ACP_MAX_TEXT_FILE_BYTES = 1024 * 1024

/**
 * How long to keep draining notifications after `session/prompt` answers.
 *
 * ACP peers legitimately emit the turn's final `agent_message_chunk` AFTER the
 * prompt response — multica has a dedicated test for it
 * (`TestHermesBackendDrainsLateFinalNotificationAfterPromptResponse`) because
 * concluding at the response boundary loses the user-visible answer. The quiet
 * window is short (a quarter second) and a hard bound caps it, so a peer that
 * simply holds stdout open costs a bounded delay, never a hang.
 */
export const ACP_NOTIFICATION_QUIET_MS = 250
export const ACP_NOTIFICATION_DRAIN_MAX_MS = 2_000

/**
 * Grace period after closing the engine's stdin, while it observes EOF and
 * exits. An ACP engine is a persistent server, so it will NOT exit on its own
 * once a turn ends; without an EOF it runs forever and the run never settles.
 * multica uses the same shape (`hermesReaderDrainGrace`): ask politely, then
 * force. Long enough for a normal teardown, short enough that a peer ignoring
 * EOF costs a bounded delay.
 */
export const ACP_SHUTDOWN_GRACE_MS = 2_000

/** Where the client-side capability switches live (see the module header). */
export const ACP_FS_ENV = 'DSH_AGENTS_BRIDGE_ACP_FS'
export const ACP_TERMINAL_ENV = 'DSH_AGENTS_BRIDGE_ACP_TERMINAL'
export const ACP_AUTH_METHOD_ENV = 'DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD'
/**
 * Optional comma-separated terminal executable allow-list, checked only after
 * {@link ACP_TERMINAL_ENV} opts terminal service in. Bare names match a bare
 * command's basename; path entries match the exact executable path. Unset keeps
 * the historical "terminal capability means this deployment trusts it to run
 * processes" policy.
 */
export const ACP_TERMINAL_COMMANDS_ENV = 'DSH_AGENTS_BRIDGE_ACP_TERMINAL_COMMANDS'

/** ACP `stopReason` values that mean the turn did NOT produce an answer. */
export const ACP_FAILURE_STOP_REASONS: ReadonlySet<string> = new Set([
  'refusal',
  'max_tokens',
  'max_turn_requests',
])

// ── Capability switches ─────────────────────────────────────────────────────

function envFlag(env: Readonly<Record<string, string>>, key: string): boolean {
  const raw = env[key]
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** Client-side capability state for one run, derived from `DriverDeps.env`. */
export interface AcpClientCapabilities {
  readonly fs: boolean
  readonly terminal: boolean
  /** Optional terminal executable allow-list; empty = the terminal switch is the whole policy. */
  readonly terminalCommands: readonly string[]
}

export function acpClientCapabilities(
  env: Readonly<Record<string, string>>,
): AcpClientCapabilities {
  const terminalCommands = (env[ACP_TERMINAL_COMMANDS_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return {
    fs: envFlag(env, ACP_FS_ENV),
    terminal: envFlag(env, ACP_TERMINAL_ENV),
    terminalCommands,
  }
}

/** The `_meta`/`env`-selected auth method, if the caller pinned one. */
export function acpAuthMethodFromEnv(
  env: Readonly<Record<string, string>>,
): string | undefined {
  const raw = env[ACP_AUTH_METHOD_ENV]
  if (raw === undefined || raw.trim() === '') return undefined
  return raw.trim()
}

/**
 * Whether `terminal/create` with THIS request shape is inside an optional
 * command allow-list.
 *
 * The argv-less form is a shell line, and a basename check cannot say which
 * executables that shell will go on to run. When an allow-list is configured it
 * is therefore refused rather than given a false label; argv form keeps the
 * executable inspectable.
 */
export function isAcpTerminalCommandAllowed(
  command: string,
  args: readonly string[],
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return true
  if (allowlist.includes(command)) return true
  if (args.length === 0) return false
  const base = path.basename(command)
  return command === base && allowlist.includes(base)
}

/**
 * Build a terminal child environment without copying host credentials.
 *
 * ACP terminals spawn through the client under this driver's own merged env,
 * which routinely contains provider tokens. The engine already runs as the user,
 * so this is not a privilege boundary — but it means the capability cannot
 * accidentally broaden secret visibility for every process it launches.
 */
export function acpTerminalEnvironment(
  base: Readonly<Record<string, string>>,
  extra: unknown,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (isSensitiveKey(name) || looksLikeSecret(value)) continue
    env[name] = value
  }
  if (Array.isArray(extra)) {
    for (const item of extra) {
      const record = asRecord(item)
      const name = record === undefined ? undefined : asString(record['name'])
      const value = record === undefined ? undefined : asString(record['value'])
      if (name === undefined || name === '' || value === undefined) continue
      if (isSensitiveKey(name) || looksLikeSecret(value)) continue
      env[name] = value
    }
  }
  return env
}

// ── Path confinement (the safety red line) ──────────────────────────────────

/** A refusal to serve a client-side capability, worded for a diagnosis. */
export class AcpPathRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpPathRefusedError'
  }
}

/**
 * Resolve `requested` against `root` and prove it stays inside `root`.
 *
 * `realpath` is applied to the DEEPEST EXISTING ancestor rather than to the
 * final component, and that detail is the whole reason this is not a one-line
 * `startsWith` check: a `fs/write_text_file` for a file that does not exist yet
 * cannot be `realpath`ed, while `/tmp/link -> /etc` — which does exist — would
 * make a lexical check pass and the write land in `/etc`. Resolving the ancestor
 * catches the symlink at the point where it is still a directory.
 *
 * Returns the absolute path to use. Throws `AcpPathRefusedError` with the
 * offending path and the allowed root, because a bare "denied" is not
 * diagnosable from the engine's side.
 */
export function confineToRoot(root: string | undefined, requested: string): string {
  if (root === undefined || root === '') {
    throw new AcpPathRefusedError(
      `refusing ${JSON.stringify(requested)}: this run has no working directory, ` +
        'so no path can be proven to be inside it',
    )
  }
  const absRoot = path.resolve(root)
  const target = path.resolve(absRoot, requested)

  const realRoot = realpathOfDeepestAncestor(absRoot)
  const realTarget = realpathOfDeepestAncestor(target)
  const inside =
    realTarget === realRoot ||
    realTarget.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)
  if (!inside) {
    throw new AcpPathRefusedError(
      `refusing ${JSON.stringify(requested)}: resolves to ${realTarget}, ` +
        `outside this run's working directory ${realRoot}`,
    )
  }
  return target
}

/**
 * `realpath` the deepest existing ancestor of `p` and re-append the missing
 * tail. Existing behaviour when nothing exists is to return `path.resolve(p)`.
 */
function realpathOfDeepestAncestor(p: string): string {
  let current = p
  const missing: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(current)
      return missing.length === 0 ? real : path.join(real, ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(p)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Refuse a path that is not a regular file. FIFOs are the case that matters:
 * opening one for a read can wait for a writer the engine never supplies.
 */
function requireRegularFile(fd: number, operation: string, absolute: string): fs.Stats {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile()) {
    throw new AcpPathRefusedError(
      `refusing ${operation} ${JSON.stringify(absolute)}: it is not a regular file (FIFO/socket/device paths are not served)`,
    )
  }
  return stat
}

/**
 * Bounded `fs/read_text_file`: regular file only, at most `maxBytes` read.
 *
 * `O_NONBLOCK` because opening a FIFO waits for a writer the engine never
 * supplies; `requireRegularFile` then refuses it.
 *
 * NO `O_NOFOLLOW` here, unlike the write path, and that asymmetry is deliberate:
 * a read through a symlink INSIDE the run's root is legitimate and common
 * (`node_modules/.bin/*`, a symlinked config), so refusing it would break real
 * engines. `confineToRoot` has already resolved the final component, so what is
 * left is only a race against someone swapping the file for a link — and a racer
 * inside the run's own directory gains nothing, since the engine runs as the
 * same user with its own shell. On the WRITE side the direction is the dangerous
 * one (a link turned into an arbitrary overwrite), which is why it does refuse.
 */
function readBoundedUtf8File(absolute: string, maxBytes: number): string {
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  try {
    const stat = requireRegularFile(fd, 'fs/read_text_file', absolute)
    if (stat.size > maxBytes) {
      throw new AcpPathRefusedError(
        `refusing fs/read_text_file ${JSON.stringify(absolute)}: ${stat.size} bytes exceeds the ${maxBytes}-byte host cap`,
      )
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const remaining = maxBytes + 1 - total
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining))
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      total += read
      if (total > maxBytes) {
        throw new AcpPathRefusedError(
          `refusing fs/read_text_file ${JSON.stringify(absolute)}: content grew past the ${maxBytes}-byte host cap while being read`,
        )
      }
      chunks.push(buffer.subarray(0, read))
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** Bounded `fs/write_text_file`; `O_NOFOLLOW` closes a final-component symlink race. */
function writeBoundedUtf8File(absolute: string, content: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    throw new AcpPathRefusedError(
      `refusing fs/write_text_file ${JSON.stringify(absolute)}: ${bytes} bytes of content exceeds the ${maxBytes}-byte host cap`,
    )
  }
  const fd = fs.openSync(
    absolute,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o666,
  )
  try {
    requireRegularFile(fd, 'fs/write_text_file', absolute)
    fs.writeFileSync(fd, content, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// ── Usage (ported from multica `acp_usage.go`) ──────────────────────────────

/**
 * Field-presence flags. A zero alone cannot say whether a runtime reported zero
 * or omitted the bucket, and the two metering paths below are frequently
 * partial.
 */
const USAGE_INPUT = 1
const USAGE_OUTPUT = 2
const USAGE_CACHE_READ = 4
const USAGE_CACHE_WRITE = 8

interface UsageSnapshot {
  input: number
  rawInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  rawReasoning: number
  total: number
  hasTotal: boolean
  fields: number
  /** True once `input` was re-bucketed to exclude cached reads. */
  inputNormalized: boolean
}

function emptySnapshot(): UsageSnapshot {
  return {
    input: 0,
    rawInput: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    rawReasoning: 0,
    total: 0,
    hasTotal: false,
    fields: 0,
    inputNormalized: false,
  }
}

/**
 * Reconciler for the two metering paths every ACP runtime shares: cumulative
 * `usage_update` notifications and the terminal `session/prompt` result.
 *
 * Per-bucket maxima deduplicate equivalent snapshots while retaining buckets
 * omitted from one path. Input is special: the self-describing NORMALIZED
 * candidate (its `totalTokens` proves cache-inclusive input, so it was
 * re-bucketed) and the AMBIGUOUS candidate (nothing proved it) are not
 * comparable, so they are held in separate slots and resolved from the whole
 * observed set by `resolveInput`. That is what makes the answer independent of
 * whether a late `usage_update` lands before or after the terminal prompt
 * response.
 *
 * Ported from multica `acp_usage.go` (`acpUsageAccumulator`); the cost bucket
 * is dropped because the frozen `AgentUsage` ABI has no slot for it.
 */
interface UsageAccumulatorSlots {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  fields: number
  ambiguousInput: number
  hasAmbiguousInput: boolean
  normalizedInput: number
  normalizedTotal: number
  hasNormalized: boolean
}

function emptyAccumulator(): UsageAccumulatorSlots {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    fields: 0,
    ambiguousInput: 0,
    hasAmbiguousInput: false,
    normalizedInput: 0,
    normalizedTotal: 0,
    hasNormalized: false,
  }
}

/** Per-bucket maxima; input goes to its own slot and is resolved afterwards. */
function mergeInto(acc: UsageAccumulatorSlots, next: UsageSnapshot): void {
  if (hasField(next, USAGE_INPUT)) {
    if (next.inputNormalized) {
      if (
        !acc.hasNormalized ||
        next.total > acc.normalizedTotal ||
        (next.total === acc.normalizedTotal && next.input > acc.normalizedInput)
      ) {
        acc.normalizedInput = next.input
        acc.normalizedTotal = next.total
        acc.hasNormalized = true
      }
    } else if (!acc.hasAmbiguousInput || next.input > acc.ambiguousInput) {
      acc.ambiguousInput = next.input
      acc.hasAmbiguousInput = true
    }
  }
  if (hasField(next, USAGE_OUTPUT) && (!hasAccField(acc, USAGE_OUTPUT) || next.output > acc.output)) {
    acc.output = next.output
  }
  if (
    hasField(next, USAGE_CACHE_READ) &&
    (!hasAccField(acc, USAGE_CACHE_READ) || next.cacheRead > acc.cacheRead)
  ) {
    acc.cacheRead = next.cacheRead
  }
  if (
    hasField(next, USAGE_CACHE_WRITE) &&
    (!hasAccField(acc, USAGE_CACHE_WRITE) || next.cacheWrite > acc.cacheWrite)
  ) {
    acc.cacheWrite = next.cacheWrite
  }

  acc.fields |= next.fields
  resolveInput(acc)
}

function hasAccField(a: UsageAccumulatorSlots, field: number): boolean {
  return (a.fields & field) !== 0
}

function resolveInput(a: UsageAccumulatorSlots): void {
  if (!a.hasAmbiguousInput && a.hasNormalized) {
    a.input = a.normalizedInput
  } else if (a.hasAmbiguousInput && !a.hasNormalized) {
    a.input = a.ambiguousInput
  } else if (a.hasAmbiguousInput && a.hasNormalized) {
    // input + output is a conservative cumulative floor even when the
    // ambiguous input contains cached reads. A normalized record below that
    // floor is a per-call delta and must not replace the larger cumulative
    // stream.
    a.input = a.normalizedTotal >= a.ambiguousInput + a.output ? a.normalizedInput : a.ambiguousInput
  }
}

function hasField(s: UsageSnapshot, field: number): boolean {
  return (s.fields & field) !== 0
}

/** Numbers may arrive as JSON numbers or as numeric strings (multica `acpUsageInt64`). */
function usageNumber(
  fields: Record<string, unknown>,
  names: readonly string[],
): number | undefined {
  for (const name of names) {
    const raw = fields[name]
    if (raw === undefined || raw === null) continue
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.trunc(raw)
    if (typeof raw === 'string') {
      const parsed = Number(raw.trim())
      if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed)
    }
  }
  return undefined
}

/**
 * Parse one ACP usage object. Accepts camelCase and snake_case spellings of
 * every bucket, because runtimes disagree about which they emit.
 */
export function parseAcpUsage(raw: unknown): UsageSnapshot {
  const fields = asRecord(raw)
  const s = emptySnapshot()
  if (fields === undefined) return s

  const input = usageNumber(fields, ['inputTokens', 'input_tokens'])
  if (input !== undefined) {
    s.input = input
    s.rawInput = input
    s.fields |= USAGE_INPUT
  }
  const output = usageNumber(fields, ['outputTokens', 'output_tokens'])
  if (output !== undefined) {
    s.output = output
    s.fields |= USAGE_OUTPUT
  }
  const cacheRead = usageNumber(fields, [
    'cachedReadTokens',
    'cacheReadTokens',
    'cached_input_tokens',
    'cache_read_tokens',
    'cache_read_input_tokens',
    // The snake_case mirror of `cachedReadTokens`. multica's list omits it, but
    // a runtime that spells its camelCase name in snake_case would lose the
    // bucket silently — and a dropped cache bucket is not visible downstream.
    'cached_read_tokens',
  ])
  if (cacheRead !== undefined) {
    s.cacheRead = cacheRead
    s.fields |= USAGE_CACHE_READ
  }
  const cacheWrite = usageNumber(fields, [
    'cachedWriteTokens',
    'cacheWriteTokens',
    'cache_write_tokens',
    'cache_creation_input_tokens',
    // Same reasoning as `cached_read_tokens` above.
    'cached_write_tokens',
  ])
  if (cacheWrite !== undefined) {
    s.cacheWrite = cacheWrite
    s.fields |= USAGE_CACHE_WRITE
  }
  const reasoning = usageNumber(fields, ['reasoningTokens', 'reasoning_tokens'])
  if (reasoning !== undefined) s.rawReasoning = reasoning

  const total = usageNumber(fields, ['totalTokens', 'total_tokens'])
  if (total !== undefined) {
    s.total = total
    s.hasTotal = true
  }
  normalizeInput(s)
  return s
}

/**
 * Re-bucket an input count that already CONTAINS cached reads, so the four
 * buckets stay mutually exclusive (`types.ts` §`AgentUsage`).
 *
 * ACP does not specify which convention a runtime uses. The re-bucketing only
 * happens when `totalTokens` PROVES the inclusive shape
 * (`total == input + output`, multica's Grok Build observation); a runtime
 * reporting exclusive buckets, or omitting the total, is left alone. Guessing
 * without that proof would silently shrink input for every well-behaved runtime.
 */
function normalizeInput(s: UsageSnapshot): void {
  s.input = s.rawInput
  s.inputNormalized = false
  if (!hasField(s, USAGE_INPUT) || !hasField(s, USAGE_OUTPUT) || !hasField(s, USAGE_CACHE_READ)) {
    return
  }
  if (s.total <= 0 || s.cacheRead <= 0 || s.cacheRead > s.input) return
  if (s.total !== s.input + s.output) return
  s.input -= s.cacheRead
  s.inputNormalized = true
}

/**
 * Fill buckets the PREFERRED representation omitted or reported as zero from a
 * fallback. Standard top-level `result.usage` is authoritative over vendor
 * `_meta`; nested `_meta.usage` is authoritative over its flat mirror
 * (multica `acpUsageSnapshot.withFallback`).
 */
function withFallback(preferred: UsageSnapshot, fallback: UsageSnapshot): UsageSnapshot {
  const result = { ...preferred }
  let inputFromFallback = false
  if (hasField(fallback, USAGE_INPUT) && (!hasField(result, USAGE_INPUT) || result.rawInput === 0)) {
    result.input = fallback.input
    result.rawInput = fallback.rawInput
    result.inputNormalized = fallback.inputNormalized
    inputFromFallback = true
  }
  if (hasField(fallback, USAGE_OUTPUT) && (!hasField(result, USAGE_OUTPUT) || result.output === 0)) {
    result.output = fallback.output
  }
  if (
    hasField(fallback, USAGE_CACHE_READ) &&
    (!hasField(result, USAGE_CACHE_READ) || result.cacheRead === 0)
  ) {
    result.cacheRead = fallback.cacheRead
  }
  if (
    hasField(fallback, USAGE_CACHE_WRITE) &&
    (!hasField(result, USAGE_CACHE_WRITE) || result.cacheWrite === 0)
  ) {
    result.cacheWrite = fallback.cacheWrite
  }
  if (fallback.rawReasoning > result.rawReasoning) result.rawReasoning = fallback.rawReasoning

  result.fields |= fallback.fields
  if (inputFromFallback) {
    result.total = fallback.total
    result.hasTotal = fallback.hasTotal
  } else if (!result.hasTotal && fallback.hasTotal) {
    result.total = fallback.total
    result.hasTotal = true
  }
  // Always restart from the raw count so a preferred/fallback merge normalizes
  // once every complementary field is present, never subtracting twice.
  normalizeInput(result)
  return result
}

/**
 * Reconcile a terminal `session/prompt` result: standard top-level `usage` is
 * preferred, `_meta` (nested `usage` first, then its flat mirror) fills gaps.
 */
export function promptResultUsage(result: Record<string, unknown>): UsageSnapshot {
  const top = parseAcpUsage(result.usage)
  const meta = asRecord(result._meta)
  let metaSnapshot = emptySnapshot()
  if (meta !== undefined) {
    metaSnapshot = withFallback(parseAcpUsage(meta.usage), parseAcpUsage(meta))
  }
  return withFallback(top, metaSnapshot)
}

/** True when anything was actually reported, so an empty accumulator stays absent. */
function usagePresent(a: UsageAccumulatorSlots): boolean {
  return a.input > 0 || a.output > 0 || a.cacheRead > 0 || a.cacheWrite > 0
}

/** Project the accumulator onto the frozen `AgentUsage`. */
export function toAgentUsage(a: UsageAccumulatorSlots, rawReasoning: number): AgentUsage | undefined {
  if (!usagePresent(a)) return undefined
  return {
    inputTokens: a.input,
    outputTokens: a.output,
    ...(a.cacheRead > 0 ? { cacheReadTokens: a.cacheRead } : {}),
    ...(a.cacheWrite > 0 ? { cacheWriteTokens: a.cacheWrite } : {}),
    // DISCLOSURE, never a bucket to add up — see the `AgentUsage` doc comment.
    // ACP defines no dedicated reasoning counter, so this is set only when a
    // runtime states one explicitly.
    ...(rawReasoning > 0 ? { reasoningTokens: rawReasoning } : {}),
  }
}

// ── Permission selection (ported from multica `hermes.go:1321`) ─────────────

/** One `session/request_permission` option. `kind` is ACP's classification. */
export interface AcpPermissionOption {
  readonly optionId: string
  readonly kind: string
}

const KIND_ALLOW_ONCE = 'allow_once'
const KIND_ALLOW_ALWAYS = 'allow_always'
const KIND_REJECT_ONCE = 'reject_once'

/**
 * Option ids known to grant for the CURRENT SESSION without persisting. ACP has
 * no session-scoped kind — both "one action" and "forever" arrive as
 * `allow_always` — so the session-scoped ones are recognised by id.
 */
export const ACP_SESSION_SCOPED_OPTION_IDS: readonly string[] = [
  'allow_session',
  'approve_for_session',
]

export interface PermissionSelection {
  readonly optionId: string
  readonly grant: boolean
  readonly ok: boolean
}

/**
 * Decide how to answer a `session/request_permission`.
 *
 * The bridge is headless: there is no human to ask, and leaving the request
 * unanswered makes the engine block until its own internal timeout, so the task
 * hangs. Order of preference:
 *
 *  1. a known session-scoped grant id, if actually offered with a grant kind;
 *  2. any single-use grant (`kind: "allow_once"`) — inherently scoped to one
 *     action, so it is safe regardless of the opaque optionId;
 *  3. an offered `reject_once` — deny THIS action rather than reply
 *     `cancelled`, which other ACP runtimes read as cancelling the whole turn.
 *
 * `allow_always` is NEVER auto-selected. ACP v1 defines it as remembering the
 * choice; on Hermes that persists to the runtime owner's on-disk allowlist and
 * outlives the task (multica GitHub #5300), which is a far larger grant than
 * "let this turn run". Grant nature comes from the explicit `kind`, never from
 * the opaque id, so an unknown kind fails closed.
 */
export function selectPermissionOption(
  options: readonly AcpPermissionOption[],
): PermissionSelection {
  for (const want of ACP_SESSION_SCOPED_OPTION_IDS) {
    for (const opt of options) {
      if (opt.optionId === want && isGrantKind(opt.kind)) {
        return { optionId: opt.optionId, grant: true, ok: true }
      }
    }
  }
  for (const opt of options) {
    if (opt.optionId !== '' && opt.kind.trim().toLowerCase() === KIND_ALLOW_ONCE) {
      return { optionId: opt.optionId, grant: true, ok: true }
    }
  }
  for (const opt of options) {
    if (opt.optionId !== '' && opt.kind.trim().toLowerCase() === KIND_REJECT_ONCE) {
      return { optionId: opt.optionId, grant: false, ok: true }
    }
  }
  return { optionId: '', grant: false, ok: false }
}

export function isGrantKind(kind: string): boolean {
  const k = kind.trim().toLowerCase()
  return k === KIND_ALLOW_ONCE || k === KIND_ALLOW_ALWAYS
}

// ── Update normalization ────────────────────────────────────────────────────

export type AcpUpdateType =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'usage_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'plan'
  | 'unknown'

/**
 * Read the update discriminant off a `session/update` payload.
 *
 * Three shapes exist in the wild (multica `normalizeACPUpdate`): the ACP v1
 * `sessionUpdate` enum, a plain `type` field, and an externally-tagged wrapper
 * `{"agentMessageChunk":{…}}`. Normalizing the name (strip `_`/`-`, lowercase)
 * before matching means `agentMessageChunk`, `agent_message_chunk` and
 * `AGENT-MESSAGE-CHUNK` all land on the same branch.
 */
export function classifyUpdate(data: unknown): AcpUpdateType {
  const record = asRecord(data)
  if (record === undefined) return 'unknown'
  const declared = asString(record['sessionUpdate']) ?? asString(record['type'])
  if (declared !== undefined && declared !== '') {
    return updateTypeFromName(declared)
  }
  const keys = Object.keys(record)
  if (keys.length === 1) {
    const only = keys[0]
    if (only !== undefined) return updateTypeFromName(only)
  }
  return 'unknown'
}

export function updateTypeFromName(name: string): AcpUpdateType {
  switch (name.trim().toLowerCase().replace(/[_-]/g, '')) {
    case 'agentmessagechunk':
      return 'agent_message_chunk'
    case 'agentthoughtchunk':
      return 'agent_thought_chunk'
    case 'toolcall':
      return 'tool_call'
    case 'toolcallupdate':
      return 'tool_call_update'
    case 'usageupdate':
      return 'usage_update'
    case 'configoptionupdate':
      return 'config_option_update'
    case 'sessioninfoupdate':
      return 'session_info_update'
    case 'availablecommandsupdate':
      return 'available_commands_update'
    case 'currentmodeupdate':
      return 'current_mode_update'
    case 'plan':
      return 'plan'
    default:
      return 'unknown'
  }
}

/** Concatenate the rendered text of every ACP content block. */
export function extractToolCallText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const pieces: string[] = []
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (block === undefined) continue
    const type = asString(block['type'])
    if (type === 'content') {
      const inner = asRecord(block['content'])
      if (inner === undefined) continue
      if (asString(inner['type']) !== 'text') continue
      const text = asString(inner['text'])
      if (text !== undefined && text !== '') pieces.push(text)
    } else if (type === 'diff') {
      const p = asString(block['path']) ?? ''
      if (p === '') continue
      const newText = asString(block['newText']) ?? ''
      const oldText = asString(block['oldText']) ?? ''
      // A full unified diff can be enormous and we only need to record that the
      // tool wrote here; the UI can re-read the file for the content.
      pieces.push(
        oldText === ''
          ? `--- ${p}\n+++ ${p}\n(new file, ${newText.length} bytes)`
          : `--- ${p}\n+++ ${p}\n(edited: ${oldText.length} → ${newText.length} bytes)`,
      )
    }
    // terminal / image / unknown blocks carry no inline text; the terminal's
    // own output is served through `terminal/output`.
  }
  return pieces.join('\n')
}

/** Render an ACP output field that may be a string OR a structured value. */
export function rawText(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

/**
 * Pull the tool name out of an ACP tool call's `title`, falling back to `kind`.
 *
 * ACP titles look like `"terminal: ls -la"`, `"read: /path"`, `"patch (replace)"`.
 * Ported from multica `hermesToolNameFromTitle`, including the deliberate choice
 * to preserve an unclassifiable non-empty title rather than drop the tool name.
 */
export function toolNameFromTitle(title: string, kind: string, name: string): string {
  if (name !== '') return name
  switch (title) {
    case 'execute code':
      return 'execute_code'
    default:
      break
  }
  const idx = title.indexOf(':')
  if (idx > 0) {
    const head = title.slice(0, idx).trim()
    if (head === 'terminal') return 'terminal'
    if (head === 'read') return 'read_file'
    if (head === 'write') return 'write_file'
    if (head.startsWith('patch')) return 'patch'
    if (head === 'search') return 'search_files'
    if (head === 'web search') return 'web_search'
    if (head === 'extract') return 'web_extract'
    if (head === 'delegate') return 'delegate_task'
    if (head === 'analyze image') return 'vision_analyze'
    return head
  }
  switch (kind) {
    case 'read':
      return 'read_file'
    case 'edit':
      return 'write_file'
    case 'execute':
      return 'terminal'
    case 'search':
      return 'search_files'
    case 'fetch':
      return 'web_search'
    case 'think':
      return 'thinking'
    default:
      return title !== '' ? title : kind
  }
}

/**
 * Turn an ACP failure result into a message a human can act on.
 *
 * The captured CodeBuddy Code run puts the real cause in `_meta` as a JSON
 * STRING wrapping a JSON-RPC error (`codebuddy.ai/errorMessage` →
 * `{"code":-32000,"message":"Authentication required","data":{"details":"401 …"}}`),
 * and other runtimes use their own key. Each candidate is unwrapped one level if
 * it parses as JSON, and the first non-empty one wins. Without this a dead
 * credential is reported as a bare "refusal" with no cause.
 */
export function acpFailureDetail(result: Record<string, unknown> | undefined): string {
  if (result === undefined) return ''
  const meta = asRecord(result['_meta'])
  const candidates: string[] = []
  if (meta !== undefined) {
    for (const key of [
      'codebuddy.ai/errorMessage',
      'errorMessage',
      'error_message',
      'error',
    ]) {
      const raw = meta[key]
      if (raw !== undefined && raw !== null) candidates.push(rawText(raw))
    }
  }
  for (const key of ['errorMessage', 'error_message', 'error']) {
    const raw = result[key]
    if (raw !== undefined && raw !== null) candidates.push(rawText(raw))
  }
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue
    const parsed = tryParseJson(candidate)
    const record = asRecord(parsed)
    if (record === undefined) return candidate
    const message = asString(record['message']) ?? ''
    const data = asRecord(record['data'])
    const details = data === undefined ? '' : (asString(data['details']) ?? '')
    const combined = [message, details].filter((s) => s !== '').join(': ')
    return combined !== '' ? combined : candidate
  }
  return ''
}

// ── argv ────────────────────────────────────────────────────────────────────

export interface AcpArgOptions {
  readonly protocolArgs?: readonly string[]
  readonly extraArgs?: readonly string[]
}

/**
 * Per-run argv. ACP is driven entirely over the pipe, so nothing about the turn
 * (prompt, cwd, model) travels on the command line — the only argv is the
 * protocol selector from the descriptor plus whatever the caller added.
 */
export function buildAcpArgs(opts: AcpArgOptions, logger?: BridgeLogger): string[] {
  const args: string[] = [...(opts.protocolArgs ?? [])]
  args.push(...filterCustomArgs(opts.extraArgs, ACP_BLOCKED_ARGS, logger))
  return args
}

// ── The transport ───────────────────────────────────────────────────────────

type RpcId = number | string

interface PendingRpc {
  /** Kept so a JSON-RPC error frame can name the call that failed. */
  readonly method: string
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

/** A JSON-RPC error frame, kept structured so callers can branch on the code. */
export class AcpRpcError extends Error {
  readonly method: string
  readonly code: number
  readonly data: string
  constructor(method: string, code: number, message: string, data: string) {
    super(data === '' ? `${method}: ${message} (code=${code})` : `${method}: ${message} (code=${code}, data=${data})`)
    this.name = 'AcpRpcError'
    this.method = method
    this.code = code
    this.data = data
  }
}

/** Live terminal owned by this client (multica `acpTerminal`). */
interface AcpTerminal {
  readonly id: string
  output: Buffer
  truncated: boolean
  readonly limit: number
  exitCode: number | null
  signal: string | null
  done: boolean
  child?: SpawnedProcess
  waiters: Array<() => void>
}

/**
 * The client half of an ACP conversation: frame I/O, request correlation, and
 * the server-side handlers for the `fs/*` / `terminal/*` / permission methods
 * the engine calls back into.
 */
export class AcpClient {
  readonly #child: SpawnedProcess
  readonly #logger: BridgeLogger
  readonly #now: () => number
  readonly #caps: AcpClientCapabilities
  readonly #cwd: string | undefined
  readonly #env: Readonly<Record<string, string>>
  readonly #spawn: SpawnFn

  #nextId = 1
  #pending = new Map<RpcId, PendingRpc>()
  #writeChain: Promise<void> = Promise.resolve()
  #writeFailed: Error | undefined
  #terminals = new Map<string, AcpTerminal>()
  #nextTerminalId = 1
  #closed = false

  /** The backend session id, learned from `session/new` (or `session/resume`). */
  sessionId = ''

  /** Invoked for every accepted `session/update` notification. */
  onUpdate: (type: AcpUpdateType, update: Record<string, unknown>) => void = () => {}
  /** Invoked for every non-`session/update` notification (vendor extensions). */
  onNotification: (method: string, params: unknown) => void = () => {}
  /** Invoked for any accepted update, so a drain window can be re-armed. */
  onActivity: () => void = () => {}
  /** Gates updates: false drops them (history replay before the prompt). */
  acceptUpdate: () => boolean = () => true
  /** Invoked when the agent->client permission handler made a decision. */
  onPermission: (selection: PermissionSelection, params: unknown) => void = () => {}
  /**
   * Invoked once when the stdout reader crosses a stream limit.
   *
   * Rejecting the in-flight requests is not enough on its own: the run may be
   * between requests (not awaiting the pipe at all), in which case there is
   * nothing to reject and the session sits until the idle watchdog. A limit
   * breach is a terminal condition of the RUN, so the driver must settle it on a
   * real terminal path — this is that trigger, not a bookkeeping flag (RR-MI-7).
   */
  onOverflow: (overflow: Error) => void = () => {}

  constructor(init: {
    child: SpawnedProcess
    logger: BridgeLogger
    now: () => number
    caps: AcpClientCapabilities
    cwd?: string
    env: Readonly<Record<string, string>>
    spawn: SpawnFn
  }) {
    this.#child = init.child
    this.#logger = init.logger
    this.#now = init.now
    this.#caps = init.caps
    this.#cwd = init.cwd
    this.#env = init.env
    this.#spawn = init.spawn
  }

  /**
   * Attach the stdout reader. MUST run before the first write: the peer may emit
   * a startup burst that fills the pipe while we are still writing, and a
   * reader attached afterwards deadlocks (multica `claude_deadlock_test.go`).
   *
   * A peer that never emits `\n` (or never stops) would grow this reader's
   * buffer inside the host process, so a limit breach fails every in-flight
   * request AND reports through {@link onOverflow}, which the run turns into a
   * real terminal settlement (MI-4 / RR-MI-7): the run settles as a failure
   * naming the overrun, and the shutdown path terminates the group.
   */
  start(): void {
    const reader = readLines(
      this.#child.stdout,
      (line) => this.#handleLine(line),
      {
        onOverflow: (overflow) => {
          this.#failAll(overflow)
          this.onOverflow(overflow)
        },
      },
    )
    void reader.flushed.then(() => {
      this.#failAll(new Error('ACP engine closed its output stream'))
    })
    this.#child.stdout.on('error', () => {
      this.#failAll(new Error('ACP engine stdout read error'))
    })
  }

  /** Reject every in-flight request. Called when the pipe ends. */
  #failAll(err: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const p of pending) p.reject(err)
  }

  /**
   * Serialise one frame onto stdin. Writes are chained rather than awaited
   * inline so a caller (including the reader thread answering a capability
   * request) never blocks on pipe backpressure.
   */
  writeFrame(frame: unknown): void {
    if (this.#closed) return
    const data = `${JSON.stringify(frame)}\n`
    this.#writeChain = this.#writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          try {
            this.#child.stdin.write(data, (err?: Error | null) => {
              if (err !== undefined && err !== null) this.#writeFailed = err
              resolve()
            })
          } catch (err) {
            this.#writeFailed = err instanceof Error ? err : new Error(String(err))
            resolve()
          }
        }),
    )
  }

  /** Wait until every frame written so far has left this process. */
  async flushWrites(): Promise<void> {
    await this.#writeChain
  }

  /** Send a request and await its response. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(`ACP transport closed; cannot send ${method}`))
    }
    const id = this.#nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject })
    })
    this.writeFrame({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  /** Drop a pending request (used by the cancel/timeout paths). */
  cancelPending(reason: string): void {
    this.#failAll(new Error(reason))
  }

  /**
   * Stop accepting work and release child processes this client started.
   *
   * Idempotent. Every terminal's termination is AWAITED (each `terminate()` is
   * itself bounded by the runtime's SIGTERM→grace→SIGKILL ladder): the run's
   * `done` is the caller's only signal that nothing outlives the transcript, so
   * a fire-and-forget kill here would make "settled" a lie — the engine-owned
   * terminal children are exactly what `child.terminate()` cannot reach
   * (RR-IM-6).
   */
  async dispose(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#failAll(new Error('ACP transport disposed'))
    await Promise.all([...this.#terminals.values()].map((t) => this.#killTerminal(t)))
  }

  /**
   * Signal EOF to the engine by ending its stdin, then wait (bounded) for it to
   * exit.
   *
   * An ACP engine is a PERSISTENT SERVER: it answers `session/prompt` and then
   * keeps running, so waiting on its exit without closing stdin hangs forever.
   * multica does the same thing for the same reason (`hermes.go:717`, "Close
   * stdin first so Hermes can observe EOF and exit cleanly").
   *
   * Resolves `true` when the process exited within the grace window. `false`
   * means a well-behaved-engine assumption did not hold, and the caller must
   * force a group kill — the transcript is still complete either way, since the
   * stdout reader has already drained every frame it was going to get.
   */
  async shutdown(graceMs: number): Promise<boolean> {
    await this.flushWrites().catch(() => {})
    const stdin = this.#child.stdin
    try {
      stdin.end()
    } catch {
      /* already ended or destroyed */
    }
    const timedOut = await Promise.race([
      this.#child.exited.then(() => false).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
    ])
    return !timedOut
  }

  // ── inbound dispatch ──────────────────────────────────────────────────────

  #handleLine(line: string): void {
    const parsed = tryParseJson(line)
    const frame = asRecord(parsed)
    if (frame === undefined) {
      // A non-JSON line is diagnostics (a banner), never a protocol frame. It is
      // logged rather than reported as an error so a chatty peer cannot fail a
      // healthy run.
      this.#logger.debug('acp: non-JSON stdout line ignored', { line: line.slice(0, 200) })
      return
    }
    const id = frame['id']
    const hasId = id !== undefined && id !== null
    const method = asString(frame['method'])

    if (hasId && (frame['result'] !== undefined || frame['error'] !== undefined)) {
      this.#handleResponse(frame, id)
      return
    }
    if (hasId && method !== undefined) {
      this.#handleAgentRequest(method, frame)
      return
    }
    if (method !== undefined) {
      // Request-shaped but id-less. Some peers (measured: `codebuddy-code
      // --acp`'s `_codebuddy.ai/command`) send these and never wait for an
      // answer. Answering would emit `"id":null`; treating it as a request
      // would wedge the reader. It is handled as a notification.
      this.#handleNotification(method, frame['params'])
      return
    }
    this.#logger.debug('acp: unclassifiable frame ignored')
  }

  #handleResponse(frame: Record<string, unknown>, id: unknown): void {
    const key: RpcId = typeof id === 'number' || typeof id === 'string' ? id : String(id)
    const pending = this.#pending.get(key)
    if (pending === undefined) return
    this.#pending.delete(key)
    const errFrame = asRecord(frame['error'])
    if (errFrame !== undefined) {
      const code = typeof errFrame['code'] === 'number' ? errFrame['code'] : 0
      const message = asString(errFrame['message']) ?? 'ACP error'
      const dataRaw = errFrame['data']
      const data =
        dataRaw === undefined || dataRaw === null
          ? ''
          : typeof dataRaw === 'string'
            ? dataRaw
            : rawText(dataRaw)
      pending.reject(new AcpRpcError(pending.method, code, message, data))
      return
    }
    pending.resolve(frame['result'])
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' && method !== 'session/notification') {
      this.onNotification(method, params)
      return
    }
    const p = asRecord(params)
    const update = p === undefined ? undefined : p['update']
    if (update === undefined) return
    const type = classifyUpdate(update)
    if (!this.acceptUpdate()) return
    this.onActivity()
    this.onUpdate(type, asRecord(update) ?? {})
  }

  // ── agent → client requests ───────────────────────────────────────────────

  #handleAgentRequest(method: string, frame: Record<string, unknown>): void {
    const id = frame['id']
    const params = frame['params']

    // `session/request_permission` is synchronous and must be answered promptly:
    // the engine blocks on it.
    if (method === 'fs/read_text_file' || method === 'fs/write_text_file') {
      this.#reply(id, () => this.#serveFs(method, params))
      return
    }
    if (method.startsWith('terminal/')) {
      // `terminal/wait_for_exit` is long-lived by design, and the engine keeps
      // polling/killing WHILE it is pending — so it is answered off the reader
      // path (multica `hermes.go:1113`).
      if (method === 'terminal/wait_for_exit') {
        void this.#serveTerminal(method, params).then(
          (result) => this.#sendResult(id, result),
          (err: unknown) => this.#sendError(id, -32602, errorText(err)),
        )
        return
      }
      this.#reply(id, () => this.#serveTerminal(method, params))
      return
    }
    if (method === 'session/request_permission') {
      const options = permissionOptionsFrom(params)
      const selection = selectPermissionOption(options)
      if (!selection.ok) {
        // Nothing safely selectable: a protocol error is honest. Fabricating an
        // un-offered id is not, and `cancelled` would abort the whole turn.
        this.#logger.warn('acp: no auto-selectable permission option offered', { method })
        this.#sendError(id, -32603, 'no auto-selectable permission option offered')
        return
      }
      this.onPermission(selection, params)
      this.#sendResult(id, {
        outcome: { outcome: 'selected', optionId: selection.optionId },
      })
      return
    }
    this.#logger.debug('acp: unhandled agent->client request', { method })
    this.#sendError(id, -32601, `method not found: ${method}`)
  }

  /**
   * Answer a handler, converting a throw into a JSON-RPC error.
   *
   * The handler may be SYNCHRONOUS or ASYNC: `terminal/create` must actually
   * spawn a process before it knows the `terminalId`, so it returns a Promise.
   * Sending a Promise as the `result` would serialize it to `{}` and the engine
   * would then address a terminal we never told it about — measured as
   * `unknown terminal ""` before this was awaited.
   */
  #reply(id: unknown, run: () => unknown): void {
    let outcome: unknown
    try {
      outcome = run()
    } catch (err) {
      this.#sendError(id, err instanceof AcpPathRefusedError ? -32602 : -32603, errorText(err))
      return
    }
    if (!(outcome instanceof Promise)) {
      this.#sendResult(id, outcome)
      return
    }
    void outcome.then(
      (result) => this.#sendResult(id, result),
      (err: unknown) => this.#sendError(id, err instanceof AcpPathRefusedError ? -32602 : -32603, errorText(err)),
    )
  }

  #sendResult(id: unknown, result: unknown): void {
    this.writeFrame({ jsonrpc: '2.0', id, result })
  }

  #sendError(id: unknown, code: number, message: string): void {
    this.writeFrame({ jsonrpc: '2.0', id, error: { code, message } })
  }

  // ── client-side capabilities ──────────────────────────────────────────────

  #serveFs(method: string, params: unknown): unknown {
    if (!this.#caps.fs) {
      throw new Error(`${method}: file-system capability is not enabled for this run`)
    }
    const p = asRecord(params)
    if (p === undefined) throw new Error(`${method}: params required`)
    const requested = asString(p['path']) ?? ''
    if (requested === '') throw new Error(`${method}: path required`)
    // THE RED LINE: every path is proven to be inside the run's cwd (see
    // `confineToRoot`). An escape is refused with the path and the root named.
    const abs = confineToRoot(this.#cwd, requested)

    if (method === 'fs/read_text_file') {
      const offset = typeof p['line'] === 'number' && Number.isFinite(p['line'])
        ? Math.max(1, Math.floor(p['line']))
        : undefined
      const limit = typeof p['limit'] === 'number' && Number.isFinite(p['limit'])
        ? Math.max(0, Math.floor(p['limit']))
        : undefined
      let text = readBoundedUtf8File(abs, ACP_MAX_TEXT_FILE_BYTES)
      if (offset !== undefined || limit !== undefined) {
        const lines = text.split('\n')
        const start = Math.max(0, (offset ?? 1) - 1)
        const end = limit === undefined ? lines.length : start + limit
        text = lines.slice(start, end).join('\n')
      }
      return { content: text }
    }

    const content = asString(p['content'])
    if (content === undefined) throw new Error(`${method}: content required`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    writeBoundedUtf8File(abs, content, ACP_MAX_TEXT_FILE_BYTES)
    return {}
  }

  async #serveTerminal(method: string, params: unknown): Promise<unknown> {
    if (!this.#caps.terminal) {
      throw new Error(`${method}: terminal capability is not enabled for this run`)
    }
    const p = asRecord(params)
    if (p === undefined) throw new Error(`${method}: params required`)

    if (method === 'terminal/create') return this.#createTerminal(p)

    const terminalId = asString(p['terminalId']) ?? ''
    const terminal = this.#terminals.get(terminalId)
    if (terminal === undefined) throw new Error(`unknown terminal ${JSON.stringify(terminalId)}`)

    switch (method) {
      case 'terminal/output': {
        const { output, truncated } = this.#snapshot(terminal)
        return {
          output,
          truncated,
          ...(terminal.done
            ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } }
            : {}),
        }
      }
      case 'terminal/wait_for_exit': {
        if (!terminal.done) {
          await new Promise<void>((resolve) => {
            terminal.waiters.push(resolve)
          })
        }
        return { exitCode: terminal.exitCode, signal: terminal.signal }
      }
      case 'terminal/kill': {
        await this.#killTerminal(terminal)
        return {}
      }
      case 'terminal/release': {
        await this.#killTerminal(terminal)
        this.#terminals.delete(terminalId)
        return {}
      }
      default:
        throw new Error(`unsupported terminal method ${method}`)
    }
  }

  async #createTerminal(p: Record<string, unknown>): Promise<unknown> {
    const command = asString(p['command']) ?? ''
    if (command.trim() === '') throw new Error('terminal/create requires command')
    // The terminal's cwd obeys the same confinement as fs/*, defaulting to the
    // run's cwd — a process started outside it could read anything the user can.
    const cwd = confineToRoot(this.#cwd, asString(p['cwd']) ?? '.')

    const rawArgs = Array.isArray(p['args']) ? p['args'].filter((a) => typeof a === 'string') : []
    const args = rawArgs as string[]
    if (!isAcpTerminalCommandAllowed(command, args, this.#caps.terminalCommands)) {
      const shape = args.length === 0 ? 'shell commands' : `command ${JSON.stringify(command)}`
      throw new AcpPathRefusedError(
        `refusing terminal/create: ${shape} is not in this deployment's ACP terminal allow-list ` +
          `(${this.#caps.terminalCommands.join(', ')})`,
      )
    }
    const env = acpTerminalEnvironment(this.#env, p['env'])

    // The engine sizes this, the host pays for it: `outputByteLimit` arrives on
    // the wire (and `1e12` is a perfectly legal value there), while the retained
    // buffer is memory in THIS process. It is clamped to the host cap instead of
    // adopted verbatim (MI-19); an absent limit still means the engine default.
    const engineLimit = typeof p['outputByteLimit'] === 'number' && p['outputByteLimit'] > 0
      ? p['outputByteLimit']
      : ACP_DEFAULT_OUTPUT_BYTE_LIMIT
    const limit = Math.min(engineLimit, ACP_MAX_OUTPUT_BYTE_LIMIT)

    // No `args` means the command is a shell line, exactly as multica does it.
    const spec =
      args.length > 0
        ? { command, args, cwd, env }
        : { command: '/bin/sh', args: ['-c', command], cwd, env }

    const child = this.#spawn(spec)
    const id = `dsh-acp-terminal-${this.#nextTerminalId++}`
    const terminal: AcpTerminal = {
      id,
      output: Buffer.alloc(0),
      truncated: false,
      limit,
      exitCode: null,
      signal: null,
      done: false,
      child,
      waiters: [],
    }
    this.#terminals.set(id, terminal)

    const append = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      terminal.output = Buffer.concat([terminal.output, buf])
      if (terminal.output.length > terminal.limit) {
        let start = terminal.output.length - terminal.limit
        // Never retain the tail of a rune whose leading byte was dropped.
        while (start < terminal.output.length && !isRuneStart(terminal.output, start)) start++
        terminal.output = terminal.output.subarray(start)
        terminal.truncated = true
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    void child.exited.then((exit) => {
      terminal.done = true
      if (exit.code !== null) terminal.exitCode = exit.code
      if (exit.signal !== null) terminal.signal = exit.signal
      for (const resolve of terminal.waiters.splice(0)) resolve()
    })
    return { terminalId: id }
  }

  /** Retained output, trimmed to whole runes at both ends. */
  #snapshot(terminal: AcpTerminal): { output: string; truncated: boolean } {
    let raw = terminal.output
    // A pipe read can split a rune across writes; do not expose the fragment.
    if (raw.length > 0) {
      let last = raw.length - 1
      while (last > 0 && !isRuneStart(raw, last)) last--
      raw = raw.subarray(0, last + 1)
    }
    return { output: raw.toString('utf8'), truncated: terminal.truncated }
  }

  async #killTerminal(terminal: AcpTerminal): Promise<void> {
    const child = terminal.child
    if (child === undefined) return
    // `terminate()` signals the whole GROUP, which is what stops a shell's
    // descendants too — a plain child kill would leave them holding the pipe.
    await child.terminate().catch(() => {})
  }
}

function isRuneStart(buf: Buffer, index: number): boolean {
  const byte = buf[index]
  if (byte === undefined) return false
  return (byte & 0xc0) !== 0x80
}

function permissionOptionsFrom(params: unknown): AcpPermissionOption[] {
  const p = asRecord(params)
  const raw = p === undefined ? undefined : p['options']
  if (!Array.isArray(raw)) return []
  const out: AcpPermissionOption[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (rec === undefined) continue
    const optionId = asString(rec['optionId']) ?? ''
    const kind = asString(rec['kind']) ?? ''
    out.push({ optionId, kind })
  }
  return out
}

// ── The run ─────────────────────────────────────────────────────────────────

let sessionCounter = 0

function nextSessionId(at: number): string {
  sessionCounter = (sessionCounter + 1) % 1_000_000
  return `dsh-acp-${at.toString(36)}-${sessionCounter.toString(36)}`
}

/** Extract the session id from a `session/new` / `session/resume` result. */
export function extractSessionId(result: unknown): string {
  const record = asRecord(result)
  if (record === undefined) return ''
  return asString(record['sessionId']) ?? ''
}

/** The auth method ids an `initialize` result advertises. */
export function extractAuthMethods(result: unknown): string[] {
  const record = asRecord(result)
  const raw = record === undefined ? undefined : record['authMethods']
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const id = rec === undefined ? undefined : asString(rec['id'])
    if (id !== undefined && id.trim() !== '') out.push(id.trim())
  }
  return out
}

/** The model the session reports as current, when it reports one. */
export function extractCurrentModelId(result: unknown): string {
  const record = asRecord(result)
  if (record === undefined) return ''
  const models = asRecord(record['models'])
  const candidates = [
    models === undefined ? undefined : models['currentModelId'],
    models === undefined ? undefined : models['current_model_id'],
    record['currentModelId'],
    record['current_model_id'],
  ]
  for (const c of candidates) {
    const s = asString(c)
    if (s !== undefined && s.trim() !== '') return s.trim()
  }
  return ''
}

/**
 * The effort selector a session advertises, if it has one.
 *
 * ACP standardises `configOptions` and `session/set_config_option` but NOT the
 * way a reasoning-effort dial is named, so the selector is matched by
 * id/category against a small vocabulary rather than by a per-runtime table
 * (multica `acpEffortOptionIDs`). Values are passed through VERBATIM: the CLI
 * owns its vocabulary (`minimal…max`, `enabled`, `minimal…ultra`), and
 * flattening onto a shared enum would silently drop levels a runtime accepts.
 */
export interface AcpEffortOption {
  readonly configId: string
  readonly currentValue: string
  readonly values: readonly string[]
}

const EFFORT_OPTION_IDS = new Set(['effort', 'thought_level', 'reasoning_effort'])

export function extractEffortOption(result: unknown): AcpEffortOption | undefined {
  const record = asRecord(result)
  if (record === undefined) return undefined
  const raw =
    (Array.isArray(record['configOptions']) ? record['configOptions'] : undefined) ??
    (Array.isArray(record['config_options']) ? record['config_options'] : undefined)
  if (raw === undefined) return undefined

  for (const item of raw) {
    const opt = asRecord(item)
    if (opt === undefined) continue
    const id = (asString(opt['id']) ?? '').trim()
    const category = (asString(opt['category']) ?? '').trim().toLowerCase()
    if (!EFFORT_OPTION_IDS.has(id.toLowerCase()) && !EFFORT_OPTION_IDS.has(category)) continue
    // An option we can read but not address is useless: without an id there is
    // nothing to send back to `session/set_config_option`.
    if (id === '') continue
    const values: string[] = []
    const options = Array.isArray(opt['options']) ? opt['options'] : []
    for (const choice of options) {
      const rec = asRecord(choice)
      if (rec === undefined) continue
      const value = (asString(rec['value']) ?? '').trim()
      if (value === '' || values.includes(value)) continue
      values.push(value)
    }
    const current = (asString(opt['currentValue']) ?? asString(opt['current_value']) ?? '').trim()
    return {
      configId: id,
      // Only echo a default we also advertise: CodeBuddy's captured
      // `currentValue: "enabled"` is not one of its own offered levels, and
      // reporting it as the default would name a level the picker cannot offer.
      currentValue: values.includes(current) ? current : '',
      values,
    }
  }
  return undefined
}

/**
 * Run one ACP conversation.
 *
 * Returns as soon as the child is spawned and the reader is attached — never
 * awaiting the handshake, let alone the turn (frozen ABI D5: a tool call has a
 * seconds-long timeout while an agent task lasts minutes).
 */
export async function runAcp(
  opts: AgentRunOptions,
  deps: DriverDeps,
  signal: AbortSignal,
  rt: DriverRuntime,
): Promise<AgentSessionHandle> {
  const now = rt.now ?? Date.now
  const startedAt = now()

  const caps = acpClientCapabilities(deps.env)
  const authMethod = acpAuthMethodFromEnv(deps.env)

  const args = buildAcpArgs(
    { protocolArgs: deps.command.protocolArgs, extraArgs: opts.extraArgs },
    deps.logger,
  )
  const commandLine = buildCommandLine(
    {
      ...deps.command,
      argsPrefix: filterLaunchPrefix(deps.command.argsPrefix, ACP_BLOCKED_ARGS, deps.logger),
    },
    args,
  )

  // Declared before the session because its cancel hook is captured at
  // construction and would otherwise close over a binding in its TDZ.
  let settleCancelled: (reason: string) => void = () => {}

  const session = new DriverSession({
    sessionId: nextSessionId(startedAt),
    agentId: opts.agent,
    startedAt,
    logger: deps.logger,
    onCancel: (reason) => settleCancelled(reason),
  })

  const child = rt.spawn({
    command: commandLine.command,
    args: commandLine.args,
    cwd: opts.cwd,
    env: deps.env,
  })
  // ABI v6: hand the kernel the pid it persists for the post-restart reap (IM-4).
  session.attachProcess(child.pid)

  deps.logger.debug('driver launched', {
    family: 'acp',
    command: commandLine.command,
    args: commandLine.args,
    fsCapability: caps.fs,
    terminalCapability: caps.terminal,
  })

  const client = new AcpClient({
    child,
    logger: deps.logger,
    now,
    caps,
    cwd: opts.cwd,
    env: deps.env,
    spawn: rt.spawn,
  })

  const usage = emptyAccumulator()
  let rawReasoning = 0
  const deliverable = new AcpDeliverable()
  let turnActivity = 0
  let accepting = false
  let promptStopReason = ''
  let promptAnswered = false
  let promptError = ''
  let upstreamError = ''
  let promptResult: unknown
  let hardTimer: NodeJS.Timeout | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let terminalReason: 'none' | 'cancelled' | 'timeout' | 'idle' = 'none'
  const stderrTail = { value: '' }

  client.acceptUpdate = () => accepting
  client.onActivity = () => {
    turnActivity++
    markActivity()
  }
  client.onUpdate = (type, update) => {
    switch (type) {
      case 'agent_message_chunk':
        handleTextChunk(session, now, deliverable, update)
        break
      case 'agent_thought_chunk':
        handleThoughtChunk(session, now, update)
        break
      case 'tool_call':
        handleToolCall(session, now, deliverable, update)
        break
      case 'tool_call_update':
        handleToolCallUpdate(session, now, update)
        break
      case 'usage_update': {
        const snapshot = parseAcpUsage(update['usage'])
        rawReasoning = Math.max(rawReasoning, snapshot.rawReasoning)
        mergeInto(usage, snapshot)
        break
      }
      case 'session_info_update' as AcpUpdateType:
      case 'config_option_update':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'plan':
        // Real state the model benefits from seeing, but not an answer: mapped
        // to `status` rather than dropped, and deliberately NOT to `text` so it
        // can never become the deliverable.
        session.push(
          event(now, 'status', {
            content: `${type.replace(/_/g, ' ')}${describeUpdate(update)}`,
          }),
        )
        break
      default:
        // A genuinely unknown update is preserved as `log` rather than invented
        // as text or silently dropped (invariant: no new AgentMessageType).
        session.push(event(now, 'log', { content: `acp update: ${JSON.stringify(update).slice(0, 500)}` }))
        break
    }
  }
  client.onPermission = (selection, params) => {
    const p = asRecord(params)
    const toolCall = p === undefined ? undefined : asRecord(p['toolCall'])
    session.push(
      event(now, 'status', {
        content: selection.grant
          ? `permission granted (${selection.optionId})`
          : `permission denied (${selection.optionId})`,
        ...(toolCall === undefined ? {} : { tool: asString(toolCall['title']) ?? undefined }),
      }),
    )
  }
  client.onNotification = (method, params) => {
    deps.logger.debug('acp: vendor notification', { method, params: JSON.stringify(params).slice(0, 200) })
  }

  // Attach the reader BEFORE anything is written (see the module header).
  client.start()

  // RR-MI-7: a stream-limit breach is a terminal condition, not bookkeeping.
  // `dead` is read by nobody and rejecting the pending requests is a no-op when
  // the run is not awaiting one, so settle through the same failure path the
  // handshake uses — it disposes the client (engine-owned terminals included)
  // and kills the group. `failBeforePrompt` is a hoisted declaration below.
  client.onOverflow = (overflow) => {
    void failBeforePrompt(`acp stream overflowed: ${overflow.message}`)
  }

  function clearTimers(): void {
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    hardTimer = undefined
    idleTimer = undefined
  }

  function finishOnce(result: AgentResult): void {
    if (session.result !== undefined) return
    clearTimers()
    signal.removeEventListener('abort', onAbort)
    session.finish(result)
  }

  function requestTerminal(reason: 'cancelled' | 'timeout' | 'idle', message: string): void {
    if (terminalReason !== 'none') return
    terminalReason = reason
    client.cancelPending(message)
    finishOnce({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status: reason === 'cancelled' ? 'cancelled' : 'timeout',
      exitCode: null,
      text: '',
      error: message,
      durationMs: now() - startedAt,
      ...(client.sessionId === '' ? {} : { backendSessionId: client.sessionId }),
    })
    void child.terminate().catch(() => {})
  }

  settleCancelled = (reason: string) => {
    requestTerminal('cancelled', reason === '' ? 'execution cancelled' : reason)
  }

  // Caller-supplied windows are clamped to the runtime's timer ceiling: an
  // over-large delay is silently rewritten to 1 ms by `setTimeout`, which would
  // turn "no deadline" into an immediate timeout that kills the engine and
  // mislabels the run (RR-MI-5).
  const hardTimeoutMs =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? clampTimerDelay(opts.timeoutMs) : 0
  if (hardTimeoutMs > 0) {
    hardTimer = setTimeout(() => {
      requestTerminal('timeout', `acp timed out after ${hardTimeoutMs}ms`)
    }, hardTimeoutMs)
  }

  const idleTimeoutMs = clampTimerDelay(opts.idleTimeoutMs ?? DEFAULT_ACP_IDLE_TIMEOUT_MS)
  function markActivity(): void {
    if (idleTimeoutMs <= 0 || terminalReason !== 'none') return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      requestTerminal('idle', `acp produced no output for ${idleTimeoutMs}ms`)
    }, idleTimeoutMs)
  }
  markActivity()

  function onAbort(): void {
    requestTerminal('cancelled', 'execution cancelled')
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    stderrTail.value = (stderrTail.value + text).slice(-STDERR_TAIL_BYTES)
  })
  // Swallow stream errors: an unhandled 'error' event would take the host down
  // when the child dies mid-write.
  child.stderr.on('error', () => {})
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})

  // ── the conversation, on a detached task (invariant 1) ──
  void (async () => {
    // 1. Handshake. The client capabilities advertised here are exactly the ones
    //    the handlers above will actually serve: never advertise, then refuse.
    const initParams: Record<string, unknown> = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: 'dsh-agents-bridge', version: '0.1.0' },
      clientCapabilities: {},
    }
    if (caps.fs || caps.terminal) {
      initParams['clientCapabilities'] = {
        ...(caps.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
        ...(caps.terminal ? { terminal: true } : {}),
      }
    }

    let initResult: unknown
    try {
      initResult = await client.request('initialize', initParams)
    } catch (err) {
      // A missing binary or a refused launch surfaces here as a closed stream,
      // because the reader dies before any response arrives. Attach the spawn
      // error so the message names the REAL cause (ENOENT, EACCES, …) instead
      // of only the symptom.
      const spawnError = await child.exited
        .then((e) => e.error)
        .catch(() => undefined)
      return failBeforePrompt(
        spawnError === undefined
          ? `acp initialize failed: ${errorText(err)}`
          : `acp initialize failed: ${spawnError}`,
      )
    }

    const authMethods = extractAuthMethods(initResult)
    if (authMethods.length > 0) {
      deps.logger.info('acp engine advertises auth methods', { authMethods })
      if (authMethod === undefined) {
        // Reported, not guessed: picking a login flow is the user's decision.
        session.push(
          event(now, 'status', {
            content:
              `engine requires authentication; it accepts: ${authMethods.join(', ')}. ` +
              `Set ${ACP_AUTH_METHOD_ENV} to one of these to have the bridge authenticate.`,
          }),
        )
      } else if (!authMethods.includes(authMethod)) {
        return failBeforePrompt(
          `acp engine does not offer auth method ${JSON.stringify(authMethod)}; ` +
            `it accepts: ${authMethods.join(', ')}`,
        )
      } else {
        try {
          await client.request('authenticate', { methodId: authMethod })
        } catch (err) {
          return failBeforePrompt(`acp authenticate failed: ${errorText(err)}`)
        }
      }
    }

    // 2. Session. `session/resume` when the caller pinned an id, else `session/new`.
    const cwd = opts.cwd ?? process.cwd()
    let sessionResult: unknown
    try {
      if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== '') {
        const resumed = await client.request('session/resume', {
          cwd,
          sessionId: opts.resumeSessionId,
          mcpServers: [],
        })
        sessionResult = resumed
        client.sessionId = extractSessionId(resumed) || opts.resumeSessionId
      } else {
        const created = await client.request('session/new', {
          cwd,
          mcpServers: [],
          ...(opts.model === undefined || opts.model === '' ? {} : { model: opts.model }),
        })
        sessionResult = created
        client.sessionId = extractSessionId(created)
        if (client.sessionId === '') {
          return failBeforePrompt('acp session/new returned no session id')
        }
      }
    } catch (err) {
      const rpc = opts.resumeSessionId === undefined ? 'session/new' : 'session/resume'
      return failBeforePrompt(`acp ${rpc} failed: ${errorText(err)}`)
    }

    session.push(
      event(now, 'status', {
        content: `session ${client.sessionId} ready`,
      }),
    )
    // ABI v6: the ACP session id is established by the handshake, before the
    // prompt is sent — publish it now so the kernel persists the resume pointer
    // even if the host restarts mid-turn (IM-5).
    session.pinBackendSessionId(client.sessionId)

    // 2b. Reasoning effort, best effort. A session that advertises no effort
    //     option is normal (most runtimes do not) and must not fail the run; a
    //     level the session does not offer is skipped rather than sent, because
    //     an unadvertised token invites a hard error on a call whose failure we
    //     deliberately swallow.
    if (opts.effort !== undefined && opts.effort !== '') {
      const option = extractEffortOption(sessionResult)
      if (option === undefined) {
        deps.logger.warn('acp session advertises no reasoning-effort option; running without it', {
          requested: opts.effort,
        })
      } else if (!option.values.includes(opts.effort)) {
        deps.logger.warn('acp session does not advertise the requested effort; running without it', {
          requested: opts.effort,
          advertised: option.values.join(','),
        })
      } else {
        try {
          await client.request('session/set_config_option', {
            sessionId: client.sessionId,
            configId: option.configId,
            value: opts.effort,
          })
        } catch (err) {
          // Never fatal: the prompt runs at the runtime's own default.
          deps.logger.warn('acp runtime rejected the effort request; running anyway', {
            requested: opts.effort,
            error: errorText(err),
          })
        }
      }
    }

    // 3. The prompt. The update gate opens only here, so any history replay the
    //    engine flushes during setup is dropped instead of duplicated into the
    //    transcript.
    session.push(event(now, 'status', { content: 'running' }))
    accepting = true
    try {
      promptResult = await client.request('session/prompt', {
        sessionId: client.sessionId,
        prompt: [{ type: 'text', text: opts.prompt }],
      })
      const record = asRecord(promptResult)
      promptStopReason = record === undefined ? '' : (asString(record['stopReason']) ?? '')
      if (record !== undefined) {
        // Runtimes disagree about where per-turn metering lives; the standard
        // top-level `usage` is authoritative and `_meta` fills the gaps.
        const snapshot = promptResultUsage(record)
        rawReasoning = Math.max(rawReasoning, snapshot.rawReasoning)
        mergeInto(usage, snapshot)
        upstreamError = acpFailureDetail(record)
      }
      markActivity()
    } catch (err) {
      promptError = errorText(err)
    }
    promptAnswered = promptError === ''
    // 3b. Drain the tail. The turn's final chunk legitimately arrives AFTER the
    //     prompt response (multica's late-notification test), so concluding at
    //     the response boundary would drop the answer.
    await drainNotifications(client, opts, deps)

    // 4. Settle. Close the engine's stdin and give it a bounded window to exit:
    //    an ACP engine is a PERSISTENT SERVER that keeps running after a turn,
    //    so awaiting its exit without signalling EOF would hang the run forever
    //    (measured against the real engine and against the fixture peer).
    accepting = false
    const exitedCleanly = await client.shutdown(ACP_SHUTDOWN_GRACE_MS)
    if (!exitedCleanly) {
      deps.logger.debug('acp: engine ignored stdin EOF; forcing shutdown', {
        graceMs: ACP_SHUTDOWN_GRACE_MS,
      })
      void child.terminate().catch(() => {})
    }
    const exit: ProcessExit = await child.exited.catch(() => ({
      code: null,
      signal: null,
      error: 'process exit unavailable',
    }))

    if (terminalReason !== 'none' || session.result !== undefined) {
      // Cancel/timeout already settled; make sure the group is gone so nothing
      // outlives the transcript. `dispose()` owns the TERMINALS the engine
      // created (each in its own group), which `child.terminate()` cannot reach
      // — an engine that never releases one would otherwise leak it (IM-15).
      await client.dispose()
      void child.terminate().catch(() => {})
      return
    }

    const { deliverableText } = deliverable.result()
    const diagnosis = stderrDiagnosis(stderrTail.value)

    let status: AgentResult['status'] = 'completed'
    let errMsg = ''

    if (promptError !== '') {
      status = 'failed'
      errMsg = `acp session/prompt failed: ${promptError}`
    } else if (ACP_FAILURE_STOP_REASONS.has(promptStopReason)) {
      // MEASURED (not inferred): a host with no credential answers a real ACP
      // prompt with exit code 0 and `stopReason: "refusal"`, carrying the actual
      // 401 only in `_meta`. Treating `refusal` as a normal outcome would report
      // a dead credential as a completed turn in which the model declined.
      status = 'failed'
      errMsg =
        upstreamError !== ''
          ? upstreamError
          : `acp turn ended with stopReason "${promptStopReason}"`
    } else if (exit.error !== undefined) {
      status = 'failed'
      errMsg = `acp failed to start: ${exit.error}`
    } else if (!promptAnswered) {
      status = 'failed'
      errMsg =
        diagnosis !== ''
          ? `acp stream ended without a prompt response: ${diagnosis}`
          : 'acp stream ended without a prompt response'
    } else if ((exit.code ?? 0) !== 0) {
      status = 'failed'
      const detail = `exit status ${exit.code ?? 'null'}${exit.signal === null ? '' : ` (signal ${exit.signal})`}`
      errMsg = diagnosis !== '' ? `${detail}: ${diagnosis}` : `acp exited with error: ${detail}`
    }
    if (status !== 'completed' && errMsg !== '' && diagnosis !== '' && !errMsg.includes(diagnosis)) {
      errMsg = `${errMsg}: ${diagnosis}`
    }

    // Both exits dispose the client: it is the ONLY owner of the terminal
    // children the engine asked us to spawn (each in its own detached group),
    // and settle-time `child.terminate()` only reaches the engine itself. The
    // engine is free to create a terminal and never release it; the run ending
    // must still leave no process behind (IM-15).
    await client.dispose()

    finishOnce({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status,
      exitCode: exit.code,
      // Failed runs report no text, so a partial transcript cannot be mistaken
      // for a final answer.
      text: status === 'completed' ? deliverableText : '',
      ...(errMsg === '' ? {} : { error: errMsg }),
      ...(toAgentUsage(usage, rawReasoning) === undefined ? {} : { usage: toAgentUsage(usage, rawReasoning) }),
      durationMs: now() - startedAt,
      ...(client.sessionId === '' ? {} : { backendSessionId: client.sessionId }),
    })
    deps.logger.debug('acp run settled', {
      status,
      stopReason: promptStopReason,
      activity: turnActivity,
    })
  })()

  /**
   * Settle a run that never reached the prompt (initialize / auth / session/new
   * failure) — and the overflow exit, which takes this path too.
   *
   * Every EXIT of `runAcp` disposes the client, and this one used to be the
   * exception: an engine that created a terminal and then failed `session/new`
   * left that terminal's process group running past `handle.done` (RR-IM-6).
   * Disposal is AWAITED before `finishOnce`, so the caller's `done` really does
   * mean "nothing this run started is still alive". `dispose()` is idempotent,
   * so an exit that also passes the post-prompt disposal is unaffected.
   */
  async function failBeforePrompt(message: string): Promise<void> {
    accepting = true
    await client.dispose()
    void child.terminate().catch(() => {})
    finishOnce({
      sessionId: session.sessionId,
      agentId: opts.agent,
      status: 'failed',
      exitCode: null,
      text: '',
      error: message,
      durationMs: now() - startedAt,
      ...(client.sessionId === '' ? {} : { backendSessionId: client.sessionId }),
    })
  }

  return session
}

/**
 * Wait out the post-response notification tail.
 *
 * Returns as soon as any of these is true, so a peer that holds stdout open
 * forever costs the hard bound, never a hang: no notification for the quiet
 * window, the reader finished, the hard bound elapsed, or the run was
 * cancelled.
 */
async function drainNotifications(
  client: AcpClient,
  opts: AgentRunOptions,
  deps: DriverDeps,
): Promise<void> {
  const quiet = ACP_NOTIFICATION_QUIET_MS
  const hard = Math.max(
    quiet,
    Math.min(ACP_NOTIFICATION_DRAIN_MAX_MS, opts.idleTimeoutMs ?? ACP_NOTIFICATION_DRAIN_MAX_MS),
  )
  let last = Date.now()
  const previous = client.onActivity
  client.onActivity = () => {
    previous()
    last = Date.now()
  }
  const deadline = last + hard
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(quiet, 50)))
    if (Date.now() - last >= quiet) return
    if (Date.now() >= deadline) {
      deps.logger.debug('acp: notification drain hit its hard bound')
      return
    }
  }
}

// ── event handlers ──────────────────────────────────────────────────────────

/**
 * Tracks which text block is the ANSWER.
 *
 * ACP runtimes stream interim narration ("Let me check the logs first…") and the
 * final answer as the same `agent_message_chunk` type, and a tool call is the
 * only boundary they expose — so the deliverable is the text emitted after the
 * latest tool call, falling back to the last non-empty block when a turn ends ON
 * a tool call (multica `acp_deliverable.go`). The full text is retained because
 * provider-error detection must keep reading every chunk.
 */
export class AcpDeliverable {
  #full = ''
  #deliverable = ''
  #lastTextBlock = ''

  observeText(text: string): void {
    this.#full += text
    this.#deliverable += text
  }

  observeToolCall(): void {
    if (this.#deliverable.trim() !== '') this.#lastTextBlock = this.#deliverable
    this.#deliverable = ''
  }

  result(): { deliverableText: string; fullText: string } {
    const deliverableText =
      this.#deliverable.trim() === '' ? this.#lastTextBlock : this.#deliverable
    return { deliverableText, fullText: this.#full }
  }
}

function contentText(update: Record<string, unknown>): string {
  const content = asRecord(update['content'])
  if (content === undefined) return ''
  // ACP sends a content block; some runtimes inline the text directly.
  const nested = asString(content['text'])
  if (nested !== undefined) return nested
  return ''
}

function handleTextChunk(
  session: DriverSession,
  now: () => number,
  deliverable: AcpDeliverable,
  update: Record<string, unknown>,
): void {
  const text = contentText(update)
  if (text === '') return
  deliverable.observeText(text)
  session.push(event(now, 'text', { content: text }))
}

function handleThoughtChunk(
  session: DriverSession,
  now: () => number,
  update: Record<string, unknown>,
): void {
  const text = contentText(update)
  if (text === '') return
  // Deliberately NOT fed to the deliverable: reasoning is not the answer.
  session.push(event(now, 'thinking', { content: text }))
}

function handleToolCall(
  session: DriverSession,
  now: () => number,
  deliverable: AcpDeliverable,
  update: Record<string, unknown>,
): void {
  const callId = asString(update['toolCallId']) ?? ''
  const title = asString(update['title']) ?? ''
  const kind = asString(update['kind']) ?? ''
  const name = asString(update['name']) ?? ''
  const tool = toolNameFromTitle(title, kind, name)

  // A tool call is the deliverable boundary: whatever text came before it was
  // narration, not the answer.
  deliverable.observeToolCall()

  const input =
    asRecord(update['rawInput']) ?? asRecord(update['input']) ?? asRecord(update['parameters'])
  session.push(
    event(now, 'tool_use', {
      tool,
      callId,
      ...(input === undefined ? {} : { input }),
    }),
  )
}

function handleToolCallUpdate(
  session: DriverSession,
  now: () => number,
  update: Record<string, unknown>,
): void {
  const status = (asString(update['status']) ?? '').toLowerCase()
  if (status !== 'completed' && status !== 'failed') return
  const callId = asString(update['toolCallId']) ?? ''
  const rawOutput = update['rawOutput'] ?? update['output']
  const output =
    rawOutput === undefined || rawOutput === null
      ? extractToolCallText(update['content'])
      : rawText(rawOutput)
  session.push(
    event(now, 'tool_result', {
      callId,
      output: status === 'failed' && output === '' ? 'tool call failed' : output,
    }),
  )
}

/** One short line describing a state-only update, for a `status` event. */
function describeUpdate(update: Record<string, unknown>): string {
  const parts: string[] = []
  const mode = asString(update['currentModeId']) ?? asString(update['current_mode_id'])
  if (mode !== undefined && mode !== '') parts.push(mode)
  const commands = update['availableCommands']
  if (Array.isArray(commands)) parts.push(`${commands.length} commands`)
  const options = update['configOptions']
  if (Array.isArray(options)) parts.push(`${options.length} config options`)
  return parts.length === 0 ? '' : `: ${parts.join(', ')}`
}

/** Filter the codex/ACP stderr noise down to something worth reporting. */
function stderrDiagnosis(tail: string): string {
  if (tail.trim() === '') return ''
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !/^\s*(at |\^|node:internal)/.test(l))
  if (lines.length === 0) return ''
  return lines.slice(-3).join(' | ').slice(0, 500)
}

export function createAcpBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'acp',
    run: (opts, runDeps, signal) => runAcp(opts, runDeps, signal, resolveRuntime(rt)),
  }
}
