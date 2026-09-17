/**
 * App-bundle scan tests (P3).
 *
 * EVERY fixture here is a fake bundle built in a tmp dir, and every filesystem
 * interaction that matters goes through an injected `readDir`/`roots` seam. Not
 * one assertion reads this machine's `/Applications`: a test that needed the
 * real bundles would pass here and fail on any other machine, which is the
 * definition of a test that does not test anything.
 *
 * The one exception is the explicitly host-guarded block at the bottom, which
 * asserts the scanner agrees with the REAL WorkBuddy bundles where they exist.
 * It skips elsewhere, and nothing above depends on it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { BUILTIN_DESCRIPTORS, createRegistry } from '../../src/kernel/registry.ts'
import {
  bundleSlug,
  envPrefixFor,
  inferFamily,
  mergeScannedIdentities,
  parseProductIdentity,
  productIdentityId,
  scanDesktopBundles,
  shadowedSummary,
  slugify,
  type DirEntry,
} from '../../src/tracks/desktop/scan.ts'
import { DESKTOP_TRACK_DESCRIPTORS } from '../../src/tracks/desktop/catalog.ts'
import { createDesktopPolicy } from '../../src/tracks/desktop/index.ts'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-scan-'))

const BUILTIN_IDS = BUILTIN_DESCRIPTORS.map((descriptor) => descriptor.id)

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** The production directory reader, re-exposed for the cache-counting tests. */
function defaultReadDirForTest(absolutePath: string): readonly DirEntry[] {
  let names: string[]
  try {
    names = fs.readdirSync(absolutePath)
  } catch {
    return []
  }
  return names.map((name) => {
    try {
      const stat = fs.statSync(path.join(absolutePath, name))
      return { name, isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size }
    } catch {
      return { name, isDirectory: false, isFile: false }
    }
  })
}

/* --------------------------------------------------------------- fixtures */

/** The real shape of a bundled-CodeBuddy-CLI `product.json`, trimmed. */
function productJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    $schema: 'product-schema.json',
    productName: 'WorkBuddy',
    platform: 'CLI',
    endpoint: 'https://copilot.tencent.com',
    applicationName: 'WorkBuddy',
    dataFolderName: '.workbuddy',
    darwinBundleIdentifier: 'com.tencent.workbuddy.mac',
    ...overrides,
  })
}

interface BundleSpec {
  /** Directory name, including `.app`. */
  readonly name: string
  /** `cli/product.json` contents; omit for a bundle with no CLI. */
  readonly product?: string
  /** Write `cli/bin/codebuddy`. */
  readonly launcher?: boolean
  /** Write a `Contents/Info.plist` carrying this `CFBundleIdentifier`. */
  readonly bundleId?: string
  /** Extra files, keyed by path relative to `Contents`. */
  readonly files?: Readonly<Record<string, string>>
  /** Create the `Contents` directory at all (false models a bare `Foo.app`). */
  readonly contents?: boolean
}

function writeBundle(root: string, spec: BundleSpec): string {
  const bundlePath = path.join(root, spec.name)
  fs.mkdirSync(bundlePath, { recursive: true })
  if (spec.contents === false) return bundlePath
  const contents = path.join(bundlePath, 'Contents')
  fs.mkdirSync(contents, { recursive: true })
  if (spec.bundleId !== undefined) {
    fs.writeFileSync(
      path.join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key>\n<string>${spec.bundleId}</string>\n</dict></plist>\n`,
    )
  }
  if (spec.product !== undefined) {
    const cli = path.join(contents, 'Resources', 'app.asar.unpacked', 'cli')
    fs.mkdirSync(cli, { recursive: true })
    fs.writeFileSync(path.join(cli, 'product.json'), spec.product)
    if (spec.launcher !== false) {
      const bin = path.join(cli, 'bin')
      fs.mkdirSync(bin, { recursive: true })
      fs.writeFileSync(path.join(bin, 'codebuddy'), '#!/usr/bin/env node\n', { mode: 0o755 })
    }
  }
  for (const [relative, body] of Object.entries(spec.files ?? {})) {
    const target = path.join(contents, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // A bundled `node` is executable on the real bundles (AutoClaw's is 0755),
    // and the scanner requires the bit, so the fixture sets it.
    const mode = path.basename(relative) === 'node' ? 0o755 : 0o644
    fs.writeFileSync(target, body, { mode })
  }
  return bundlePath
}

/** A fresh directory per test, so no test can see another's bundles. */
let bundleCounter = 0
function freshRoot(): string {
  bundleCounter += 1
  const root = path.join(tmpRoot, `root-${bundleCounter}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

/* ---------------------------------------------------------- pure helpers */

describe('scan helpers', () => {
  it('slugifies a product name into a stable id, matching the built-in ids', () => {
    // The important property: the REAL product values land on the ids the
    // built-in table already uses, so a scan of the standard install SHADOWS
    // rather than duplicating.
    expect(slugify('workbuddy-ai')).toBe('workbuddy-ai')
    expect(slugify('WorkBuddy AI')).toBe('workbuddy-ai')
    expect(slugify('WorkBuddy')).toBe('workbuddy')
    expect(slugify('  AutoClaw  ')).toBe('autoclaw')
    expect(slugify('')).toBe('')
    expect(bundleSlug('WorkBuddy AI.app')).toBe('workbuddy-ai')
    expect(bundleSlug('Foo')).toBe('foo')
    expect(envPrefixFor('workbuddy-ai')).toBe('WORKBUDDY_AI')
    expect(envPrefixFor('some.new app')).toBe('SOME_NEW_APP')
  })

  it('reads the identity fields out of a product.json, ignoring the rest', () => {
    const identity = parseProductIdentity(
      JSON.stringify({
        $schema: 'product-schema.json',
        productName: 'WorkBuddy AI',
        applicationName: 'workbuddy-ai',
        dataFolderName: '.workbuddy-ai',
        isOversea: true,
        darwinBundleIdentifier: 'com.workbuddy.workbuddy-ai',
        endpoint: 'https://www.workbuddy.ai',
        // Everything below is noise the reader must not pick an id out of.
        models: [{ id: 'not-an-identity' }],
        authentication: { id: 'workbuddy-desktop-ai' },
      }),
    )
    expect(identity?.applicationName).toBe('workbuddy-ai')
    expect(identity?.dataFolderName).toBe('.workbuddy-ai')
    expect(identity?.isOversea).toBe(true)
    expect(identity?.endpoint).toBe('https://www.workbuddy.ai')
  })

  it('refuses a product.json that says nothing that could identify a product', () => {
    expect(parseProductIdentity('not json at all')).toBeUndefined()
    expect(parseProductIdentity('[1,2,3]')).toBeUndefined()
    // Parses as an object, but carries no identity field: not evidence.
    expect(parseProductIdentity(JSON.stringify({ models: [], tools: [] }))).toBeUndefined()
  })

  it('derives the id from applicationName first, then productName, then the bundle name', () => {
    expect(productIdentityId({ applicationName: 'workbuddy-ai' }, 'fallback')).toBe('workbuddy-ai')
    // `applicationName` wins over the display label — that is what makes the
    // international build produce the id the built-in table uses.
    expect(productIdentityId({ applicationName: 'workbuddy-ai', productName: 'WorkBuddy AI' }, 'x')).toBe('workbuddy-ai')
    expect(productIdentityId({ productName: 'WorkBuddy AI' }, 'x')).toBe('workbuddy-ai')
    expect(productIdentityId(undefined, 'foo')).toBe('foo')
    expect(productIdentityId(undefined, '')).toBe('')
  })
})

/* --------------------------------------------------------------- scanning */

describe('scanDesktopBundles', () => {
  it('produces TWO distinct identities for two bundles with different product.json', () => {
    const root = freshRoot()
    writeBundle(root, {
      name: 'WorkBuddy.app',
      product: productJson(),
      bundleId: 'com.tencent.workbuddy.mac',
    })
    writeBundle(root, {
      name: 'WorkBuddy AI.app',
      product: productJson({
        productName: 'WorkBuddy AI',
        applicationName: 'workbuddy-ai',
        dataFolderName: '.workbuddy-ai',
        isOversea: true,
        darwinBundleIdentifier: 'com.workbuddy.workbuddy-ai',
        endpoint: 'https://www.workbuddy.ai',
      }),
      bundleId: 'com.workbuddy.workbuddy-ai',
    })

    const scan = scanDesktopBundles({ roots: [root] })
    const byId = new Map(scan.identities.map((entry) => [entry.descriptor.id, entry.descriptor]))
    // This is the whole point of the workstream: two bundles, one byte-identical
    // launcher, two identities — decided by the FILE, not by the directory name.
    expect([...byId.keys()].sort()).toEqual(['workbuddy', 'workbuddy-ai'])

    const domestic = byId.get('workbuddy')!
    const international = byId.get('workbuddy-ai')!
    expect(domestic.family).toBe('codebuddy')
    expect(international.family).toBe('codebuddy')
    expect(domestic.command.executable).not.toBe(international.command.executable)
    expect(domestic.command.executable).toContain('WorkBuddy.app/')
    expect(international.command.executable).toContain('WorkBuddy AI.app/')
    expect(domestic.track).toBe('desktop')
    expect(international.track).toBe('desktop')
    expect(domestic.envPrefix).toBe('WORKBUDDY')
    expect(international.envPrefix).toBe('WORKBUDDY_AI')
  })

  it('puts the product.json facts into notes, so an identity is diagnosable', () => {
    const root = freshRoot()
    writeBundle(root, {
      name: 'WorkBuddy AI.app',
      product: productJson({
        applicationName: 'workbuddy-ai',
        dataFolderName: '.workbuddy-ai',
        isOversea: true,
      }),
    })
    const scan = scanDesktopBundles({ roots: [root] })
    const notes = scan.identities[0]!.descriptor.notes ?? ''
    // Which bundle, which file, and what the file said — all three, so a wrong
    // identity can be traced without re-running anything.
    expect(notes).toContain('WorkBuddy AI.app')
    expect(notes).toContain('Resources/app.asar.unpacked/cli/product.json')
    expect(notes).toContain('applicationName=workbuddy-ai')
    expect(notes).toContain('dataFolderName=.workbuddy-ai')
    expect(notes).toContain('isOversea=true')
    // The load-bearing consequence is stated, not left implicit.
    expect(notes).toContain('.workbuddy-ai')
  })

  it('is reproducible: the same machine yields the same ids in the same order', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'Beta.app', product: productJson({ applicationName: 'beta-agent' }) })
    writeBundle(root, { name: 'Alpha.app', product: productJson({ applicationName: 'alpha-agent' }) })
    const first = scanDesktopBundles({ roots: [root] })
    const second = scanDesktopBundles({ roots: [root] })
    // Same ids, same order, on repeated probes — the property that makes a
    // scanned id safe to address from settings or an env override.
    expect(first.identities.map((entry) => entry.descriptor.id)).toEqual(
      second.identities.map((entry) => entry.descriptor.id),
    )
    // Bundle order is sorted, not "whatever readdir returned".
    expect(first.identities.map((entry) => entry.descriptor.id)).toEqual(['alpha-agent', 'beta-agent'])
    // No random numbers, no timestamps, no absolute paths in the id.
    for (const entry of first.identities) {
      expect(entry.descriptor.id).not.toMatch(/\d{6,}/)
      expect(entry.descriptor.id).not.toContain(tmpRoot)
      expect(entry.descriptor.id).not.toContain('/')
    }
  })

  it('skips a malformed bundle safely instead of throwing', () => {
    const root = freshRoot()
    // A directory named `Foo.app` with no Contents/ at all.
    fs.mkdirSync(path.join(root, 'Empty.app'), { recursive: true })
    // A product.json that is not JSON, with a launcher beside it.
    writeBundle(root, { name: 'Broken.app', product: '{{{ this is not json' })
    // A product.json that is JSON but says nothing identifiable.
    writeBundle(root, { name: 'Useless.app', product: JSON.stringify({ models: [] }) })
    // A product.json with no launcher beside it.
    writeBundle(root, { name: 'NoLauncher.app', product: productJson(), launcher: false })
    // A dangling symlink where a bundle is expected.
    fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(root, 'Dangling.app'))
    // A real directory (not a bundle) among the candidates.
    fs.mkdirSync(path.join(root, 'plain-directory'), { recursive: true })

    const scan = scanDesktopBundles({ roots: [root] })
    expect(scan.identities).toEqual([])
    // Every candidate is accounted for rather than silently vanishing.
    expect(scan.skipped.length).toBeGreaterThan(0)
    expect(scan.budgetExhausted).toBe(false)
  })

  it('never throws for a bundle whose Contents is unreadable', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'Hostile.app', product: productJson() })
    const hostile = path.join(root, 'Hostile.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'product.json')
    fs.chmodSync(hostile, 0o000)
    try {
      expect(() => scanDesktopBundles({ roots: [root] })).not.toThrow()
      const scan = scanDesktopBundles({ roots: [root] })
      // Explicitly no fabricated identity from an unreadable file.
      expect(scan.identities.map((entry) => entry.descriptor.id)).not.toContain('hostile')
    } finally {
      fs.chmodSync(hostile, 0o644)
    }
  })

  it('honours the wall-clock budget and says so', () => {
    const root = freshRoot()
    for (let i = 0; i < 12; i += 1) {
      writeBundle(root, { name: `App${i}.app`, product: productJson({ applicationName: `agent-${i}` }) })
    }
    // Pin the origin, then advance the clock past the deadline: the walk must
    // stop instead of reading all 12 bundles.
    const scan = scanDesktopBundles({
      roots: [root],
      startedAt: 1_000_000_000,
      now: () => 1_000_000_000 + 5_000,
      budgetMs: 1,
    })
    expect(scan.budgetExhausted).toBe(true)
    expect(scan.identities.length).toBeLessThan(12)

    // A clock that stays INSIDE the budget reads everything, so the bound is a
    // bound and not a bug.
    const full = scanDesktopBundles({
      roots: [root],
      startedAt: 1_000_000_000,
      now: () => 1_000_000_000,
      budgetMs: 10_000,
    })
    expect(full.identities.length).toBe(12)
    expect(full.budgetExhausted).toBe(false)
  })

  it('listens to an injected directory reader and never touches the real fs', () => {
    // A tree that exists only in memory: `readDir` answers for the fake paths.
    const tree: Record<string, readonly DirEntry[]> = {
      '/fake/Apps': [{ name: 'Ghost.app', isDirectory: true, isFile: false }],
      '/fake/Apps/Ghost.app/Contents': [{ name: 'Info.plist', isDirectory: false, isFile: true }],
    }
    const seen: string[] = []
    const scan = scanDesktopBundles({
      roots: ['/fake/Apps'],
      readDir: (absolutePath) => {
        seen.push(absolutePath)
        return tree[absolutePath] ?? []
      },
    })
    // The fake bundle has no CLI and no engine, so it is skipped — and the point
    // is that the walk NEVER asked the real filesystem anything.
    expect(scan.identities).toEqual([])
    expect(seen).toContain('/fake/Apps')
    expect(seen).toContain('/fake/Apps/Ghost.app/Contents')
    for (const dir of seen) expect(dir.startsWith('/fake/')).toBe(true)
  })

  it('recognises a bundled node engine and a bundled interpreter', () => {
    const root = freshRoot()
    writeBundle(root, {
      name: 'Gateway.app',
      files: {
        'Resources/gateway/acmeopenclaw/acmeopenclaw.mjs': '#!/usr/bin/env node\n// openclaw gateway\n',
        'Resources/node/darwin-arm64/node': '#!/bin/sh\nexit 0\n',
      },
    })
    const scan = scanDesktopBundles({ roots: [root] })
    const engine = scan.identities[0]!.descriptor
    expect(engine.id).toBe('acmeopenclaw')
    expect(engine.track).toBe('desktop')
    expect(engine.family).toBe('openclaw')
    expect(engine.command.executable).toContain('acmeopenclaw.mjs')
    // The interpreter is preferred FROM THE BUNDLE, not from PATH.
    expect(engine.command.interpreter).toContain('/Contents/Resources/node/darwin-arm64/node')
    // No verified argv exists for an unknown engine, so it is not launchable.
    expect(engine.unsupported).toBeDefined()
    expect(engine.unsupported?.reason).toContain('acmeopenclaw.mjs')
  })

  it('reports a lone bundled interpreter as an unsupported candidate, not as an agent', () => {
    const root = freshRoot()
    writeBundle(root, {
      name: 'Runtime.app',
      files: { 'Resources/node/darwin-arm64/node': '#!/bin/sh\nexit 0\n' },
    })
    const scan = scanDesktopBundles({ roots: [root] })
    const descriptor = scan.identities[0]!.descriptor
    expect(descriptor.id).toBe('runtime-interpreter')
    expect(descriptor.unsupported).toBeDefined()
    expect(descriptor.unsupported?.reason).toContain('interpreter cannot be driven on its own')
  })

  it('infers the engine family from the registered list, never inventing one', () => {
    const root = freshRoot()
    const enginePath = path.join(root, 'thing.mjs')
    fs.writeFileSync(enginePath, '#!/usr/bin/env node\n// a totally unknown agent runtime\n')
    // "unknown" is not in the registered list, so it must fall back rather than
    // produce a family no driver implements.
    expect(inferFamily(enginePath, ['claude', 'codebuddy', 'codex', 'openclaw', 'generic'], 'thing')).toBe('generic')
    expect(inferFamily(enginePath, ['claude', 'codebuddy'], 'thing')).toBe('claude')
    // A file that names a registered family is matched on it.
    expect(inferFamily(enginePath, ['openclaw', 'generic'], 'openclaw')).toBe('openclaw')
  })

  it('returns an empty, well-formed result for a root that does not exist', () => {
    const scan = scanDesktopBundles({ roots: [path.join(tmpRoot, 'nope-never-created')] })
    expect(scan.identities).toEqual([])
    expect(scan.budgetExhausted).toBe(false)
    expect(scan.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

/* ----------------------------------------------------------- merge rules */

describe('built-in descriptors always win over a scan', () => {
  it('never lets a scanned identity replace a built-in id', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'AutoClaw.app', product: productJson({ applicationName: 'autoclaw' }) })
    writeBundle(root, { name: 'WorkBuddy.app', product: productJson() })
    const scan = scanDesktopBundles({ roots: [root] })
    // The scan really did produce both ids…
    expect(scan.identities.map((entry) => entry.descriptor.id).sort()).toEqual(['autoclaw', 'workbuddy'])

    const merged = mergeScannedIdentities(DESKTOP_TRACK_DESCRIPTORS, scan.identities)
    // …and neither was added, because the built-in table already names them.
    expect(merged.descriptors.map((descriptor) => descriptor.id)).toEqual(
      DESKTOP_TRACK_DESCRIPTORS.map((descriptor) => descriptor.id),
    )
    expect(merged.shadowed.map((entry) => entry.descriptor.id).sort()).toEqual(['autoclaw', 'workbuddy'])
    for (const entry of merged.shadowed) expect(entry.shadowedByBuiltin).toBe(true)

    // The host-verified built-in facts are intact — this is the property that
    // matters, because the built-in autoclaw descriptor carries the
    // `--profile autoclaw` argv a scan could never re-derive.
    const autoclaw = merged.descriptors.find((descriptor) => descriptor.id === 'autoclaw')
    // `--profile autoclaw` — and NOT `agent`: the openclaw driver emits the
    // `agent` subcommand itself, so a prefix carrying it would duplicate it in
    // the final argv. See tests/integration/argv-shape.test.ts.
    expect(autoclaw?.command.argsPrefix).toEqual(['--profile', 'autoclaw'])
    expect(autoclaw?.command.executable).toBe(
      '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs',
    )
  })

  it('supplements the table with ids it does not have, keeping built-ins first', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    const scan = scanDesktopBundles({ roots: [root] })
    const merged = mergeScannedIdentities(DESKTOP_TRACK_DESCRIPTORS, scan.identities)
    expect(merged.shadowed).toEqual([])
    expect(merged.descriptors.length).toBe(DESKTOP_TRACK_DESCRIPTORS.length + 1)
    expect(merged.descriptors.map((descriptor) => descriptor.id).slice(0, DESKTOP_TRACK_DESCRIPTORS.length)).toEqual(
      DESKTOP_TRACK_DESCRIPTORS.map((descriptor) => descriptor.id),
    )
    expect(merged.descriptors.at(-1)?.id).toBe('house-agent')
  })

  it('summarises what was shadowed, and stays quiet when nothing was', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'WorkBuddy.app', product: productJson() })
    const scan = scanDesktopBundles({ roots: [root] })
    const merged = mergeScannedIdentities(DESKTOP_TRACK_DESCRIPTORS, scan.identities)
    const summary = shadowedSummary(merged.shadowed)
    expect(summary).toContain('[scan]')
    expect(summary).toContain('workbuddy')
    expect(summary).toContain('keeping the built-in descriptor')
    expect(shadowedSummary([])).toBeUndefined()
  })

  it('produces a descriptor a scanned bundle can actually be launched from', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    const scan = scanDesktopBundles({ roots: [root] })
    const descriptor = scan.identities[0]!.descriptor
    // The desktop policy refuses a missing executable by naming the app, so a
    // scanned descriptor that was really launchable must pass through it.
    const outcome = createDesktopPolicy().launch({
      descriptor,
      executablePath: descriptor.command.executable,
      env: { PATH: '' },
      rawExecutable: descriptor.command.executable,
    })
    expect('command' in outcome).toBe(true)
    if (!('command' in outcome)) return
    expect(outcome.command.executable).toBe(descriptor.command.executable)
  })
})

/* ------------------------------------------------------------ registry */

/**
 * The scan wired into `createRegistry`.
 *
 * Every case below injects `roots` so the registry scans a tmp tree rather than
 * this machine's `/Applications`, and inherits the existing probe cache rather
 * than introducing a second one.
 */
describe('registry integration', () => {
  function registryFor(root: string, extra: Record<string, unknown> = {}) {
    return createRegistry({
      env: { PATH: '' },
      probeVersion: async () => undefined,
      scan: { roots: [root] },
      // No port expectations: the tests must not depend on what is listening on
      // the machine running them.
      portProbe: false,
      trackPolicyOptions: { searchPath: [] },
      hostOptions: { home: '/home/test', contents: {} },
      ...extra,
    })
  }

  it('supplements the built-in table with a discovered bundle', async () => {
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    const registry = registryFor(root)
    const results = await registry.probe()
    expect(results.map((result) => result.id)).toContain('house-agent')
    // The built-ins are all still there, and still first.
    for (const descriptor of DESKTOP_TRACK_DESCRIPTORS) {
      expect(results.map((result) => result.id)).toContain(descriptor.id)
    }
  })

  it('keeps the built-in descriptor when a scan sees the same id', async () => {
    const root = freshRoot()
    // A bundle claiming `workbuddy`, but at a path the built-in table does not
    // name — the built-in still wins, so the descriptor is unchanged.
    writeBundle(root, { name: 'WorkBuddy.app', product: productJson() })
    const registry = registryFor(root)
    const result = (await registry.probe()).find((entry) => entry.id === 'workbuddy')
    expect(result).toBeDefined()
    expect(registry.get('workbuddy')?.command.executable).toBe(
      DESKTOP_TRACK_DESCRIPTORS.find((descriptor) => descriptor.id === 'workbuddy')?.command.executable,
    )
    // And the shadowing is diagnosable rather than silent.
    expect(registry.scanDiagnostics()).toContain('workbuddy')
    expect(registry.scanDiagnostics()).toContain('keeping the built-in descriptor')
  })

  it('reuses the existing probe TTL cache instead of re-scanning', async () => {
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    let clock = 0
    let scans = 0
    const registry = registryFor(root, {
      now: () => clock,
      // A readDir that counts how many times the registry walked the tree.
      scan: {
        roots: [root],
        readDir: (absolutePath: string) => {
          scans += 1
          return defaultReadDirForTest(absolutePath)
        },
      },
    })
    await registry.probe()
    const afterFirst = scans
    expect(afterFirst).toBeGreaterThan(0)

    // Inside the TTL: served from the probe cache, so no further walking.
    await registry.probe()
    expect(scans).toBe(afterFirst)

    // Past the TTL the identities are re-probed, but the SCAN is memoised: it is
    // about which bundles are installed, which does not change on a TTL.
    clock = 61_000
    await registry.probe()
    expect(scans).toBe(afterFirst)
  })

  it('does NOT re-walk the bundle scan when the caller asks for a refresh', async () => {
    // IM-8: `probe({refresh:true})` used to clear the scan memo, so every
    // refresh re-ran a synchronous filesystem walk (up to the scan budget) on
    // the event loop — a model could trigger it repeatedly. Which bundles are
    // INSTALLED does not change on a 60-second TTL, so the walk is memoised for
    // the registry's lifetime and refresh only re-runs the cheap `--version`
    // probes.
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    let scans = 0
    const registry = registryFor(root, {
      scan: {
        roots: [root],
        readDir: (absolutePath: string) => {
          scans += 1
          return defaultReadDirForTest(absolutePath)
        },
      },
    })
    await registry.probe()
    const afterFirst = scans
    expect(afterFirst).toBeGreaterThan(0)
    await registry.probe({ refresh: true })
    expect(scans).toBe(afterFirst)
  })

  it('resolves a discovered identity against its real bundle path', async () => {
    const root = freshRoot()
    const bundlePath = writeBundle(root, {
      name: 'HouseAgent.app',
      product: productJson({ applicationName: 'house-agent' }),
    })
    const registry = registryFor(root)
    // The scan has to run before `resolve` knows the id.
    await registry.probe()
    const resolved = registry.resolve('house-agent')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.executablePath).toBe(
      path.join(bundlePath, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    )
    expect(resolved.descriptor.track).toBe('desktop')
  })

  it('leaves every built-in identity available exactly as it was before the scan', async () => {
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    const withScan = await registryFor(root).probe()
    const withoutScan = await registryFor(root, { scan: false }).probe()
    // Built-in availability is identical whether or not a scan ran: a scan may
    // ADD an identity, and may never change one that is already there.
    for (const descriptor of DESKTOP_TRACK_DESCRIPTORS) {
      const before = withoutScan.find((entry) => entry.id === descriptor.id)
      const after = withScan.find((entry) => entry.id === descriptor.id)
      expect(after?.available).toBe(before?.available)
      expect(after?.reason).toBe(before?.reason)
    }
  })

  it('degrades to "bundle unrecognised" for a malformed bundle instead of failing the probe', async () => {
    const root = freshRoot()
    fs.mkdirSync(path.join(root, 'Empty.app'), { recursive: true })
    writeBundle(root, { name: 'Broken.app', product: 'not json' })
    const registry = registryFor(root)
    // The probe still completes for every built-in identity.
    const results = await registry.probe()
    expect(results.length).toBeGreaterThanOrEqual(DESKTOP_TRACK_DESCRIPTORS.length)
    expect(results.map((entry) => entry.id)).not.toContain('broken')
    expect(registry.scanDiagnostics()).toBeUndefined()
  })

  it('never lets a port fingerprint change `available`', async () => {
    const root = freshRoot()
    // A bundle the bridge can find but NOT launch with: `mimo` is the built-in
    // `unsupported` identity, so its `available` is false on every host — which
    // makes this assertion host-independent.
    const confirmed = await registryFor(root, {
      portExpectations: [
        {
          agentId: 'mimo',
          port: 19_999,
          label: 'mimo engine',
          signature: /mimo/,
        },
      ],
      portProbe: true,
      portConnector: async () => 'HTTP/1.1 200 OK\r\n\r\n{"service":"mimo"}',
    }).probe()
    const mimo = confirmed.find((entry) => entry.id === 'mimo')
    // The fingerprint was CONFIRMED, and availability is still false because
    // nothing can be launched. This is the invariant the workstream requires.
    expect(mimo?.available).toBe(false)
    expect(mimo?.notes).toContain('confirmed')
    expect(mimo?.notes).toContain('availability is decided by whether the engine can be launched')

    // An ABSENT fingerprint adds no note at all: a desktop app that is simply
    // not running is the normal state and must not create probe noise. `mimo`
    // has no descriptor notes, so the field stays absent rather than becoming an
    // empty or "[port] …" string.
    const absent = await registryFor(root, {
      portExpectations: [{ agentId: 'mimo', port: 19_998, label: 'mimo engine' }],
      portProbe: true,
      portConnector: async () => undefined,
    }).probe()
    const mimoAbsent = absent.find((entry) => entry.id === 'mimo')
    expect(mimoAbsent?.notes).toBeUndefined()
    expect(mimoAbsent?.available).toBe(false)

    // An UNEXPECTED answer is reported as suspected, and is equally powerless.
    const unexpected = await registryFor(root, {
      portExpectations: [{ agentId: 'mimo', port: 19_996, label: 'mimo engine', signature: /mimo/ }],
      portProbe: true,
      portConnector: async () => 'HTTP/1.1 200 OK\r\n\r\n{"service":"something-else"}',
    }).probe()
    const suspected = unexpected.find((entry) => entry.id === 'mimo')
    expect(suspected?.available).toBe(false)
    expect(suspected?.notes).toContain('suspected')
  })

  it('does not let a throwing port connector fail the probe', async () => {
    const root = freshRoot()
    const results = await registryFor(root, {
      portExpectations: [{ agentId: 'autoclaw', port: 19_997, label: 'openclaw gateway' }],
      portProbe: true,
      portConnector: async () => {
        throw new Error('socket exploded')
      },
    }).probe()
    expect(results.length).toBeGreaterThan(0)
  })

  it('does not scan at all when the caller disables it', async () => {
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    const results = await registryFor(root, { scan: false }).probe()
    expect(results.map((entry) => entry.id)).not.toContain('house-agent')
    expect(results.length).toBe(BUILTIN_IDS.length)
  })

  it('proves the scan root is the injected one: the real host is never read', async () => {
    // The hermeticity PROOF, not just an intention. `readDir` is the single
    // syscall seam the scanner walks through, so recording every path it is
    // asked about and asserting they all live under the tmp root demonstrates
    // that this registry never touched `/Applications` or `~/Applications`.
    // If a future change reintroduces a real-root default, this fails loudly on
    // any machine, instead of silently making the suite host-dependent.
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    const asked: string[] = []
    const registry = registryFor(root, {
      scan: {
        roots: [root],
        readDir: (absolutePath: string) => {
          asked.push(absolutePath)
          return defaultReadDirForTest(absolutePath)
        },
      },
    })
    const results = await registry.probe()
    expect(results.map((entry) => entry.id)).toContain('house-agent')
    // Something was walked, or the assertion below would be vacuous.
    expect(asked.length).toBeGreaterThan(0)
    for (const absolutePath of asked) {
      expect(absolutePath.startsWith(root)).toBe(true)
    }
    // And no path anywhere near the usual host locations.
    expect(asked.some((entry) => entry === '/Applications' || entry === '/Applications/')).toBe(false)
    expect(asked.some((entry) => entry.endsWith('/Applications'))).toBe(false)
  })

  it('walks nothing on the host when scan is disabled (syscall audit)', async () => {
    // The assertion that would have caught the original bug.
    //
    // The instrumented-`readDir` proof above only covers the path where the
    // scanner is actually invoked. The leak that shipped originally was the
    // case where it was invoked with NO injected roots, so it silently walked
    // the developer's real `/Applications` — the injected seam saw nothing
    // because the real `fs.readdirSync` was used instead.
    //
    // So this test patches `fs.readdirSync` itself and counts the host paths
    // the scan actually touches. It is deterministic on every machine: the
    // first registry disables the scan and must read NOTHING, and the second
    // uses an explicitly injected tmp root so the only real directories it may
    // touch are ones under that root.
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })

    const hostReads: string[] = []
    const realReaddir = fs.readdirSync
    const spy = (target: fs.PathLike, ...rest: unknown[]): string[] => {
      const asString = String(target)
      if (asString === '/Applications' || asString === '/Applications/' || /\/(Applications|\.workbuddy[^/]*)$/.test(asString)) {
        hostReads.push(asString)
      }
      return (realReaddir as (...args: unknown[]) => string[])(target, ...rest)
    }
    ;(fs as unknown as { readdirSync: typeof spy }).readdirSync = spy
    try {
      // 1. scan disabled ⇒ the host must not be touched at all.
      await registryFor(root, { scan: false }).probe()
      expect(hostReads).toEqual([])

      // 2. scan enabled with an INJECTED root ⇒ still no host read.
      await registryFor(root).probe()
      expect(hostReads).toEqual([])
    } finally {
      ;(fs as unknown as { readdirSync: typeof realReaddir }).readdirSync = realReaddir
    }
  })

  it('does read the host when no roots are injected — the leak this guards', async () => {
    // The NEGATIVE control, so the audit above cannot pass vacuously: a registry
    // that takes the production default MUST walk `/Applications`. If this ever
    // stops reading the host, the audit above has become meaningless and this
    // fails to say so.
    const hostReads: string[] = []
    const realReaddir = fs.readdirSync
    const spy = (target: fs.PathLike, ...rest: unknown[]): string[] => {
      const asString = String(target)
      if (asString === '/Applications' || asString === '/Applications/') hostReads.push(asString)
      return (realReaddir as (...args: unknown[]) => string[])(target, ...rest)
    }
    ;(fs as unknown as { readdirSync: typeof spy }).readdirSync = spy
    try {
      await createRegistry({
        env: { PATH: '' },
        probeVersion: async () => undefined,
        portProbe: false,
        trackPolicyOptions: { searchPath: [] },
        hostOptions: { home: '/home/test', contents: {} },
      }).probe()
    } finally {
      ;(fs as unknown as { readdirSync: typeof realReaddir }).readdirSync = realReaddir
    }
    expect(hostReads.length).toBeGreaterThan(0)
  })
})

/* ----------------------------------------------------------- host-guard */

/**
 * Host-dependent proof that the scanner agrees with the REAL bundles. Nothing
 * above needs this: it is here so that a mismatch between the scanner's model of
 * a bundle and the bundle itself is caught on the machine that has it, instead
 * of only in a fixture that cannot drift.
 */
const WORKBUDDY_BUNDLE = '/Applications/WorkBuddy.app'
const WORKBUDDY_AI_BUNDLE = '/Applications/WorkBuddy AI.app'
const haveBoth = fs.existsSync(WORKBUDDY_BUNDLE) && fs.existsSync(WORKBUDDY_AI_BUNDLE)

describe.skipIf(!haveBoth)('real bundles (host-dependent)', () => {
  it('derives the two WorkBuddy identities from the two product.json files', () => {
    const scan = scanDesktopBundles({
      roots: [WORKBUDDY_BUNDLE, WORKBUDDY_AI_BUNDLE],
      budgetMs: 10_000,
    })
    const byId = new Map(scan.identities.map((entry) => [entry.descriptor.id, entry]))
    expect([...byId.keys()].sort()).toEqual(['workbuddy', 'workbuddy-ai'])
    // The ids and paths the scanner reads out of the bundles are exactly the
    // ones the built-in catalog hardcodes — so the built-ins shadow cleanly.
    for (const descriptor of DESKTOP_TRACK_DESCRIPTORS) {
      if (descriptor.id !== 'workbuddy' && descriptor.id !== 'workbuddy-ai') continue
      expect(byId.get(descriptor.id)?.descriptor.command.executable).toBe(descriptor.command.executable)
    }
    // And the two bundles really do carry different product facts.
    expect(byId.get('workbuddy')?.descriptor.notes).toContain('dataFolderName=.workbuddy')
    expect(byId.get('workbuddy-ai')?.descriptor.notes).toContain('dataFolderName=.workbuddy-ai')
    expect(byId.get('workbuddy-ai')?.descriptor.notes).toContain('isOversea=true')
  })

  it('scans the whole /Applications tree well inside the default budget', () => {
    const scan = scanDesktopBundles({ roots: ['/Applications'] })
    // The bounds exist so one hostile bundle cannot stall a probe; the normal
    // case must be far below them.
    expect(scan.budgetExhausted).toBe(false)
    expect(scan.elapsedMs).toBeLessThan(2_000)
    expect(scan.identities.length).toBeGreaterThan(0)
  })
})
