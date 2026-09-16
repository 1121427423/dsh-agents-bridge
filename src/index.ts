/**
 * dsh-agents-bridge — plugin entry.
 *
 * Exposes local agent CLIs (Claude Code, CodeBuddy/WorkBuddy, OpenClaw/AutoClaw,
 * and any configured generic argv CLI) to the DSH main agent as six tools:
 * `agents_probe`, `agents_run`, `agents_status`, `agents_output`,
 * `agents_cancel`, `agents_send`.
 *
 * Layering (see docs/design.md §2): this file is the only place that knows all
 * three layers. It builds the kernel (`createAgentManager`) and injects the
 * driver factory (`createBackend`) into it, so the kernel never imports
 * `src/drivers/**` and drivers never import the kernel — neither can be tested
 * in isolation otherwise.
 *
 * The lifetime rule that makes the whole design work: a run is a MINUTES-long
 * child process while a tool call has a cooperative timeout budget, so
 * `agents_run` returns as soon as the child is spawned and the model polls
 * `agents_output`. Nothing in this file may await a session's `done` promise.
 *
 * @module dsh-agents-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { createBackend } from './drivers/index.ts'
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
 * Only `tools` and `systemPrompt` are declared. The command registry
 * (`commands`) is deliberately NOT here: cordis marks a plugin INACTIVE when an
 * inject-listed service is unmounted, and a host without a command registry
 * must still get the six agent tools. The smoke command resolves `commands`
 * lazily and skips itself when it is absent.
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
}

/**
 * Build the manager, register the tool surface and the prompt section, and tie
 * everything to this fiber's lifetime.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const logger: BridgeLogger = createLogger('dsh-agents-bridge')

  // Wire the kernel's process factory into the drivers' runtime seam BEFORE any
  // manager can start a run. Drivers resolve it lazily, so without this the
  // first `agents_run` fails with "no driver runtime installed". Idempotent, and
  // intentionally outside the effect: it is process-global wiring, not a
  // resource this fiber owns (see src/integrate.ts).
  installDriverRuntime()

  const managerOptions: ManagerOptions = {
    logger,
    // `createBackend` is the seam that keeps the kernel free of driver imports:
    // the kernel asks for a family, the entry decides what implements it.
    createBackend,
    ...(config.overrides === undefined ? {} : { overrides: config.overrides }),
    ...(config.descriptors === undefined ? {} : { extraDescriptors: config.descriptors }),
    ...(config.storeDir === undefined ? {} : { storeDir: config.storeDir }),
    ...(config.defaultCwd === undefined ? {} : { defaultCwd: config.defaultCwd }),
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
      text: buildPromptSection(configuredIds),
    })

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
      // `void`: the effect disposer is synchronous by contract; disposal of the
      // child process groups continues in the background and is not awaited
      // (awaiting it would make plugin unload wait on a kill grace window).
      void manager.dispose()
    }
  }, 'agents-bridge.register()')

  // Logged rather than thrown: a deployment that has no agent CLI installed is
  // still a working plugin — `agents_probe` reports the empty surface and the
  // model learns the boundary (see docs/design.md §3, type ③).
  logger.info('dsh-agents-bridge loaded', { tools: TOOL_NAMES.length, configuredIds })
}

/**
 * Assemble the prompt section the model reads before choosing a tool.
 *
 * Written as one short statement per decision the model has to make (discover,
 * choose, run, poll, stop) rather than a tool catalogue: the tool schemas
 * already describe the parameters, and a second catalogue in the prompt only
 * costs context and invites drift.
 *
 * @param configuredIds - identities named by this deployment's config row.
 */
export function buildPromptSection(configuredIds: readonly string[] = []): string {
  const lines = [
    'Agent bridge: this host can drive other agent CLIs installed locally — `claude` (Claude Code), `workbuddy` (CodeBuddy/WorkBuddy), `autoclaw`/`openclaw` (OpenClaw/AutoClaw), plus any generic CLI configured for this plugin. They run as separate processes with their own tools and their own conversation; none of them can see this conversation, so every prompt must be self-contained.',
    'When to delegate: long multi-step work you want kept out of this context (a build-and-fix loop in another repo), two or more independent tasks that should run in parallel, a task better served by a different vendor\'s model, or work in a directory you do not want to disturb here. Do not delegate a one-command check you can do yourself.',
    'How: call agents_probe once to see which identities are actually available, and why an unavailable one is unavailable (a sealed desktop app reports its boundary instead of silently vanishing). Then agents_run — it returns a sessionId IMMEDIATELY and never waits for the task, because these tasks take minutes and a tool call does not.',
    'Then poll agents_output with the returned sessionId: read with sinceIndex=0 first, and pass back the nextIndex it returns on every later call so you only receive new events. Use agents_status for a cheap liveness check, agents_cancel to stop a run (it kills the whole process group, not just the parent), and agents_send to continue a finished conversation when the dialect supports resume.',
  ]
  if (configuredIds.length > 0) {
    lines.push(`Identities named by this deployment's config: ${configuredIds.join(', ')}. Confirm them with agents_probe before the first run — being listed in config is not the same as being installed.`)
  }
  lines.push(`Tools: ${TOOL_NAMES.join(', ')}. Smoke command: /${HELLO_COMMAND_NAME}.`)
  return lines.join('\n')
}

export { createToolDefinitions, registerTools, HELLO_COMMAND_NAME, registerSmokeCommand }
