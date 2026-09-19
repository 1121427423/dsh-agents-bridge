/**
 * dsh-agents-bridge — plugin entry.
 *
 * Exposes local agent CLIs (Claude Code, CodeBuddy/WorkBuddy, OpenClaw/AutoClaw,
 * and any configured generic argv CLI) to the DSH main agent as nine tools:
 * `agents_probe`, `agents_run`, `agents_run_many`, `agents_status`,
 * `agents_wait`, `agents_output`, `agents_usage`, `agents_cancel`,
 * `agents_send`.
 *
 * Layering (see docs/design.md §2): this file is the only place that knows all
 * three layers. It builds the kernel (`createAgentManager`) and injects the
 * driver factory (`createBackend`) into it, so the kernel never imports
 * `src/drivers/**` and drivers never import the kernel — neither can be tested
 * in isolation otherwise.
 *
 * The lifetime rule that makes the whole design work: a run is a MINUTES-long
 * child process while a tool call has a cooperative timeout budget, so
 * `agents_run` returns as soon as the child is spawned and the model waits
 * through the separate `agents_wait` tool. Nothing in this file may await a
 * session's `done` promise.
 *
 * @module dsh-agents-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import {
  ACP_KEEPALIVE_ENV,
  ACP_KEEPALIVE_IDLE_DEFAULT_MS,
  createAcpBackend,
  createAcpResidentPool,
  createBackend,
} from './drivers/index.ts'
import { attachHostApi, type WebRuntimeFace, type WebServerFace } from './host/api.ts'
import { installDriverRuntime } from './integrate.ts'
import { createJobRegistrar, type JobSeat, type JobsFace } from './host/jobs.ts'
import { createLogger } from './kernel/logger.ts'
import { createAgentManager } from './kernel/manager.ts'
import type { AgentDescriptor, AgentId, BridgeLogger, ManagerOptions } from './kernel/types.ts'
import { installSettings, settingsEntryFrom, type MutableManagerOptions } from './settings.ts'
import { TOOL_NAMES, createToolDefinitions } from './tools/definitions.ts'
import { registerTools } from './tools/register.ts'
import { HELLO_COMMAND_NAME, registerSmokeCommand } from './tools/smoke.ts'

/** Cordis plugin name (also the patch row id in `cordis.patch.yml`). */
export const name = 'agents-bridge'

/**
 * Services this plugin's own fiber waits for.
 *
 * Only `tools` and `systemPrompt` are declared. Two more services are involved
 * and NEITHER may appear here:
 *
 *  - `commands` — cordis marks a plugin INACTIVE while an inject-listed service
 *    is unmounted, and a host without a command registry must still get the nine
 *    agent tools. The smoke command resolves `commands` lazily and skips itself
 *    when it is absent (design doc D16).
 *  - `webServer` — the same trap with a larger blast radius: the HTTP API only
 *    powers the Web client half, so declaring it here would cost a headless
 *    deployment all nine tools in exchange for a panel it cannot show.
 *
 * Not declaring `webServer` is necessary but NOT sufficient, and the second half
 * is the trap this plugin actually fell into: the host's web server is just
 * another row of the loader tree, so at the moment this plugin applies the
 * service frequently does not exist YET. A one-shot `ctx.get('webServer')` then
 * reads `undefined` on a host that very much has a web server — which is what
 * this entry used to do, and why the supervisor panel never mounted anywhere.
 *
 * The mechanism that satisfies both constraints is cordis SCOPE injection
 * (`ctx.inject`, see `apply` below): the callback runs only while `webServer` is
 * available, is re-run when it appears, and never gates this plugin's own fiber.
 */
export const inject = ['tools', 'systemPrompt'] as const

/** The user-facing config row for this plugin in `cordis.yml` / settings. */
export interface Config {
  /**
   * Extra agent identities discovered at runtime (from settings or a remote
   * descriptor source). Merged with — not replacing — the kernel's built-in
   * registry table.
   */
  readonly descriptors?: readonly AgentDescriptor[]
  /** Per-identity field overrides on top of the descriptor table (path, model, env). */
  readonly overrides?: Readonly<Record<AgentId, Partial<AgentDescriptor>>>
  /** Base directory for the session store; default is under the DSH home. */
  readonly storeDir?: string
  /** Default working directory for runs that pass no `cwd`. */
  readonly defaultCwd?: string

  /* ── P2 hardening knobs (all optional; unset = today's behaviour) ───────── */

  /**
   * Allow-list of directory prefixes a run's `cwd` must fall under. Both sides
   * are `realpath`-resolved before comparison, so symlink aliases (`/tmp` →
   * `/private/tmp`) cannot slip past. Unset = any directory.
   */
  readonly allowedCwd?: readonly string[]
  /** Deny-list of directory prefixes; wins over `allowedCwd`. Unset = none. */
  readonly deniedCwd?: readonly string[]
  /** Allow-list of agent ids. Unset = every identity the bridge registers. */
  readonly allowedAgents?: readonly AgentId[]
  /**
   * Maximum sessions running at once. A run that would exceed it fails
   * immediately rather than queueing. Default `DEFAULT_MAX_CONCURRENT` (4).
   */
  readonly maxConcurrent?: number
  /**
   * SIGTERM → SIGKILL grace window for cancellation, in ms. Default 5000.
   */
  readonly graceMs?: number
  /**
   * Idle time (ms) before a resident ACP engine process is parked away.
   *
   * When > 0, a completed ACP turn leaves the engine process alive and the next
   * run reuses it, skipping the cold start. Default
   * `ACP_KEEPALIVE_IDLE_DEFAULT_MS` (1h); `<= 0` disables residency (every run
   * spawns fresh, the pre-residency behaviour). Overridable per deployment with
   * `DSH_AGENTS_BRIDGE_ACP_KEEPALIVE_MS`.
   */
  readonly acpKeepAliveMs?: number
  /**
   * Which wire drives the standalone Qoder CN CLI (`qoderclicn`).
   *
   * `'stream-json'` (the default) uses `qoderclicn -p --output-format
   * stream-json`; `'acp'` uses `qoderclicn --yolo --acp`. BOTH implementations
   * are kept — the switch only decides which one is OFFERED, and the other
   * reports as unavailable with a reason naming this setting, so flipping it
   * brings the row straight back.
   *
   * It defaults to stream-json because Qoder's ACP `session/prompt` began
   * answering an upstream 500 for every client (reproduced with multica's own
   * call sequence), while the headless mode answers normally. The desktop row
   * `qoder-cn` is always ACP and is NOT affected by this switch. Overridable per
   * deployment with `DSH_AGENTS_BRIDGE_QODER_TRANSPORT`.
   */
  readonly qoderTransport?: QoderTransport
}

/** The two wires the standalone Qoder CN CLI can be driven over. */
export type QoderTransport = 'stream-json' | 'acp'

/** Environment variable that overrides {@link Config.qoderTransport}. */
export const QODER_TRANSPORT_ENV = 'DSH_AGENTS_BRIDGE_QODER_TRANSPORT'

/** Default transport — the one that answers while ACP is failing upstream. */
export const QODER_TRANSPORT_DEFAULT: QoderTransport = 'stream-json'

/** The descriptor id each transport owns on the CLI track. */
const QODER_TRANSPORT_DESCRIPTOR: Readonly<Record<QoderTransport, AgentId>> = {
  'stream-json': 'qoderclicn-print',
  acp: 'qoderclicn',
}

/** Where a transport value could come from, and the raw text it supplied. */
interface TransportCandidate {
  readonly source: 'config' | 'env'
  readonly raw: string
}

function normaliseTransport(raw: string | undefined): string {
  return raw === undefined ? '' : raw.trim().toLowerCase()
}

function isTransportValue(value: string): value is QoderTransport {
  return value === 'stream-json' || value === 'acp'
}

/** What the switch decided, and the value it had to throw away to decide it. */
export interface QoderTransportDecision {
  readonly transport: QoderTransport
  /** Which door the winning value came through. */
  readonly from: 'config' | 'env' | 'default'
  /**
   * The first non-empty value, in precedence order, that was NOT one of the two
   * accepted literals — whichever door it came through. `apply()` warns on it.
   */
  readonly ignored?: { readonly source: 'config' | 'env'; readonly value: string }
}

/**
 * Decide the Qoder CLI transport, and report anything it had to ignore.
 *
 * Precedence: the plugin's `qoderTransport` field, then
 * `DSH_AGENTS_BRIDGE_QODER_TRANSPORT`, then stream-json. BOTH sources are
 * normalised the same way (`trim().toLowerCase()`), so a YAML row writing `ACP`
 * means ACP rather than "fall back to the default because of the case".
 *
 * MISCONFIGURATION AND PRECEDENCE ARE DIFFERENT THINGS, and this function is
 * what keeps them apart: a value that is merely SHADOWED by the other door is
 * valid — its source simply lost — so it is not reported; a value that is
 * UNUSABLE is reported no matter which door it came through. Warning about the
 * first would be noise, and noise is how a real warning gets ignored.
 */
export function decideQoderTransport(configured?: QoderTransport): QoderTransportDecision {
  const candidates: TransportCandidate[] = []
  // ANY supplied value becomes a candidate, not just a string one: a YAML type
  // slip (`qoderTransport: 1`) used to be filtered out here, which put it beyond
  // the reach of the "unusable" scan below and made it fail SILENTLY — the same
  // class of bug as a typo, one gate further out. `String(...)` is what the
  // warning reports, so the operator sees the value that was written.
  if (configured !== undefined) candidates.push({ source: 'config', raw: String(configured) })
  const envRaw = process.env[QODER_TRANSPORT_ENV]
  if (envRaw !== undefined) candidates.push({ source: 'env', raw: envRaw })

  const winner = candidates.find((candidate) => isTransportValue(normaliseTransport(candidate.raw)))
  const ignored = candidates.find((candidate) => {
    const value = normaliseTransport(candidate.raw)
    return value !== '' && !isTransportValue(value)
  })

  return {
    transport:
      winner === undefined
        ? QODER_TRANSPORT_DEFAULT
        : (normaliseTransport(winner.raw) as QoderTransport),
    from: winner === undefined ? 'default' : winner.source,
    ...(ignored === undefined ? {} : { ignored: { source: ignored.source, value: ignored.raw } }),
  }
}

/** The transport alone, for callers that do not need the decision's provenance. */
export function resolveQoderTransport(configured?: QoderTransport): QoderTransport {
  return decideQoderTransport(configured).transport
}

/**
 * Descriptor overrides that implement the switch.
 *
 * The UNSELECTED row is marked `unsupported` rather than deleted: the kernel
 * already refuses a run against such an identity with a machine-readable reason
 * and `probe` surfaces it (`launch: 'unsupported'`), so the model learns the
 * boundary instead of the bridge silently omitting an identity — and flipping
 * the setting restores it with no code change and no lost evidence.
 */
export function qoderTransportOverrides(
  transport: QoderTransport,
): Record<AgentId, Partial<AgentDescriptor>> {
  const selected = QODER_TRANSPORT_DESCRIPTOR[transport]
  const overrides: Record<AgentId, Partial<AgentDescriptor>> = {}
  for (const [other, id] of Object.entries(QODER_TRANSPORT_DESCRIPTOR)) {
    if (id === selected) continue
    overrides[id] = {
      unsupported: {
        reason:
          `not selected: qoderTransport=${transport} (env ${QODER_TRANSPORT_ENV}). ` +
          `This CLI is driven over "${transport}" right now; set the switch to "${other}" ` +
          `to use this identity instead.`,
      },
    }
  }
  return overrides
}

/**
 * Build the manager, register the tool surface and the prompt section, and tie
 * everything to this fiber's lifetime.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Scope `surface`: `createLogger` already stamps `[dsh-agents-bridge:...]`, so
  // passing the plugin name here would print it twice.
  const logger: BridgeLogger = createLogger('surface')

  // Wire the kernel's process factory into the drivers' runtime seam BEFORE any
  // manager can start a run. Drivers resolve it lazily, so without this the
  // first `agents_run` fails with "no driver runtime installed". Idempotent, and
  // intentionally outside the effect: it is process-global wiring, not a
  // resource this fiber owns (see src/integrate.ts).
  installDriverRuntime(config.graceMs)

  /**
   * ACP residency: keep a completed engine process alive so the next run skips
   * the cold start. Defaults to 1h idle; `acpKeepAliveMs <= 0` (or the
   * `DSH_AGENTS_BRIDGE_ACP_KEEPALIVE_MS=0` env) disables it, restoring the
   * one-shot behaviour. The pool is owned by this plugin fiber and torn down
   * with it.
   */
  const acpKeepAliveMs = resolveAcpKeepAliveMs(config.acpKeepAliveMs)
  const acpResident =
    acpKeepAliveMs > 0
      ? createAcpResidentPool({ idleMs: acpKeepAliveMs, logger })
      : undefined

  /**
   * Which wire the standalone Qoder CN CLI is driven over (D46).
   *
   * Both rows stay in the catalog — the switch marks the unselected one
   * `unsupported` so `probe` explains why it is not offered, and the operator
   * can flip it back with one setting. The decision itself sits BELOW, after
   * `installSettings`: the settings user layer (what the settings card writes)
   * outranks the plugin config, so it has to be consulted before the switch
   * merges its descriptor overrides.
   */
  const overrides: Record<AgentId, Partial<AgentDescriptor>> = { ...config.overrides }

  /**
   * The manager options object, kept MUTABLE on purpose.
   *
   * The settings namespace below resolves to `schema ← this composition entry ←
   * user layer`, and its values reach the kernel by writing into THIS object:
   * the manager captured it at construction, and fields it reads per call
   * (`options.defaultCwd`, `manager.ts:401`) therefore change the moment a user
   * saves. The same object is what makes the other knobs meaningful too — they
   * are snapshotted into the run policy when the manager is built
   * (`manager.ts:160-168`), so their saved value applies from the next plugin
   * load. Which is which is declared per field in `src/settings.ts` and rendered
   * by the card; a switch that does nothing would be worse than no switch.
   */
  const managerOptions: MutableManagerOptions = {
    logger,
    // `createBackend` is the seam that keeps the kernel free of driver imports:
    // the kernel asks for a family, the entry decides what implements it. The
    // ACP family gets the resident pool; every other family is untouched.
    createBackend: (family, deps) =>
      family === 'acp' ? createAcpBackend(deps, undefined, acpResident) : createBackend(family, deps),
    // Unconditional since D46: the transport switch (decided just below, once
    // the settings user layer has been consulted) always contributes one entry
    // before the manager is built, so the object the manager receives is never
    // empty. The old `length === 0` guard read as if overrides could be absent,
    // which they no longer can.
    overrides,
    ...(config.descriptors === undefined ? {} : { extraDescriptors: config.descriptors }),
    ...(config.storeDir === undefined ? {} : { storeDir: config.storeDir }),
    ...(config.defaultCwd === undefined ? {} : { defaultCwd: config.defaultCwd }),
    ...(config.allowedCwd === undefined ? {} : { allowedCwd: config.allowedCwd }),
    ...(config.deniedCwd === undefined ? {} : { deniedCwd: config.deniedCwd }),
    ...(config.allowedAgents === undefined ? {} : { allowedAgents: config.allowedAgents }),
    ...(config.maxConcurrent === undefined ? {} : { maxConcurrent: config.maxConcurrent }),
    ...(config.graceMs === undefined ? {} : { graceMs: config.graceMs }),
  }

  // BEFORE the manager is built: when the host's settings service is already up,
  // `ctx.inject` fires synchronously and the resolved user layer is in place for
  // construction. When it mounts later, the composition entry is what the manager
  // starts with and the resolved values arrive on the next change (matching the
  // per-field effect declared above).
  const settings = installSettings(ctx, managerOptions, settingsEntryFrom(config))

  /**
   * The Qoder CN CLI transport switch (D46), decided ONCE per plugin load, from
   * the settings user layer first (what the settings card writes), then the
   * plugin config field, then the env, then the default.
   *
   * The user layer outranks the plugin config because that is how EVERY field in
   * this namespace layers (`schema ← composition entry ← user layer`); reading
   * it HERE — not inside the settings scope's watcher — is also what keeps the
   * card's 下次加载生效 claim honest: a later save re-decides nothing until the
   * plugin loads again.
   *
   * The merge is FIELD-level, not key-level, and that distinction is the whole
   * point: a caller's `overrides.qoderclicn` is a legitimate two-line patch
   * (pinning the executable, say), and `{...switch, ...caller}` would let it
   * replace the switch's patch object wholesale — deleting `unsupported` and
   * silently re-enabling the row. So the switch owns exactly ONE field and the
   * caller keeps every other one.
   */
  const storedRaw = settings.read().fields.find((field) => field.key === 'qoderTransport')?.value
  // The value resolved through the port is already union-checked: `coerceField`
  // refuses anything outside the pair on the write path, and the schema is the
  // same closed union, so a string here is a transport literal (or the config
  // value the composition entry carries).
  const storedTransport = typeof storedRaw === 'string' ? (storedRaw as QoderTransport) : undefined
  const decision = decideQoderTransport(storedTransport ?? config.qoderTransport)
  const qoderTransport = decision.transport
  const qoderOverrides = qoderTransportOverrides(qoderTransport)
  for (const [id, patch] of Object.entries(qoderOverrides)) {
    overrides[id] = { ...overrides[id], ...patch }
  }
  if (decision.ignored !== undefined) {
    // A misconfigured switch must be LOUD, through ANY door — the alternative
    // is an operator who believes they selected ACP while the bridge quietly
    // kept the default. A value that merely lost the precedence contest is not
    // reported: it is valid, and warning about it would train the reader to
    // ignore this line.
    logger.warn('qoderTransport value not recognised and was ignored', {
      source: decision.ignored.source,
      value: decision.ignored.value,
      using: qoderTransport,
      accepted: ['stream-json', 'acp'],
    })
  }
  logger.info('qoder cli transport selected', {
    transport: qoderTransport,
    agent: QODER_TRANSPORT_DESCRIPTOR[qoderTransport],
    disabled: Object.keys(qoderOverrides),
    // The port resolves the composition entry too, so a stored value EQUAL to
    // the config value still counts as "config"; "settings" is claimed only
    // when the user layer actually overrode something.
    source:
      storedTransport !== undefined && storedTransport !== config.qoderTransport
        ? 'settings'
        : decision.from,
  })

  const manager = createAgentManager(managerOptions)
  /**
   * The completion-notice seam, kept MUTABLE for the same reason
   * `managerOptions` is: the `jobs` service is a loader row like any other and
   * is frequently NOT up yet when this plugin applies, so the tool definitions
   * have to be built before the registry they will use exists. The scope below
   * fills this seat in (and empties it again on unload); `agents_run` reads it
   * per call, so a run started in either state behaves correctly.
   */
  const jobSeat: JobSeat = {}
  const definitions = createToolDefinitions(manager, jobSeat)
  // Identities the CONFIG names (built-ins are the kernel registry's business).
  // Rendered into the prompt so the model knows the deployment's own ids, while
  // still being told to confirm them with agents_probe.
  const configuredIds = [...new Set([
    ...(config.descriptors ?? []).map(descriptor => descriptor.id),
    ...Object.keys(config.overrides ?? {}),
  ])]

  /**
   * Route disposer published by the scope below, closed by this plugin's own
   * effect so the route always comes off BEFORE the manager is disposed.
   *
   * `undefined` while no web server is available — which is a normal state, not
   * an error: the nine tools above do not need one.
   */
  let unmountHostApi: (() => void) | undefined

  // Everything registrable goes inside ONE effect so the disposers run in
  // reverse order on unload and nothing is left registered on a half-torn-down
  // fiber (HMR reloads included).
  ctx.effect(() => {
    const toolDisposers = registerTools(ctx, definitions)

    // Order 108: tool guidance occupies 100-199, and 107 is taken by
    // dsh-background-promotion. A static string is used rather than a provider
    // thunk: probing here would make prompt assembly run subprocesses, and the
    // model is told to call `agents_probe` for the live answer anyway.
    const section: PromptSection = {
      name: 'tool:agents-bridge',
      order: 108,
      text: buildPromptSection(configuredIds, config.allowedAgents),
    }
    const sectionDisposer = ctx.systemPrompt.section(section)

    // Optional: the smoke command needs a command registry, the tools do not.
    const smokeDisposer = registerSmokeCommand(ctx)

    return () => {
      // Unregister the tools explicitly instead of relying on fiber teardown:
      // `ctx.tools.register` hands back the exact disposer, and releasing the
      // model-visible surface first means a concurrent prompt assembly cannot
      // advertise a tool whose manager is already disposed.
      for (const dispose of toolDisposers) dispose()
      smokeDisposer?.()
      sectionDisposer()
      // Before `manager.dispose()`: a route that outlived the manager would
      // answer `cancel`/`output` against a disposed facade. Cordis unloads a
      // fiber's effects CONCURRENTLY, so the scope below cannot rely on its own
      // teardown winning that race — the handle is closed here, synchronously.
      unmountHostApi?.()
      // Tear down resident ACP engine processes before the manager goes away.
      void acpResident?.dispose()
      // `void`: the effect disposer is synchronous by contract; disposal of the
      // child process groups continues in the background and is not awaited
      // (awaiting it would make plugin unload wait on a kill grace window).
      void manager.dispose()
    }
  }, 'agents-bridge.register()')

  // The HTTP API is a SEPARATE fiber, not part of the effect above. Cordis runs
  // this callback only while `webServer` is available and unloads it again if
  // the service goes away, so the plugin's own fiber is never gated by it:
  // a host without a web server keeps all nine tools (D16), and a host whose web
  // server mounts AFTER us — which is the normal case, the web server is just
  // another loader row — still gets the panel.
  ctx.inject(['webServer'], (scoped) => {
    // `webRuntime` is genuinely optional, and read rather than injected: it only
    // widens the browser-trust fence to the non-loopback authorities this
    // deployment serves, and the route works without it (loopback only). Making
    // it a dependency would hold the whole panel back on hosts that never
    // provide one, and `dsh-web-app` provides it only after `webServer` exists.
    const webRuntime = scoped.get('webRuntime') as WebRuntimeFace | undefined
    // Guaranteed present: the scope only runs while `webServer` is available.
    // Read through `get` rather than `scoped.webServer` because the service
    // belongs to the host, not to the `Context` interface this plugin compiles
    // against (`webServer` is not part of the DSH plugin ABI we typecheck on).
    const webServer = scoped.get('webServer') as WebServerFace
    const disposeApi = scoped.effect(
      () =>
        attachHostApi({
          webServer,
          ...(webRuntime === undefined ? {} : { webRuntime }),
          manager,
          settings,
          logger,
        }),
      'agents-bridge.host-api()',
    )
    unmountHostApi = () => {
      unmountHostApi = undefined
      disposeApi()
    }
  })

  /**
   * Completion notices live on the same optional-service footing as the HTTP API
   * above, and for the same reason (D16): `jobs` is a loader row that is usually
   * NOT up yet when this plugin applies, and declaring it in `inject` would mark
   * the whole plugin INACTIVE on every host without one — costing the nine tools
   * in exchange for a notice. Scope-injected instead, so a host with no job
   * registry keeps every tool and simply gets no `jobId` back from `agents_run`.
   *
   * `createJobRegistrar` attaches the controller the registry requires before any
   * `start` can be accepted; the disposer below detaches it and empties the seat,
   * so a reload cannot leave `agents_run` holding a registrar whose registry is
   * gone.
   */
  let jobSeatFilled = false
  ctx.inject(['jobs'], (scoped) => {
    const jobs = scoped.get('jobs') as JobsFace | undefined
    if (jobs === undefined) return
    const registrar = createJobRegistrar(jobs, logger)
    jobSeat.registrar = registrar
    jobSeatFilled = true
    // The state line matters in BOTH directions. The `no job registry available
    // yet` line below is printed at apply time and is true only of that instant
    // (the `jobs` row mounts late, exactly like `webServer`, whose route is
    // mounted right after this plugin applies). Without this line, a host where
    // the scope DID fire later would be indistinguishable in the log from one
    // that never provides `jobs` at all — which is the question an operator
    // actually asks ("why did I never get a notice?").
    logger.info('job registry available: session completions will announce themselves', {
      kind: 'agents',
    })
    scoped.effect(
      () => () => {
        jobSeatFilled = false
        if (jobSeat.registrar === registrar) jobSeat.registrar = undefined
        registrar.dispose()
      },
      'agents-bridge.jobs()',
    )
  })

  // Same honesty rule as the panel line below: what is knowable is that the
  // service is not up YET, never that this host lacks one. The definitive line
  // is `session completion notices are on` from `createJobRegistrar`.
  if (!jobSeatFilled) {
    logger.info('no job registry available yet: session completions will not announce themselves (agents_run still returns a sessionId, and the nine tools are unaffected)')
  }

  // Whether the panel is mounted is knowable only as a STATE, never as a claim
  // about the host. The host's own web server is just another row of the loader
  // tree and, measured on the standalone web harness, is provided ~800 ms AFTER
  // this plugin applies — so a line asserting "this host has no web server" here
  // would be false on a host that has one, which is precisely the lie this
  // workstream removed. `unmountHostApi` is set synchronously by the scope above
  // when the service is already up (cordis resolves dependents on the spot) and
  // stays `undefined` while it is not, so the honest statement is available:
  // not mounted YET. The definitive line is `host api route mounted` from
  // `attachHostApi`; this one keeps a deployment where the panel never appears
  // diagnosable from the host log.
  if (unmountHostApi === undefined) {
    logger.info('no webServer available yet: the agent supervisor panel is not mounted (it mounts as soon as the host provides one), the nine tools are unaffected')
  }

  // Logged rather than thrown: a deployment that has no agent CLI installed is
  // still a working plugin — `agents_probe` reports the empty surface and the
  // model learns the boundary (see docs/design.md §3, type ③).
  logger.info('dsh-agents-bridge loaded', { tools: TOOL_NAMES.length, configuredIds })
}

/**
 * Resolve the ACP residency idle window.
 *
 * Precedence: the plugin's `acpKeepAliveMs` config field, then the
 * `DSH_AGENTS_BRIDGE_ACP_KEEPALIVE_MS` environment variable, then the 1h
 * default. A non-positive result disables residency.
 */
function resolveAcpKeepAliveMs(configured?: number): number {
  if (configured !== undefined && Number.isFinite(configured)) return configured
  const raw = process.env[ACP_KEEPALIVE_ENV]
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return ACP_KEEPALIVE_IDLE_DEFAULT_MS
}

/**
 * Assemble the prompt section the model reads before choosing a tool.
 *
 * Written as one short statement per decision the model has to make (delegate or
 * not, write the prompt, start, wait, read, stop) rather than a tool catalogue:
 * the tool schemas already describe the parameters, and a second catalogue in
 * the prompt only costs context and invites drift. The last line names the
 * surface so a model that only reads this section still knows the tools exist.
 *
 * Every line is a rule the model can be held to, and each one exists because
 * the alternative wastes the caller's money: delegating a one-command check,
 * sending a prompt that assumes shared context, polling `agents_output` in a
 * loop, or letting a run that went the wrong way keep burning tokens.
 *
 * @param configuredIds - identities named by this deployment's config row.
 * @param allowedAgents - when the config narrows the agent allow-list, the model
 *   is told the boundary up front instead of discovering it by being rejected.
 */
export function buildPromptSection(
  configuredIds: readonly string[] = [],
  allowedAgents?: readonly string[],
): string {
  const lines = [
    'Agent bridge: this host can drive other agent CLIs installed locally — `claude` (Claude Code), `workbuddy` (CodeBuddy/WorkBuddy), `autoclaw`/`openclaw` (OpenClaw/AutoClaw), plus any generic CLI configured for this plugin. Each runs as its own process with its own tools and its own conversation.',
    'Delegate when the work is long and multi-step and you want it out of this context, when two or more tasks are independent (run them together), when another vendor\'s model fits better, or when the work belongs in a directory you do not want to disturb here. Do NOT delegate a one-command check you can do yourself: a delegation costs a turn plus the other model\'s tokens.',
    'Write every prompt as if the other agent knows nothing. It CANNOT see this conversation, your earlier turns, or any file you read — put the absolute paths, the constraints, the acceptance criteria and the exact deliverable in the prompt itself.',
    'Discover first: agents_probe once tells you which identities are actually drivable and why an unavailable one is not. Then agents_run (one task) or agents_run_many (several independent tasks in ONE call — never N separate agents_run calls). Each returns a sessionId IMMEDIATELY and never waits for the task, because these tasks take minutes and a tool call does not.',
    'Then wait, do not poll: agents_wait returns as soon as the sessions are terminal or its timeout elapses, and a timeout there is a normal result, not an error (call it again, or read the increment). Use agents_output only when you need the transcript — read incrementally and always pass the returned nextIndex back. agents_usage totals the tokens a batch has spent.',
    'Stay in control: agents_cancel a run that is going the wrong way instead of letting it burn tokens, and agents_send to continue a finished conversation where the dialect supports resume.',
    'You only ever see normalized events (text, tool_use, tool_result, status, error). The delegated agent\'s raw transcript never enters this context, so report what agents_output returns rather than guessing at the rest.',
  ]
  if (configuredIds.length > 0) {
    lines.push(`Identities named by this deployment's config: ${configuredIds.join(', ')}. Confirm them with agents_probe before the first run — being listed in config is not the same as being installed.`)
  }
  if (allowedAgents !== undefined && allowedAgents.length > 0) {
    lines.push(`This deployment only enables: ${allowedAgents.join(', ')}. Asking for any other identity is refused before a process starts.`)
  }
  lines.push(`Tools: ${TOOL_NAMES.join(', ')}. Smoke command: /${HELLO_COMMAND_NAME}.`)
  return lines.join('\n')
}

export { createToolDefinitions, registerTools, HELLO_COMMAND_NAME, registerSmokeCommand }
export { API_PREFIX, attachHostApi, createApiRouteHandler, isTrustedApiRequest } from './host/api.ts'
