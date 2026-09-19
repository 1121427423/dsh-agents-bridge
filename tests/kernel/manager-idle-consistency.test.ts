/**
 * The manager and each driver arm their OWN idle watchdog, and the whole point
 * of the two layers is that a run can never be killed at two different
 * thresholds (see the table comments in `src/kernel/manager.ts` and
 * `src/drivers/argv.ts`). The two tables cannot import each other — the kernel
 * must not depend on `src/drivers/**` (design doc D3) — so they are maintained
 * as mirrors, and the only thing linking them used to be a "Must equal …"
 * comment on each row. Comments drift; this test does not.
 *
 * Driver-side homes of the numbers, one per family:
 *   - claude / codebuddy / qoderclicn / openclaw / generic / zcode
 *       → `DEFAULT_IDLE_TIMEOUT_MS` in `src/drivers/argv.ts`
 *   - codex → `DEFAULT_CODEX_IDLE_TIMEOUT_MS` in `src/drivers/codex.ts`
 *     (deliberately local there, not an entry in argv's table)
 *   - acp → `DEFAULT_ACP_IDLE_TIMEOUT_MS` in `src/drivers/acp.ts`
 *
 * The exhaustiveness guard compares the key set against `DRIVER_FAMILIES`:
 * adding a family widens the `ProtocolFamily` union (the compiler names the
 * manager table), but `DRIVER_FAMILIES` is a runtime list — asserting the two
 * key sets match keeps a new family from silently keeping a manager entry no
 * driver has.
 */
import { describe, expect, it } from 'vitest'

import { MANAGER_DEFAULT_IDLE_TIMEOUT_MS } from '../../src/kernel/manager.ts'
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../src/drivers/argv.ts'
import { DEFAULT_CODEX_IDLE_TIMEOUT_MS } from '../../src/drivers/codex.ts'
import { DEFAULT_ACP_IDLE_TIMEOUT_MS } from '../../src/drivers/acp.ts'
import { DRIVER_FAMILIES } from '../../src/drivers/index.ts'

/** The driver-side default for one family, from whichever module owns it. */
function driverIdleMs(family: (typeof DRIVER_FAMILIES)[number]): number {
  if (family === 'codex') return DEFAULT_CODEX_IDLE_TIMEOUT_MS
  if (family === 'acp') return DEFAULT_ACP_IDLE_TIMEOUT_MS
  return DEFAULT_IDLE_TIMEOUT_MS[family]
}

describe('manager ↔ driver idle-timeout tables', () => {
  it('carries exactly one entry per registered family', () => {
    expect(Object.keys(MANAGER_DEFAULT_IDLE_TIMEOUT_MS).sort()).toEqual(
      [...DRIVER_FAMILIES].sort(),
    )
  })

  for (const family of DRIVER_FAMILIES) {
    it(`agrees with the driver on ${family}`, () => {
      expect(MANAGER_DEFAULT_IDLE_TIMEOUT_MS[family]).toBe(driverIdleMs(family))
    })
  }
})
