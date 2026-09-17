#!/usr/bin/env node
/**
 * A `#!/usr/bin/env node` CLI shim, exactly like the ones npm installs for
 * `claude`, `codex` and `codebuddy-code` on this host.
 *
 * It exists to pin ONE regression: an identity whose shim the CLI track repairs
 * (because `node` is not on the child's PATH) must still answer `--version`
 * through the REPAIRED interpreter. Probed bare it dies with
 * `env: node: No such file or directory` before printing anything, and the
 * bridge used to publish that stderr line as the engine's version.
 *
 * The version it prints is deliberately semver-shaped and obviously fake, so a
 * test can never confuse it with a real engine's output.
 */
process.stdout.write('9.9.9 (fixture-node-shim)\n')
