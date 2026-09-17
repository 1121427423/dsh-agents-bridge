/**
 * Identity registry: the mechanism that resolves and probes identities.
 *
 * The DATA moved out in ABI v2: the descriptor tables now live in the two track
 * catalogs (`src/tracks/cli/catalog.ts`, `src/tracks/desktop/catalog.ts`) and
 * the per-track launch rules in the track modules. This module stays the
 * single mechanism both tracks share — resolve a `<PREFIX>_PATH` override, find
 * the binary, hand the result to the track policy, and probe `<exe> --version`.
 * It never branches on a specific agent id.
 *
 * `probe()` only ever runs `<exe> --version` (plus pure filesystem lookups).
 * Nothing here may trigger a login prompt, an onboarding window, or a nested
 * agent loop: probing is called from a model-facing tool and must be cheap,
 * silent and safe.
 *
 * @module dsh-agents-bridge/kernel/registry
 */

import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  AgentDescriptor,
  AgentId,
  AgentTrack,
  BridgeLogger,
  CommandSpec,
  ProbeResult,
} from './types.ts'
import { childLogger } from './logger.ts'
import { buildCommandLine } from './command-line.ts'
import { BUILTIN_DESCRIPTORS, policyFor, type TrackPolicyOptions } from '../tracks/index.ts'
import { credentialStatusFor, type CredentialReaderOptions } from '../tracks/health.ts'
import { modelFieldsFor, modelsFor, type ModelReaderOptions } from '../tracks/models.ts'
import {
  mergeScannedIdentities,
  scanDesktopBundles,
  shadowedSummary,
  type DesktopScanResult,
  type ScanOptions,
} from '../tracks/desktop/scan.ts'
import {
  defaultPortExpectations,
  portNote,
  probePorts,
  type Connector,
  type PortExpectation,
  type PortFinding,
} from '../tracks/desktop/port-probe.ts'

/**
 * Re-exported for embedders that already import this module: the descriptor
 * DATA now lives in the two track catalogs (ABI v2), but the registry remains
 * the natural place to read the table from.
 */
export { BUILTIN_DESCRIPTORS }

/** Probe cache TTL: probing is cheap but not free (one `--version` spawn each). */
const DEFAULT_PROBE_TTL_MS = 60_000
const DEFAULT_VERSION_TIMEOUT_MS = 3_000
const MAX_VERSION_CHARS = 4096

/** One identity with every host-dependent value resolved. */
export interface ResolvedIdentity {
  readonly descriptor: AgentDescriptor
  /** The track that produced `command`. */
  readonly track: AgentTrack
  /**
   * The `CommandSpec` a driver should launch. `executable` / `interpreter` are
   * absolute when they were found; otherwise the raw descriptor values are kept
   * so a spawn failure surfaces the original string.
   */
  readonly command: CommandSpec
  /** Merged child environment (host env + descriptor env). */
  readonly env: Record<string, string>
  readonly executablePath?: string
  /**
   * Absolute path of the DESCRIPTOR-pinned `command.interpreter`, when it was
   * found. `undefined` for a CLI-track shim that `launch()` repaired — that
   * repair lands in `command.interpreter` instead, which is why NOTHING may
   * build an argv from this field alone. Use `buildCommandLine(command, args)`;
   * see `docs/findings-node-shim.md`.
   */
  readonly interpreterPath?: string
  /** `<PREFIX>_MODEL` override, when set. The manager uses it as a run default. */
  readonly model?: string
  /** Human-readable reason the identity cannot be launched; absent = available. */
  readonly reason?: string
}

export interface VersionProbeInput {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

/**
 * What one `<exe> --version` attempt actually produced.
 *
 * The split exists because the two halves are NOT interchangeable, and merging
 * them is how this bridge came to report a spawn failure as a version number:
 * `version` comes from STDOUT only, `diagnostic` is the child's own explanation
 * (stderr, a spawn error, a timeout) and is surfaced as an explained probe
 * `notes` line, never as a version.
 */
export interface VersionProbeOutcome {
  /** Parsed version, from the child's STDOUT. */
  readonly version?: string
  /** Why no version was obtained — one line, for the probe row. */
  readonly diagnostic?: string
}

/**
 * Injectable so tests never spawn a process while probing.
 *
 * A bare `string | undefined` is still accepted (and is what every existing
 * injector returns), so widening this did not move a single test.
 */
export type VersionProbeResult = string | VersionProbeOutcome | undefined
export type VersionProbe = (input: VersionProbeInput) => Promise<VersionProbeResult>

export interface RegistryOptions {
  readonly logger?: BridgeLogger
  /** Settings/env overrides merged on top of the descriptor table. */
  readonly overrides?: Readonly<Record<AgentId, Partial<AgentDescriptor>>>
  readonly extraDescriptors?: readonly AgentDescriptor[]
  /** Environment for PATH lookups and `<PREFIX>_*` overrides; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Injectable clock (epoch ms) for the probe cache TTL. */
  readonly now?: () => number
  readonly probeCacheTtlMs?: number
  readonly versionTimeoutMs?: number
  /** Injectable version prober (defaults to a bounded `<exe> --version` spawn). */
  readonly probeVersion?: VersionProbe
  /** Injectable executable resolver (defaults to track searchPath + PATH). */
  readonly resolveExecutable?: ExecutableResolver
  /** Overrides how a track builds its CommandSpec (tests / settings). */
  readonly trackPolicyOptions?: TrackPolicyOptions
  /**
   * Where the credential/model readers look for each engine's own config files.
   * Defaults to the real home directory; tests pass `contents`/`home` so probe
   * output is host-independent. Readers never see a credential VALUE leave.
   */
  readonly hostOptions?: CredentialReaderOptions & ModelReaderOptions
  /**
   * App-bundle scan (P3). `false` disables it entirely; an object tunes it
   * (roots, budget, injectable directory reader). Enabled by default so a
   * machine whose bundles live outside the built-in table is still covered.
   */
  readonly scan?: false | ScanOptions
  /**
   * Loopback port fingerprinting (P3). Defaults to `defaultPortExpectations()`,
   * which is empty — no port is asserted without a verified host fact.
   */
  readonly portExpectations?: readonly PortExpectation[]
  /** Set to `false` to skip the port sweep entirely. */
  readonly portProbe?: boolean
  /** Injectable connector, so tests fingerprint without opening a socket. */
  readonly portConnector?: Connector
}

export interface AgentRegistry {
  readonly descriptors: readonly AgentDescriptor[]
  get(id: AgentId): AgentDescriptor | undefined
  /** Resolve one identity against the host; never throws. */
  resolve(id: AgentId): ResolvedIdentity
  /** Probe every identity; `refresh: true` bypasses the TTL cache. */
  probe(opts?: { readonly refresh?: boolean }): Promise<readonly ProbeResult[]>
  invalidate(): void
  /**
   * One-line summary of what the app-bundle scan found (identities added,
   * bundles shadowed by a built-in, or a budget that ran out). `undefined`
   * until the first `probe()`, and when the scan had nothing to report.
   */
  scanDiagnostics(): string | undefined
}

/* ------------------------------------------------------------------ paths */

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A file that will be handed to an interpreter only has to be READABLE.
 *
 * Verified failure this fixes: AutoClaw ships its engine as
 * `.../gateway/openclaw/openclaw.mjs` with mode 644 and runs it as
 * `node openclaw.mjs`, so an executable-bit test reported a healthy desktop
 * engine as missing. The interpreter itself is still required to be executable.
 */
function isReadableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false
    fs.accessSync(candidate, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Expand a leading `~` without touching the rest of the path. */
function expandHome(raw: string): string {
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

/**
 * Resolver for one lookup. `extraDirs` is the track policy's search path and is
 * consulted BEFORE the inherited PATH: a GUI-launched host routinely has a
 * minimal PATH in which an installed engine is invisible (verified: `claude`
 * was unresolvable while /usr/local/bin/claude existed).
 */
function makeResolver(
  env: Readonly<Record<string, string | undefined>>,
): ExecutableResolver {
  const searchPath = env['PATH'] ?? ''
  return (raw: string, extraDirs: readonly string[] = [], requireExecutable = true): string | undefined => {
    const accept = requireExecutable ? isExecutableFile : isReadableFile
    const candidate = expandHome(raw)
    if (candidate === '' || candidate.includes(path.sep)) {
      const abs = path.resolve(candidate)
      return accept(abs) ? abs : undefined
    }
    for (const dir of [...extraDirs, ...searchPath.split(path.delimiter)]) {
      // An empty PATH entry means "current directory" by POSIX convention.
      const base = dir === '' ? '.' : expandHome(dir)
      const abs = path.resolve(base, candidate)
      if (accept(abs)) return abs
    }
    return undefined
  }
}

/**
 * Resolve a raw executable to an absolute path.
 *
 * `extraDirs` is the track policy's search path (consulted first, mirroring the
 * login shell's user-dirs-first ordering). `requireExecutable: false` is for a
 * file that will be run through an interpreter — see `isReadableFile`.
 */
export type ExecutableResolver = (
  raw: string,
  extraDirs?: readonly string[],
  requireExecutable?: boolean,
) => string | undefined

/* ---------------------------------------------------------------- version */

function parseVersion(text: string): string | undefined {
  const semver = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(text)
  if (semver?.[1]) return semver[1]
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  return firstLine ? firstLine.slice(0, 120) : undefined
}

/** First non-blank line of a diagnostic, bounded so a stack cannot reach a row. */
function firstDiagnosticLine(text: string): string | undefined {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0)
  return line === undefined ? undefined : line.slice(0, 200)
}

/** One-line text for a spawn failure, without leaking a stack into a probe row. */
function probeErrorText(err: unknown): string {
  return firstDiagnosticLine(err instanceof Error ? err.message : String(err)) ?? 'spawn failed'
}

/**
 * `<exe> --version` with a hard deadline.
 *
 * Any failure (missing binary, hang, non-zero exit) yields no version — an
 * unknown version is not an error, and probe must never surface a spawn failure
 * as a bridge failure.
 *
 * STDOUT and STDERR are kept apart on purpose. They used to be concatenated and
 * fed to `parseVersion`, whose "no semver → first non-empty line" fallback then
 * published the child's ERROR TEXT as the engine's version: a GUI-launched host
 * with no `node` on PATH reported `version: "env: node: No such file or
 * directory"` for `claude`, `codex` and `codebuddy-code` while marking all three
 * available. A diagnostic is now a diagnostic (see `VersionProbeOutcome`).
 */
export const defaultVersionProbe: VersionProbe = ({ argv, env, timeoutMs }) =>
  new Promise<VersionProbeResult>((resolve) => {
    const file = argv[0]
    if (!file) {
      resolve(undefined)
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (value: VersionProbeResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof nodeSpawn>
    try {
      child = nodeSpawn(file, argv.slice(1), {
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      finish({ diagnostic: probeErrorText(err) })
      return
    }
    const stdout: string[] = []
    const stderr: string[] = []
    let collected = 0
    const collect = (into: string[]) => (buf: Buffer): void => {
      if (collected >= MAX_VERSION_CHARS) return
      const text = buf.toString('utf8')
      collected += text.length
      into.push(text)
    }
    child.stdout?.on('data', collect(stdout))
    child.stderr?.on('data', collect(stderr))
    child.on('error', (err) => finish({ diagnostic: probeErrorText(err) }))
    child.on('close', () => {
      const version = parseVersion(stdout.join(''))
      if (version !== undefined) {
        finish({ version })
        return
      }
      const diagnostic = firstDiagnosticLine(stderr.join(''))
      finish(diagnostic === undefined ? undefined : { diagnostic })
    })
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish({ diagnostic: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
  })

/* --------------------------------------------------------------- registry */

function mergeDescriptors(
  overrides: RegistryOptions['overrides'],
  extras: readonly AgentDescriptor[] | undefined,
): AgentDescriptor[] {
  const table = new Map<AgentId, AgentDescriptor>()
  for (const descriptor of BUILTIN_DESCRIPTORS) table.set(descriptor.id, descriptor)
  for (const [id, patch] of Object.entries(overrides ?? {})) {
    const existing = table.get(id)
    if (!existing) continue // an override never invents an identity
    const merged: AgentDescriptor = {
      ...existing,
      ...patch,
      command: { ...existing.command, ...(patch.command ?? {}) },
    }
    table.set(id, merged)
  }
  for (const extra of extras ?? []) table.set(extra.id, extra)
  return [...table.values()]
}

/**
 * Fold scan results into the descriptor table the registry will use.
 *
 * Built-in wins by construction: `mergeScannedIdentities` never lets a scanned
 * identity replace a built-in id, so a descriptor carrying host-verified facts
 * (the exact launcher path, `--profile autoclaw`, MiMo's `unsupported`
 * boundary) can never be weakened by a heuristic scan of the same bundle.
 */
function mergeScan(
  base: readonly AgentDescriptor[],
  scan: DesktopScanResult,
): { readonly descriptors: readonly AgentDescriptor[]; readonly shadowed: string | undefined } {
  const merged = mergeScannedIdentities(base, scan.identities)
  return { descriptors: merged.descriptors, shadowed: shadowedSummary(merged.shadowed) }
}

function upperPrefix(descriptor: AgentDescriptor): string | undefined {
  const prefix = descriptor.envPrefix
  if (!prefix) return undefined
  return prefix.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string | undefined,
): string | undefined {
  if (!key) return undefined
  const raw = env[key]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

export function createRegistry(options: RegistryOptions = {}): AgentRegistry {
  const logger = options.logger
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.probeCacheTtlMs ?? DEFAULT_PROBE_TTL_MS
  const versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS
  const resolveExecutable = options.resolveExecutable ?? makeResolver(env)
  const trackPolicyOptions: TrackPolicyOptions = options.trackPolicyOptions ?? {}
  const hostOptions: CredentialReaderOptions & ModelReaderOptions = options.hostOptions ?? {}
  const policyCache = new Map<AgentTrack, ReturnType<typeof policyFor>>()
  const probeVersion = options.probeVersion ?? defaultVersionProbe
  const descriptors = mergeDescriptors(options.overrides, options.extraDescriptors)
  const byId = new Map<AgentId, AgentDescriptor>(descriptors.map((d) => [d.id, d]))

  /**
   * Scan state. The bundle scan is a real filesystem walk, so it is NOT run at
   * construction: `createRegistry` is called during plugin apply, and a model
   * that never calls `agents_probe` must not pay for it. Instead the scan runs
   * once, lazily, on the first `probe()` after the cache is cold, and its result
   * is memoised for the lifetime of the registry — a scan is about which bundles
   * are INSTALLED, which does not change on a 60-second TTL.
   */
  const scanEnabled = options.scan !== false
  const scanOptions: ScanOptions = options.scan === false ? {} : (options.scan ?? {})
  const portExpectations = options.portExpectations ?? defaultPortExpectations()
  const portProbeEnabled = options.portProbe !== false && portExpectations.length > 0
  let scanState: { readonly descriptors: readonly AgentDescriptor[]; readonly shadowed: string | undefined } | undefined
  let scanNote: string | undefined
  let portFindings: readonly PortFinding[] = []

  /** Memoised probe results, served for `ttlMs` after the last fresh pass. */
  let cache: readonly ProbeResult[] | undefined
  let cachedAt = 0
  /**
   * The probe pass currently running, shared by concurrent callers — a bundle
   * walk plus one `--version` child per identity is not work to do twice at once
   * (MI-22). Cleared when the pass settles.
   */
  let inFlight: Promise<readonly ProbeResult[]> | undefined

  /**
   * Resolve the table this probe run should use, running the scan at most once.
   *
   * `refresh` deliberately does NOT discard the scan memo. Which app bundles are
   * INSTALLED does not change on a 60-second TTL, and the walk is synchronous
   * (`fs.readdirSync`), so re-running it on every `probe({refresh:true})` blocked
   * the event loop for up to the scan budget each time a model asked for fresh
   * version numbers — the re-run was the bug (MI-8), and it contradicted the
   * memoisation this very function is documented to provide.
   */
  function effectiveDescriptors(): readonly AgentDescriptor[] {
    if (!scanEnabled) return descriptors
    if (scanState !== undefined) return scanState.descriptors
    const scan = scanDesktopBundles(scanOptions)
    const merged = mergeScan(descriptors, scan)
    scanState = merged
    const notes: string[] = []
    if (merged.shadowed !== undefined) notes.push(merged.shadowed)
    if (scan.budgetExhausted) {
      notes.push(`[scan] wall-clock budget exhausted after ${scan.elapsedMs}ms; some bundles were not examined`)
    }
    if (merged.descriptors.length > descriptors.length) {
      const added = merged.descriptors.slice(descriptors.length).map((descriptor) => descriptor.id)
      notes.push(`[scan] added ${added.length} identity(ies) the built-in table does not name: ${added.join(', ')}`)
    }
    scanNote = notes.length > 0 ? notes.join(' ') : undefined
    return scanState.descriptors
  }

  function tableFor(id: AgentId): AgentDescriptor | undefined {
    return scanState?.descriptors.find((descriptor) => descriptor.id === id) ?? byId.get(id)
  }

  function resolve(id: AgentId): ResolvedIdentity {
    const descriptor = tableFor(id)
    if (!descriptor) {
      return {
        descriptor: { id, track: 'cli', family: 'generic', displayName: id, command: { executable: id } },
        command: { executable: id },
        track: 'cli',
        env: collectEnv(undefined, env),
        reason: `unknown agent id "${id}"`,
      }
    }

    const prefix = upperPrefix(descriptor)
    const overridePath = envValue(env, prefix ? `${prefix}_PATH` : undefined)
    const overrideModel = envValue(env, prefix ? `${prefix}_MODEL` : undefined)
    const overrideInterpreter = envValue(env, prefix ? `${prefix}_INTERPRETER` : undefined)

    // `<PREFIX>_INTERPRETER=` (empty) removes an interpreter for overrides that
    // point at a native binary; an unset variable keeps the descriptor's value.
    const rawExecutable = overridePath ?? descriptor.command.executable
    const rawInterpreter =
      overrideInterpreter ?? (prefix && env[`${prefix}_INTERPRETER`] !== undefined ? undefined : descriptor.command.interpreter)

    // The track policy owns the search path, so the lookup happens before the
    // policy runs: first with the policy's dirs, then (for a descriptor that
    // pins its own) with the descriptor's extra dirs.
    let policy = policyCache.get(descriptor.track)
    if (policy === undefined) {
      policy = policyFor(descriptor.track, trackPolicyOptions)
      policyCache.set(descriptor.track, policy)
    }
    const extraDirs = [...(descriptor.command.searchPath ?? []), ...policy.searchPath]
    // With an interpreter the target is a SCRIPT: readable is enough, and the
    // interpreter is the thing that must be executable.
    const executablePath = resolveExecutable(rawExecutable, extraDirs, rawInterpreter === undefined)
    const interpreterPath = rawInterpreter ? resolveExecutable(rawInterpreter, extraDirs, true) : undefined

    const fallbackCommand: CommandSpec = {
      executable: executablePath ?? rawExecutable,
      ...(rawInterpreter !== undefined ? { interpreter: interpreterPath ?? rawInterpreter } : {}),
      ...(descriptor.command.argsPrefix ? { argsPrefix: descriptor.command.argsPrefix } : {}),
      ...(descriptor.command.env ? { env: descriptor.command.env } : {}),
    }

    const base: ResolvedIdentity = {
      descriptor,
      command: fallbackCommand,
      env: collectEnv(descriptor, env),
      track: descriptor.track,
      ...(executablePath !== undefined ? { executablePath } : {}),
      ...(interpreterPath !== undefined ? { interpreterPath } : {}),
      ...(overrideModel !== undefined ? { model: overrideModel } : {}),
    }

    if (descriptor.unsupported) {
      return { ...base, reason: descriptor.unsupported.reason }
    }
    // The policy decides: it may repair a node shim (CLI track) or refuse
    // outright (desktop track). Unresolved paths still reach it, because the
    // policy produces the user-facing reason.
    const outcome = policy.launch({
      descriptor,
      ...(executablePath !== undefined ? { executablePath } : {}),
      ...(interpreterPath !== undefined ? { interpreterPath } : {}),
      env,
      rawExecutable,
      ...(rawInterpreter !== undefined ? { rawInterpreter } : {}),
    })
    if ('reason' in outcome) return { ...base, reason: outcome.reason }
    return { ...base, command: outcome.command }
  }

  async function probeOne(descriptor: AgentDescriptor): Promise<ProbeResult> {
    const resolved = resolve(descriptor.id)
    // Ports are swept once per probe run, before any identity is assembled, so
    // a fingerprint can be attached without each `probeOne` opening a socket.
    const portEvidence = portFindings.filter((finding) => finding.agentId === descriptor.id)
    const scannedPortNote = portNote(portEvidence)
    const baseNotes = descriptor.notes
    const combinedNotes =
      scannedPortNote === undefined ? baseNotes : baseNotes === undefined ? scannedPortNote : `${baseNotes} ${scannedPortNote}`
    const identity = {
      id: descriptor.id,
      displayName: descriptor.displayName,
      track: descriptor.track,
      family: descriptor.family,
      ...(combinedNotes !== undefined ? { notes: combinedNotes } : {}),
    }
    const capabilities = descriptor.capabilities
    // Model discovery is independent of launchability: an engine whose binary is
    // missing still has a readable catalog, and the model benefits from knowing
    // which ids exist before deciding whether to fix the install.
    const discovery = modelsFor(descriptor.id, hostOptions)
    if (resolved.reason !== undefined) {
      return {
        ...identity,
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(resolved.executablePath !== undefined ? { executable: resolved.executablePath } : {}),
        available: false,
        reason: resolved.reason,
        health: {
          launch: descriptor.unsupported === undefined ? 'missing' : 'unsupported',
          ...credentialStatusFor(descriptor.id, hostOptions),
        },
        ...modelFieldsFor(discovery),
      }
    }
    // The probe argv comes from the SAME constructor the run path uses, applied
    // to the SAME `CommandSpec` the manager hands the driver. Building it by
    // hand out of `interpreterPath` was the defect: that field is set only when
    // the DESCRIPTOR pins an interpreter, so a CLI-track shim repaired by
    // `createCliPolicy().launch()` (which writes `command.interpreter`) was
    // probed bare and died with `env: node: No such file or directory`.
    const line = buildCommandLine(resolved.command, ['--version'])
    const argv = [line.command, ...line.args]
    let version: string | undefined
    let diagnostic: string | undefined
    try {
      const outcome = await probeVersion({ argv, env: resolved.env, timeoutMs: versionTimeoutMs })
      if (typeof outcome === 'string') {
        version = outcome
      } else if (outcome !== undefined) {
        version = outcome.version
        diagnostic = outcome.diagnostic
      }
    } catch {
      // A probe implementation must never be able to fail probe().
      version = undefined
    }
    // An identity can resolve and still not answer `--version`. That is not an
    // error, but it is not silent either: the reason goes in `notes`, where it
    // is explained, rather than into `version`, where it was a lie.
    const probeNote =
      version === undefined && diagnostic !== undefined ? `[probe] --version failed: ${diagnostic}` : undefined
    const notes =
      probeNote === undefined ? combinedNotes : combinedNotes === undefined ? probeNote : `${combinedNotes} ${probeNote}`
    return {
      ...identity,
      ...(capabilities !== undefined ? { capabilities } : {}),
      available: true,
      ...(resolved.executablePath !== undefined ? { executable: resolved.executablePath } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(notes !== undefined ? { notes } : {}),
      health: { launch: 'ok', ...credentialStatusFor(descriptor.id, hostOptions) },
      ...modelFieldsFor(discovery),
    }
  }

  /**
   * Run one full probe pass: the (memoised) identity table, the port
   * fingerprint, and one `--version` per resolvable identity.
   *
   * Split out of `probe()` so the single-flight there can share exactly this
   * work between concurrent callers.
   */
  async function runProbePass(): Promise<readonly ProbeResult[]> {
    // The bundle scan runs at most ONCE per registry lifetime, before the
    // (possibly longer) identity list is assembled, so the table is complete
    // for this pass.
    const table = effectiveDescriptors()
    if (portProbeEnabled) {
      try {
        const sweep = await probePorts({
          expectations: portExpectations,
          ...(options.portConnector !== undefined ? { connect: options.portConnector } : {}),
        })
        portFindings = sweep.findings
      } catch {
        // A fingerprint is corroboration only; failing to obtain it must not
        // be able to fail the probe.
        portFindings = []
      }
    }
    const results = await Promise.all(table.map((descriptor) => probeOne(descriptor)))
    cache = results
    cachedAt = now()
    logger?.debug('probed agent identities', {
      agents: results.map((r) => `${r.id}:${r.available ? 'available' : 'unavailable'}`),
      ...(scanNote !== undefined ? { scan: scanNote } : {}),
    })
    return results
  }

  return {
    get descriptors() {
      // The scan is part of "what this host has", so it is reflected here too —
      // but only once something has asked for it (see `effectiveDescriptors`).
      return scanState?.descriptors ?? descriptors
    },
    get: (id) => tableFor(id),
    resolve,
    async probe(opts) {
      const refresh = opts?.refresh === true
      const at = now()
      if (!refresh && cache !== undefined && at - cachedAt < ttlMs) return cache
      // Single-flight (MI-22): a pass is a synchronous bundle walk, a port
      // sweep and one `--version` child per resolvable identity. Two callers
      // arriving together (the panel's refresh button plus a model's
      // `agents_probe`) used to run all of that twice; the second now joins the
      // first's promise. `inFlight` is read and assigned with no `await` in
      // between, so a concurrent caller cannot slip past it; the `finally`
      // clears it for the next pass, whoever started it.
      if (inFlight !== undefined) return inFlight
      const run = runProbePass()
      inFlight = run
      try {
        return await run
      } finally {
        if (inFlight === run) inFlight = undefined
      }
    },
    invalidate() {
      cache = undefined
      cachedAt = 0
    },
    scanDiagnostics() {
      return scanNote
    },
  }
}

function notFoundReason(
  what: 'executable' | 'interpreter',
  raw: string,
  prefix: string | undefined,
): string {
  const hint = prefix ? ` (set ${prefix}_PATH to override)` : ''
  return `${what} not found or not executable: ${raw}${hint}`
}

/** Child environment: host env plus the descriptor's fixed extras. */
function collectEnv(
  descriptor: AgentDescriptor | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') merged[key] = value
  }
  for (const [key, value] of Object.entries(descriptor?.command.env ?? {})) merged[key] = value
  return merged
}

/** Convenience for embedders that only need a logger-attached registry. */
export function createRegistryWithLogger(
  logger: BridgeLogger | undefined,
  options: Omit<RegistryOptions, 'logger'> = {},
): AgentRegistry {
  return createRegistry({ ...options, ...(logger ? { logger: childLogger(logger, 'registry') } : {}) })
}
