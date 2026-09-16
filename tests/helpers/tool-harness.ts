/**
 * Invoke a model-facing tool definition without a host.
 *
 * The tool layer is deliberately pure (`src/tools/definitions.ts` touches no
 * `ctx`), so a test can build the definitions over a real `AgentManager` and
 * call `execute` / `output.render` directly. That is the difference between
 * testing the tools and testing the runtime: `tests/plugin-config.test.ts`
 * already covers the registration path.
 *
 * `exec` is passed as an empty object because none of these tools read the
 * execution context — they are fire-and-forget by contract, so there is no
 * signal to forward.
 *
 * @module tests/helpers/tool-harness
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { createToolDefinitions, type ToolDefinitions } from '../../src/tools/definitions.ts'
import type { AgentManager } from '../../src/kernel/types.ts'

/** The definition table keyed by tool name, for `callTool` / `renderTool`. */
export type ToolTable = Map<string, ToolDefinitions[number]>

export function toolsFor(manager: AgentManager): ToolTable {
  return new Map(createToolDefinitions(manager).map((definition) => [definition.name, definition]))
}

function requireTool(tools: ToolTable, name: string): ToolDefinitions[number] {
  const tool = tools.get(name)
  if (tool === undefined) {
    throw new Error(`tool ${name} is not registered (registered: ${[...tools.keys()].join(', ')})`)
  }
  return tool
}

/** Runs one tool and returns its canonical output value. */
export async function callTool<T = Record<string, unknown>>(
  tools: ToolTable,
  name: string,
  args: unknown,
): Promise<T> {
  const tool = requireTool(tools, name)
  return (await (tool as unknown as {
    execute: (input: unknown, exec: unknown) => Promise<unknown>
  }).execute(args, {})) as T
}

/** Runs the tool's PURE render over an already-produced value. */
export function renderTool(tools: ToolTable, name: string, args: unknown, value: unknown): string {
  const tool = requireTool(tools, name)
  const blocks = (tool as unknown as {
    output: { render: (a: unknown, v: unknown) => ContentBlock[] }
  }).output.render(args, value)
  return blocks
    .map((block) => (block.type === 'text' ? (block as { text: string }).text : ''))
    .join('\n')
}
