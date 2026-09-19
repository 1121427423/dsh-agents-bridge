/**
 * dsh-agents-bridge / drivers — Qoder CN CLI, headless stream-json dialect.
 *
 * WHY THIS EXISTS (D46). The bridge already drives both Qoder binaries over ACP
 * (`qoderclicn`, `qoder-cn`). On 2026-09-19 the engine's ACP `session/prompt`
 * began answering an upstream
 * `{code:500, message:"Sorry, something went wrong. Please try again…"}` for
 * EVERY client — reproduced frame-for-frame by a minimal script that copies
 * multica's own call sequence (`server/pkg/agent/qoder.go`), so the fault is
 * server-side, not this bridge. The CLI's HEADLESS mode is unaffected, and that
 * is what this dialect speaks. ACP is kept and stays selectable through the
 * `qoderTransport` switch (see src/index.ts).
 *
 * MEASURED on `qoderclicn` 1.1.56, this host:
 *   - `-p` writes exactly the answer to stdout — one line, `PONG`, nothing else;
 *     the `skill configs` warning goes to stderr.
 *   - `-p --output-format stream-json` emits the CLAUDE/CodeBuddy frame set:
 *     `system/init` (`session_id`, `model`, `tools`, `mcp_servers`,
 *     `permissionMode`) → `assistant` (`message.content[]` with thinking/text) →
 *     `result{subtype:"success", is_error:false, result:"PONG", stop_reason}` —
 *     and every frame carries `session_id`, which is what makes resume possible.
 *   - the claude-family stdin line is accepted verbatim alongside
 *     `--input-format stream-json`:
 *     `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`
 *     (this is byte-for-byte what `buildClaudeInput` writes).
 *
 * THE FLAGS ARE NOT CLAUDE'S, which is why this is a third dialect and not a
 * reuse of `claude` or `codebuddy`:
 *   - `--verbose` DOES NOT EXIST here (`error: unknown option '--verbose'`), and
 *     BOTH existing stream-json dialects pass it.
 *   - the permission mode is spelled `bypass_permissions` (the other two use
 *     `bypassPermissions`).
 *   - there is no `AskUserQuestion` tool to deny: the real `system/init` frame's
 *     tool list does not contain it, so nothing is disallowed here.
 *
 * UNVERIFIED, and marked as such rather than guessed:
 *   - `--strict-mcp-config` scope behaviour → `false` (never strict) is the
 *     conservative choice, because narrowing the scope union is the failure
 *     codebuddy measured the hard way (MUL-5846).
 *   - whether the CLI loads its own project context file → `forwardSystemPrompt:
 *     false` avoids duplicating the brief, matching claude's reasoning (MUL-5392).
 *   - which key its permission client reads → `controlResponseIncludesAllowed:
 *     true` sends BOTH keys, the union-safe reading the codebuddy fork required.
 *     With `--permission-mode bypass_permissions` a request should not arise at
 *     all, so this only matters if that mode is later relaxed.
 *
 * @module dsh-agents-bridge/drivers/qoderclicn
 */

import type { AgentBackend, DriverDeps } from '../kernel/types.ts'
import type { BlockedArgs } from './argv.ts'

import { resolveRuntime, type DriverRuntime } from './argv.ts'
import {
  buildStreamJsonArgs,
  mcpConfigPathFromEnv,
  runStreamJsonFamily,
  type StreamJsonArgOptions,
  type StreamJsonDialect,
} from './claude.ts'

/**
 * Flags the driver owns on this CLI. Same shape as the claude/codebuddy maps,
 * with this engine's own spellings:
 *
 *  - `-p` is blocked as `optionalValue` rather than standalone. This CLI's
 *    `--print` takes no value, but a caller writing `-p "text"` would otherwise
 *    leave `text` behind as a positional prompt competing with the stdin frame
 *    (`Usage: qoderclicn [options] [command] [query...]`).
 *  - `--reasoning-effort` is this CLI's spelling of the effort dial (claude's is
 *    `--effort`), so it is bridge-owned like the rest.
 */
export const QODERCLICN_BLOCKED_ARGS: BlockedArgs = {
  '-p': 'optionalValue',
  '--print': 'standalone',
  '--output-format': 'withValue',
  '--input-format': 'withValue',
  '--permission-mode': 'withValue',
  '--reasoning-effort': 'withValue',
  '--mcp-config': 'withValue',
  '--strict-mcp-config': 'standalone',
}

export const QODERCLICN_DIALECT: StreamJsonDialect = {
  family: 'qoderclicn',
  label: 'qoderclicn',
  fixedArgs: [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    // Headless: never stall on a permission prompt. This CLI's choices are
    // default | accept_edits | bypass_permissions | dont_ask | auto.
    '--permission-mode',
    'bypass_permissions',
  ],
  blockedArgs: QODERCLICN_BLOCKED_ARGS,
  // Never strict: see the module header (the failure mode is measured on the
  // sibling fork; this engine is unverified, so the conservative side is kept).
  strictMcpConfigWhenManaged: false,
  forwardSystemPrompt: false,
  // The terminal frame carries `stop_reason`, not claude's `terminal_reason`.
  readsTerminalReason: false,
  detectsAsyncLaunch: false,
  // Union-safe: send `behavior` AND `allowed`.
  controlResponseIncludesAllowed: true,
  // This CLI spells the dial `--reasoning-effort`; `--effort` is
  // `error: unknown option` here (measured 1.1.56).
  effortFlag: '--reasoning-effort',
}

/**
 * `buildQoderclicnArgs` equivalent. Identical flag ORDER to claude's and
 * codebuddy's builders: fixed protocol flags → model → effort → max-turns →
 * system prompt → resume → filtered extras. `--mcp-config <path>` is appended by
 * the runner, last.
 */
export function buildQoderclicnArgs(
  opts: StreamJsonArgOptions,
  logger?: DriverDeps['logger'],
): string[] {
  return buildStreamJsonArgs(QODERCLICN_DIALECT, opts, logger)
}

export function createQoderclicnBackend(deps: DriverDeps, rt?: DriverRuntime): AgentBackend {
  return {
    family: 'qoderclicn',
    run: (opts, runDeps, signal) => {
      const runtime = resolveRuntime(rt)
      const mcpConfigPath = mcpConfigPathFromEnv(runDeps.env)
      return runStreamJsonFamily(QODERCLICN_DIALECT, opts, runDeps, signal, runtime, {
        ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
      })
    },
  }
}
