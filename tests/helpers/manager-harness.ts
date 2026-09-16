/**
 * Shared harness for manager-level tests: a real `AgentManager` wired to a fake
 * CLI, plus small process/file helpers.
 *
 * Extracted from tests/integration/pipeline.test.ts when the cancellation suite
 * needed the same setup. Every manager-level test needs the same three things —
 * `installDriverRuntime()`, every identity pointed at one fake script, and a
 * throwaway store dir — and copying that into a second file is how the two
 * copies drift apart.
 *
 * @module tests/helpers/manager-harness
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createBackend } from '../../src/drivers/index.ts'
import { installDriverRuntime } from '../../src/integrate.ts'
import { createLogger } from '../../src/kernel/logger.ts'
import { createAgentManager } from '../../src/kernel/manager.ts'
import type { AgentDescriptor, AgentManager, ManagerOptions, SessionSnapshot } from '../../src/kernel/types.ts'

/** The node running this test doubles as the engine interpreter. */
export const NODE = process.execPath

/**
 * Point every built-in identity at one fake CLI.
 *
 * `mergeDescriptors` merges `command` per-field, so overriding executable +
 * argsPrefix is enough — the driver still appends its own dialect flags, which
 * a fake CLI ignores.
 *
 * `commandEnv` is merged into the descriptor's `CommandSpec.env`, which is how a
 * fixture receives per-test parameters: each driver appends its dialect flags in
 * its own order, so a positional argument is not addressable from a fake CLI
 * that must work under every dialect.
 *
 * `graceMs` goes through `installDriverRuntime`, the same seam the plugin entry
 * uses — it is NOT a `ManagerOptions` field. Keeping one installation path means
 * a test cannot configure a grace window the production code would ignore.
 */
export function makeManager(
  script: string,
  overrides: Partial<ManagerOptions> = {},
  commandEnv: Readonly<Record<string, string>> = {},
  graceMs?: number,
): AgentManager {
  installDriverRuntime(graceMs)
  const override: Partial<AgentDescriptor> = {
    command: { executable: NODE, argsPrefix: [script], env: { ...commandEnv } },
  }
  return createAgentManager({
    logger: createLogger('manager-test'),
    storeDir: mkdtempSync(path.join(tmpdir(), 'bridge-store-')),
    defaultCwd: tmpdir(),
    overrides: { claude: override, workbuddy: override, openclaw: override, autoclaw: override },
    createBackend,
    ...overrides,
  })
}

/** Owns a set of managers and disposes them all (call from `afterEach`). */
export class ManagerPool {
  readonly #managers: AgentManager[] = []

  add(manager: AgentManager): AgentManager {
    this.#managers.push(manager)
    return manager
  }

  create(
    script: string,
    overrides: Partial<ManagerOptions> = {},
    commandEnv: Readonly<Record<string, string>> = {},
    graceMs?: number,
  ): AgentManager {
    return this.add(makeManager(script, overrides, commandEnv, graceMs))
  }

  async disposeAll(): Promise<void> {
    await Promise.all(this.#managers.splice(0).map((manager) => manager.dispose()))
  }
}

/** Polls `status()` until the session is terminal. Never really sleeps long. */
export async function waitTerminal(
  manager: AgentManager,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<SessionSnapshot> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = manager.status(sessionId)
    if (snapshot?.terminal === true) return snapshot
    if (Date.now() > deadline) {
      throw new Error(
        `session ${sessionId} never reached a terminal state (last: ${JSON.stringify(snapshot)})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ForkReport {
  readonly childPid: number
  readonly childPpid: number
  readonly grandchildPid: number | null
  readonly childSignal: string | null
  readonly grandchildSignal: string | null
  readonly ready: boolean
}

/** Reads the fork fixture's report; returns undefined while it is half-written. */
export function readForkReport(reportPath: string): ForkReport | undefined {
  try {
    const text = readFileSync(reportPath, 'utf8').trim()
    if (text === '') return undefined
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as ForkReport
  } catch {
    return undefined
  }
}

/**
 * Waits until the fork fixture has both processes alive.
 *
 * This is the difference between a test that proves group-kill works and a test
 * that races it: cancelling before the grandchild exists would pass trivially.
 */
export async function waitForkReady(
  reportPath: string,
  timeoutMs = 10_000,
): Promise<ForkReport> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const report = readForkReport(reportPath)
    if (report?.ready === true && report.grandchildPid !== null) return report
    if (Date.now() > deadline) {
      throw new Error(
        `fake-forking-cli never reported a grandchild (last: ${JSON.stringify(report)})`,
      )
    }
    await sleep(20)
  }
}

/** Worst-case escalation wait: SIGTERM grace + SIGKILL confirm, with slack. */
export const ESCALATION_BUDGET_MS = 4_000

/**
 * Polls until every pid is gone. `pids` may contain nulls (not yet known).
 *
 * Used instead of a bare assertion right after `cancel()` because the kernel's
 * guarantee is "the tree is reaped by the time cancel resolves" — a positive
 * claim that is worth asserting as a bounded wait, and a *failure* to reap is
 * what the test must catch.
 */
export async function waitAllGone(
  pids: readonly (number | null | undefined)[],
  timeoutMs = ESCALATION_BUDGET_MS,
): Promise<boolean> {
  const { processGone } = await import('../../src/kernel/spawn.ts')
  const known = pids.filter((pid): pid is number => typeof pid === 'number' && pid > 0)
  if (known.length === 0) return false
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (known.every((pid) => processGone(pid))) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}
