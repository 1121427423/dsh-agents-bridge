/**
 * Run the DSH Plugin Studio contract verifier against this plugin.
 *
 * WHY A WRAPPER AND NOT A ONE-LINE SCRIPT
 * ---------------------------------------
 * `verify_plugin.py` ships with the `dsh-plugin-studio` skill, which lives
 * outside this repository (and outside version control). Hardcoding its
 * absolute path in `package.json` would bake one machine's home directory into
 * the build config, and a missing skill would surface as an opaque
 * "command not found". So the path is RESOLVED at run time, in this order:
 *
 *   1. `$DSH_PLUGIN_STUDIO_VERIFIER` — the script itself;
 *   2. `$DSH_PLUGIN_STUDIO` — the skill directory (`<dir>/scripts/verify_plugin.py`);
 *   3. `~/.agents/skills/dsh-plugin-studio/scripts/verify_plugin.py`
 *      (the skill's documented install location);
 *   4. `~/.codebuddy/skills/dsh-plugin-studio/scripts/verify_plugin.py`
 *      (the other place skills are installed on this machine).
 *
 * When none of them exists the script says exactly that, lists what it tried,
 * and exits non-zero — a missing verifier is a gate that did not run, never a
 * gate that passed. Extra arguments are forwarded (`pnpm run verify -- --json`).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Every place the skill's verifier is looked for, in priority order. */
const candidates = [
  process.env['DSH_PLUGIN_STUDIO_VERIFIER'],
  process.env['DSH_PLUGIN_STUDIO'] === undefined
    ? undefined
    : path.join(process.env['DSH_PLUGIN_STUDIO'], 'scripts', 'verify_plugin.py'),
  path.join(homedir(), '.agents', 'skills', 'dsh-plugin-studio', 'scripts', 'verify_plugin.py'),
  path.join(homedir(), '.codebuddy', 'skills', 'dsh-plugin-studio', 'scripts', 'verify_plugin.py'),
].filter(candidate => candidate !== undefined && candidate !== '')

const verifier = candidates.find(candidate => existsSync(candidate))

if (verifier === undefined) {
  console.error(
    [
      'dsh-plugin-studio verifier not found — the contract gate cannot run.',
      '',
      'Looked for (in order):',
      ...candidates.map(candidate => `  - ${candidate}`),
      '',
      'Point at it explicitly with either:',
      '  DSH_PLUGIN_STUDIO_VERIFIER=/path/to/verify_plugin.py pnpm run verify',
      '  DSH_PLUGIN_STUDIO=/path/to/dsh-plugin-studio       pnpm run verify',
      '',
      'The verifier ships with the `dsh-plugin-studio` skill (stdlib-only Python,',
      'no Node/pnpm needed): <skill>/scripts/verify_plugin.py',
    ].join('\n'),
  )
  process.exit(2)
}

// Forward the caller's extra flags. pnpm passes its own `--` separator through
// (`pnpm run verify -- --json` → `['--', '--json']`), and argparse would read
// that as "end of options"; drop it so both spellings work.
const forwarded = process.argv.slice(2).filter(argument => argument !== '--')

const result = spawnSync('python3', [verifier, root, ...forwarded], { stdio: 'inherit' })

if (result.error !== undefined && result.error !== null) {
  console.error(`failed to run ${verifier}: ${result.error.message}`)
  process.exit(2)
}

process.exit(result.status ?? 1)
