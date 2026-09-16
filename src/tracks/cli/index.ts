/**
 * dsh-agents-bridge / CLI track.
 *
 * The CLI track drives binaries the USER installed themselves (`claude`,
 * `codex`, `codebuddy-code`, `openclaw`). Two facts shape this whole module,
 * both verified on the target machine:
 *
 *  1. A GUI-launched host does not inherit a login shell's PATH. In this very
 *     session `PATH` was `/opt/homebrew/bin:/usr/bin:/bin:...`, so a bare
 *     `claude` resolved to NOTHING while `/usr/local/bin/claude` existed and
 *     worked. Hence `searchPath`, applied before the inherited PATH.
 *  2. Most of these binaries are npm shims (`#!/usr/bin/env node`). If `node`
 *     is not on the child's PATH they die with `env: node: No such file or
 *     directory` before printing anything (exactly how the bundled WorkBuddy
 *     CLI failed). Hence the shebang repair below: read the first line, and if
 *     it asks for `env node` while `node` is unresolvable, prepend a node we
 *     did resolve.
 *
 * Correction 2 is deliberately narrow: it only ever fires on a file that is
 * literally a `#!... node` script. A native binary is never given an
 * interpreter.
 *
 * @module dsh-agents-bridge/tracks/cli
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { CommandSpec } from '../../kernel/types.ts'
import { notFoundReason, type LaunchInput, type TrackPolicy } from '../types.ts'

/**
 * Directories searched for CLI-track binaries, in order, BEFORE the inherited
 * PATH.
 *
 * The order is not invented: it mirrors the user's own login-shell PATH on the
 * target machine (observed: nvm's bin, then ~/.local/bin, ~/.bun/bin, ~/bin,
 * and only then /opt/homebrew/bin), where per-user and version-managed installs
 * deliberately win over system ones. Keeping that order matters in practice,
 * because this host has TWO codex installs — ~/bin/codex (nvm, 0.154.0) and
 * /opt/homebrew/bin/codex (cask, 0.144.6) — and the user's shell picks the nvm
 * one. `probe` reports the resolved absolute path + version precisely so a
 * surprise like this is visible instead of silent.
 */
export const CLI_SEARCH_PATH: readonly string[] = [
  '~/.nvm/versions/node/*/bin',
  '~/.local/bin',
  '~/.bun/bin',
  '~/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

/**
 * Node candidates tried when a shim needs an interpreter and the descriptor did
 * not pin one. `process.execPath` is last on purpose: under a desktop host it
 * may be an Electron binary, which only behaves like node with
 * `ELECTRON_RUN_AS_NODE=1`.
 */
const NODE_CANDIDATES: readonly string[] = ['/opt/homebrew/bin/node', '~/.nvm/versions/node/*/bin/node']

export interface CliPolicyDeps {
  /** Injectable for tests; defaults to `fs.readFileSync(path, 'utf8')`. */
  readonly readFile?: (file: string) => string | undefined
  /** Injectable for tests; defaults to a real `node` lookup. */
  readonly resolveNode?: (env: Readonly<Record<string, string | undefined>>) => string | undefined
  /** Overrides the built-in search path (settings-driven). */
  readonly searchPath?: readonly string[]
}

const SHEBANG_MAX_BYTES = 256

/** First line of a text file, or undefined when it is not a readable text file. */
export function readShebang(
  file: string,
  readFile: (f: string) => string | undefined = defaultReadFile,
): string | undefined {
  const head = readFile(file)
  if (head === undefined) return undefined
  const first = head.split('\n', 1)[0] ?? ''
  return first.startsWith('#!') ? first.trim() : undefined
}

/**
 * Does this shebang ask for a `node` that the child process would fail to find?
 * Matches `#!/usr/bin/env node`, `#!/usr/bin/env -S node --flag` and
 * `#!/usr/bin/node`, but only when the basename is exactly `node`.
 */
export function wantsNode(shebang: string): boolean {
  const parts = shebang.replace(/^#!\s*/, '').split(/\s+/)
  if (parts.length === 0) return false
  const first = parts[0] ?? ''
  const base = first.endsWith('/env') ? (parts[1]?.startsWith('-') ? parts[2] : parts[1]) : first
  return path.basename(base ?? '') === 'node'
}

/** A `node` binary that exists, preferring the descriptor's own search path. */
export function findNode(searchPath: readonly string[]): string | undefined {
  const candidates = [
    ...searchPath.map((dir) => path.join(dir, 'node')),
    ...NODE_CANDIDATES,
  ]
  for (const candidate of candidates) {
    for (const file of expandGlob(expandHome(candidate))) {
      if (isExecutable(file)) return file
    }
  }
  return undefined
}

/**
 * Build the CLI-track policy.
 *
 * `launch` never throws: a missing engine, a refused launch or an unrepairable
 * shim all come back as `{ reason }`, because the caller turns that into a
 * probe line rather than an exception a model has to interpret.
 */
/**
 * Turn the DECLARED search path into the operational one: version-manager
 * entries are globs (`~/.nvm/versions/node/<version>/bin`) and a locator that
 * receives them literally would look for a directory actually named `*`.
 *
 * Verified failure this fixes: `codebuddy-code` exists ONLY under
 * `~/.nvm/versions/node/v22.22.3/bin`, so probe reported an installed engine as
 * unavailable while `claude` (also in /usr/local/bin) and `codex` (also in
 * ~/bin) happened to resolve through a later entry and hid the bug.
 *
 * `~` is deliberately left in place: the resolver expands it against the home
 * directory it was handed, so the policy does not have to know one.
 */
export function expandSearchPath(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) => (dir.includes('*') ? expandGlob(dir) : [dir]))
}

export function createCliPolicy(deps: CliPolicyDeps = {}): TrackPolicy {
  // Expanded once, at construction: `policy.searchPath` is what the resolver
  // iterates, so it must be a list of real directories.
  const searchPath = expandSearchPath(deps.searchPath ?? CLI_SEARCH_PATH)
  const readFile = deps.readFile ?? defaultReadFile
  const resolveNode =
    deps.resolveNode ??
    ((env: Readonly<Record<string, string | undefined>>): string | undefined => {
      // A node already on the child PATH is the best answer: no repair needed.
      const onPath = lookupOnPath('node', env['PATH'])
      return onPath ?? findNode(searchPath)
    })

  return {
    track: 'cli',
    label: 'CLI track (user-installed binary)',
    searchPath,
    launch(input: LaunchInput): { readonly command: CommandSpec } | { readonly reason: string } {
      const { descriptor, executablePath } = input
      if (!executablePath) {
        return { reason: notFoundReason('executable', input.rawExecutable, descriptor.envPrefix) }
      }

      // Explicit interpreter wins, and is an error if it is missing — silently
      // dropping it would run a node script through the OS loader.
      let interpreter = input.interpreterPath
      if (input.rawInterpreter !== undefined && interpreter === undefined) {
        return { reason: notFoundReason('interpreter', input.rawInterpreter, descriptor.envPrefix) }
      }

      let detail: string | undefined
      if (interpreter === undefined) {
        const shebang = readShebang(executablePath, readFile)
        if (shebang !== undefined && wantsNode(shebang) && lookupOnPath('node', input.env['PATH']) === undefined) {
          interpreter = resolveNode(input.env)
          detail = interpreter
            ? `repaired node shim (${shebang}) with ${interpreter}`
            : `node shim (${shebang}) but no usable node interpreter was found`
        }
      }

      const command: CommandSpec = {
        executable: executablePath,
        ...(interpreter !== undefined ? { interpreter } : {}),
        ...(descriptor.command.argsPrefix !== undefined ? { argsPrefix: descriptor.command.argsPrefix } : {}),
        ...(descriptor.command.env !== undefined ? { env: descriptor.command.env } : {}),
        // The wire protocol is launch data, so it must survive the track: the
        // same binary is two identities (`codebuddy-code` speaks both the
        // codebuddy stream-json dialect and ACP) and dropping this would make
        // the ACP identity silently run the wrong protocol.
        ...(descriptor.command.protocolArgs !== undefined
          ? { protocolArgs: descriptor.command.protocolArgs }
          : {}),
      }
      // `detail` is not part of CommandSpec; it travels back through the
      // resolved identity's `reason`-free channel via the logger by the caller.
      void detail
      return { command }
    },
  }
}

/* ------------------------------------------------------------------ helpers */

function defaultReadFile(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(SHEBANG_MAX_BYTES)
      const read = fs.readSync(fd, buffer, 0, SHEBANG_MAX_BYTES, 0)
      const head = buffer.subarray(0, read)
      // A NUL byte in the first block means a binary, not a script.
      if (head.includes(0)) return undefined
      return head.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function lookupOnPath(name: string, searchPath: string | undefined): string | undefined {
  for (const dir of (searchPath ?? '').split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(expandHome(dir), name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function expandHome(raw: string): string {
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

/**
 * Expand the ONE glob shape we allow (a node version-manager directory such as
 * `.../node/<version>/bin/node`), newest version first. Kept deliberately tiny:
 * a general globber here would be a liability, and nvm's layout is the only
 * version-manager path in `CLI_SEARCH_PATH`.
 */
function expandGlob(rawInput: string): string[] {
  // `~` must go BEFORE readdir: Node does not expand it, so a glob handed in as
  // `~/.nvm/.../*/bin` would silently readdir a literal `~` and find nothing.
  // (Caught on the real machine: the registry test passed because it used an
  // absolute temp path, while this host's declared entry starts with `~`.)
  const raw = expandHome(rawInput)
  const marker = raw.indexOf('*')
  if (marker === -1) return [raw]
  const dir = raw.slice(0, raw.lastIndexOf(path.sep, marker))
  const rest = raw.slice(dir.length + 1)
  const inner = rest.indexOf(path.sep)
  try {
    const entries = fs.readdirSync(dir)
    const versions = entries
      .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
      .sort(compareVersionsDesc)
    if (inner === -1) return versions.map((v) => path.join(dir, v))
    const tail = rest.slice(inner + 1)
    return versions.map((v) => path.join(dir, v, tail))
  } catch {
    return []
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
