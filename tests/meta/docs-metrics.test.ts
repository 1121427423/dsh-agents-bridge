/**
 * `docs/plan.md` — the delivery metrics must not under-report skipped tests.
 *
 * The metrics row used to say the one skipped test was the env-gated ACP e2e,
 * as if that were the only way a test can go missing. There are THREE
 * mechanisms, and two of them are host-conditional: a machine without the
 * desktop bundles silently runs 4 fewer tests. `vitest` reports those as
 * `skipped`, not as passes — but a reader comparing the advertised figure with
 * a clean machine's output would conclude the numbers were wrong. This pins the
 * sentence that owns up to all three.
 *
 * @module tests/meta/docs-metrics
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const plan = fs.readFileSync(path.join(root, 'docs', 'plan.md'), 'utf8')

/** The `| 测试 |` row of the delivery-metrics table. */
function metricsRow(): string {
  const row = plan.split('\n').find((line) => line.startsWith('| 测试 |'))
  if (row === undefined) throw new Error('docs/plan.md: the 测试 metrics row is missing')
  return row
}

describe('docs/plan.md delivery metrics — skip accounting (MI-14)', () => {
  it('marks the skipped figure host-conditional and names all three skip mechanisms', () => {
    const row = metricsRow()

    // 1. the env-gated ACP end-to-end describe (`describe.runIf(ENABLED)`).
    expect(row).toContain('DSH_ACP_E2E')
    // 2 & 3. the host-probe `describe.skipIf` suites, both files by name.
    expect(row).toContain('desktop.test.ts')
    expect(row).toContain('scan.test.ts')
    // ...and the two bundles those probes look for, by absolute path, so the
    // precondition is stated rather than implied.
    expect(row).toContain('/Applications/WorkBuddy.app')
    expect(row).toContain('/Applications/WorkBuddy AI.app')
    // The count is presented as host-dependent, not as a fixed figure.
    expect(row).toContain('宿主条件')
  })
})
