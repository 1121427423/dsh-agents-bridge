/**
 * dsh-agents-bridge / drivers — the family → driver table.
 *
 * This is the only module the plugin entry (workstream C) and the kernel
 * (workstream A) are expected to import. It owns two things:
 *
 *  1. `createBackend(family, deps)` — the factory the kernel is handed through
 *     `ManagerOptions.createBackend`, so the kernel itself never imports a
 *     dialect (design.md §2, decision D3).
 *  2. The re-export of the driver runtime seam (`setDriverRuntime`), because
 *     `DriverDeps` is frozen and has no `spawn` field.
 *
 * ── KERNEL INTEGRATION (exact calls) ───────────────────────────────────────
 *
 *   import { setDriverRuntime, createBackend } from './drivers/index.ts'
 *
 *   // once, during plugin/kernel construction, BEFORE the first run:
 *   setDriverRuntime({ spawn: spawnFn })
 *
 *   // where ManagerOptions is built:
 *   const manager = createManager({ logger, createBackend })
 *
 * `spawnFn` must satisfy the `SpawnFn` contract documented in `argv.ts`
 * (synchronous, never throws for a missing binary — it reports ENOENT through
 * `exited.error` — and `terminate()` signals the whole process GROUP).
 *
 * `DriverDeps.command` supplies the identity (executable / interpreter /
 * argsPrefix), `DriverDeps.env` the merged child environment, and
 * `DriverDeps.logger` the logger. Everything else the drivers need
 * (MCP config path, openclaw idle grace, generic resume flag) travels in
 * `DriverDeps.env` under the `DSH_AGENTS_BRIDGE_*` namespace, so no ABI change
 * is required.
 *
 * @module dsh-agents-bridge/drivers
 */

import type { AgentBackend, DriverDeps, ProtocolFamily } from '../kernel/types.ts'
import type { AcpResidentPool } from './acp-resident.ts'

import {
  clearDriverRuntime,
  getDriverRuntime,
  setDriverRuntime,
  type BlockedArgMode,
  type BlockedArgs,
  type DriverRuntime,
  type ProcessExit,
  type SpawnFn,
  type SpawnSpec,
  type SpawnedProcess,
} from './argv.ts'
import { createClaudeBackend } from './claude.ts'
import { createCodebuddyBackend } from './codebuddy.ts'
import { createQoderclicnBackend } from './qoderclicn.ts'
import { createCodexBackend } from './codex.ts'
import { createGenericBackend } from './generic-argv.ts'
import { createOpenclawBackend } from './openclaw.ts'
import { createAcpBackend } from './acp.ts'
import { createZcodeBackend } from './zcode.ts'

/**
 * The dialects implemented in v1, in the order the model-facing tool should
 * present them. Every entry maps to exactly one driver module; several agent
 * identities may share one family (multica's "identity fork": WorkBuddy ships a
 * CodeBuddy binary, both speak the claude stream-json dialect).
 *
 * `acp` is the v4 addition (decision D27): one entry unlocks every CLI that
 * speaks the Agent Client Protocol, regardless of which vendor ships it.
 *
 * `zcode` is the v5 addition (decision D38): the ZCode Protocol of the CLI
 * bundled inside ZCode.app. It shares claude's FLAG vocabulary but not its
 * wire, which is exactly why it needed its own entry instead of a codebuddy
 * dialect (see docs/findings-zcode-headless.md §3).
 */
export const DRIVER_FAMILIES: readonly ProtocolFamily[] = [
  'claude',
  'codebuddy',
  'qoderclicn',
  'codex',
  'openclaw',
  'acp',
  'generic',
  'zcode',
]

/**
 * Build the backend for one protocol family.
 *
 * `deps` is per-identity, so a family with two identities (openclaw / autoclaw)
 * gets two backends from two calls — the argv difference lives entirely in
 * `deps.command`.
 *
 * Throws for an unknown family instead of silently falling back to `generic`:
 * a misconfigured descriptor must be loud, because a silent fallback would run
 * the wrong CLI with the wrong flags.
 */
export function createBackend(
  family: ProtocolFamily,
  deps: DriverDeps,
  resident?: AcpResidentPool,
): AgentBackend {
  switch (family) {
    case 'claude':
      return createClaudeBackend(deps)
    case 'codebuddy':
      return createCodebuddyBackend(deps)
    case 'qoderclicn':
      return createQoderclicnBackend(deps)
    case 'codex':
      return createCodexBackend(deps)
    case 'openclaw':
      return createOpenclawBackend(deps)
    case 'acp':
      return createAcpBackend(deps, undefined, resident)
    case 'generic':
      return createGenericBackend(deps)
    case 'zcode':
      return createZcodeBackend(deps)
    default:
      // Reachable from JS/config even though the union is closed in TS.
      throw new Error(
        `dsh-agents-bridge: unknown protocol family ${JSON.stringify(family)}. ` +
          `Known families: ${DRIVER_FAMILIES.join(', ')}. ` +
          'Add the dialect under src/drivers/ and register it here, or fix the ' +
          'agent descriptor\'s `family` field.',
      )
  }
}

/**
 * Same as `createBackend`, but with an explicitly supplied runtime instead of
 * the module-level seam. Tests use it; the kernel may prefer it if it wants no
 * global state.
 */
export function createBackendWithRuntime(
  family: ProtocolFamily,
  deps: DriverDeps,
  runtime: DriverRuntime,
  resident?: AcpResidentPool,
): AgentBackend {
  switch (family) {
    case 'claude':
      return createClaudeBackend(deps, runtime)
    case 'codebuddy':
      return createCodebuddyBackend(deps, runtime)
    case 'qoderclicn':
      return createQoderclicnBackend(deps, runtime)
    case 'codex':
      return createCodexBackend(deps, runtime)
    case 'openclaw':
      return createOpenclawBackend(deps, runtime)
    case 'acp':
      return createAcpBackend(deps, runtime, resident)
    case 'generic':
      return createGenericBackend(deps, runtime)
    case 'zcode':
      return createZcodeBackend(deps, runtime)
    default:
      throw new Error(
        `dsh-agents-bridge: unknown protocol family ${JSON.stringify(family)}. ` +
          `Known families: ${DRIVER_FAMILIES.join(', ')}.`,
      )
  }
}

// ── Runtime seam, re-exported for the kernel and the entry ─────────────────

export {
  clearDriverRuntime,
  getDriverRuntime,
  setDriverRuntime,
  type BlockedArgMode,
  type BlockedArgs,
  type DriverRuntime,
  type ProcessExit,
  type SpawnFn,
  type SpawnSpec,
  type SpawnedProcess,
}

// ── ACP resident pool, re-exported for the plugin entry ────────────────────

export { ACP_KEEPALIVE_ENV, ACP_KEEPALIVE_IDLE_DEFAULT_MS, createAcpBackend, residentKey } from './acp.ts'
export {
  createAcpResidentPool,
  type AcpResidentEntry,
  type AcpResidentPool,
  type AcpResidentPoolOptions,
} from './acp-resident.ts'

// ── Qoder CN CLI headless dialect, re-exported (D46) ───────────────────────

export {
  buildQoderclicnArgs,
  QODERCLICN_BLOCKED_ARGS,
  QODERCLICN_DIALECT,
} from './qoderclicn.ts'
