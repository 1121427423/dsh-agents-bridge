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
import { BUILTIN_DESCRIPTORS, policyFor, type TrackPolicyOptions } from '../tracks/index.ts'

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

/** Injectable so tests never spawn a process while probing. */
export type VersionProbe = (input: VersionProbeInput) => Promise<string | undefined>

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
}

export interface AgentRegistry {
  readonly descriptors: readonly AgentDescriptor[]
  get(id: AgentId): AgentDescriptor | undefined
  /** Resolve one identity against the host; never throws. */
  resolve(id: AgentId): ResolvedIdentity
  /** Probe every identity; `refresh: true` bypasses the TTL cache. */
  probe(opts?: { readonly refresh?: boolean }): Promise<readonly ProbeResult[]>
  invalidate(): void
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

/**
 * `<exe> --version` with a hard deadline. Any failure (missing binary, hang,
 * non-zero exit) yields `undefined` — an unknown version is not an error, and
 * probe must never surface a spawn failure as a bridge failure.
 */
export const defaultVersionProbe: VersionProbe = ({ argv, env, timeoutMs }) =>
  new Promise<string | undefined>((resolve) => {
    const file = argv[0]
    if (!file) {
      resolve(undefined)
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (value: string | undefined): void => {
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
    } catch {
      finish(undefined)
      return
    }
    const chunks: string[] = []
    let collected = 0
    const collect = (buf: Buffer): void => {
      if (collected >= MAX_VERSION_CHARS) return
      const text = buf.toString('utf8')
      collected += text.length
      chunks.push(text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => finish(undefined))
    child.on('close', () => finish(parseVersion(chunks.join(''))))
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(undefined)
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
  const policyCache = new Map<AgentTrack, ReturnType<typeof policyFor>>()
  const probeVersion = options.probeVersion ?? defaultVersionProbe
  const descriptors = mergeDescriptors(options.overrides, options.extraDescriptors)
  const byId = new Map<AgentId, AgentDescriptor>(descriptors.map((d) => [d.id, d]))

  let cache: readonly ProbeResult[] | undefined
  let cachedAt = 0

  function resolve(id: AgentId): ResolvedIdentity {
    const descriptor = byId.get(id)
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
    const identity = {
      id: descriptor.id,
      displayName: descriptor.displayName,
      track: descriptor.track,
      family: descriptor.family,
      ...(descriptor.notes !== undefined ? { notes: descriptor.notes } : {}),
    }
    const capabilities = descriptor.capabilities
    if (resolved.reason !== undefined) {
      return {
        ...identity,
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(resolved.executablePath !== undefined ? { executable: resolved.executablePath } : {}),
        available: false,
        reason: resolved.reason,
      }
    }
    const argv = [...(resolved.interpreterPath ? [resolved.interpreterPath] : []), resolved.executablePath ?? '', '--version']
    let version: string | undefined
    try {
      version = await probeVersion({ argv, env: resolved.env, timeoutMs: versionTimeoutMs })
    } catch {
      // A probe implementation must never be able to fail probe().
      version = undefined
    }
    return {
      ...identity,
      ...(capabilities !== undefined ? { capabilities } : {}),
      available: true,
      ...(resolved.executablePath !== undefined ? { executable: resolved.executablePath } : {}),
      ...(version !== undefined ? { version } : {}),
    }
  }

  return {
    descriptors,
    get: (id) => byId.get(id),
    resolve,
    async probe(opts) {
      const refresh = opts?.refresh === true
      const at = now()
      if (!refresh && cache !== undefined && at - cachedAt < ttlMs) return cache
      const results = await Promise.all(descriptors.map((descriptor) => probeOne(descriptor)))
      cache = results
      cachedAt = now()
      logger?.debug('probed agent identities', {
        agents: results.map((r) => `${r.id}:${r.available ? 'available' : 'unavailable'}`),
      })
      return results
    },
    invalidate() {
      cache = undefined
      cachedAt = 0
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
