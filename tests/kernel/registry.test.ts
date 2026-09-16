import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { BUILTIN_DESCRIPTORS, createRegistry } from '../../src/kernel/registry.ts'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-registry-'))

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** Create a fake executable so PATH lookup has something real to find. */
function fakeExecutable(name: string): string {
  const file = path.join(tmpRoot, name)
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return file
}

describe('built-in descriptor table', () => {
  it('ships the v1 identities with their launch facts', () => {
    const ids = BUILTIN_DESCRIPTORS.map((d) => d.id)
    for (const required of ['claude', 'workbuddy', 'autoclaw', 'openclaw', 'generic']) {
      expect(ids).toContain(required)
    }

    const registry = createRegistry({ env: { PATH: '' } })
    const claude = registry.get('claude')
    expect(claude?.family).toBe('claude')
    expect(claude?.command.executable).toBe('claude')
    expect(claude?.envPrefix).toBe('CLAUDE')

    const workbuddy = registry.get('workbuddy')
    expect(workbuddy?.family).toBe('codebuddy')
    expect(workbuddy?.command.executable).toBe(
      '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    )
    expect(workbuddy?.command.interpreter).toBe('/opt/homebrew/bin/node')

    const autoclaw = registry.get('autoclaw')
    expect(autoclaw?.family).toBe('openclaw')
    expect(autoclaw?.command.executable).toBe(
      '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs',
    )
    expect(autoclaw?.command.interpreter).toBe('/opt/homebrew/bin/node')
    expect(autoclaw?.command.argsPrefix).toEqual(['agent'])

    const openclaw = registry.get('openclaw')
    expect(openclaw?.family).toBe('openclaw')
    expect(openclaw?.command.executable).toBe('openclaw')
    expect(openclaw?.command.argsPrefix).toEqual(['agent'])

    expect(registry.get('generic')?.family).toBe('generic')
  })

  it('applies overrides without dropping untouched descriptor fields', () => {
    const cli = fakeExecutable('override-cli')
    const registry = createRegistry({
      env: { PATH: '' },
      overrides: { claude: { displayName: 'Claude (patched)', command: { executable: cli } } },
    })
    expect(registry.get('claude')?.displayName).toBe('Claude (patched)')
    expect(registry.get('claude')?.command.executable).toBe(cli)
    expect(registry.get('claude')?.family).toBe('claude')
  })

  it('merges runtime-discovered identities', () => {
    const registry = createRegistry({
      env: { PATH: tmpRoot },
      extraDescriptors: [
        {
          id: 'house-agent',
          family: 'generic',
          displayName: 'House agent',
          command: { executable: fakeExecutable('house-agent') },
          envPrefix: 'HOUSE',
        },
      ],
    })
    expect(registry.descriptors.map((d) => d.id)).toContain('house-agent')
    expect(registry.resolve('house-agent').reason).toBeUndefined()
  })
})

describe('resolve()', () => {
  it('resolves a bare name through PATH', () => {
    const claude = fakeExecutable('claude-on-path')
    const dir = path.dirname(claude)
    const registry = createRegistry({
      env: { PATH: dir },
      overrides: { claude: { command: { executable: path.basename(claude) } } },
    })
    const resolved = registry.resolve('claude')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.executablePath).toBe(claude)
    expect(resolved.command.executable).toBe(claude)
  })

  it('honours <PREFIX>_PATH / _INTERPRETER / _MODEL', () => {
    const cli = fakeExecutable('codebuddy-cli')
    const node = fakeExecutable('node-interpreter')
    const registry = createRegistry({
      env: {
        PATH: '',
        WORKBUDDY_PATH: cli,
        WORKBUDDY_INTERPRETER: node,
        WORKBUDDY_MODEL: 'gpt-5.4',
      },
    })
    const resolved = registry.resolve('workbuddy')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.executablePath).toBe(cli)
    expect(resolved.interpreterPath).toBe(node)
    expect(resolved.command.interpreter).toBe(node)
    expect(resolved.model).toBe('gpt-5.4')
  })

  it('can drop an interpreter with an explicit empty override', () => {
    const cli = fakeExecutable('native-cli')
    const registry = createRegistry({
      env: { PATH: '', WORKBUDDY_PATH: cli, WORKBUDDY_INTERPRETER: '' },
    })
    const resolved = registry.resolve('workbuddy')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.command.interpreter).toBeUndefined()
  })

  it('reports a missing interpreter instead of pretending to be launchable', () => {
    const cli = fakeExecutable('codebuddy-cli-2')
    const registry = createRegistry({
      env: { PATH: '', WORKBUDDY_PATH: cli, WORKBUDDY_INTERPRETER: path.join(tmpRoot, 'no-such-node') },
    })
    const resolved = registry.resolve('workbuddy')
    expect(resolved.reason).toContain('interpreter not found or not executable')
    expect(resolved.reason).toContain('WORKBUDDY_PATH')
  })

  it('reports a missing executable with the override hint', () => {
    const registry = createRegistry({ env: { PATH: '' } })
    const resolved = registry.resolve('claude')
    expect(resolved.reason).toContain('executable not found or not executable: claude')
    expect(resolved.reason).toContain('CLAUDE_PATH')
  })

  it('reports unsupported identities without trying to resolve them', () => {
    const registry = createRegistry({ env: { PATH: tmpRoot } })
    const resolved = registry.resolve('mimo')
    expect(resolved.reason).toBe(registry.get('mimo')?.unsupported?.reason)
    expect(resolved.reason).toContain('asar')
  })
})

describe('probe()', () => {
  it('probes <exe> --version (through the interpreter) and reports availability', async () => {
    const cli = fakeExecutable('probe-codebuddy')
    const node = fakeExecutable('probe-node')
    const calls: string[][] = []
    const registry = createRegistry({
      env: { PATH: '', WORKBUDDY_PATH: cli, WORKBUDDY_INTERPRETER: node },
      probeVersion: async ({ argv }) => {
        calls.push([...argv])
        return '1.2.3'
      },
    })

    const results = await registry.probe()
    const workbuddy = results.find((r) => r.id === 'workbuddy')
    expect(workbuddy?.available).toBe(true)
    expect(workbuddy?.executable).toBe(cli)
    expect(workbuddy?.version).toBe('1.2.3')
    expect(calls).toContainEqual([node, cli, '--version'])

    const mimo = results.find((r) => r.id === 'mimo')
    expect(mimo?.available).toBe(false)
    expect(mimo?.reason).toContain('asar')

    const claude = results.find((r) => r.id === 'claude')
    expect(claude?.available).toBe(false)
    expect(claude?.reason).toContain('not found')
  })

  it('keeps an unknown version from failing the probe', async () => {
    const cli = fakeExecutable('probe-cli-flaky')
    const registry = createRegistry({
      env: { PATH: '', GENERIC_PATH: cli },
      probeVersion: async () => {
        throw new Error('probe exploded')
      },
    })
    const results = await registry.probe()
    const generic = results.find((r) => r.id === 'generic')
    expect(generic?.available).toBe(true)
    expect(generic?.version).toBeUndefined()
  })

  it('caches results for the TTL and honours refresh', async () => {
    const cli = fakeExecutable('probe-cli-cache')
    let clock = 0
    let probeCalls = 0
    const registry = createRegistry({
      env: { PATH: '', GENERIC_PATH: cli },
      now: () => clock,
      probeVersion: async () => {
        probeCalls += 1
        return '9.9.9'
      },
    })

    await registry.probe()
    const afterFirst = probeCalls
    expect(afterFirst).toBeGreaterThan(0)

    await registry.probe()
    expect(probeCalls).toBe(afterFirst) // served from cache

    clock = 61_000
    await registry.probe()
    expect(probeCalls).toBe(afterFirst * 2) // TTL expired

    await registry.probe({ refresh: true })
    expect(probeCalls).toBe(afterFirst * 3)
  })

  it('invalidates the cache on demand', async () => {
    const cli = fakeExecutable('probe-cli-invalidate')
    let probeCalls = 0
    const registry = createRegistry({
      env: { PATH: '', GENERIC_PATH: cli },
      probeVersion: async () => {
        probeCalls += 1
        return undefined
      },
    })
    await registry.probe()
    const afterFirst = probeCalls
    registry.invalidate()
    await registry.probe()
    expect(probeCalls).toBe(afterFirst * 2)
  })
})
