/**
 * dsh-agents-bridge — tool registration wiring.
 *
 * Separated from the definitions so `definitions.ts` stays host-free and this
 * module owns exactly one responsibility: push the six definitions into
 * `ctx.tools` and hand back the disposers that take them out again.
 *
 * `ctx.tools.register` returns the exact Cordis effect disposer for that
 * registration, so the entry can compose them into a single disposer instead
 * of relying on fiber teardown ordering. Returning the array (rather than
 * registering an effect here) keeps this function trivially testable.
 *
 * @module dsh-agents-bridge/tools/register
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentManager } from '../kernel/types.ts'
import type { ToolDefinitions } from './definitions.ts'

/**
 * Register every tool with the runtime.
 *
 * @param ctx - the plugin fiber; `tools` must be in the plugin's `inject`.
 * @param definitions - output of `createToolDefinitions(manager)`.
 * @returns one disposer per registered tool, in registration order.
 */
export function registerTools(ctx: Context, definitions: ToolDefinitions): Array<() => void> {
  const disposers: Array<() => void> = []
  for (const definition of definitions) {
    // Registration order is the order the model reads the tools in; the
    // definitions array is already ordered probe → run → status → output →
    // cancel → send (discover, act, observe, interrupt, continue).
    disposers.push(ctx.tools.register(definition))
  }
  return disposers
}
