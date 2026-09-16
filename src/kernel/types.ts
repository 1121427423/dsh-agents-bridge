/**
 * dsh-agents-bridge — FROZEN KERNEL CONTRACTS.
 *
 * This file is the seam between the three parallel workstreams:
 *   A. kernel   — registry / spawn / session / manager / watchdog / store
 *   B. drivers  — protocol dialects (claude stream-json, codebuddy, openclaw, generic argv)
 *   C. surface  — plugin entry + model-facing tools (`ctx.tools.register`)
 *
 * RULE: treat every exported type here as an ABI. Do not rename or reshape a
 * field to make an implementation easier — propose a change in docs/plan.md
 * instead. Ported in spirit from multica `server/pkg/agent/agent.go`
 * (`Backend.Execute → *Session`, unified `Message` stream, `TokenUsage`).
 *
 * ── ABI CHANGELOG ─────────────────────────────────────────────────────────
 *  v1  initial contracts (workstreams A/B/C).
 *  v2  + `AgentTrack` and the REQUIRED `AgentDescriptor.track`: the CLI track
 *      and the desktop track are two different implementations of "establish
 *      and launch an engine", and the split is explicit data, never inferred
 *      from the protocol family (openclaw exists on both tracks). Additive
 *      otherwise: `CommandSpec.searchPath`, `ProbeResult.track` / `.health` /
 *      `.models`, `ProtocolFamily` += 'codex'. Only `track` is breaking, and
 *      the compiler flags every descriptor that lacks it.
 *  v3  + `ProtocolFamily` += 'acp' (decision D24): one ACP driver serves the
 *      12+ CLIs that speak the Agent Client Protocol, so adding one of those is
 *      a descriptor, not a dialect. Purely additive — no existing field changes
 *      meaning, and every v2 descriptor still compiles unchanged. Three new
 *      OPTIONAL fields come with it:
 *        - `CommandSpec.protocolArgs`: the argv tokens that select the wire
 *          protocol (`['--acp']`). Needed because the SAME binary is two
 *          identities (`codebuddy-code` speaks both the codebuddy stream-json
 *          dialect and ACP), and "which protocol did this identity select" is
 *          launch data — hard-coding the flag inside the ACP driver would bind a
 *          protocol family to one vendor's spelling.
 *        - `AgentDescriptor.capabilities.clientTools`: whether the engine asks
 *          the CLIENT to serve `fs/*` and `terminal/*`. ACP lets the agent call
 *          back into us to read/write files and run processes, so this is an
 *          authority question worth stating in data rather than discovering at
 *          runtime.
 *        - `ProbeResult.authMethods`: the `authMethods` ids an ACP engine
 *          advertises in its `initialize` result. "Which login does this
 *          engine accept" is not expressible with `AgentHealth` alone.
 *      The union widening is the only non-additive part, and it is the
 *      desirable one: the two `switch (family)` sites are exhaustive, so the
 *      compiler names every place that must serve the new family instead of
 *      letting a missing case fall through to `generic` and launch the wrong
 *      CLI with the wrong flags.
 *
 * @module dsh-agents-bridge/kernel/types
 */

/** Stable identity of one launchable agent CLI (an "identity", not a protocol). */
export type AgentId = string

/**
 * Protocol family: the wire dialect a driver knows how to speak. Several agent
 * identities may share one family (multica's "identity fork" concept: WorkBuddy
 * ships a CodeBuddy binary, both speak the claude stream-json dialect).
 *
 * `'acp'` (ABI v3, D24) is the Agent Client Protocol — JSON-RPC 2.0 framed as
 * NDJSON over the child's stdin/stdout. It is the one family here that is a
 * cross-vendor standard rather than a vendor dialect, which is why it is the
 * family that unlocks the most identities per line of driver code.
 */
export type ProtocolFamily = 'claude' | 'codebuddy' | 'codex' | 'openclaw' | 'acp' | 'generic'

/**
 * Integration track: HOW the bridge obtains a launchable engine. This is a
 * separate axis from `ProtocolFamily` (the wire dialect), and the two tracks
 * are implemented independently — a fix or a policy in one must never leak
 * into the other (design decision D21).
 *
 *  - `cli`     — a standalone binary the user installed themselves, resolved
 *                through PATH plus an explicit `CommandSpec.searchPath`
 *                (verified: a GUI-launched DSH inherits a minimal PATH, so a
 *                bare `claude` resolves to nothing while `/usr/local/bin/claude`
 *                exists). Auth belongs to that CLI's own config; the bridge
 *                reads status but never holds or forwards a credential.
 *  - `desktop` — an engine owned by a desktop app: launched from an absolute
 *                path inside the bundle, reusing the app's login/session,
 *                sometimes behind a per-app profile. Never PATH-resolved.
 */
export type AgentTrack = 'cli' | 'desktop'

/** How the bridge reaches an engine. v1 implements `spawn`; `connect` is reserved. */
export type TransportMode = 'spawn' | 'connect'

/**
 * How to launch one engine.
 *
 * `interpreter` exists because some desktop apps ship their engine as a
 * `#!/usr/bin/env node` script while `node` itself is NOT on PATH (verified on
 * this machine: WorkBuddy's bundled `cli/bin/codebuddy` fails with
 * `env: node: No such file or directory`). When `interpreter` is set the argv is
 * `[interpreter, executable, ...argsPrefix, ...perRunArgs]`.
 */
export interface CommandSpec {
  /** Absolute path (preferred) or bare name resolved through PATH. */
  readonly executable: string
  /** Optional interpreter prepended to argv (e.g. an app-bundled node binary). */
  readonly interpreter?: string
  /** Fixed argv inserted before per-run arguments (e.g. `['agent']`, `['--profile','p']`). */
  readonly argsPrefix?: readonly string[]
  /**
   * Argv tokens that select this identity's WIRE PROTOCOL (`['--acp']`),
   * inserted after `argsPrefix` and before the driver's own per-run args
   * (ABI v3).
   *
   * Exists because one binary can expose two protocols: `codebuddy-code` speaks
   * the codebuddy stream-json dialect by default and ACP when given `--acp`, so
   * the bridge registers it as two identities over one binary. Putting the token
   * here keeps the ACP driver vendor-neutral — a second ACP identity
   * (`hermes acp`, `kimi --acp`) declares its own spelling instead of the driver
   * guessing one and thereby only ever driving the first vendor it was written
   * for.
   */
  readonly protocolArgs?: readonly string[]
  /** Extra environment variables for the child process. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * `cli` track only: extra directories searched for a bare `executable`,
   * in order, BEFORE the inherited PATH. Exists because version-manager and
   * per-user installs (`~/.nvm/.../bin`, `~/.local/bin`, `/usr/local/bin`) are
   * routinely absent from the PATH of a GUI-launched host process, which would
   * otherwise make `probe` report an installed engine as unavailable.
   */
  readonly searchPath?: readonly string[]
}

/** One agent CLI known to the bridge. */
export interface AgentDescriptor {
  readonly id: AgentId
  /**
   * Integration track (ABI v2). REQUIRED so that "which half implements this"
   * is always explicit: an engine is never silently treated as a CLI because
   * nobody filled the field in.
   */
  readonly track: AgentTrack
  readonly family: ProtocolFamily
  readonly displayName: string
  readonly command: CommandSpec
  /**
   * Environment variable prefix for path/model overrides, e.g. `AUTOCLAW` →
   * `AUTOCLAW_PATH`, `AUTOCLAW_MODEL` (multica's `MULTICA_<ID>_PATH` pattern).
   */
  readonly envPrefix?: string
  /** Project-level skills directory relative to the run cwd (informational). */
  readonly skillsDir?: string
  /** Transport this identity prefers; defaults to `spawn`. */
  readonly defaultMode?: TransportMode
  /** What the dialect supports, so the model is not offered unsupported knobs. */
  readonly capabilities?: {
    readonly resume?: boolean
    readonly model?: boolean
    readonly effort?: boolean
    readonly mcpConfig?: boolean
    /**
     * ABI v3: the engine issues `fs/*` and `terminal/*` requests back to the
     * bridge (the ACP client). False/absent means the bridge advertises no such
     * capability and the engine keeps its own tools. This is an AUTHORITY
     * statement, not a feature list: enabling it lets the driven agent read and
     * write files and start processes through us.
     */
    readonly clientTools?: boolean
  }
  /**
   * Present when the identity is known but NOT drivable (e.g. a sealed desktop
   * app). `probe` still reports it — the model must learn the boundary instead
   * of the bridge silently omitting it.
   */
  readonly unsupported?: { readonly reason: string }
  /**
   * Host-verified caveat worth surfacing to the model and the user, e.g. "on
   * this machine `claude` resolves to a reverse-engineered fork". Travels into
   * `ProbeResult.notes`; never affects launch behaviour.
   */
  readonly notes?: string
}

/**
 * Health of the two things that actually decide whether a run can work:
 * the launch (binary/interpreter found) and the credential (the engine's own
 * upstream auth is usable). `credential: 'unknown'` is the honest answer
 * whenever checking would cost a network round trip — probing is called from a
 * model-facing tool and must stay cheap.
 */
export interface AgentHealth {
  readonly launch: 'ok' | 'missing' | 'unsupported'
  /**
   * `not-applicable` = the engine authenticates some other way (e.g. a desktop
   * app's reused login). `invalid` = a credential exists but the upstream
   * rejected it in a real run; `unknown` = present but unverified.
   */
  readonly credential: 'ok' | 'missing' | 'invalid' | 'unknown' | 'not-applicable'
  /** One line of evidence for the model/human, e.g. the upstream error text. */
  readonly detail?: string
  /** Config file the status was derived from, when there is one. */
  readonly configPath?: string
}

/** Result of probing one identity on the host. */
export interface ProbeResult {
  readonly id: AgentId
  readonly displayName: string
  readonly track: AgentTrack
  readonly family: ProtocolFamily
  readonly available: boolean
  /** Resolved absolute path when found. */
  readonly executable?: string
  /** Detected CLI version when cheaply obtainable. */
  readonly version?: string
  /** Why it is unavailable / not drivable (human-readable). */
  readonly reason?: string
  readonly capabilities?: AgentDescriptor['capabilities']
  /** Launch + credential status (ABI v2). */
  readonly health?: AgentHealth
  /**
   * Model ids the engine will accept, when a per-engine catalog is readable
   * locally (decision D20). Best-effort: absent means "not discovered", which
   * is NOT the same as "the engine has no models".
   */
  readonly models?: readonly string[]
  /** Where `models` came from, for the model to explain itself. */
  readonly modelsSource?: string
  /**
   * ACP only (ABI v3): the auth method ids the engine advertised in its
   * `initialize` result (e.g. `iOA`, `external`, `internal`, `selfhosted` for
   * CodeBuddy Code). A non-empty list means the engine expects an
   * `authenticate` step before `session/new` will do anything useful; an
   * absent field means the engine needs no explicit auth.
   *
   * It is reported rather than acted on because choosing a login flow is the
   * user's decision — the bridge may only pick one when
   * `DSH_AGENTS_BRIDGE_ACP_AUTH_METHOD` names it explicitly.
   */
  readonly authMethods?: readonly string[]
  /** Verbatim caveat from the descriptor (see `AgentDescriptor.notes`). */
  readonly notes?: string
}

/** Per-run options. Mirrors the useful subset of multica's `ExecOptions`. */
export interface AgentRunOptions {
  readonly agent: AgentId
  readonly prompt: string
  /** Working directory for the child process; defaults to the bridge's cwd. */
  readonly cwd?: string
  readonly model?: string
  /** Runtime-native reasoning level; ignored by dialects that do not support it. */
  readonly effort?: string
  /** Hard wall-clock deadline. 0/undefined = no deadline (idle watchdog only). */
  readonly timeoutMs?: number
  /** No-output window before the run is failed. undefined = driver default. */
  readonly idleTimeoutMs?: number
  readonly mode?: TransportMode
  /** Resume a previous conversation when the dialect supports it. */
  readonly resumeSessionId?: string
  /** Extra CLI args appended last (driver-filtered for protocol-breaking flags). */
  readonly extraArgs?: readonly string[]
}

/** Normalized event types (multica `MessageType`, trimmed to what v1 emits). */
export type AgentMessageType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'status'
  | 'log'
  | 'error'

/** One normalized event from a running agent. */
export interface AgentMessage {
  readonly type: AgentMessageType
  /** Text and error payloads. */
  readonly content?: string
  /** Tool name for `tool_use` / `tool_result`. */
  readonly tool?: string
  readonly callId?: string
  readonly input?: unknown
  readonly output?: string
  readonly level?: 'debug' | 'info' | 'warn' | 'error'
  /** Epoch ms when the bridge observed the event. */
  readonly at: number
}

/**
 * Token accounting, mutually exclusive buckets (multica `TokenUsage`).
 *
 * `reasoningTokens` (ABI v2, additive) is DISCLOSURE, not a bucket to add up:
 * codex reports `reasoning_output_tokens` as a SUBSET of `output_tokens`, so a
 * caller summing every field would double-count. It is kept separate precisely
 * because folding it into `outputTokens` would hide how much of the spend was
 * reasoning, and dropping it would hide that the model reasoned at all.
 */
export interface AgentUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'

/** Terminal outcome of one run. */
export interface AgentResult {
  readonly sessionId: string
  readonly agentId: AgentId
  readonly status: Exclude<AgentRunStatus, 'running'>
  readonly exitCode: number | null
  /** Final assistant text, when the dialect produces one. */
  readonly text: string
  readonly error?: string
  readonly usage?: AgentUsage
  readonly durationMs: number
  /** Backend session id for a later resume, when the dialect exposes one. */
  readonly backendSessionId?: string
}

/** Cheap view of a session for status tools. */
export interface SessionSnapshot {
  readonly sessionId: string
  readonly agentId: AgentId
  readonly status: AgentRunStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly messageCount: number
  readonly lastMessage?: AgentMessage
  readonly result?: AgentResult
  /** True when a terminal state has been reached and the record will not change. */
  readonly terminal: boolean
}

/** Incremental read of a session transcript. */
export interface SessionOutput {
  readonly sessionId: string
  readonly status: AgentRunStatus
  readonly messages: readonly AgentMessage[]
  /** Pass back as `sinceIndex` for the next incremental read. */
  readonly nextIndex: number
}

/** Minimal logger seam so kernel/drivers stay host-agnostic and testable. */
export interface BridgeLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child?(scope: string): BridgeLogger
}

/** What a driver needs to launch and speak to one engine. */
export interface DriverDeps {
  readonly command: CommandSpec
  /** Merged environment for the child (process env + descriptor + overrides). */
  readonly env: Readonly<Record<string, string>>
  readonly logger: BridgeLogger
}

/** A running (or just-started) agent conversation owned by a driver. */
export interface AgentSessionHandle {
  readonly sessionId: string
  readonly agentId: AgentId
  readonly startedAt: number
  /** Full transcript buffer; the manager appends as `done` settles. */
  readonly messages: readonly AgentMessage[]
  /** Resolves exactly once, at the terminal state. */
  readonly done: Promise<AgentResult>
  /** Idempotent. Graceful signal → grace window → process-group kill. */
  cancel(reason?: string): Promise<void>
  snapshot(): SessionSnapshot
}

/** One wire dialect. Ported from multica's `Backend` interface. */
export interface AgentBackend {
  readonly family: ProtocolFamily
  run(opts: AgentRunOptions, deps: DriverDeps, signal: AbortSignal): Promise<AgentSessionHandle>
}

/** Factory exported by `src/drivers/index.ts` and consumed by the kernel. */
export type BackendFactory = (deps: DriverDeps) => AgentBackend

/** The facade the tool surface talks to (implemented by the kernel). */
export interface AgentManager {
  /** Probe every registered identity; `refresh` bypasses the probe cache. */
  probe(opts?: { readonly refresh?: boolean }): Promise<readonly ProbeResult[]>
  /** Start a run and return immediately with a live snapshot. */
  run(opts: AgentRunOptions): Promise<SessionSnapshot>
  status(sessionId: string): SessionSnapshot | undefined
  list(): readonly SessionSnapshot[]
  output(sessionId: string, opts?: { readonly sinceIndex?: number; readonly limit?: number }): SessionOutput | undefined
  cancel(sessionId: string, reason?: string): Promise<boolean>
  /** Resume a finished session's conversation with a new prompt (v1: best-effort). */
  send(sessionId: string, prompt: string): Promise<SessionSnapshot>
  dispose(): Promise<void>
}

/** Kernel construction inputs (keeps the kernel free of host imports). */
export interface ManagerOptions {
  readonly logger: BridgeLogger
  /** Overrides applied on top of the descriptor table (settings / env). */
  readonly overrides?: Readonly<Record<AgentId, Partial<AgentDescriptor>>>
  /** Extra identities discovered at runtime (e.g. from settings). */
  readonly extraDescriptors?: readonly AgentDescriptor[]
  /** Base directory for the session store; defaults under the DSH home. */
  readonly storeDir?: string
  /** Default cwd for runs that do not pass one. */
  readonly defaultCwd?: string
  /** Factory injected by the entry so the kernel never imports drivers directly. */
  readonly createBackend: (family: ProtocolFamily, deps: DriverDeps) => AgentBackend
}
