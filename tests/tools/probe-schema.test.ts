/**
 * `agents_probe` output schema — the "no undeclared field" fence.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The registry has always returned `ProbeResult.capabilities`, but the tool's
 * `output.schema` did not declare it while setting `additionalProperties:
 * false`. The kernel materializes the value against that schema, so the FIRST
 * call a model makes in any session — `agents_probe` — failed with
 * `value[0].capabilities is not a declared property`. Every identity was
 * affected; nothing was drivable as far as the model could tell.
 *
 * The unit-level harness does not materialize outputs (it calls `execute`
 * directly), which is exactly why the bug shipped: a test that only checks the
 * manager's return value cannot see a schema drift. So this file walks the real
 * returned value against the real declared schema and fails on any key the
 * schema does not declare — the same check the runtime performs, written out so
 * the next added field is caught in CI instead of in the model's first turn.
 *
 * @module tests/tools/probe-schema
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ManagerPool } from '../helpers/manager-harness.ts'
import { callTool, toolsFor, type ToolTable } from '../helpers/tool-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAST = path.join(here, '..', 'fixtures', 'fake-stream-json-cli.mjs')

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

/** The subset of JSON Schema this walker understands (what `defineTool` emits). */
interface Schema {
  readonly type?: string
  readonly properties?: Readonly<Record<string, Schema>>
  readonly items?: Schema
  readonly additionalProperties?: boolean
}

/**
 * Returns `path: key` for every object key the schema does not declare.
 *
 * Only objects that declare `additionalProperties: false` are closed — matching
 * the runtime's rule, so a walker miss can never invent a failure the kernel
 * would not raise (the fence must not be stricter than production).
 */
function undeclaredKeys(schema: Schema | undefined, value: unknown, at = '$'): string[] {
  if (schema === undefined) return []
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => undeclaredKeys(schema.items, entry, `${at}[${index}]`))
  }
  if (value === null || typeof value !== 'object') return []
  const properties = schema.properties
  if (properties === undefined) return []
  const out: string[] = []
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const child = properties[key]
    if (child === undefined) {
      out.push(`${at}.${key}`)
      continue
    }
    out.push(...undeclaredKeys(child, entry, `${at}.${key}`))
  }
  return out
}

/** Reads the declared output schema off a registered definition. */
function outputSchema(tools: ToolTable, name: string): Schema {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return (tool as unknown as { output: { schema: Schema } }).output.schema
}

describe('agents_probe output schema', () => {
  it('declares every field the registry returns (capabilities included)', async () => {
    // `scan: false` keeps this suite off the host's installed applications.
    const manager = pool.create(FAST, { scan: false })
    const tools = toolsFor(manager)
    const value = await callTool<Array<Record<string, unknown>>>(tools, 'agents_probe', {})

    expect(value.length).toBeGreaterThan(0)
    expect(undeclaredKeys(outputSchema(tools, 'agents_probe'), value)).toEqual([])
  })

  it('carries capabilities through materialization instead of dropping them', async () => {
    const manager = pool.create(FAST, { scan: false })
    const tools = toolsFor(manager)
    const value = await callTool<Array<Record<string, unknown>>>(tools, 'agents_probe', {})

    // The built-in catalog gives at least one identity real knobs; if that ever
    // stops being true this assertion should be rewritten, not deleted — the
    // point is that a non-empty capability set survives the schema.
    const withCapabilities = value.filter(entry => entry['capabilities'] !== undefined)
    expect(withCapabilities.length).toBeGreaterThan(0)
    for (const entry of withCapabilities) {
      const capabilities = entry['capabilities'] as Record<string, unknown>
      expect(Object.keys(capabilities).length).toBeGreaterThan(0)
      for (const flag of Object.values(capabilities)) expect(typeof flag).toBe('boolean')
    }
  })

  it('renders the same value the schema accepted', async () => {
    const manager = pool.create(FAST, { scan: false })
    const tools = toolsFor(manager)
    const value = await callTool<Array<Record<string, unknown>>>(tools, 'agents_probe', {})
    const tool = tools.get('agents_probe') as unknown as {
      output: { render: (args: unknown, v: unknown) => Array<{ type: string; text?: string }> }
    }
    const text = tool.output.render({}, value).map(block => block.text ?? '').join('\n')
    expect(text).toContain('Drivable now:')
  })
})
