/**
 * CLI-track policy tests.
 *
 * These lock in the two host facts that motivated the track split. Both are
 * reproduced hermetically here (no real install is touched):
 *
 *  1. a bare `claude`/`codex` resolves through the track's search path even when
 *     the inherited PATH cannot see it, and
 *  2. a `#!/usr/bin/env node` shim gets an interpreter even though `node` is not
 *     on the child's PATH — while a native binary never does.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createRegistry } from '../../src/kernel/registry.ts'
import { CLI_SEARCH_PATH, createCliPolicy, findNode, readShebang, wantsNode } from '../../src/tracks/index.ts'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-cli-track-'))

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function writeFile(name: string, contents: string, mode = 0o755): string {
  const file = path.join(tmpRoot, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, { mode })
  fs.chmodSync(file, mode)
  return file
}

describe('shebang inspection', () => {
  it('recognises the node shims the installed CLIs actually use', () => {
    expect(wantsNode('#!/usr/bin/env node')).toBe(true)
    expect(wantsNode('#!/usr/bin/env -S node --experimental-strip-types')).toBe(true)
    expect(wantsNode('#!/usr/local/bin/node')).toBe(true)
    // Not node: must never be given a node interpreter.
    expect(wantsNode('#!/bin/sh')).toBe(false)
    expect(wantsNode('#!/usr/bin/env python3')).toBe(false)
    expect(wantsNode('#!/usr/bin/env nodejs')).toBe(false)
  })

  it('reads a shebang but refuses to call a binary a script', () => {
    const script = writeFile('shim.sh', '#!/usr/bin/env node\nconsole.log(1)\n')
    expect(readShebang(script)).toBe('#!/usr/bin/env node')

    // A NUL byte in the first block means a real binary (e.g. codex is a Mach-O
    // at /opt/homebrew/Caskroom/codex/.../codex-aarch64-apple-darwin).
    const binary = writeFile('fake-binary', '\u0000\u0001\u0002#!/usr/bin/env node\n')
    expect(readShebang(binary)).toBeUndefined()
  })
})

describe('cli track policy', () => {
  it('repairs a node shim when node is not on the child PATH', () => {
    const policy = createCliPolicy({
      searchPath: [tmpRoot],
      resolveNode: () => '/fake/node',
    })
    const shim = writeFile('repair/claude', '#!/usr/bin/env node\n')
    const outcome = policy.launch({
      descriptor: descriptorFor('repair-claude'),
      executablePath: shim,
      env: { PATH: '/nonexistent' },
      rawExecutable: 'claude',
    })
    expect('command' in outcome).toBe(true)
    if (!('command' in outcome)) return
    expect(outcome.command.executable).toBe(shim)
    expect(outcome.command.interpreter).toBe('/fake/node')
  })

  it('leaves a native binary alone and does not invent an interpreter', () => {
    const policy = createCliPolicy({ searchPath: [tmpRoot], resolveNode: () => '/fake/node' })
    // Binary content (NUL in the first block) — this is what codex is.
    const binary = writeFile('native/codex', '\u0000\u0001MACHO')
    const outcome = policy.launch({
      descriptor: descriptorFor('native-codex'),
      executablePath: binary,
      env: { PATH: '/nonexistent' },
      rawExecutable: 'codex',
    })
    expect('command' in outcome).toBe(true)
    if (!('command' in outcome)) return
    expect(outcome.command.interpreter).toBeUndefined()
  })

  it('does not repair a shim when node IS reachable on the child PATH', () => {
    const policy = createCliPolicy({ searchPath: [tmpRoot], resolveNode: () => '/fake/node' })
    const node = writeFile('onpath/node', '#!/bin/sh\n')
    const shim = writeFile('ok/claude', '#!/usr/bin/env node\n')
    const outcome = policy.launch({
      descriptor: descriptorFor('ok-claude'),
      executablePath: shim,
      env: { PATH: path.dirname(node) },
      rawExecutable: 'claude',
    })
    expect('command' in outcome).toBe(true)
    if (!('command' in outcome)) return
    expect(outcome.command.interpreter).toBeUndefined()
  })

  it('reports the <PREFIX>_PATH escape hatch when nothing resolves', () => {
    const outcome = createCliPolicy({ searchPath: [] }).launch({
      descriptor: { ...descriptorFor('missing-codex'), envPrefix: 'CODEX' },
      env: { PATH: '' },
      rawExecutable: 'codex',
    })
    expect('reason' in outcome).toBe(true)
    if (!('reason' in outcome)) return
    expect(outcome.reason).toContain('executable not found or not executable: codex')
    expect(outcome.reason).toContain('CODEX_PATH')
  })

  it('keeps an explicit interpreter mandatory (never silently dropped)', () => {
    const outcome = createCliPolicy({ searchPath: [] }).launch({
      descriptor: {
        ...descriptorFor('pinned'),
        command: { executable: 'x', interpreter: '/nope/node' },
      },
      executablePath: writeFile('pinned/x', '#!/bin/sh\n'),
      env: { PATH: '' },
      rawExecutable: 'x',
      rawInterpreter: '/nope/node',
    })
    expect('reason' in outcome).toBe(true)
    if (!('reason' in outcome)) return
    expect(outcome.reason).toContain('interpreter not found or not executable')
  })
})

describe('cli track search path', () => {
  it('resolves a bare name the inherited PATH cannot see', () => {
    // The exact failure this exists for: a GUI-launched host has a minimal PATH,
    // so `claude` is invisible even though /usr/local/bin/claude works.
    const bin = path.join(tmpRoot, 'searchbin')
    fs.mkdirSync(bin, { recursive: true })
    const claude = writeFile('searchbin/claude', '#!/bin/sh\nexit 0\n')

    const registry = createRegistry({
      env: { PATH: '/usr/bin:/bin' },
      trackPolicyOptions: { searchPath: [bin] },
      probeVersion: async () => 'test-version',
    })
    const resolved = registry.resolve('claude')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.executablePath).toBe(claude)
  })

  it('prefers the track search path over the inherited PATH', () => {
    const a = path.join(tmpRoot, 'first')
    const b = path.join(tmpRoot, 'second')
    fs.mkdirSync(a, { recursive: true })
    fs.mkdirSync(b, { recursive: true })
    const first = writeFile('first/codex', '#!/bin/sh\n')
    writeFile('second/codex', '#!/bin/sh\n')

    const registry = createRegistry({
      env: { PATH: b },
      trackPolicyOptions: { searchPath: [a] },
    })
    expect(registry.resolve('codex').executablePath).toBe(first)
  })

  it('mirrors the login-shell order: per-user and version-managed dirs first', () => {
    // Observed login PATH order on the target machine. Two codex installs exist
    // (nvm 0.154.0 in ~/bin and the cask 0.144.6 in /opt/homebrew/bin); the
    // search path must agree with the shell about which one wins.
    const homebrew = CLI_SEARCH_PATH.indexOf('/opt/homebrew/bin')
    expect(CLI_SEARCH_PATH.indexOf('~/.local/bin')).toBeLessThan(homebrew)
    expect(CLI_SEARCH_PATH.indexOf('~/bin')).toBeLessThan(homebrew)
    expect(CLI_SEARCH_PATH.findIndex((dir) => dir.includes('nvm'))).toBeLessThan(homebrew)
  })

  it('accepts a NON-executable script when an interpreter will run it', () => {
    // Verified failure: AutoClaw's engine is mode 644 and runs as `node openclaw.mjs`,
    // so an executable-bit test reported a healthy desktop engine as missing.
    const dir = path.join(tmpRoot, 'mode644')
    fs.mkdirSync(dir, { recursive: true })
    const script = path.join(dir, 'engine.mjs')
    fs.writeFileSync(script, 'console.log(1)\n', { mode: 0o644 })
    fs.chmodSync(script, 0o644)
    const node = writeFile('mode644/node', '#!/bin/sh\n')

    const registry = createRegistry({
      env: { PATH: '' },
      trackPolicyOptions: { searchPath: [dir] },
      resolveExecutable: (raw, extraDirs, requireExecutable = true) => {
        const abs = path.resolve(raw)
        if (!fs.existsSync(abs)) return undefined
        if (!requireExecutable) return abs
        try {
          fs.accessSync(abs, fs.constants.X_OK)
          return abs
        } catch {
          return undefined
        }
      },
    })
    // Same file, two answers: unreachable as a bare executable, reachable as a
    // script handed to an interpreter.
    expect(registry.resolve('claude').reason).toBeDefined()
    const viaInterpreter = createRegistry({
      env: { PATH: '', CLAUDE_PATH: script, CLAUDE_INTERPRETER: node },
      trackPolicyOptions: { searchPath: [dir] },
      resolveExecutable: (raw, extraDirs, requireExecutable = true) => {
        const abs = path.resolve(raw)
        if (!fs.existsSync(abs)) return undefined
        if (!requireExecutable) return abs
        try {
          fs.accessSync(abs, fs.constants.X_OK)
          return abs
        } catch {
          return undefined
        }
      },
    }).resolve('claude')
    expect(viaInterpreter.reason).toBeUndefined()
    expect(viaInterpreter.executablePath).toBe(script)
  })

  it('ships the install locations observed on the target machine', () => {
    // Data, not behaviour: if someone trims this list, the GUI-PATH bug returns.
    for (const dir of ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']) {
      expect(CLI_SEARCH_PATH).toContain(dir)
    }
    // nvm's per-version bin dir is a glob expansion, not a literal directory.
    expect(CLI_SEARCH_PATH.some((dir) => dir.includes('node'))).toBe(true)
  })

  it('finds a real node through the glob shape nvm uses', () => {
    const root = path.join(tmpRoot, 'nvm', 'versions', 'node')
    const v22 = path.join(root, 'v22.22.3', 'bin', 'node')
    const v24 = path.join(root, 'v24.1.0', 'bin', 'node')
    for (const file of [v22, v24]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
      fs.chmodSync(file, 0o755)
    }
    // Newest version wins.
    expect(findNode([path.join(root, '<v>', 'bin').replace('<v>', '*')])).toBe(v24)
  })
})

function descriptorFor(id: string) {
  return {
    id,
    track: 'cli' as const,
    family: 'claude' as const,
    displayName: id,
    command: { executable: id },
  }
}
