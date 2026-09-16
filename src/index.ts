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
import { createBackend } from './drivers/index.ts'
import { attachHostApi, type WebRuntimeFace, type WebServerFace } from './host/api.ts'
import { installDriverRuntime } from './integrate.ts'
import { createLogger } from './kernel/logger.ts'
import { createAgentManager } from './kernel/manager.ts'
import type { AgentDescriptor, AgentId, BridgeLogger, ManagerOptions } from './kernel/types.ts'
import { TOOL_NAMES, createToolDefinitions } from './tools/definitions.ts'
import { registerTools } from './tools/register.ts'
import { HELLO_COMMAND_NAME, registerSmokeCommand } from './tools/smoke.ts'

/** Cordis plugin name (also the patch row id in `cordis.patch.yml`). */
export const name = 'agents-bridge'

/**
 * Services read at apply time.
 *
 * Only `tools` and `systemPrompt` are declared. Two more services are resolved
 * LAZILY, and both omissions are load-bearing:
 *
 *  - `commands` — cordis marks a plugin INACTIVE when an inject-listed service
 *    is unmounted, and a host without a command registry must still get the nine
 *    agent tools. The smoke command resolves `commands` lazily and skips itself
 *    when it is absent (design doc D16).
 *  - `webServer` — same trap, larger blast radius: the HTTP API only powers the
 *    Web client half, so declaring it would cost a headless deployment all nine
 *    tools in exchange for a panel it cannot show. When it is absent the plugin
 *    logs why and registers the tools exactly as before.
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

  const managerOptions: ManagerOptions = {
    logger,
    // `createBackend` is the seam that keeps the kernel free of driver imports:
    // the kernel asks for a family, the entry decides what implements it.
    createBackend,
    ...(config.overrides === undefined ? {} : { overrides: config.overrides }),
    ...(config.descriptors === undefined ? {} : { extraDescriptors: config.descriptors }),
    ...(config.storeDir === undefined ? {} : { storeDir: config.storeDir }),
    ...(config.defaultCwd === undefined ? {} : { defaultCwd: config.defaultCwd }),
    ...(config.allowedCwd === undefined ? {} : { allowedCwd: config.allowedCwd }),
    ...(config.deniedCwd === undefined ? {} : { deniedCwd: config.deniedCwd }),
    ...(config.allowedAgents === undefined ? {} : { allowedAgents: config.allowedAgents }),
    ...(config.maxConcurrent === undefined ? {} : { maxConcurrent: config.maxConcurrent }),
    ...(config.graceMs === undefined ? {} : { graceMs: config.graceMs }),
  }

  const manager = createAgentManager(managerOptions)
  const definitions = createToolDefinitions(manager)
  // Identities the CONFIG names (built-ins are the kernel registry's business).
  // Rendered into the prompt so the model knows the deployment's own ids, while
  // still being told to confirm them with agents_probe.
  const configuredIds = [...new Set([
    ...(config.descriptors ?? []).map(descriptor => descriptor.id),
    ...Object.keys(config.overrides ?? {}),
  ])]

  // Resolved BEFORE the effect so the log line about a missing service is
  // emitted once, but consumed INSIDE it — see the note on `inject` above.
  // A host without a web server simply has no client half; the tools are
  // unaffected, which is the whole point of not declaring `webServer`.
  const webServer = ctx.get('webServer') as WebServerFace | undefined
  const webRuntime = ctx.get('webRuntime') as WebRuntimeFace | undefined

  // Everything registrable goes inside ONE effect so the disposers run in
  // reverse order on unload and nothing is left registered on a half-torn-down
  // fiber (HMR reloads included).
  ctx.effect(() => {
    const toolDisposers = registerTools(ctx, definitions)

    // Order 108: tool guidance occupies 100-199, and 107 is taken by
    // dsh-background-promotion. A static string is used rather than a provider
    // thunk: probing here would make prompt assembly run subprocesses, and the
    // model is told to call `agents_probe` for the live answer anyway.
    const sectionDisposer = ctx.systemPrompt.section({
      name: 'tool:agents-bridge',
      order: 108,
      text: buildPromptSection(configuredIds, config.allowedAgents),
    })

    // Optional: the smoke command needs a command registry, the tools do not.
    const smokeDisposer = registerSmokeCommand(ctx)

    // Optional: the HTTP API serves the Web client half only. `null` when the
    // host has no web server — the nine tools above are already registered.
    const apiDisposer = webServer === undefined
      ? null
      : attachHostApi({
          webServer,
          ...(webRuntime === undefined ? {} : { webRuntime }),
          manager,
          logger,
        })

    return () => {
      // Unregister the tools explicitly instead of relying on fiber teardown:
      // `ctx.tools.register` hands back the exact disposer, and releasing the
      // model-visible surface first means a concurrent prompt assembly cannot
      // advertise a tool whose manager is already disposed.
      for (const dispose of toolDisposers) dispose()
      smokeDisposer?.()
      sectionDisposer()
      // Before `manager.dispose()`: a route that outlived the manager would
      // answer `cancel`/`output` against a disposed facade.
      apiDisposer?.()
      // `void`: the effect disposer is synchronous by contract; disposal of the
      // child process groups continues in the background and is not awaited
      // (awaiting it would make plugin unload wait on a kill grace window).
      void manager.dispose()
    }
  }, 'agents-bridge.register()')

  if (webServer === undefined) {
    logger.info('host has no webServer: the agent supervisor panel is unavailable, the nine tools are unaffected')
  }

  // Logged rather than thrown: a deployment that has no agent CLI installed is
  // still a working plugin — `agents_probe` reports the empty surface and the
  // model learns the boundary (see docs/design.md §3, type ③).
  logger.info('dsh-agents-bridge loaded', { tools: TOOL_NAMES.length, configuredIds })
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
