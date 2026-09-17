/**
 * IM-14 — the TEST tree is inside a type gate.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tsc --noEmit` (the base `tsconfig.json`, `include: ["src"]`) never compiled a
 * single test: 52 test files plus `scripts/acceptance.ts` were outside every
 * typecheck this project ran, and four real TS2339s had accumulated in
 * `tests/integration/client-bundle.test.ts` unseen. `tsconfig.tests.json` is
 * that second gate (`rootDir: '.'`, `noEmit`, `include: src + tests + scripts`),
 * and this suite is its alarm: it runs the project's OWN compiler against the
 * project's OWN config and fails on any diagnostic.
 *
 * WHY IT MUST NOT BE A HAND-ROLLED COMPILE
 * ----------------------------------------
 * Measuring this defect with a bare `tsc --noEmit <file>` reports four EXTRA
 * errors that the project config resolves (TS1259 `esModuleInterop`, TS1343
 * `import.meta`, TS2322, TS2349) — a fake signal that would send someone
 * chasing non-defects. The gate is judged with `-p tsconfig.tests.json`, so the
 * compiler sees the same options as every other consumer.
 *
 * @module tests/integration/typecheck
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const TSC = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const CONFIG = path.join(root, 'tsconfig.tests.json')

describe('IM-14: the test-tree type gate', () => {
  it(
    'typechecks src + tests + scripts with zero errors',
    () => {
      // A missing compiler or config is a FAILURE, never a skip: a gate that
      // silently disappears is exactly the defect this file guards.
      expect(existsSync(TSC)).toBe(true)
      expect(existsSync(CONFIG)).toBe(true)

      const result = spawnSync(process.execPath, [TSC, '--noEmit', '-p', 'tsconfig.tests.json'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 180_000,
      })

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      expect(result.status, output).toBe(0)
      expect(output.trim()).toBe('')
    },
    240_000,
  )

  it('has an entry point in package.json, so the gate is runnable by name', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.['typecheck:tests'] ?? '').toContain('tsconfig.tests.json')
  })
})
