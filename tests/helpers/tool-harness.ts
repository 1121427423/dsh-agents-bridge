/**
 * Invoke a model-facing tool definition without a host.
 *
 * The tool layer is deliberately pure (`src/tools/definitions.ts` touches no
 * `ctx`), so a test can build the definitions over a real `AgentManager` and
 * call `execute` / `output.render` directly. That is the difference between
 * testing the tools and testing the runtime: `tests/plugin-config.test.ts`
 * already covers the registration path.
 *
 * `exec` defaults to an empty object. `agents_run` / `agents_run_many` are the
 * two tools that DO read it: `exec.agent` is the calling agent, and it is what a
 * session's completion notice is addressed to (host/jobs.ts). A test that means
 * "the agent loop called this" passes one; everything else keeps the default,
 * which exercises the unowned path.
 *
 * @module tests/helpers/tool-harness
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { createToolDefinitions, type ToolDefinitions } from '../../src/tools/definitions.ts'
import type { JobSeat } from '../../src/host/jobs.ts'
import type { AgentManager } from '../../src/kernel/types.ts'

/** The definition table keyed by tool name, for `callTool` / `renderTool`. */
export type ToolTable = Map<string, ToolDefinitions[number]>

export function toolsFor(manager: AgentManager, seat?: JobSeat): ToolTable {
  return new Map(
    createToolDefinitions(manager, seat).map((definition) => [definition.name, definition]),
  )
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
  exec: unknown = {},
): Promise<T> {
  const tool = requireTool(tools, name)
  return (await (tool as unknown as {
    execute: (input: unknown, exec: unknown) => Promise<unknown>
  }).execute(args, exec)) as T
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
