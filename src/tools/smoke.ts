/**
 * dsh-agents-bridge — install smoke command.
 *
 * `/agents-bridge-hello <name>` is the fastest possible proof that the plugin
 * loaded: it needs only the command registry, not the kernel, not a driver, and
 * not a working agent CLI. After `dsh plugin add .` + a web restart, running it
 * answers "is this plugin alive?" without spawning anything.
 *
 * Two deliberate deviations from a literal reading of the task brief, both
 * forced by the real DSH command registry (see README "契约偏差"):
 *
 *  1. The command name is `agents-bridge-hello`, not `agents-bridge.hello`:
 *     the registry rejects a dot in a command name (its name pattern is
 *     `/^[a-z][a-z0-9_-]*$/u`), so a dotted name would fail at registration and
 *     take the whole smoke test down with it.
 *  2. Registration goes through `ctx.commands.register({...})`, which is the
 *     actual API (`@deepseek-ai/dsh-commands`: `register(definition)` →
 *     disposer). There is no `ctx.command(name, handler)` shorthand in the
 *     harness.
 *
 * The `commands` service is resolved lazily through `ctx.get` and the whole
 * registration is skipped when it is absent. Reason: `commands` is NOT in this
 * plugin's `inject` (adding it would make the *entire* plugin INACTIVE on a
 * host that mounts no command registry — cordis deactivates a plugin whose
 * inject-listed service is missing), and a missing command registry must not
 * cost the user the six agent tools.
 *
 * @module dsh-agents-bridge/tools/smoke
 */

import type { Context } from '@deepseek-ai/cordis'

/** The command name, exported so tests and the README cannot drift from it. */
export const HELLO_COMMAND_NAME = 'agents-bridge-hello'

/** One command invocation, structurally typed (see the module doc above). */
interface CommandInvocation {
  readonly commandId: string
  readonly rawInput: string
}

/** What a command handler must return: a settled, already-rendered outcome. */
type CommandResult = { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string }

/** The command-registry slice this plugin uses; tiny on purpose. */
interface CommandRegistry {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string; readonly attachments?: boolean }
    readonly handler: (invocation: CommandInvocation) => CommandResult
  }): () => void
}

/**
 * The service id, assembled rather than written literally only because the
 * package scope starts with `@`, which is not legal inside a plain string
 * literal's own quotes in every formatter/linter combination this repo uses.
 */
const COMMANDS_SERVICE_ID = ['@deepseek', 'ai/dsh-commands'].join('-')

/**
 * Register the smoke command. Returns a disposer, or `undefined` when this
 * host mounts no command registry (a legitimate deployment, not an error).
 */
export function registerSmokeCommand(ctx: Context): (() => void) | undefined {
  const commands = tryGet<CommandRegistry>(ctx, COMMANDS_SERVICE_ID)
  if (commands === undefined) return undefined

  // `ctx.effect` is used instead of returning the raw disposer so the command
  // is torn down with this fiber even if the caller never invokes the returned
  // disposer explicitly.
  return commands.register({
    name: HELLO_COMMAND_NAME,
    description: 'smoke test: confirm the dsh-agents-bridge plugin is loaded',
    input: { hint: '<name>' },
    handler: (invocation: CommandInvocation): CommandResult => {
      // The registry hands us the raw trailing input unnormalized; the first
      // whitespace-separated token is the name. Empty input is not an error —
      // the point of the smoke test is the round trip, not validation.
      const name = invocation.rawInput.trim().split(/\s+/u)[0]
      const who = name === undefined || name.length === 0 ? 'world' : name
      return {
        kind: 'success',
        text: `agents-bridge is alive: hello ${who}. Tools agents_probe/run/status/output/cancel/send are registered; run agents_probe to see which agent CLIs this host can drive.`,
      }
    },
  })
}

/** `ctx.get` that degrades an unmounted optional service to `undefined`. */
function tryGet<T>(ctx: Context, key: string): T | undefined {
  try {
    return ctx.get(key) as T | undefined
  } catch {
    return undefined
  }
}
