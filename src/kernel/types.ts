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
 * @module dsh-agents-bridge/kernel/types
 */

/** Stable identity of one launchable agent CLI (an "identity", not a protocol). */
export type AgentId = string

/**
 * Protocol family: the wire dialect a driver knows how to speak. Several agent
 * identities may share one family (multica's "identity fork" concept: WorkBuddy
 * ships a CodeBuddy binary, both speak the claude stream-json dialect).
 */
export type ProtocolFamily = 'claude' | 'codebuddy' | 'openclaw' | 'generic'

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
  /** Extra environment variables for the child process. */
  readonly env?: Readonly<Record<string, string>>
}

/** One agent CLI known to the bridge. */
export interface AgentDescriptor {
  readonly id: AgentId
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
  }
  /**
   * Present when the identity is known but NOT drivable (e.g. a sealed desktop
   * app). `probe` still reports it — the model must learn the boundary instead
   * of the bridge silently omitting it.
   */
  readonly unsupported?: { readonly reason: string }
}

/** Result of probing one identity on the host. */
export interface ProbeResult {
  readonly id: AgentId
  readonly displayName: string
  readonly family: ProtocolFamily
  readonly available: boolean
  /** Resolved absolute path when found. */
  readonly executable?: string
  /** Detected CLI version when cheaply obtainable. */
  readonly version?: string
  /** Why it is unavailable / not drivable (human-readable). */
  readonly reason?: string
  readonly capabilities?: AgentDescriptor['capabilities']
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

/** Token accounting, mutually exclusive buckets (multica `TokenUsage`). */
export interface AgentUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
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
