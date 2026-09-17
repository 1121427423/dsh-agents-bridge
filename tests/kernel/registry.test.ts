import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { BUILTIN_DESCRIPTORS, createRegistry } from '../../src/kernel/registry.ts'
import { policyFor } from '../../src/tracks/index.ts'

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

/**
 * A registry cut off from the host machine — the default for this whole suite.
 *
 * Two leaks are closed here, both of the same kind (a test that passes on this
 * laptop and fails on someone else's):
 *
 * 1. `searchPath: []` — the CLI track otherwise searches `~/.local/bin`,
 *    `/usr/local/bin`, `/opt/homebrew/bin` and the nvm bin dir, so on a machine
 *    where `claude`/`codex` are installed a "PATH is empty ⇒ not found"
 *    assertion silently becomes false. The track's own search behaviour is
 *    covered explicitly in tests/tracks/cli.test.ts.
 * 2. `scan: false` — since P3 the desktop track auto-scans `/Applications` and
 *    `~/Applications` on the first cold `probe()`. Without this, every probe in
 *    this file would read the host's installed apps and could gain identities
 *    (and shift the result count) depending on what the developer happens to
 *    have installed. Tests that genuinely want scan behaviour opt IN with an
 *    injected `scan: { roots: [<tmp fixture root>] }`.
 */
function createHermeticRegistry(options: Parameters<typeof createRegistry>[0] = {}) {
  return createRegistry({ ...options, scan: false, trackPolicyOptions: { searchPath: [] } })
}

describe('built-in descriptor table', () => {
  it('ships the v1 identities with their launch facts', () => {
    const ids = BUILTIN_DESCRIPTORS.map((d) => d.id)
    for (const required of ['claude', 'workbuddy', 'autoclaw', 'openclaw', 'generic', 'hermes']) {
      expect(ids).toContain(required)
    }

    const registry = createHermeticRegistry({ env: { PATH: '' } })
    const claude = registry.get('claude')
    expect(claude?.family).toBe('claude')
    expect(claude?.command.executable).toBe('claude')
    expect(claude?.envPrefix).toBe('CLAUDE')

    // ABI v2: the track is explicit data, and it is NOT the protocol family
    // (openclaw exists on both tracks).
    expect(claude?.track).toBe('cli')
    expect(BUILTIN_DESCRIPTORS.find((d) => d.id === 'codex')?.track).toBe('cli')
    expect(BUILTIN_DESCRIPTORS.find((d) => d.id === 'codex')?.family).toBe('codex')
    expect(BUILTIN_DESCRIPTORS.find((d) => d.id === 'autoclaw')?.track).toBe('desktop')
    expect(BUILTIN_DESCRIPTORS.find((d) => d.id === 'openclaw')?.track).toBe('cli')
    expect(new Set(BUILTIN_DESCRIPTORS.map((d) => d.track))).toEqual(new Set(['cli', 'desktop']))
    for (const descriptor of BUILTIN_DESCRIPTORS) {
      // Every identity must declare a track; an inferred default is the bug
      // this field exists to prevent.
      expect(['cli', 'desktop']).toContain(descriptor.track)
    }

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
    // The profile prefix the descriptor owns; `agent` is NOT here because the
    // openclaw driver already emits it (see tests/integration/argv-shape.test.ts).
    expect(autoclaw?.command.argsPrefix).toEqual(['--profile', 'autoclaw'])

    const openclaw = registry.get('openclaw')
    expect(openclaw?.family).toBe('openclaw')
    expect(openclaw?.command.executable).toBe('openclaw')
    // No prefix at all: the driver supplies the `agent` subcommand, and the CLI
    // track has no profile to select.
    expect(openclaw?.command.argsPrefix).toBeUndefined()

    expect(registry.get('generic')?.family).toBe('generic')
  })

  it('applies overrides without dropping untouched descriptor fields', () => {
    const cli = fakeExecutable('override-cli')
    const registry = createHermeticRegistry({
      env: { PATH: '' },
      overrides: { claude: { displayName: 'Claude (patched)', command: { executable: cli } } },
    })
    expect(registry.get('claude')?.displayName).toBe('Claude (patched)')
    expect(registry.get('claude')?.command.executable).toBe(cli)
    expect(registry.get('claude')?.family).toBe('claude')
  })

  it('merges runtime-discovered identities', () => {
    const registry = createHermeticRegistry({
      env: { PATH: tmpRoot },
      extraDescriptors: [
        {
          id: 'house-agent',
          // ABI v2: an extra identity must declare its track. Omitting it is a
          // loud failure by design — the bridge never guesses which half of the
          // implementation should launch something.
          track: 'cli',
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
    const registry = createHermeticRegistry({
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
    const registry = createHermeticRegistry({
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
    const registry = createHermeticRegistry({
      env: { PATH: '', WORKBUDDY_PATH: cli, WORKBUDDY_INTERPRETER: '' },
    })
    const resolved = registry.resolve('workbuddy')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.command.interpreter).toBeUndefined()
  })

  it('reports a missing interpreter instead of pretending to be launchable', () => {
    const cli = fakeExecutable('codebuddy-cli-2')
    const registry = createHermeticRegistry({
      env: { PATH: '', WORKBUDDY_PATH: cli, WORKBUDDY_INTERPRETER: path.join(tmpRoot, 'no-such-node') },
    })
    const resolved = registry.resolve('workbuddy')
    expect(resolved.reason).toContain('interpreter not found or not executable')
    expect(resolved.reason).toContain('WORKBUDDY_PATH')
  })

  it('reports a missing executable with the override hint', () => {
    const registry = createHermeticRegistry({ env: { PATH: '' } })
    const resolved = registry.resolve('claude')
    expect(resolved.reason).toContain('executable not found or not executable: claude')
    expect(resolved.reason).toContain('CLAUDE_PATH')
  })

  it('reports unsupported identities without trying to resolve them', () => {
    const registry = createHermeticRegistry({ env: { PATH: tmpRoot } })
    const resolved = registry.resolve('mimo')
    expect(resolved.reason).toBe(registry.get('mimo')?.unsupported?.reason)
    expect(resolved.reason).toContain('asar')
  })
})

describe('cli track search path expansion', () => {
  it('resolves an engine that exists ONLY inside a version-manager glob dir', () => {
    // Verified failure this locks in: `codebuddy-code` lives only under
    // ~/.nvm/versions/node/<version>/bin. A locator handed the glob literally
    // looks for a directory named `*`, so probe reported an installed engine as
    // unavailable — while `claude` (/usr/local/bin) and `codex` (~/bin) resolved
    // through later entries and hid it.
    const versionDir = path.join(tmpRoot, 'fake-nvm', 'versions', 'node', 'v22.22.3', 'bin')
    fs.mkdirSync(versionDir, { recursive: true })
    const engine = path.join(versionDir, 'codebuddy-code')
    fs.writeFileSync(engine, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.chmodSync(engine, 0o755)

    const registry = createRegistry({
      env: { PATH: '/usr/bin:/bin' },
      trackPolicyOptions: { searchPath: [path.join(tmpRoot, 'fake-nvm', 'versions', 'node', '<v>', 'bin').replace('<v>', '*')] },
    })
    const descriptor = {
      id: 'globbed',
      track: 'cli' as const,
      family: 'codebuddy' as const,
      displayName: 'globbed engine',
      command: { executable: 'codebuddy-code' },
    }
    const registryWithExtra = createRegistry({
      env: { PATH: '/usr/bin:/bin' },
      extraDescriptors: [descriptor],
      trackPolicyOptions: { searchPath: [path.join(tmpRoot, 'fake-nvm', 'versions', 'node', '*', 'bin')] },
    })
    expect(registryWithExtra.resolve('globbed').executablePath).toBe(engine)
    // The glob must end up expanded to REAL directories before it reaches the
    // resolver, and `~` must already be gone: a path like
    // `~/.nvm/versions/node/*/bin` readdirs a literal `~` and finds nothing,
    // which is how an installed engine looked unavailable on this machine.
    const policyDirs = policyFor('cli', { searchPath: [path.join(tmpRoot, 'fake-nvm', 'versions', 'node', '*', 'bin')] }).searchPath
    expect(policyDirs).toEqual([path.join(tmpRoot, 'fake-nvm', 'versions', 'node', 'v22.22.3', 'bin')])
    const declared = policyFor('cli').searchPath
    // Globs are consumed; `~` is deliberately KEPT, because the resolver expands
    // it against the home directory it was handed and the policy does not know
    // one. So the contract is: glob-free, and either absolute or `~/...`.
    expect(declared.some((dir) => dir.includes('*'))).toBe(false)
    expect(declared.every((dir) => dir.startsWith(path.sep) || dir.startsWith('~/'))).toBe(true)
    // Host-guarded proof that the glob produced a REAL directory: on a machine
    // with nvm the expanded version-manager entry must exist.
    for (const dir of declared.filter((entry) => entry.includes('.nvm'))) {
      expect(fs.existsSync(dir.replace(/^~/, os.homedir()))).toBe(true)
    }
    // And the declared constant really does contain such a glob, so this path is
    // exercised on the real machine rather than only in this test.
    expect(registry.descriptors.length).toBeGreaterThan(0)
  })
})

describe('probe() reports launch + credential health + model discovery', () => {
  it('reads credential status and models from the engine\'s own config file', async () => {
    const settings = JSON.stringify({
      env: { OPENAI_API_KEY: 'sk-live-0123456789abcdef', CLAUDE_CODE_USE_OPENAI: '1', OPEN_MODEL: 'deepseek-v4-flash[1m]' },
    })
    const registry = createHermeticRegistry({
      // A real (fake) binary, so the launch half of the health is exercised too:
      // credential status and model discovery are reported independently of it.
      env: { PATH: '', CLAUDE_PATH: fakeExecutable('probe-claude-health') },
      probeVersion: async () => '2.8.4',
      hostOptions: { home: '/home/test', contents: { '/home/test/.claude/settings.json': settings } },
    })
    const claude = (await registry.probe()).find((r) => r.id === 'claude')
    expect(claude?.health?.launch).toBe('ok')
    expect(claude?.health?.credential).toBe('ok')
    expect(claude?.models).toEqual(['deepseek-v4-flash'])
    expect(claude?.modelsSource).toContain('.claude/settings.json')
    // The status is presence-only by contract, and it says so.
    expect(claude?.health?.detail).toContain('presence only')
  })

  it('never lets a credential value reach probe output', async () => {
    const key = 'sk-ant-REALSECRETVALUE0123456789'
    const registry = createHermeticRegistry({
      env: { PATH: '' },
      probeVersion: async () => '1.0.0',
      hostOptions: {
        home: '/home/test',
        contents: { '/home/test/.claude/settings.json': JSON.stringify({ env: { OPENAI_API_KEY: key } }) },
      },
    })
    const serialized = JSON.stringify(await registry.probe())
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain('REALSECRETVALUE')
  })

  it('keeps model discovery even when the binary is missing, and never claims "no models"', async () => {
    const config = JSON.stringify({
      models: { providers: { zai: { models: [{ id: 'zaicoding_glm-5.3' }, { id: 'zai_auto' }] } } },
    })
    const registry = createHermeticRegistry({
      env: { PATH: '', AUTOCLAW_PATH: '/nope/openclaw.mjs' },
      hostOptions: { home: '/home/test', contents: { '/home/test/.openclaw-autoclaw/openclaw.json': config } },
    })
    const autoclaw = (await registry.probe()).find((r) => r.id === 'autoclaw')
    expect(autoclaw?.available).toBe(false)
    // Desktop login: the bridge must not look for a token file at all.
    expect(autoclaw?.health?.credential).toBe('not-applicable')
    expect(autoclaw?.models).toEqual(['zaicoding_glm-5.3', 'zai_auto'])
  })

  it('omits models entirely when nothing was discovered (absent is not none)', async () => {
    const registry = createHermeticRegistry({ env: { PATH: '' }, hostOptions: { home: '/home/test', contents: {} } })
    const generic = (await registry.probe()).find((r) => r.id === 'generic')
    expect(generic?.models).toBeUndefined()
    expect(generic?.modelsSource).toBeUndefined()
    expect(generic?.health?.credential).toBe('unknown')
  })

  it('probes workbuddy-ai as its own identity: delegated login + its own catalog', async () => {
    // The two outstanding P3 rows, end to end through probe(). The two
    // WorkBuddy builds differ ONLY in `cli/product.json` `dataFolderName`, so
    // the international build must read `~/.workbuddy-ai` — never the domestic
    // `~/.workbuddy` — and its auth is the app's own login, which the bridge
    // must not go looking for a file to describe.
    const international = JSON.stringify({
      models: [{ id: 'deepseek-v4.1-flash-sg' }, { id: 'gpt-6-astra' }, { id: 'gemini-3.5-flash' }],
    })
    const domestic = JSON.stringify({ models: [{ id: 'hy3' }] })
    const registry = createHermeticRegistry({
      env: { PATH: '' },
      hostOptions: {
        home: '/home/test',
        contents: {
          '/home/test/.workbuddy-ai/cache/acc-product-config-v3.json': international,
          '/home/test/.workbuddy/cache/acc-product-config-v3.json': domestic,
        },
      },
    })
    const result = (await registry.probe()).find((r) => r.id === 'workbuddy-ai')
    expect(result).toBeDefined()
    expect(result?.track).toBe('desktop')
    expect(result?.family).toBe('codebuddy')
    // not-applicable: a desktop login, not a file — and no configPath, because
    // there is no file it was derived from.
    expect(result?.health?.credential).toBe('not-applicable')
    expect(result?.health?.configPath).toBeUndefined()
    expect(result?.health?.detail).toContain('www.workbuddy.ai')
    // Its OWN catalog, not the domestic one.
    expect(result?.models).toEqual(['deepseek-v4.1-flash-sg', 'gpt-6-astra', 'gemini-3.5-flash'])
    expect(result?.modelsSource).toContain('.workbuddy-ai/cache/acc-product-config-v3.json')
  })

  it('degrades workbuddy-ai model discovery to "not discovered" when its cache is unreadable', async () => {
    // D19: this file is a SERVER-PUSHED cache, so its absence is routine and
    // must never throw or claim the engine has no models.
    const registry = createHermeticRegistry({ env: { PATH: '' }, hostOptions: { home: '/home/test', contents: {} } })
    const result = (await registry.probe()).find((r) => r.id === 'workbuddy-ai')
    expect(result).toBeDefined()
    expect(result?.models).toBeUndefined()
    expect(result?.modelsSource).toBeUndefined()
    // The credential half is unaffected by a missing catalog, and vice versa.
    expect(result?.health?.credential).toBe('not-applicable')
  })
})

describe('probe()', () => {
  it('probes <exe> --version (through the interpreter) and reports availability', async () => {
    const cli = fakeExecutable('probe-codebuddy')
    const node = fakeExecutable('probe-node')
    const calls: string[][] = []
    const registry = createHermeticRegistry({
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
    const registry = createHermeticRegistry({
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
    const registry = createHermeticRegistry({
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

  it('single-flights concurrent probes instead of re-walking and re-spawning (MI-22)', async () => {
    // `probe({refresh:true})` is the expensive call: a bundle walk, a port
    // sweep, and one `--version` child per resolvable identity. Two callers that
    // arrive together (the panel's refresh button plus a model's `agents_probe`)
    // used to run the whole pass twice — the second caller now joins the first
    // in-flight promise.
    const cli = fakeExecutable('probe-cli-single-flight')
    let probeCalls = 0
    const registry = createHermeticRegistry({
      env: { PATH: '', GENERIC_PATH: cli },
      probeVersion: async () => {
        probeCalls += 1
        // Long enough that the two calls genuinely overlap: without a delay the
        // first pass can finish before the second one starts, which would make
        // the defect invisible in the count.
        await new Promise((resolve) => setTimeout(resolve, 5))
        return '1.0.0'
      },
    })

    const [first, second] = await Promise.all([
      registry.probe({ refresh: true }),
      registry.probe({ refresh: true }),
    ])
    const concurrent = probeCalls
    // Both callers were served, with the same facts.
    expect(concurrent).toBeGreaterThan(0)
    expect(first.map((r) => r.id).sort()).toEqual(second.map((r) => r.id).sort())

    // One solo refresh after that is exactly one pass, so `concurrent` must not
    // be the 2× a missing single-flight would produce.
    probeCalls = 0
    await registry.probe({ refresh: true })
    expect(concurrent).toBe(probeCalls)
  })

  it('invalidates the cache on demand', async () => {
    const cli = fakeExecutable('probe-cli-invalidate')
    let probeCalls = 0
    const registry = createHermeticRegistry({
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
