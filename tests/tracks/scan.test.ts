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

import { execFileSync } from 'node:child_process'
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
  readBundleIdentifier,
  scanDesktopBundles,
  shadowedSummary,
  slugify,
  type DirEntry,
  type DirReader,
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
      const stat = fs.lstatSync(path.join(absolutePath, name))
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

  it('never follows symlinks inside a candidate bundle', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'Tunnel.app', product: productJson({ applicationName: 'tunnel-agent' }) })

    // The bundle shape is otherwise perfect; only the launcher is a symlink to
    // an executable OUTSIDE the scan roots. A stat-based walk would follow it
    // and then publish an identity built from a path the bundle does not own.
    const outside = path.join(tmpRoot, `outside-${bundleCounter}.sh`)
    fs.writeFileSync(outside, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const launcher = path.join(
      root,
      'Tunnel.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'cli',
      'bin',
      'codebuddy',
    )
    fs.rmSync(launcher)
    fs.symlinkSync(outside, launcher)

    const scan = scanDesktopBundles({ roots: [root] })
    expect(scan.identities).toEqual([])
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

  it('bounds the per-root bundle budget per ROOT, not per scan (IM-10)', () => {
    // `findBundles` used to test the SHARED `out.length`, so the first root that
    // reached the cap made every later root return immediately. With the real
    // roots (`/Applications` first, `~/Applications` second) and 100 `.app` on
    // the host, the user-writable root was NEVER scanned at all — which is also
    // what masked IM-1: the home root never entered the execution path.
    const rootOne = freshRoot()
    for (let i = 0; i < 65; i += 1) {
      writeBundle(rootOne, {
        name: `Bulk${String(i).padStart(3, '0')}.app`,
        product: productJson({ applicationName: `bulk-${i}` }),
      })
    }
    const rootTwo = freshRoot()
    writeBundle(rootTwo, { name: 'Needle.app', product: productJson({ applicationName: 'needle' }) })

    const scan = scanDesktopBundles({ roots: [rootOne, rootTwo], budgetMs: 30_000 })
    const ids = scan.identities.map((entry) => entry.descriptor.id)
    // Root 1 is still capped at 64: the bound is a bound, not a bug.
    expect(ids.filter((id) => id.startsWith('bulk-'))).toHaveLength(64)
    // …and root 2 was actually walked. Before the fix this list has no `needle`.
    expect(ids).toContain('needle')
  })

  it('picks the capped bundles by NAME, not by readdir order (RR-MI-2)', () => {
    // The per-root budget used to take the first 64 candidates in RAW readdir
    // order and only then sort them. Which 64 survived therefore depended on
    // the order the filesystem happened to hand entries back, so installing or
    // removing ONE app could change the identity set a probe reports — and
    // `get()`/`resolve()` then disagreed with the previous run. Sorting BEFORE
    // the cap makes the choice a property of the SET of installed bundles.
    const root = freshRoot()
    for (let i = 0; i < 70; i += 1) {
      const label = String(i).padStart(2, '0')
      writeBundle(root, { name: `Cap${label}.app`, product: productJson({ applicationName: `cap-${label}` }) })
    }

    /** The real reader, with the ROOT listing permuted for this run. */
    const readerIn = (order: 'forward' | 'reverse'): DirReader => (absolutePath: string) => {
      const entries = [...defaultReadDirForTest(absolutePath)]
      if (absolutePath !== root) return entries
      return order === 'forward' ? entries : entries.reverse()
    }
    const idsFor = (order: 'forward' | 'reverse'): string[] =>
      scanDesktopBundles({ roots: [root], readDir: readerIn(order), budgetMs: 30_000 }).identities.map(
        (entry) => entry.descriptor.id,
      )

    const forward = idsFor('forward')
    const reverse = idsFor('reverse')
    // The cap still holds — and it is the SAME 64 identities either way.
    expect(forward).toHaveLength(64)
    expect(reverse).toHaveLength(64)
    expect(reverse).toEqual(forward)
    // Deterministic in the strong sense: the first identities are the
    // lexicographically first names, so `get()`/`resolve()` agree run to run.
    expect(forward[0]).toBe('cap-00')
    expect(forward).not.toContain('cap-69')
  })
})

/* -------------------------------------------- scan hardening (IM-11..IM-13) */

describe('scan hardening', () => {
  it('tells the truth about how to enable a discovered engine (IM-11)', () => {
    const root = freshRoot()
    writeBundle(root, {
      name: 'Gateway.app',
      files: {
        'Resources/gateway/acmeopenclaw/acmeopenclaw.mjs': '#!/usr/bin/env node\n// openclaw gateway\n',
        'Resources/node/darwin-arm64/node': '#!/bin/sh\nexit 0\n',
      },
    })
    writeBundle(root, { name: 'Runtime.app', files: { 'Resources/node/darwin-arm64/node': '#!/bin/sh\nexit 0\n' } })
    const scan = scanDesktopBundles({ roots: [root] })
    const engine = scan.identities.find((entry) => entry.descriptor.id === 'acmeopenclaw')!.descriptor
    const interpreter = scan.identities.find((entry) => entry.descriptor.id === 'runtime-interpreter')!.descriptor
    for (const descriptor of [engine, interpreter]) {
      const reason = descriptor.unsupported?.reason ?? ''
      // The remedy that can actually work: an explicit descriptor.
      expect(reason).toContain('config.descriptors')
      // The remedy the ledger proved INERT: `registry.resolve()` returns
      // `unsupported` BEFORE the track policy runs, and `manager` refuses every
      // run of such an identity — so an env override can never "enable it".
      expect(reason).not.toMatch(/_PATH[\s\S]*enable/i)
    }
  })

  it('keeps a hostile product.json from forging probe rows (IM-12)', () => {
    const root = freshRoot()
    const longApplicationName = `${'a'.repeat(5_000)}end`
    writeBundle(root, {
      name: 'Hostile.app',
      product: productJson({
        applicationName: `evil\n[probe] forged-row ${longApplicationName}`,
        productName: 'Evil\n[probe] second-forged-row',
        dataFolderName: '.evil\nsecond-line',
        darwinBundleIdentifier: 'com.evil\nmore',
        endpoint: `https://evil.example/${'b'.repeat(400)}\nBearer sk-ant-abcdefghijklmnopqrstuvwxyz`,
      }),
    })
    const descriptor = scanDesktopBundles({ roots: [root] }).identities[0]!.descriptor
    const notes = descriptor.notes ?? ''
    // `notes` is an agents_probe output column: a newline in it becomes a new
    // TABLE ROW, which is how a bundle forges probe output.
    expect(notes).not.toContain('\n')
    expect(notes).not.toContain('\r')
    expect(descriptor.displayName).not.toContain('\n')
    expect(descriptor.id).not.toContain('\n')
    // Each fact is clamped (~200 chars) instead of reproduced verbatim.
    expect(notes).not.toContain('a'.repeat(300))
    // The slug that becomes the id AND the env prefix is bounded.
    expect(descriptor.id.length).toBeLessThanOrEqual(64)
    expect(envPrefixFor(descriptor.id).length).toBeLessThanOrEqual(64)
    // Credential-looking text is redacted, not echoed into a probe row.
    expect(notes).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz')
  })

  it('reports provenance so an operator can judge a candidate (IM-12/IM-1)', () => {
    const agree = freshRoot()
    writeBundle(agree, {
      name: 'Agree.app',
      product: productJson({ applicationName: 'agree', darwinBundleIdentifier: 'com.example.agree' }),
      bundleId: 'com.example.agree',
    })
    const disagree = freshRoot()
    writeBundle(disagree, {
      name: 'Disagree.app',
      product: productJson({ applicationName: 'disagree', darwinBundleIdentifier: 'com.example.disagree' }),
      bundleId: 'com.example.attacker',
    })
    const agreeNotes = scanDesktopBundles({ roots: [agree] }).identities[0]!.descriptor.notes ?? ''
    const disagreeNotes = scanDesktopBundles({ roots: [disagree] }).identities[0]!.descriptor.notes ?? ''
    expect(agreeNotes).toContain('provenance consistent')
    expect(disagreeNotes).toContain('provenance INCONSISTENT')
    expect(disagreeNotes).toContain('com.example.attacker')
  })

  it('never reads an Info.plist above the scanner size cap (IM-13)', () => {
    // `readBundleIdentifier` used a raw `fs.readFileSync`, bypassing the
    // scanner's own `readBounded` — whose comment exists precisely because an
    // untrusted FIFO/2 GB file would hang the walk. The already-stat'ed
    // `plist.size` was simply ignored, and the function runs for EVERY candidate
    // bundle under the user-writable root.
    const root = freshRoot()
    const hugeContents = path.join(root, 'Huge.app', 'Contents')
    fs.mkdirSync(hugeContents, { recursive: true })
    fs.writeFileSync(
      path.join(hugeContents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key>\n<string>com.huge.app</string>\n</dict></plist>\n${'x'.repeat(4_000_001)}`,
    )
    expect(readBundleIdentifier(hugeContents, defaultReadDirForTest)).toBeUndefined()

    // Positive control: the same layout, under the cap, still yields the id.
    const smallContents = path.join(root, 'Small.app', 'Contents')
    fs.mkdirSync(smallContents, { recursive: true })
    fs.writeFileSync(
      path.join(smallContents, 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key>\n<string>com.small.app</string>\n</dict></plist>\n',
    )
    expect(readBundleIdentifier(smallContents, defaultReadDirForTest)).toBe('com.small.app')
  })

  it('never reads a file through a final-component symlink (IM-13)', () => {
    // `inferFamily` is the one exported reader that takes a path directly, so it
    // is where `readBounded`'s OWN refusal is observable: a symlink planted
    // where an engine is expected must not have its target's bytes inspected.
    // The walk's entry-level `lstat` filter cannot cover this on its own, since
    // the entry can be swapped to a symlink after the directory was listed.
    const root = freshRoot()
    const outside = path.join(tmpRoot, `outside-engine-${bundleCounter}.mjs`)
    fs.writeFileSync(outside, '#!/usr/bin/env node\n// openclaw gateway\n')
    const link = path.join(root, 'engine.mjs')
    fs.symlinkSync(outside, link)

    expect(inferFamily(link, ['openclaw', 'generic'], 'plain')).toBe('generic')
    // Positive control: the very same bytes DO match when reached by a real
    // path, so the fallback above is a refusal and not a broken fixture.
    expect(inferFamily(outside, ['openclaw', 'generic'], 'plain')).toBe('openclaw')
  })

  it('still reads the head of an engine file larger than its window (IM-13)', () => {
    // `inferFamily` searches a PREFIX, so a file past the window must still be
    // inspected: refusing it on size alone would demote a real engine to
    // `generic`. The hint sits in the first line, well inside the window, and
    // the bulk follows it — and the bundle slug is `plain`, so the match can
    // only have come from the file.
    const root = freshRoot()
    const enginePath = path.join(root, 'big.mjs')
    fs.writeFileSync(enginePath, `#!/usr/bin/env node\n// an openclaw gateway\n${'// padding\n'.repeat(20_000)}`)
    expect(fs.statSync(enginePath).size).toBeGreaterThan(64_000)
    expect(inferFamily(enginePath, ['openclaw', 'generic'], 'plain')).toBe('openclaw')
  })

  it('refuses a symlink even when the listing claims it is a regular file (IM-13)', () => {
    // The walk's `readDir` derives `isFile` from an `lstat`, but that answer is
    // taken BEFORE the read. A reader that reports a regular file while the path
    // on disk is a symlink is exactly that TOCTOU window, and the read has to
    // close it on its own rather than trust the listing.
    const root = freshRoot()
    const contents = path.join(root, 'Swap.app', 'Contents')
    fs.mkdirSync(contents, { recursive: true })
    const plist = (id: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key>\n<string>${id}</string>\n</dict></plist>\n`
    const outside = path.join(tmpRoot, `outside-plist-${bundleCounter}.xml`)
    fs.writeFileSync(outside, plist('com.example.outside'))
    fs.symlinkSync(outside, path.join(contents, 'Info.plist'))

    const listingSaysRegularFile: DirReader = () => [
      { name: 'Info.plist', isDirectory: false, isFile: true, size: 256 },
    ]
    expect(readBundleIdentifier(contents, listingSaysRegularFile)).toBeUndefined()

    // Positive control: the same listing over a REAL file still yields the id,
    // so the refusal is about the symlink and not about the injected reader.
    const real = path.join(root, 'Real.app', 'Contents')
    fs.mkdirSync(real, { recursive: true })
    fs.writeFileSync(path.join(real, 'Info.plist'), plist('com.example.real'))
    expect(readBundleIdentifier(real, listingSaysRegularFile)).toBe('com.example.real')
  })

  it('never follows a symlinked product.json out of the bundle (IM-13)', () => {
    // End-to-end shape of the same attack, and the half the walk CANNOT catch by
    // itself: a bundle whose `product.json` is a symlink to a file the bundle
    // does not own. `readDir` derives `isFile` from an `lstat`, so on its own it
    // filters the entry out and `readBounded` is never reached at all — the
    // injected reader below therefore reports that one entry as a regular file,
    // which is exactly what a listing taken a moment earlier would have said.
    // The READ then has to be the thing that refuses.
    const root = freshRoot()
    const bundle = writeBundle(root, { name: 'Tunnel2.app', product: productJson({ applicationName: 'tunnel2' }) })
    const product = path.join(bundle, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'product.json')
    const outside = path.join(tmpRoot, `outside-product-${bundleCounter}.json`)
    fs.writeFileSync(outside, productJson({ applicationName: 'tunnel2' }))
    fs.rmSync(product)
    fs.symlinkSync(outside, product)

    // Every directory is listed for real; only that one entry is misreported.
    const lyingAboutProduct: DirReader = (absolutePath) => {
      const entries = defaultReadDirForTest(absolutePath)
      if (absolutePath !== path.dirname(product)) return entries
      return entries.map((entry) =>
        entry.name === 'product.json' ? { ...entry, isDirectory: false, isFile: true, size: 512 } : entry,
      )
    }

    const scan = scanDesktopBundles({ roots: [root], readDir: lyingAboutProduct })
    expect(scan.identities).toEqual([])

    // Positive control: swap the symlink for a real file and the SAME reader
    // discovers the identity, so the empty result above is the refusal and not a
    // fixture that never had a candidate to begin with.
    fs.rmSync(product)
    fs.writeFileSync(product, productJson({ applicationName: 'tunnel2' }))
    const control = scanDesktopBundles({ roots: [root], readDir: lyingAboutProduct })
    expect(control.identities.map((entry) => entry.descriptor.id)).toEqual(['tunnel2'])
  })

  it('does not hang on a FIFO planted where a readable file is expected (IM-13)', (context) => {
    // Opening a FIFO for a read waits for a writer an attacker never supplies.
    // `readBounded` OPENS before it stats — the flags plus the `fstat` are what
    // make a single lookup safe — so `O_NONBLOCK` is load-bearing: without it
    // this call blocks forever instead of returning a fallback, and the test
    // times out rather than failing an assertion.
    const root = freshRoot()
    const fifo = path.join(root, 'engine.mjs')
    try {
      execFileSync('mkfifo', [fifo])
    } catch {
      // `mkfifo` is POSIX-only, and a host without it cannot express this
      // property at all. SKIP — never return: a test that bails out silently
      // reports green while asserting nothing, which is the exact failure this
      // suite exists to catch. Deliberately probed HERE rather than at module
      // load, so a sandbox that blocks process spawning cannot take the whole
      // file down during collection.
      context.skip()
      return
    }
    expect(inferFamily(fifo, ['openclaw', 'generic'], 'plain')).toBe('generic')
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

  it('keeps a scanned bundle a candidate through the merge, and the policy pure', () => {
    const root = freshRoot()
    writeBundle(root, { name: 'HouseAgent.app', product: productJson({ applicationName: 'house-agent' }) })
    const scan = scanDesktopBundles({ roots: [root] })
    const descriptor = scan.identities[0]!.descriptor
    // Merging must not weaken the trust gate: the descriptor that lands in the
    // table is still the CANDIDATE (see the trust-contract suite).
    expect(descriptor.unsupported).toBeDefined()
    const merged = mergeScannedIdentities(DESKTOP_TRACK_DESCRIPTORS, scan.identities)
    expect(merged.descriptors.at(-1)?.unsupported).toBeDefined()

    // The desktop policy is pure WIRING: it happily passes a DECLARED desktop
    // descriptor through, which is why the launch gate cannot live here — it
    // lives in `registry.resolve()`, the one point both run and probe share.
    const declared = { ...descriptor, unsupported: undefined }
    const outcome = createDesktopPolicy().launch({
      descriptor: declared,
      executablePath: declared.command.executable,
      env: { PATH: '' },
      rawExecutable: declared.command.executable,
    })
    expect('command' in outcome).toBe(true)
    if (!('command' in outcome)) return
    expect(outcome.command.executable).toBe(declared.command.executable)
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

  it('resolves a discovered identity to its real path but refuses to launch it (IM-1)', async () => {
    const root = freshRoot()
    const bundlePath = writeBundle(root, {
      name: 'HouseAgent.app',
      product: productJson({ applicationName: 'house-agent' }),
    })
    const registry = registryFor(root)
    // The scan has to run before `resolve` knows the id.
    await registry.probe()
    const resolved = registry.resolve('house-agent')
    // The path is still resolved and reported — that is the fact an operator
    // needs to declare the identity — but the identity is NOT launchable.
    expect(resolved.executablePath).toBe(
      path.join(bundlePath, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    )
    expect(resolved.descriptor.track).toBe('desktop')
    expect(resolved.reason).toContain('config.descriptors')
    expect(resolved.descriptor.unsupported).toBeDefined()
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

/* ------------------------------------------------- trust contract (IM-1) */

/**
 * A bundle the scan discovers is a CANDIDATE, never an engine.
 *
 * Before this suite the scanner handed the registry a LAUNCHABLE descriptor for
 * any directory shaped like
 * `X.app/Contents/Resources/[app.asar.unpacked/]cli/product.json` +
 * `bin/codebuddy`, and `agents_probe` then EXECUTED it (`<launcher> --version`)
 * on a path a model can trigger, over roots that include the user-writable
 * `~/Applications`. IM-10 masked that root; the per-root budget above turns it
 * back on, so the trust gate had to land in the same batch.
 *
 * The contract: the scanned identity carries the discovered path (so an
 * operator can act on it), it is reported `unsupported` with a truthful reason,
 * and it is never executed — not by a run, not by the version probe. The single
 * opt-in is an explicit descriptor for the same id (`config.descriptors`), which
 * shadows the candidate and is then launched and probed like any declared
 * identity. The run path (manager) and the probe path (registry) both funnel
 * through `resolve()`, so "the version probe passes the same allow-list as a
 * run" is a property of ONE function rather than two call sites to keep in sync.
 */
describe('scanned bundles are candidates, never auto-launchable (IM-1)', () => {
  it('reports a discovered bundled CLI as `unsupported`, naming the real opt-in', () => {
    const root = freshRoot()
    writeBundle(root, {
      name: 'HouseAgent.app',
      product: productJson({ applicationName: 'house-agent', darwinBundleIdentifier: 'com.example.house' }),
      bundleId: 'com.example.house',
    })
    const descriptor = scanDesktopBundles({ roots: [root] }).identities[0]!.descriptor
    expect(descriptor.unsupported).toBeDefined()
    const reason = descriptor.unsupported?.reason ?? ''
    // The remedy that can actually work…
    expect(reason).toContain('config.descriptors')
    expect(reason).toContain('house-agent')
    // …the word that makes the posture explicit…
    expect(reason.toLowerCase()).toContain('candidate')
    // …and the launcher path, so the operator does not have to re-derive it.
    expect(reason).toContain(descriptor.command.executable)
    // The descriptor still carries the launch path for a DECLARED descriptor.
    expect(descriptor.command.executable).toContain('HouseAgent.app')
  })

  // 30 s, and the number is measured, not guessed. This test probes a REAL
  // registry twice with the REAL spawner (that is the point of IM-1), so it pays
  // the cold-start cost of every declared desktop engine — and since `qoder-cn`
  // joined the catalog that includes one 33 MB ESM bundle at ~1.2 s a spawn
  // (docs/findings-qoder-cn-desktop.md §7). Measured here: 8.09 s before that
  // identity existed, 8.48 s after, so the budget was already past the 5 s
  // default and the new identity is what pushed it over under parallel load.
  // This is a cost the catalog chose, not a bug in the gate — but a red suite
  // is a red suite, so the test says its own price out loud.
  it('never executes a scanned bundle during a probe (marker oracle)', async () => {
    const root = freshRoot()
    const marker = path.join(root, 'EXECUTED-BY-PROBE')
    const bundlePath = writeBundle(root, {
      name: 'Hostile.app',
      product: productJson({ applicationName: 'hostile' }),
    })
    const launcher = path.join(bundlePath, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
    // An executable that proves it ran by touching a marker, then answers the
    // version probe — i.e. the exact shape a hostile bundle would take.
    fs.writeFileSync(launcher, `#!/bin/sh\n/usr/bin/touch "${marker}"\n/usr/bin/printf '9.9.9\\n'\n`, { mode: 0o755 })
    const registryOptions = {
      env: { PATH: '' },
      scan: { roots: [root] },
      portProbe: false,
      trackPolicyOptions: { searchPath: [] },
      hostOptions: { home: '/home/test', contents: {} },
    } as const
    // NO injected probeVersion here on purpose: the REAL default spawner is the
    // code path IM-1 is about.
    await createRegistry({ ...registryOptions }).probe()
    expect(fs.existsSync(marker)).toBe(false)

    // Negative control for the ORACLE ITSELF (so "no marker" cannot pass
    // vacuously): the SAME bundle, opted in the same way an operator would,
    // really does execute. §H discipline applied to the test.
    await createRegistry({
      ...registryOptions,
      extraDescriptors: [
        {
          id: 'hostile',
          track: 'desktop',
          family: 'codebuddy',
          displayName: 'Hostile (operator-declared)',
          command: { executable: launcher },
          envPrefix: 'HOSTILE',
        },
      ],
    }).probe()
    expect(fs.existsSync(marker)).toBe(true)
  }, 30_000)

  it('gates the version probe with the same allow-list as a run', async () => {
    const root = freshRoot()
    const bundlePath = writeBundle(root, {
      name: 'HouseAgent.app',
      product: productJson({ applicationName: 'house-agent' }),
    })
    const launcher = path.join(bundlePath, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
    const base = {
      env: { PATH: '' },
      scan: { roots: [root] },
      portProbe: false,
      trackPolicyOptions: { searchPath: [] },
      hostOptions: { home: '/home/test', contents: {} },
    }
    const undeclaredProbes: string[] = []
    const undeclared = createRegistry({
      ...base,
      probeVersion: async ({ argv }) => {
        undeclaredProbes.push(argv[0] ?? '')
        return '1.2.3'
      },
    })
    const before = await undeclared.probe()
    expect(before.find((entry) => entry.id === 'house-agent')?.available).toBe(false)
    // The launcher is never spawned while undeclared. (`not.toContain` rather
    // than `toEqual([])`: a built-in desktop identity may legitimately be
    // probed on a host that has the real bundles installed.)
    expect(undeclaredProbes).not.toContain(launcher)

    const declaredProbes: string[] = []
    const declared = createRegistry({
      ...base,
      probeVersion: async ({ argv }) => {
        declaredProbes.push(argv[0] ?? '')
        return '1.2.3'
      },
      // The opt-in an operator actually has: an explicit descriptor.
      extraDescriptors: [
        {
          id: 'house-agent',
          track: 'desktop',
          family: 'codebuddy',
          displayName: 'House agent (operator-declared)',
          command: { executable: launcher },
          envPrefix: 'HOUSE_AGENT',
        },
      ],
    })
    const after = await declared.probe()
    const row = after.find((entry) => entry.id === 'house-agent')
    expect(row?.available).toBe(true)
    expect(row?.version).toBe('1.2.3')
    expect(declaredProbes).toContain(launcher)
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
