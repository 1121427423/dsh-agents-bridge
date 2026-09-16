/**
 * dsh-agents-bridge / drivers — CodeBuddy / WorkBuddy.
 *
 * Authoritative spec: multica `server/pkg/agent/codebuddy.go`. Its own header
 * says it best: *"spawns the CodeBuddy CLI (a Claude Code fork) with
 * `--output-format stream-json`. It mirrors claude.go's execution model:
 * concurrent stdin/stdout to avoid pipe deadlocks, open stdin for
 * control_request auto-approval, and runContext for zero-timeout =
 * no-deadline semantics."*
 *
 * So this module is deliberately thin: it re-exports the claude engine and
 * declares a dialect. Only two things actually differ, and both are argv:
 *
 *  1. `--disallowedTools` names three interactive tools, not one. CodeBuddy
 *     exempts AskUserQuestion and ExitPlanMode from permission-mode
 *     finalization, so `bypassPermissions` does NOT auto-approve them and a
 *     headless turn stalls waiting for a confirmation nobody can give
 *     (GitHub #6012). EnterPlanMode is denied alongside them so the model
 *     cannot enter a plan mode it has no tool to leave. Each tool must be its
 *     own argv value: the CLI matches names exactly, so a comma-joined string
 *     matches nothing despite its own help text.
 *  2. `--strict-mcp-config` must NEVER be passed (measured on CodeBuddy 2.x
 *     with a real MCP server registered per scope):
 *
 *       --mcp-config only ....... managed + user + local  <- what we want
 *       --mcp-config + strict ... managed only
 *       strict only ............. nothing at all
 *
 *     Adding one managed server must not disable the user's own, so the union
 *     is the contract and the CLI already applies it (MUL-5846).
 *
 * `interpreter` support is not coded here because it is not dialect-specific:
 * `buildCommandLine` in `argv.ts` expands
 * `[interpreter, executable, ...argsPrefix, ...args]` for every driver, which
 * is what WorkBuddy needs (`/Applications/WorkBuddy.app/.../cli/bin/codebuddy`
 * is a `#!/usr/bin/env node` script while `node` is not on PATH).
 *
 * Verified against the real binary (CodeBuddy 2.137.1) all of these flags
 * exist: `-p/--print`, `--output-format <text|json|stream-json>`,
 * `--input-format <text|stream-json>`, `-r/--resume`, `--mcp-config`,
 * `--permission-mode`, `--model`, `--effort`, `--max-turns`,
 * `--append-system-prompt`, `--disallowedTools`.
 *
 * @module dsh-agents-bridge/drivers/codebuddy
 */

import type { AgentBackend, DriverDeps } from '../kernel/types.ts'

import { resolveRuntime, type DriverRuntime } from './argv.ts'
import {
  CODEBUDDY_BLOCKED_ARGS,
  buildStreamJsonArgs,
  mcpConfigPathFromEnv,
  runStreamJsonFamily,
  type StreamJsonArgOptions,
  type StreamJsonDialect,
} from './claude.ts'

export { CODEBUDDY_BLOCKED_ARGS }

export const CODEBUDDY_DIALECT: StreamJsonDialect = {
  family: 'codebuddy',
  label: 'codebuddy',
  fixedArgs: [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--disallowedTools',
    'AskUserQuestion',
    'EnterPlanMode',
    'ExitPlanMode',
  ],
  blockedArgs: CODEBUDDY_BLOCKED_ARGS,
  // Never strict: see the module header for the measured scope table.
  strictMcpConfigWhenManaged: false,
  // CodeBuddy has no per-task CLAUDE.md convention to lean on, so the system
  // prompt really is its own flag (codebuddy.go:86).
  forwardSystemPrompt: true,
  // The ported codebuddy switch reads no structured terminal reason.
  readsTerminalReason: false,
  // codebuddy.go's handleUser returns nothing — no async-launch guard.
  detectsAsyncLaunch: false,
}

/**
 * `buildCodebuddyArgs` equivalent. Identical flag ORDER to claude's builder:
 * fixed protocol flags → model → effort → max-turns → system prompt → resume →
 * filtered extras. `--mcp-config <path>` is appended by the runner, last.
 */
export function buildCodebuddyArgs(
  opts: StreamJsonArgOptions,
  logger?: DriverDeps['logger'],
): string[] {
  return buildStreamJsonArgs(CODEBUDDY_DIALECT, opts, logger)
}

export function createCodebuddyBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'codebuddy',
    run: (opts, runDeps, signal) => {
      const runtime = resolveRuntime(rt)
      const mcpConfigPath = mcpConfigPathFromEnv(runDeps.env)
      return runStreamJsonFamily(CODEBUDDY_DIALECT, opts, runDeps, signal, runtime, {
        ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
      })
    },
  }
}
