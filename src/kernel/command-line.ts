/**
 * dsh-agents-bridge / kernel — THE argv constructor. One implementation.
 *
 * The rule is frozen in `docs/design.md` §4 and exists because the agent CLIs
 * this bridge drives are routinely `#!/usr/bin/env node` scripts while `node`
 * is NOT on the child's PATH (verified on this machine: a GUI-launched host
 * inherits `/usr/bin:/bin:/usr/sbin:/sbin`, and a bare shim dies with
 * `env: node: No such file or directory` before printing anything):
 *
 *     [interpreter, executable, ...argsPrefix, ...perCallArgs]
 *     [executable,              ...argsPrefix, ...perCallArgs]   // no interpreter
 *
 * ── WHY THIS LIVES IN `kernel/`, AND WHY IT IS ALONE ───────────────────────
 *
 * Two callers must agree on the head of that vector:
 *
 *  1. the RUN path — every driver builds its command line with this function
 *     before handing `{ command, args }` to the process factory
 *     (`src/drivers/claude.ts`, `codex.ts`, `openclaw.ts`, `acp.ts`,
 *     `generic-argv.ts`), and
 *  2. the VERSION PROBE — `kernel/registry.ts` probes `<exe> --version`.
 *
 * They disagreed for as long as the probe built its argv by hand out of
 * `ResolvedIdentity.interpreterPath`, which is set ONLY when the DESCRIPTOR
 * pins an `interpreter`. The CLI track's shim repair writes
 * `resolved.command.interpreter` instead, so the probe spawned the bare shim,
 * the child died with `env: node: No such file or directory`, and the failure
 * text was then parsed as the engine's VERSION (see
 * `docs/findings-node-shim.md`).
 *
 * A second implementation of a frozen rule is the bug class here, so there is
 * exactly one — and it sits in `kernel/`, the layer both halves already depend
 * on (`src/drivers/**` imports `kernel/types.ts`). `drivers/argv.ts` re-exports
 * it under its historical name so no driver import had to move; `kernel/spawn.ts`
 * delegates its `buildArgv` to it for the same reason. Neither re-implements it.
 *
 * @module dsh-agents-bridge/kernel/command-line
 */

import type { CommandSpec } from './types.ts'

/**
 * Expand a `CommandSpec` + per-call args into a concrete command line.
 *
 * Returns the split form rather than a flat vector because that is what
 * `node:child_process.spawn(file, args)` wants, and joining it back into a
 * string would re-open the quoting problem this bridge deliberately avoids by
 * never using a shell.
 *
 * An EMPTY `interpreter` string is treated as "no interpreter": a `<PREFIX>_INTERPRETER=`
 * override means "this target is a native binary", and the empty string is how
 * that is spelled (see `ResolvedIdentity` in `kernel/registry.ts`).
 */
export function buildCommandLine(
  spec: CommandSpec,
  args: readonly string[],
): { command: string; args: string[] } {
  const prefix = spec.argsPrefix ?? []
  if (spec.interpreter !== undefined && spec.interpreter !== '') {
    return {
      command: spec.interpreter,
      args: [spec.executable, ...prefix, ...args],
    }
  }
  return { command: spec.executable, args: [...prefix, ...args] }
}
