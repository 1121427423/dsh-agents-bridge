/**
 * Desktop-track tests.
 *
 * The desktop track has a different contract from the CLI track and needs its
 * own assertions: absolute bundle paths only, no PATH search, an interpreter
 * that must exist, and one descriptor per BUNDLE rather than per product name.
 *
 * The last point is the one that is easy to get wrong and is verified here:
 * WorkBuddy (domestic) and WorkBuddy AI (international) ship the SAME
 * byte-identical launcher, and which config home it reads follows from which
 * bundle was executed. Two apps therefore need two descriptors with two absolute
 * paths — a locale flag or an env var would be the wrong model.
 */

import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { BUILTIN_DESCRIPTORS, policyFor } from '../../src/tracks/index.ts'
import { createDesktopPolicy } from '../../src/tracks/desktop/index.ts'
import { DESKTOP_TRACK_DESCRIPTORS } from '../../src/tracks/desktop/catalog.ts'

const WORKBUDDY_BUNDLE = '/Applications/WorkBuddy.app'
const WORKBUDDY_AI_BUNDLE = '/Applications/WorkBuddy AI.app'

function descriptor(id: string) {
  const found = DESKTOP_TRACK_DESCRIPTORS.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`desktop descriptor ${id} is missing`)
  return found
}

describe('desktop track catalog', () => {
  it('is a separate half from the CLI track', () => {
    for (const entry of DESKTOP_TRACK_DESCRIPTORS) {
      expect(entry.track).toBe('desktop')
      // Absolute bundle path: never a bare name, so PATH can never be consulted.
      // (`mimo` is exempt: it is `unsupported`, so nothing is ever launched from
      // it — its bare name is documentation of a tool the bridge cannot drive.)
      if (entry.unsupported !== undefined) continue
      expect(entry.command.executable.startsWith('/')).toBe(true)
    }
    expect(DESKTOP_TRACK_DESCRIPTORS.map((d) => d.id)).toContain('workbuddy-ai')
    // The built-in table is a SUPERSET of this catalog: `BUILTIN_DESCRIPTORS`
    // also carries the CLI track, and the desktop half must appear in it
    // unchanged and in the same order. (Not an equality against the catalog
    // length: since P3 the registry may APPEND scan-discovered identities, so a
    // count comparison here would be asserting the wrong thing — see
    // tests/tracks/scan.test.ts for the built-in-wins rule.)
    const desktopIds = BUILTIN_DESCRIPTORS.filter((d) => d.track === 'desktop').map((d) => d.id)
    expect(desktopIds).toEqual(DESKTOP_TRACK_DESCRIPTORS.map((d) => d.id))
    // And every built-in desktop descriptor is one of this catalog's, by
    // identity — nothing was renamed or replaced on the way in.
    for (const entry of DESKTOP_TRACK_DESCRIPTORS) {
      expect(BUILTIN_DESCRIPTORS.find((d) => d.id === entry.id)).toEqual(entry)
    }
  })

  it('models the two WorkBuddy builds as two identities, not one flag', () => {
    const domestic = descriptor('workbuddy')
    const international = descriptor('workbuddy-ai')
    expect(domestic.command.executable).not.toBe(international.command.executable)
    expect(domestic.command.executable).toContain(`${WORKBUDDY_BUNDLE}/`)
    expect(international.command.executable).toContain(`${WORKBUDDY_AI_BUNDLE}/`)
    // Same dialect (claude-family CodeBuddy), different product and home.
    expect(domestic.family).toBe('codebuddy')
    expect(international.family).toBe('codebuddy')
    expect(domestic.envPrefix).toBe('WORKBUDDY')
    expect(international.envPrefix).toBe('WORKBUDDY_AI')
  })

  it('has NO search path: the desktop track never searches', () => {
    expect(createDesktopPolicy().searchPath).toEqual([])
    expect(policyFor('desktop').searchPath).toEqual([])
    expect(policyFor('desktop').track).toBe('desktop')
  })

  it('ships each bundled engine WITH an interpreter (node does not come from PATH)', () => {
    for (const entry of DESKTOP_TRACK_DESCRIPTORS) {
      if (entry.unsupported !== undefined) continue
      // autoclaw is the mode-644 exception the CLI track learned about; both
      // WorkBuddy builds are 0755 node scripts.
      expect(entry.command.interpreter).toBeDefined()
    }
  })
})

describe('desktop track policy', () => {
  it('refuses a missing bundle by naming the app, never by guessing a path', () => {
    const outcome = createDesktopPolicy().launch({
      descriptor: descriptor('workbuddy-ai'),
      env: { PATH: '/usr/bin' },
      rawExecutable: descriptor('workbuddy-ai').command.executable,
    })
    expect('reason' in outcome).toBe(true)
    if (!('reason' in outcome)) return
    expect(outcome.reason).toContain('executable not found or not executable')
    expect(outcome.reason).toContain('WorkBuddy AI')
    expect(outcome.reason).toContain('WORKBUDDY_AI_PATH')
  })

  it('refuses a missing interpreter instead of dropping it', () => {
    const outcome = createDesktopPolicy().launch({
      descriptor: descriptor('workbuddy'),
      executablePath: '/Applications/WorkBuddy.app/x/codebuddy',
      env: { PATH: '' },
      rawExecutable: descriptor('workbuddy').command.executable,
      rawInterpreter: '/opt/homebrew/bin/node',
    })
    expect('reason' in outcome).toBe(true)
    if (!('reason' in outcome)) return
    expect(outcome.reason).toContain('interpreter not found or not executable')
  })

  it('passes through the fixed argv (the per-app profile lives in the descriptor)', () => {
    const outcome = createDesktopPolicy().launch({
      descriptor: descriptor('autoclaw'),
      executablePath: '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs',
      interpreterPath: '/opt/homebrew/bin/node',
      env: { PATH: '' },
      rawExecutable: descriptor('autoclaw').command.executable,
      rawInterpreter: '/opt/homebrew/bin/node',
    })
    expect('command' in outcome).toBe(true)
    if (!('command' in outcome)) return
    expect(outcome.command.argsPrefix).toEqual(['--profile', 'autoclaw'])
    expect(outcome.command.interpreter).toBe('/opt/homebrew/bin/node')
  })

  it('carries protocolArgs through launch, like the CLI policy does (MI-9)', () => {
    // The ACP driver reads the wire protocol from `deps.command.protocolArgs`
    // (`src/drivers/acp.ts`). Rebuilding the command field-by-field dropped it,
    // so an ACP identity on the desktop track would silently launch the default
    // protocol of the same binary — the CLI policy already spreads it
    // (`src/tracks/cli/index.ts`), and this is the symmetry guard.
    const base = descriptor('autoclaw')
    const asAcp = { ...base, command: { ...base.command, protocolArgs: ['--acp'] } }
    const outcome = createDesktopPolicy().launch({
      descriptor: asAcp,
      executablePath: '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs',
      env: { PATH: '' },
      rawExecutable: asAcp.command.executable,
    })
    expect('command' in outcome).toBe(true)
    if (!('command' in outcome)) return
    expect(outcome.command.protocolArgs).toEqual(['--acp'])
    // …without disturbing the fields that were already carried.
    expect(outcome.command.argsPrefix).toEqual(['--profile', 'autoclaw'])
  })
})

/**
 * Host-dependent half. These assertions are the REASON the two descriptors
 * exist, so they run wherever the bundles are really installed and skip
 * elsewhere; nothing here is required for the pure tests above to be meaningful.
 */
const haveDomestic = fs.existsSync(WORKBUDDY_BUNDLE)
const haveInternational = fs.existsSync(WORKBUDDY_AI_BUNDLE)

describe.skipIf(!haveDomestic || !haveInternational)('installed bundles (host-dependent)', () => {
  /** `dataFolderName` is what makes the same launcher read a different home. */
  function dataFolderName(bundle: string): string {
    const productPath = `${bundle}/Contents/Resources/app.asar.unpacked/cli/product.json`
    return JSON.parse(fs.readFileSync(productPath, 'utf8'))['dataFolderName'] as string
  }

  it('selects its config home from the bundle it was launched out of', () => {
    expect(dataFolderName(WORKBUDDY_BUNDLE)).toBe('.workbuddy')
    expect(dataFolderName(WORKBUDDY_AI_BUNDLE)).toBe('.workbuddy-ai')
  })

  it('ships a byte-identical launcher in both bundles (identity is the path)', () => {
    const read = (bundle: string) =>
      fs.readFileSync(`${bundle}/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`)
    // If these ever diverge, the two descriptors stay correct — but the comment
    // in the catalog claiming byte-identity would be stale, and this test says so.
    expect(read(WORKBUDDY_BUNDLE).equals(read(WORKBUDDY_AI_BUNDLE))).toBe(true)
  })
})
