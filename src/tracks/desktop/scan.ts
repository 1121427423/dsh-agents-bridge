/**
 * dsh-agents-bridge / desktop track — app-bundle discovery (P3).
 *
 * The built-in desktop catalog names the bundles that happen to be installed on
 * the machine the bridge was developed against. That is a starting table, not a
 * model of the world: a user may have WorkBuddy somewhere other than
 * `/Applications`, a renamed build, or an app the bridge has never heard of that
 * ships exactly the same shape (a bundled CodeBuddy CLI, a bundled OpenClaw
 * gateway, a bundled node interpreter).
 *
 * This module generalises the table by SCANNING for that shape. Four rules,
 * each of which was learned from a real bundle on this host:
 *
 *  1. IDENTITY COMES FROM A FILE, NOT FROM A NAME. `WorkBuddy.app` and
 *     `WorkBuddy AI.app` ship a BYTE-IDENTICAL `cli/bin/codebuddy` (sha256
 *     f8b141c3…): the launcher reads `cli/product.json` beside itself to decide
 *     which product it is, which config home to use (`dataFolderName`:
 *     `.workbuddy` vs `.workbuddy-ai`) and which endpoint to authenticate
 *     against. A scanner that keyed off the bundle NAME would be guessing; this
 *     one reads `applicationName` / `dataFolderName` / `isOversea` /
 *     `darwinBundleIdentifier` and derives both the id and the notes from them.
 *
 *  2. `app.asar` IS NEVER READ. The archive beside `app.asar.unpacked/` is
 *     ~297 MB of Electron blob whose format needs an unpacker, and reading it
 *     would cost seconds per bundle for no additional fact. Everything this
 *     scanner wants (the CLI, the gateway, `product.json`) is unpacked by the
 *     app itself precisely so that node can require it — so only real files
 *     under `app.asar.unpacked/` are ever opened. `Contents/Frameworks/**` is
 *     likewise skipped for the interpreter search: an Electron bundle keeps a
 *     100+ MB `Electron Framework.framework` there and nothing this scanner
 *     needs.
 *
 *  3. EVERY BOUND IS EXPLICIT, AND OVERRUNNING ONE IS NORMAL. A `.app` is
 *     hostile input: it may be a 500 000-file tree, carry a FIFO that blocks a
 *     read forever, hold a 2 GB "product.json", or be a dangling symlink loop.
 *     So the walk has a depth cap, a per-directory entry cap, a per-file size
 *     cap and a wall-clock budget, and every `fs` call is wrapped. Hitting a
 *     bound stops that branch and records WHY in `notes`; it never throws. A
 *     probe must not fail, hang or slow down because one bundle is malformed.
 *
 *  4. THE RESULT IS STABLE. The same machine must produce the same ids on every
 *     probe: ids are derived only from the bundle-relative paths and the
 *     `product.json` contents, never from an absolute path, an mtime, a random
 *     number or a clock. That is what makes it safe to merge into a descriptor
 *     table that a settings override can address by id.
 *
 *  5. A DISCOVERED IDENTITY IS A CANDIDATE, NEVER AN ENGINE. Every identity this
 *     scanner emits carries `unsupported`, so neither `agents_run` nor the
 *     `--version` probe will ever execute it: the launcher is a file the bridge
 *     did NOT verify, under roots that include the user-writable `~/Applications`,
 *     and the probe path runs `<exe> --version` with the host user's merged
 *     environment. The operator opts in by declaring a descriptor for the id
 *     (`config.descriptors`, `src/index.ts`); a declared descriptor is merged
 *     BEFORE the scan and therefore shadows the candidate. Provenance
 *     (`CFBundleIdentifier` vs `product.json darwinBundleIdentifier`) is
 *     verified and reported so that decision is informed, but it is a
 *     self-consistency check only — two fields a hostile bundle can both write —
 *     so it never flips the gate by itself. See `docs/plan.md` §B4 for the
 *     contract.
 *
 * The scanner is PURE with respect to the host apart from `fs` itself: roots,
 * the clock and the directory reader are all injectable, which is how the tests
 * build fake bundles in a tmp dir and never look at the real `/Applications`.
 *
 * @module dsh-agents-bridge/tracks/desktop/scan
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AgentDescriptor, ProtocolFamily } from '../../kernel/types.ts'
import { oneLine, parseJsonObject, redactSecrets } from '../host-files.ts'

/* --------------------------------------------------------------- identity */

/**
 * The value `product.json` calls the product, i.e. the discriminator between
 * two bundles that share a launcher. `applicationName` is the field the
 * launcher itself reads (`workbuddy-ai` for the international build), so the
 * scanner prefers it over `productName` (a display label with a space in it).
 */
export interface ProductIdentity {
  /** `applicationName` — the value the bundled launcher keys off. */
  readonly applicationName?: string
  /** `productName` — a human label, used for `displayName` only. */
  readonly productName?: string
  /** `dataFolderName` — `~/.workbuddy` vs `~/.workbuddy-ai`. Load-bearing. */
  readonly dataFolderName?: string
  /** `isOversea` — the international build sets it; the domestic one omits it. */
  readonly isOversea?: boolean
  /** `darwinBundleIdentifier` — the app's own bundle id, for diagnostics. */
  readonly darwinBundleIdentifier?: string
  /** `endpoint` — the upstream this build authenticates against. */
  readonly endpoint?: string
}

/** Where a scanned identity came from and which file proved it. */
export interface ScanEvidence {
  /** Absolute path of the bundle (diagnostics only — never part of the id). */
  readonly bundle: string
  /** Bundle-relative path of the file the identity was derived from. */
  readonly source: string
}

/* ------------------------------------------------------------------ input */

/**
 * How one `.app` is found. The `Contents` layout is macOS-specific; the scanner
 * reads `Contents/Info.plist` to confirm the directory really is a bundle (an
 * empty `Foo.app` directory must not become an identity).
 */
export interface AppBundle {
  /** Absolute path of the `.app` directory. */
  readonly bundlePath: string
  /** Absolute path of `Contents`. */
  readonly contentsPath: string
  /** `CFBundleIdentifier` when readable, for diagnostics. */
  readonly bundleIdentifier?: string
}

/** Directory listing seam, so tests need no real filesystem. */
export type DirReader = (absolutePath: string) => readonly DirEntry[]

export interface DirEntry {
  readonly name: string
  readonly isDirectory: boolean
  readonly isFile: boolean
  /** Size in bytes for a file; `undefined` when it could not be stat'd. */
  readonly size?: number
}

export interface ScanOptions {
  /**
   * Directories whose `*.app` entries are candidates, in probe order.
   * Defaults to `/Applications` and `~/Applications`.
   */
  readonly roots?: readonly string[]
  /** Home directory used to expand a `~/...` root. */
  readonly home?: string
  /** Injectable directory reader; defaults to a bounded `fs.readdirSync`. */
  readonly readDir?: DirReader
  /** Injectable clock (epoch ms) for the wall-clock budget. */
  readonly now?: () => number
  /**
   * Epoch ms the budget is measured from. Defaults to `Date.now()`; a test that
   * injects `now` should pin this too, otherwise the deadline would follow the
   * injected clock and could never expire.
   */
  readonly startedAt?: number
  /** Wall-clock budget for the whole scan; defaults to 2000 ms. */
  readonly budgetMs?: number
  /**
   * Interpreter candidates checked IN ORDER for a bundled engine. The first
   * that exists inside the bundle is used; otherwise the descriptor falls back
   * to the first entry so the desktop policy reports the honest "interpreter
   * not found" reason.
   */
  readonly interpreterCandidates?: readonly string[]
  /** Protocol families whose drivers are compiled in, for engine inference. */
  readonly families?: readonly ProtocolFamily[]
}

/* --------------------------------------------------------------- results */

export interface ScannedIdentity {
  /** Stable, reproducible descriptor. */
  readonly descriptor: AgentDescriptor
  /** Which bundle and which file inside it produced this identity. */
  readonly evidence: ScanEvidence
  /** True when it collides with a built-in id and must NOT be added. */
  readonly shadowedByBuiltin: boolean
}

export interface ScanDiagnostic {
  /** Absolute bundle path the diagnostic belongs to. */
  readonly bundle: string
  /** One line, already redacted and collapsed. */
  readonly detail: string
}

export interface DesktopScanResult {
  /** Discovered identities, in bundle-then-root order. Deterministic. */
  readonly identities: readonly ScannedIdentity[]
  /** Bundles that produced nothing, with the reason (never an exception). */
  readonly skipped: readonly ScanDiagnostic[]
  /** True when the wall-clock budget ran out before the walk finished. */
  readonly budgetExhausted: boolean
  /** Wall-clock milliseconds actually spent. */
  readonly elapsedMs: number
}

/* ------------------------------------------------------------- constants */

const DEFAULT_BUDGET_MS = 2_000
/** Depth below `Contents` that the walk will descend. */
const MAX_DEPTH = 6
/** Entries examined per directory, so a 500 000-file tree cannot stall a probe. */
const MAX_ENTRIES_PER_DIR = 2_000
/** Candidate `.app` bundles examined per root. */
const MAX_BUNDLES_PER_ROOT = 64
/** Largest file this scanner will open. `product.json` is ~60 KB. */
const MAX_FILE_BYTES = 4_000_000
/**
 * Longest slug allowed to become a descriptor id / env-var prefix. `product.json`
 * is attacker-supplied, so an `applicationName` of 5 000 characters must not
 * reach an id, an env prefix or a settings key at full length.
 */
const MAX_ID_CHARS = 64
/**
 * Longest assembled descriptor text (`notes` / `displayName` / a candidate
 * reason). Larger than `oneLine`'s 200 because a note legitimately carries
 * several facts; unlike every fact it is NOT truncated to a single fact's size,
 * it only has to stay ONE line (see `oneLineText`).
 */
const MAX_DESCRIPTOR_TEXT_CHARS = 800

/** Where a bundled CodeBuddy CLI's product file lives, relative to `Contents`. */
const PRODUCT_CANDIDATES: readonly string[] = [
  'Resources/app.asar.unpacked/cli/product.json',
  'Resources/cli/product.json',
]

/**
 * Interpreter locations, relative to `Contents`.
 *
 * Verified on this host: AutoClaw ships
 * `Contents/Resources/node/darwin-arm64/node` (112 MB, mode 755). A bare
 * `Resources/node`, a `Resources/<...>/bin/node` and an unpacked
 * `node_modules` layout are also seen in the wild, and the `Frameworks` tree is
 * searched LAST because an Electron bundle's `Electron Framework.framework`
 * lives there and is not an interpreter anyone can pass a script to.
 */
const INTERPRETER_CANDIDATES: readonly string[] = [
  'Resources/node/darwin-arm64/node',
  'Resources/node/darwin-x64/node',
  'Resources/node/linux-x64/node',
  'Resources/node/win32-x64/node.exe',
  'Resources/node/bin/node',
  'Resources/node',
  'Resources/bin/node',
  'Resources/runtime/node',
  'Resources/app.asar.unpacked/node_modules/node/bin/node',
  'Frameworks/node',
]

/**
 * Bundled-engine entry points, relative to `Contents`.
 *
 * The exact path is a verified host fact for AutoClaw; the second entry is the
 * generalised form (`Resources/gateway/<engine>/<engine>.mjs`) so a differently
 * named gateway is still found.
 */
const ENGINE_CANDIDATES: readonly string[] = [
  'Resources/gateway/openclaw/openclaw.mjs',
]

/** `Resources/gateway/<name>/<name>.mjs` — the generalised gateway layout. */
const GATEWAY_DIR = 'Resources/gateway'

/**
 * Which driver family an engine entry point belongs to.
 *
 * Inference reads the FILE (its shebang and a bounded head of its contents),
 * then falls back to the registered family list. openclaw is deliberate: on
 * this host the AutoClaw gateway is openclaw 2026.6.8 and the `openclaw` driver
 * already speaks its NDJSON dialect.
 */
const FAMILY_HINTS: readonly { readonly needle: RegExp; readonly family: ProtocolFamily }[] = [
  { needle: /\bopenclaw\b/i, family: 'openclaw' },
  { needle: /\bcodebuddy\b/i, family: 'codebuddy' },
  { needle: /\bcodex\b/i, family: 'codex' },
  { needle: /\bclaude\b/i, family: 'claude' },
]

/** How much of an engine file is read to infer its family (never the whole file). */
const ENGINE_HEAD_BYTES = 64_000

/* ------------------------------------------------------------ id helpers */

/**
 * Turn an arbitrary product/bundle name into a stable id fragment.
 *
 * Lower-case, runs of non-alphanumerics collapsed to `-`, trimmed, and CAPPED:
 * the input is `product.json` or a directory name, i.e. attacker-chosen, and a
 * 5 000-character `applicationName` must not become a 5 000-character id, env
 * prefix and settings key. Chosen so that `WorkBuddy AI` → `workbuddy-ai`
 * (matching the built-in id), which is what makes the collisions with the
 * built-in table line up instead of creating a near-duplicate.
 */
export function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= MAX_ID_CHARS) return slug
  // Re-trim: the cut can land on a separator.
  return slug.slice(0, MAX_ID_CHARS).replace(/-+$/g, '')
}

/** `WorkBuddy AI.app` → `workbuddy-ai`. Never used for identity, only for ids. */
export function bundleSlug(bundleName: string): string {
  return slugify(bundleName.replace(/\.app$/i, ''))
}

/**
 * The env-var prefix for a scanned identity, derived from its id.
 *
 * Safe on purpose: `<PREFIX>_PATH` / `<PREFIX>_INTERPRETER` become usable
 * overrides for a discovered bundle without the user having to edit settings.
 */
export function envPrefixFor(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/* ------------------------------------------------------------ safe text */

/**
 * ONE untrusted fact, made safe for a descriptor field.
 *
 * `product.json` values and the bundle's own directory name are hostile input,
 * and the fields they feed are agents_probe OUTPUT COLUMNS: a newline in `notes`
 * or `displayName` becomes an extra row in the probe table, and a 5 000-char
 * `applicationName` becomes a 5 000-char cell. So every fact is collapsed to a
 * single line, credential-looking substrings are masked, and the length is
 * capped — the same posture as `tracks/host-files.ts` (`oneLine` 200-char cap,
 * `redactSecrets` at the single point free text leaves a reader) and
 * `tracks/health.ts`'s `fragment()`.
 */
function safeFact(raw: string): string {
  return redactSecrets(oneLine(raw))
}

/**
 * ONE line of descriptor text assembled from several facts.
 *
 * Same collapse-and-redact as `safeFact`, but capped at
 * `MAX_DESCRIPTOR_TEXT_CHARS` rather than a single fact's 200: a note carries
 * several facts, and truncating it to one fact's size would silently drop the
 * facts that make a wrong identity diagnosable. The property that must hold is
 * "one line", not "200 chars".
 */
function oneLineText(raw: string): string {
  const collapsed = redactSecrets(raw.replace(/\s+/g, ' ').trim())
  return collapsed.length > MAX_DESCRIPTOR_TEXT_CHARS
    ? `${collapsed.slice(0, MAX_DESCRIPTOR_TEXT_CHARS - 3)}...`
    : collapsed
}

/* --------------------------------------------------------------- the walk */

function defaultReadDir(absolutePath: string): readonly DirEntry[] {
  let names: string[]
  try {
    names = fs.readdirSync(absolutePath)
  } catch {
    return []
  }
  const entries: DirEntry[] = []
  for (const name of names.slice(0, MAX_ENTRIES_PER_DIR)) {
    try {
      const stat = fs.statSync(path.join(absolutePath, name))
      entries.push({ name, isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size })
    } catch {
      // A dangling symlink or an unreadable entry is simply not a candidate.
      entries.push({ name, isDirectory: false, isFile: false })
    }
  }
  return entries
}

/** `CFBundleIdentifier` out of `Contents/Info.plist`, without an XML parser. */
export function readBundleIdentifier(contentsPath: string, readDir: DirReader): string | undefined {
  const entries = readDir(contentsPath)
  const plist = entries.find((entry) => entry.name === 'Info.plist' && entry.isFile)
  if (plist === undefined) return undefined
  // The stat is already in hand from the directory listing and it is the FIRST
  // bound: a 2 GB "Info.plist" must not reach an open at all. Then the READ goes
  // through `readBounded` like every other untrusted read in this module — a raw
  // `readFileSync` here bypassed that helper entirely, so a FIFO or a device
  // node under a user-writable root blocked the whole walk with no way to
  // interrupt it. This runs for EVERY candidate bundle, which is what made that
  // reachable rather than theoretical.
  if (plist.size !== undefined && plist.size > MAX_FILE_BYTES) return undefined
  const xml = readBounded(path.join(contentsPath, 'Info.plist'))
  if (xml === undefined) return undefined
  const match = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]{1,200})<\/string>/.exec(xml)
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Describe one candidate directory as a bundle, or `undefined` if it is not one. */
function asBundle(bundlePath: string, readDir: DirReader): AppBundle | undefined {
  const contentsPath = path.join(bundlePath, 'Contents')
  const contentsEntries = readDir(contentsPath)
  // A directory named `Foo.app` with no readable `Contents/` is not a bundle.
  // This is what keeps a half-uninstalled or user-created directory out of the
  // table, and it is why `Contents/Info.plist` is not required: a bundle that
  // legitimately lacks it is still a bundle.
  if (!contentsEntries.some((child) => child.isDirectory || child.isFile)) return undefined
  const bundleIdentifier = readBundleIdentifier(contentsPath, readDir)
  return {
    bundlePath,
    contentsPath,
    ...(bundleIdentifier !== undefined ? { bundleIdentifier } : {}),
  }
}

/**
 * Find every `*.app` directly under one root, in a DETERMINISTIC order. One
 * level deep: a `.app` nested inside another bundle is not an installed
 * application.
 *
 * A root that IS a `.app` is examined directly, which is what lets a caller
 * (and every test) point the scanner at one bundle instead of a directory full
 * of them.
 */
function findBundles(root: string, readDir: DirReader, out: AppBundle[]): void {
  if (/\.app$/i.test(root)) {
    const direct = asBundle(root, readDir)
    if (direct !== undefined) out.push(direct)
    return
  }
  // The cap is PER ROOT, so `out` may already hold bundles from an earlier root.
  // Testing `out.length` directly is the IM-10 bug: once root 1 reached
  // MAX_BUNDLES_PER_ROOT every later root returned immediately, and with the
  // production roots (`/Applications` first, `~/Applications` second) that made
  // the user-writable root unreachable on any host with 64+ `.app` in
  // `/Applications` — i.e. the home root was never scanned at all. Cutting this
  // ROOT's own candidate list (below) is what keeps the bound a bound while
  // letting root 2 be walked.
  const candidates: string[] = []
  // Names are collected FIRST, bounded by the per-directory entry cap, and only
  // then sorted and cut to MAX_BUNDLES_PER_ROOT. Cutting in raw readdir order
  // (the old shape: push until the cap, sort afterwards) made WHICH identities
  // survive the cap a function of the order the filesystem returned entries, so
  // installing or removing one app could swap an identity out of the reported
  // set and make `get()`/`resolve()` disagree with the previous run (RR-MI-2).
  for (const entry of readDir(root).slice(0, MAX_ENTRIES_PER_DIR)) {
    if (entry.isDirectory && entry.name.endsWith('.app')) candidates.push(entry.name)
  }
  // Sorted, so probe order is a property of the SET of bundles rather than of
  // the order the filesystem happened to hand back. This is what makes the
  // scanned ids reproducible across runs.
  for (const name of candidates.sort().slice(0, MAX_BUNDLES_PER_ROOT)) {
    const bundle = asBundle(path.join(root, name), readDir)
    if (bundle !== undefined) out.push(bundle)
  }
}

/** Depth-first, bounded, never-following-symlink search for the first real file. */
function findFile(
  dir: string,
  names: ReadonlySet<string>,
  readDir: DirReader,
  depth: number,
  deadline: number,
  now: () => number,
): string | undefined {
  if (depth > MAX_DEPTH || now() > deadline) return undefined
  let entries: readonly DirEntry[]
  try {
    entries = readDir(dir)
  } catch {
    return undefined
  }
  let directories: string[] = []
  for (const entry of entries) {
    if (now() > deadline) return undefined
    if (entry.isFile && names.has(entry.name)) return path.join(dir, entry.name)
    if (entry.isDirectory) directories.push(entry.name)
  }
  directories = directories.sort()
  for (const name of directories) {
    if (now() > deadline) return undefined
    const found = findFile(path.join(dir, name), names, readDir, depth + 1, deadline, now)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Read a small file, refusing anything above the size cap. Never throws.
 *
 * The read is LAZY for a reason. The stat is what enforces the size cap, and a
 * `readFileSync` of a file that is a FIFO, a device node or a file on a stalled
 * network mount blocks the whole scan with no way to interrupt it — a `.app` is
 * untrusted input and must not be able to hang a probe. A `.mjs` engine is a
 * regular file in practice, and stat'ing it costs a syscall, so the stat is paid
 * up front for everything and the open is paid only on use.
 */
function readBounded(absolutePath: string, maxBytes = MAX_FILE_BYTES): string | undefined {
  try {
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
  } catch {
    return undefined
  }
  try {
    return fs.readFileSync(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------- product */

/** Parse the identity fields out of `product.json`, tolerating every shape. */
export function parseProductIdentity(contents: string): ProductIdentity | undefined {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return undefined
  const record = parsed.value
  const stringField = (key: string): string | undefined => {
    const value = record[key]
    // Every fact is clamped, one-lined and redacted HERE, at the single point
    // the untrusted file becomes identity data — so the id, the env prefix, the
    // display name and `notes` are all built from bounded, single-line values.
    return typeof value === 'string' && value.trim() !== '' ? safeFact(value) : undefined
  }
  const identity: ProductIdentity = {
    ...(stringField('applicationName') !== undefined ? { applicationName: stringField('applicationName') } : {}),
    ...(stringField('productName') !== undefined ? { productName: stringField('productName') } : {}),
    ...(stringField('dataFolderName') !== undefined ? { dataFolderName: stringField('dataFolderName') } : {}),
    ...(record['isOversea'] === true ? { isOversea: true } : {}),
    ...(stringField('darwinBundleIdentifier') !== undefined
      ? { darwinBundleIdentifier: stringField('darwinBundleIdentifier') }
      : {}),
    ...(stringField('endpoint') !== undefined ? { endpoint: stringField('endpoint') } : {}),
  }
  // An identity needs at least one discriminating fact. A `product.json` that
  // parses but says nothing useful is not evidence of anything.
  if (
    identity.applicationName === undefined &&
    identity.productName === undefined &&
    identity.dataFolderName === undefined
  ) {
    return undefined
  }
  return identity
}

/**
 * The stable id for a bundled-CLI bundle.
 *
 * `applicationName` first: it is the field the launcher itself is keyed on, and
 * it is what makes `WorkBuddy AI.app` produce `workbuddy-ai` — the id the
 * built-in table already uses — instead of a second identity for the same app.
 * The bundle NAME is the last resort, so a bundle with no readable
 * `product.json` still gets a (clearly marked) identity rather than vanishing.
 */
export function productIdentityId(identity: ProductIdentity | undefined, bundleSlugName: string): string {
  const raw = identity?.applicationName ?? identity?.productName ?? bundleSlugName
  const slug = slugify(raw)
  return slug === '' ? bundleSlugName : slug
}

/* ------------------------------------------------------------- describe */

function evidenceNote(kind: string, evidence: ScanEvidence): string {
  const relative = evidence.source === '' ? '' : ` → ${evidence.source}`
  return `[scan] ${kind} discovered by app-bundle scan of ${evidence.bundle}${relative}`
}

/* ---------------------------------------------------------------- scan */

/**
 * Scan the bundle roots and return the identities they contain.
 *
 * Deterministic for a given filesystem, bounded in time and depth, and it never
 * throws or rejects: every failure becomes a `skipped` diagnostic.
 */
export function scanDesktopBundles(options: ScanOptions = {}): DesktopScanResult {
  const now = options.now ?? (() => Date.now())
  // The budget is measured from a FIXED origin, never from a fresh `now()`
  // reading: with an injected clock, reading the start from the same source
  // would make the deadline move with the clock and the budget could never
  // expire. `startedAt` is a seam so a test can pin the origin explicitly.
  const startedAt = options.startedAt ?? Date.now()
  const deadline = startedAt + (options.budgetMs ?? DEFAULT_BUDGET_MS)
  const home = options.home ?? os.homedir()
  const readDir = options.readDir ?? defaultReadDir
  const roots = (options.roots ?? [path.join('/Applications'), path.join(home, 'Applications')]).map((root) =>
    root.startsWith('~/') ? path.join(home, root.slice(2)) : root,
  )
  const interpreterCandidates = options.interpreterCandidates ?? INTERPRETER_CANDIDATES
  const families = options.families ?? ['claude', 'codebuddy', 'codex', 'openclaw', 'generic']

  const bundles: AppBundle[] = []
  const skipped: ScanDiagnostic[] = []

  for (const root of roots) {
    if (now() > deadline) break
    try {
      findBundles(root, readDir, bundles)
    } catch {
      skipped.push({ bundle: root, detail: `[scan] could not list bundle root ${root}` })
    }
  }

  const identities: ScannedIdentity[] = []
  const claimedIds = new Set<string>()
  let budgetExhausted = false

  for (const bundle of bundles) {
    if (now() > deadline) {
      budgetExhausted = true
      break
    }
    try {
      const found = scanBundle(bundle, {
        readDir,
        deadline,
        now,
        interpreterCandidates,
        families,
      })
      if (found === undefined) {
        skipped.push({
          bundle: bundle.bundlePath,
          detail: '[scan] no bundled CodeBuddy CLI, node engine or node interpreter under Contents/',
        })
        continue
      }
      if (claimedIds.has(found.descriptor.id)) {
        // Two bundles claiming the same product id: keep the first (path order
        // is sorted, so "first" is stable) and say so rather than silently
        // dropping one.
        skipped.push({
          bundle: bundle.bundlePath,
          detail: `[scan] duplicate id "${found.descriptor.id}" (already claimed by an earlier bundle)`,
        })
        continue
      }
      claimedIds.add(found.descriptor.id)
      identities.push(found)
    } catch {
      // A bundle must never be able to fail a probe. `scanBundle` is written not
      // to throw; this is the belt-and-braces line that guarantees it.
      skipped.push({ bundle: bundle.bundlePath, detail: '[scan] bundle could not be examined (unexpected error)' })
    }
  }

  return {
    identities,
    skipped,
    budgetExhausted: budgetExhausted || now() > deadline,
    elapsedMs: Math.max(0, now() - startedAt),
  }
}

interface BundleScanContext {
  readonly readDir: DirReader
  readonly deadline: number
  readonly now: () => number
  readonly interpreterCandidates: readonly string[]
  readonly families: readonly ProtocolFamily[]
}

/**
 * Examine ONE bundle. Returns the identity it produced, or `undefined`.
 *
 * The three recognisers are tried in order of how strong their evidence is:
 *
 *   1. a bundled CodeBuddy CLI — the strongest, because `product.json` states
 *      the product's own identity and the launcher beside it is a real
 *      executable at a real absolute path. Still a CANDIDATE: identity evidence
 *      is not verification, so it is reported `unsupported` (rule 5),
 *   2. a bundled node engine (an OpenClaw gateway) — inferred from an entry
 *      point plus a family match, `unsupported` because the bridge has no
 *      verified argv for it,
 *   3. a bundled node interpreter with nothing to run — a CANDIDATE, reported
 *      as `unsupported` because an interpreter alone is not an agent.
 *
 * A recogniser that finds its marker but cannot READ it falls through rather
 * than emitting a weaker identity: "something is there but I could not open it"
 * is a `skipped` diagnostic, never a fabricated descriptor.
 */
function scanBundle(bundle: AppBundle, context: BundleScanContext): ScannedIdentity | undefined {
  const { readDir, now, deadline } = context
  const slugName = bundleSlug(path.basename(bundle.bundlePath))

  // 1. A bundled CodeBuddy CLI: a shipped launcher plus the product.json that
  //    tells it which product it is.
  const productRelative = PRODUCT_CANDIDATES.find((candidate) =>
    readDir(path.dirname(path.join(bundle.contentsPath, candidate))).some(
      (entry) => entry.name === path.basename(candidate) && entry.isFile,
    ),
  )
  if (productRelative !== undefined && now() <= deadline) {
    const productAbsolute = path.join(bundle.contentsPath, productRelative)
    const cliDir = path.dirname(productAbsolute)
    const launcher =
      readDir(path.join(cliDir, 'bin')).find((entry) => entry.name === 'codebuddy' && entry.isFile) !== undefined
        ? path.join(cliDir, 'bin', 'codebuddy')
        : undefined
    if (launcher !== undefined) {
      // The read is what makes this an identity rather than a guess. A
      // product.json that cannot be opened, or that parses but names no
      // product, means this bundle is NOT recognisable: falling back to the
      // bundle NAME here would fabricate an identity out of a directory label,
      // which is precisely the guessing the desktop track forbids. The bundle
      // is reported as skipped instead.
      const productContents = readBounded(productAbsolute, 1_000_000)
      const identity = productContents === undefined ? undefined : parseProductIdentity(productContents)
      if (identity !== undefined) {
        const id = productIdentityId(identity, slugName)
        const evidence: ScanEvidence = { bundle: bundle.bundlePath, source: productRelative }
        return {
          descriptor: bundledCliDescriptor({ id, identity, launcher, bundle, evidence }),
          evidence,
          shadowedByBuiltin: false,
        }
      }
    }
  }

  // 2. A bundled node engine (an `.mjs`/`.js` a node interpreter can run),
  //    typically an OpenClaw gateway.
  if (now() <= deadline) {
    const engine = engineEntryPoint(bundle, context)
    if (engine !== undefined) {
      const { absolute: engineAbsolute, relative: engineRelative } = engine
      const interpreter = interpreterFor(bundle, context)
      const engineName = slugify(path.basename(path.dirname(engineAbsolute))) || slugName
      const id = uniqueEngineId(engineName, slugName)
      const evidence: ScanEvidence = { bundle: bundle.bundlePath, source: engineRelative }
      return {
        descriptor: {
          id,
          track: 'desktop',
          family: inferFamily(engineAbsolute, context.families, slugName),
          displayName: oneLineText(`${bundleDisplayName(bundle)} (bundled engine)`),
          command: {
            executable: engineAbsolute,
            ...(interpreter !== undefined ? { interpreter } : {}),
          },
          envPrefix: envPrefixFor(id),
          capabilities: { model: true },
          // No `argsPrefix`: guessing argv for an engine nobody has driven is
          // how you run it wrong. The desktop track refuses the launch instead
          // (see `bundledEngineDescriptor`).
          unsupported: {
            // IM-11: this used to tell the operator to "set <PREFIX>_PATH … and
            // a driver family in settings to enable it". That remedy is INERT —
            // `registry.resolve()` returns `unsupported` BEFORE the track policy
            // runs and `manager` refuses every run — so the string was a lie. It
            // now names the one surface that can actually enable the identity.
            reason: oneLineText(`${evidenceNote('bundled node engine', evidence)} — the bridge has no verified argv for this engine, so it will not launch it, and a discovered identity is never executed by a probe. To enable it, declare a descriptor for this id in the plugin's config.descriptors (src/index.ts); a declared descriptor shadows this candidate.`),
          },
          notes: oneLineText(`${evidenceNote('bundled node engine', evidence)}. Discovered by scan, NOT verified: the entry point is reported for diagnosis until a descriptor in config.descriptors declares it.`),
        },
        evidence,
        shadowedByBuiltin: false,
      }
    }
  }

  // 3. A bundled node interpreter with nothing to run it against. Reported as an
  //    INTERPRETER candidate, not as a driver: an interpreter is not an agent,
  //    and inventing one would put an identity in the table that can never run.
  const interpreter = interpreterFor(bundle, context)
  if (interpreter !== undefined) {
    const relative = path.relative(bundle.contentsPath, interpreter)
    const evidence: ScanEvidence = { bundle: bundle.bundlePath, source: relative }
    const id = `${slugName}-interpreter`
    return {
      descriptor: {
        id,
        track: 'desktop',
        family: 'generic',
        displayName: oneLineText(`${bundleDisplayName(bundle)} (bundled node interpreter)`),
        command: { executable: interpreter },
        envPrefix: envPrefixFor(id),
        unsupported: {
          // IM-11: the old remedy ("point a descriptor's `interpreter` at it
          // (or set <PREFIX>_PATH to a script)") could never fire, because an
          // `unsupported` descriptor is refused before the track policy sees
          // it. Name the surface that works.
          reason: oneLineText(`${evidenceNote('node interpreter', evidence)} — an interpreter cannot be driven on its own, and a discovered identity is never executed by a probe. To use it, declare a descriptor in the plugin's config.descriptors (src/index.ts) whose command.interpreter is this file.`),
        },
        notes: oneLineText(`Bundled interpreter candidate. Declare a descriptor in config.descriptors that uses it before anything launches it.`),
      },
      evidence,
      shadowedByBuiltin: false,
    }
  }

  return undefined
}

/** `WorkBuddy AI.app` → `WorkBuddy AI` (single line, bounded, redacted). */
function bundleDisplayName(bundle: AppBundle): string {
  const base = path.basename(bundle.bundlePath)
  return safeFact(base.replace(/\.app$/i, ''))
}

/**
 * How a bundle's own two identity files agree about who it is.
 *
 * `consistent` means the `Info.plist` `CFBundleIdentifier` equals the
 * `product.json` `darwinBundleIdentifier`; `inconsistent` means the bundle
 * contradicts itself; `unknown` means at least one side said nothing. This is a
 * SELF-CONSISTENCY check, not a signature: a hostile bundle writes both files.
 * It exists so the operator's opt-in decision is informed, never to flip the
 * gate — see `bundledCliDescriptor`.
 */
type Provenance = 'consistent' | 'inconsistent' | 'unknown'

function provenanceOf(bundle: AppBundle, identity: ProductIdentity): Provenance {
  if (bundle.bundleIdentifier === undefined || identity.darwinBundleIdentifier === undefined) return 'unknown'
  return bundle.bundleIdentifier === identity.darwinBundleIdentifier ? 'consistent' : 'inconsistent'
}

function provenanceNote(provenance: Provenance, bundle: AppBundle, identity: ProductIdentity): string {
  if (provenance === 'consistent') {
    return `provenance consistent: CFBundleIdentifier=${bundle.bundleIdentifier} matches darwinBundleIdentifier (self-consistency only — the bridge performs no code-signature check)`
  }
  if (provenance === 'inconsistent') {
    return `provenance INCONSISTENT: CFBundleIdentifier=${bundle.bundleIdentifier} does not match product.json darwinBundleIdentifier=${identity.darwinBundleIdentifier} — the bundle contradicts its own identity files`
  }
  return 'provenance unknown: Info.plist and product.json do not both state a bundle identifier, so nothing corroborates this identity'
}

/**
 * The bundled-CLI descriptor, which is a CANDIDATE and never launchable.
 *
 * `dataFolderName` is the load-bearing read: it is what makes the SAME
 * byte-identical launcher read `~/.workbuddy` in one bundle and
 * `~/.workbuddy-ai` in the other, so it is surfaced in `notes` rather than
 * silently absorbed.
 *
 * WHY `unsupported` (IM-1): the recogniser matches on SHAPE — a directory
 * containing `…/cli/product.json` and `bin/codebuddy` — and the shape is all a
 * hostile bundle has to fake. The descriptor used to be emitted launchable, and
 * `agents_probe` then executed the discovered launcher (`<exe> --version`) with
 * the host user's merged environment, on a path a model can trigger, over roots
 * that include the user-writable `~/Applications`. A file the bridge did not
 * verify is not an engine; `unsupported` is what makes `registry.resolve()`
 * refuse it for BOTH a run and the version probe, because both go through that
 * one function. The operator opts in with an explicit descriptor for the id
 * (`config.descriptors`), which is merged before the scan and shadows this
 * candidate; provenance is reported to inform that decision (see above).
 */
function bundledCliDescriptor(input: {
  readonly id: string
  readonly identity: ProductIdentity
  readonly launcher: string
  readonly bundle: AppBundle
  readonly evidence: ScanEvidence
}): AgentDescriptor {
  const { id, identity, launcher, bundle, evidence } = input
  const facts: string[] = []
  if (identity.applicationName !== undefined) facts.push(`applicationName=${identity.applicationName}`)
  if (identity.dataFolderName !== undefined) facts.push(`dataFolderName=${identity.dataFolderName}`)
  if (identity.isOversea === true) facts.push('isOversea=true')
  if (identity.darwinBundleIdentifier !== undefined) {
    facts.push(`darwinBundleIdentifier=${identity.darwinBundleIdentifier}`)
  }
  if (identity.endpoint !== undefined) facts.push(`endpoint=${identity.endpoint}`)
  const prefix = envPrefixFor(id)
  const provenance = provenanceOf(bundle, identity)

  const noteParts = [evidenceNote('bundled CodeBuddy CLI', evidence)]
  if (facts.length > 0) noteParts.push(`product.json: ${facts.join(', ')}`)
  if (identity.dataFolderName !== undefined) {
    noteParts.push(
      `the launcher reads ${identity.dataFolderName} for its config home (identity is the bundle, not a flag)`,
    )
  }
  if (bundle.bundleIdentifier !== undefined) noteParts.push(`CFBundleIdentifier=${bundle.bundleIdentifier}`)
  noteParts.push(provenanceNote(provenance, bundle, identity))
  // No interpreter is baked in here on purpose: `resolve()` runs the
  // descriptor's interpreter through the same resolver as everything else, so a
  // scanned bundle whose interpreter moved reports an honest "interpreter not
  // found" (with a `${prefix}_INTERPRETER` hint) instead of silently launching
  // without one — which is the exact failure the desktop track exists to avoid.
  noteParts.push(
    `set ${prefix}_INTERPRETER if node is not on PATH (the bundled launcher is a node script)`,
  )

  return {
    id,
    track: 'desktop',
    family: 'codebuddy',
    displayName: oneLineText(
      identity.productName !== undefined
        ? `${identity.productName} (${bundleDisplayName(bundle)})`
        : `${bundleDisplayName(bundle)} (bundled CodeBuddy CLI)`,
    ),
    command: { executable: launcher },
    envPrefix: prefix,
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
    unsupported: {
      reason: oneLineText(`${evidenceNote('bundled CodeBuddy CLI', evidence)} — a scan-discovered bundle is a CANDIDATE: the bridge did not verify this launcher, so it will not launch it and will not execute it for a version probe. To opt in, declare a descriptor for id "${id}" in the plugin's config.descriptors (src/index.ts) with command.executable "${launcher}"; ${prefix}_PATH then only overrides the path of that declared descriptor.`),
    },
    notes: oneLineText(noteParts.join('. ')),
  }
}

/** The first candidate that exists under `contentsPath`, in declared order. */
function firstExisting(contentsPath: string, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const absolute = path.join(contentsPath, candidate)
    try {
      const stat = fs.statSync(absolute)
      if (!stat.isFile()) continue
      fs.accessSync(absolute, fs.constants.X_OK)
      return absolute
    } catch {
      // Not there, or not executable: try the next candidate.
    }
  }
  return undefined
}

/**
 * The interpreter for a bundle's engine, preferring one that ships in the
 * bundle over the host's node (the desktop track's whole point is that node is
 * NOT assumed to be on PATH).
 */
function interpreterFor(bundle: AppBundle, context: BundleScanContext): string | undefined {
  return firstExisting(bundle.contentsPath, context.interpreterCandidates)
}

/** The bundle's node engine entry point, if it ships one. */
function engineEntryPoint(
  bundle: AppBundle,
  context: BundleScanContext,
): { readonly absolute: string; readonly relative: string } | undefined {
  for (const candidate of ENGINE_CANDIDATES) {
    const absolute = path.join(bundle.contentsPath, candidate)
    if (context.readDir(path.dirname(absolute)).some((entry) => entry.name === path.basename(absolute) && entry.isFile)) {
      return { absolute, relative: candidate }
    }
  }
  // Generalised form: `Resources/gateway/<name>/<name>.mjs` (and `<name>.js`).
  const gateway = path.join(bundle.contentsPath, GATEWAY_DIR)
  const engines = context.readDir(gateway).filter((entry) => entry.isDirectory)
  for (const directory of [...engines].sort((a, b) => a.name.localeCompare(b.name))) {
    if (context.now() > context.deadline) return undefined
    const found = findFile(
      path.join(gateway, directory.name),
      new Set([`${directory.name}.mjs`, `${directory.name}.js`]),
      context.readDir,
      0,
      context.deadline,
      context.now,
    )
    if (found !== undefined) {
      return { absolute: found, relative: path.relative(bundle.contentsPath, found) }
    }
  }
  return undefined
}

/**
 * Infer the protocol family of an engine entry point.
 *
 * Reads a bounded HEAD of the file (never the whole thing) and matches on the
 * package's own name/comment text, then falls back to the family list. If the
 * engine names a family the bridge has no driver for, `generic` is used rather
 * than a family with no implementation — a descriptor whose family has no
 * driver would throw inside a run, which is worse than running it generically.
 */
export function inferFamily(
  absolutePath: string,
  families: readonly ProtocolFamily[],
  bundleSlugName: string,
): ProtocolFamily {
  const head = readBounded(absolutePath, ENGINE_HEAD_BYTES) ?? ''
  const haystack = `${bundleSlugName}\n${head.slice(0, ENGINE_HEAD_BYTES)}`
  for (const hint of FAMILY_HINTS) {
    if (hint.needle.test(haystack) && families.includes(hint.family)) return hint.family
  }
  return families.includes('generic') ? 'generic' : (families[0] ?? 'generic')
}

/**
 * Ensure a discovered engine id is not a bare product name that would collide
 * confusingly with an app of the same name, while staying deterministic.
 */
function uniqueEngineId(engineName: string, bundleSlugName: string): string {
  if (engineName === '' || engineName === bundleSlugName) return `${bundleSlugName}-engine`
  return engineName
}

/* -------------------------------------------------------------- merging */

/**
 * Merge scanned identities into a descriptor table with BUILT-IN WINS.
 *
 * This is the rule the workstream asked for, and it is the right one: the
 * built-in table carries host-verified facts (the exact launcher path, the
 * `--profile autoclaw` argv, MiMo's `unsupported` boundary) that a scan cannot
 * re-derive. A scan result is therefore a SUPPLEMENT — it may add an identity
 * the table does not have, and it may never replace or weaken one it does.
 *
 * Shadowed results are returned rather than discarded so probe output can
 * explain that a bundle was seen and deliberately not added.
 */
export function mergeScannedIdentities(
  builtins: readonly AgentDescriptor[],
  scanned: readonly ScannedIdentity[],
): { readonly descriptors: readonly AgentDescriptor[]; readonly shadowed: readonly ScannedIdentity[] } {
  const known = new Set(builtins.map((descriptor) => descriptor.id))
  const shadowed: ScannedIdentity[] = []
  const extras: AgentDescriptor[] = []
  const claimed = new Set(known)
  for (const identity of scanned) {
    if (known.has(identity.descriptor.id)) {
      shadowed.push({ ...identity, shadowedByBuiltin: true })
      continue
    }
    if (claimed.has(identity.descriptor.id)) continue
    claimed.add(identity.descriptor.id)
    extras.push(identity.descriptor)
  }
  // Built-ins first, so probe order and the model-facing listing stay stable
  // whether or not a scan discovered anything.
  return { descriptors: [...builtins, ...extras], shadowed }
}

/**
 * A one-line diagnostic for the scanned bundles a merge deliberately dropped.
 * Returns `undefined` when nothing was shadowed, so probe output stays quiet.
 */
export function shadowedSummary(shadowed: readonly ScannedIdentity[]): string | undefined {
  if (shadowed.length === 0) return undefined
  const parts = shadowed.map(
    (identity) => `${identity.descriptor.id} (seen in ${identity.evidence.bundle}, keeping the built-in descriptor)`,
  )
  return oneLine(`[scan] ${parts.join('; ')}`)
}
