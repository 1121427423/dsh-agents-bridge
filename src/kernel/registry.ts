/**
 * Identity registry: the built-in descriptor table plus `probe()`.
 *
 * "Add a CLI" must stay a data change (design goal 3), so every host fact that
 * distinguishes one engine from another lives in this table: the executable,
 * the optional interpreter, fixed argv, the `<PREFIX>_PATH` / `<PREFIX>_MODEL`
 * override prefix, and — for engines that cannot be driven at all — an explicit
 * `unsupported` reason.
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
  BridgeLogger,
  CommandSpec,
  ProbeResult,
} from './types.ts'
import { childLogger } from './logger.ts'

/**
 * WorkBuddy ships the CodeBuddy CLI as a `#!/usr/bin/env node` script while
 * `node` is NOT on PATH on the target machine (verified: `env: node: No such
 * file or directory`). Hence the explicit interpreter — see design doc §4.
 */
const WORKBUDDY_CLI =
  '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const AUTOCLAW_ENGINE =
  '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs'
/** Homebrew node: the interpreter both bundled engines need. */
const BUNDLED_NODE = '/opt/homebrew/bin/node'

const DEFAULT_PROBE_TTL_MS = 60_000
const DEFAULT_VERSION_TIMEOUT_MS = 3_000
const MAX_VERSION_CHARS = 4096

/**
 * The built-in identities. Order matters only for `probe()` output ordering.
 *
 * `generic` intentionally ships a placeholder executable: the caller points it
 * at a real CLI with `GENERIC_PATH` (the fallback path from multica's
 * `qwen.go`-style one-shot argv drivers). Resolving it to something that could
 * accidentally exist (`sh`) would make probe lie about availability.
 */
export const BUILTIN_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    id: 'claude',
    family: 'claude',
    displayName: 'Claude Code',
    command: { executable: 'claude' },
    envPrefix: 'CLAUDE',
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
  },
  {
    id: 'workbuddy',
    family: 'codebuddy',
    displayName: 'WorkBuddy (bundled CodeBuddy CLI)',
    command: { executable: WORKBUDDY_CLI, interpreter: BUNDLED_NODE },
    envPrefix: 'WORKBUDDY',
    capabilities: { resume: true, model: true, effort: true, mcpConfig: true },
  },
  {
    id: 'autoclaw',
    family: 'openclaw',
    displayName: 'AutoClaw (bundled OpenClaw engine)',
    command: { executable: AUTOCLAW_ENGINE, interpreter: BUNDLED_NODE, argsPrefix: ['agent'] },
    envPrefix: 'AUTOCLAW',
    capabilities: { resume: true, model: true },
  },
  {
    id: 'openclaw',
    family: 'openclaw',
    displayName: 'OpenClaw CLI (on PATH)',
    command: { executable: 'openclaw', argsPrefix: ['agent'] },
    envPrefix: 'OPENCLAW',
    capabilities: { resume: true, model: true },
  },
  {
    id: 'generic',
    family: 'generic',
    displayName: 'Generic agent CLI (set GENERIC_PATH)',
    command: { executable: 'agent-cli' },
    envPrefix: 'GENERIC',
    capabilities: { model: true },
  },
  {
    id: 'mimo',
    family: 'generic',
    displayName: 'MiMo (sealed desktop app)',
    command: { executable: 'mimo' },
    envPrefix: 'MIMO',
    unsupported: {
      reason:
        'MiMo keeps its agent loop inside app.asar and exposes no CLI, ACP endpoint or daemon socket, so it cannot be driven by the bridge (design doc D8).',
    },
  },
]

/** One identity with every host-dependent value resolved. */
export interface ResolvedIdentity {
  readonly descriptor: AgentDescriptor
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
  /** Injectable executable resolver (defaults to PATH + filesystem lookup). */
  readonly resolveExecutable?: (raw: string) => string | undefined
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

/** Expand a leading `~` without touching the rest of the path. */
function expandHome(raw: string): string {
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

function makeResolver(env: Readonly<Record<string, string | undefined>>): (raw: string) => string | undefined {
  const searchPath = env['PATH'] ?? ''
  return (raw: string): string | undefined => {
    const candidate = expandHome(raw)
    if (candidate === '' || candidate.includes(path.sep)) {
      const abs = path.resolve(candidate)
      return isExecutableFile(abs) ? abs : undefined
    }
    for (const dir of searchPath.split(path.delimiter)) {
      // An empty PATH entry means "current directory" by POSIX convention.
      const base = dir === '' ? '.' : expandHome(dir)
      const abs = path.resolve(base, candidate)
      if (isExecutableFile(abs)) return abs
    }
    return undefined
  }
}

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
  const probeVersion = options.probeVersion ?? defaultVersionProbe
  const descriptors = mergeDescriptors(options.overrides, options.extraDescriptors)
  const byId = new Map<AgentId, AgentDescriptor>(descriptors.map((d) => [d.id, d]))

  let cache: readonly ProbeResult[] | undefined
  let cachedAt = 0

  function resolve(id: AgentId): ResolvedIdentity {
    const descriptor = byId.get(id)
    if (!descriptor) {
      return {
        descriptor: { id, family: 'generic', displayName: id, command: { executable: id } },
        command: { executable: id },
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

    const executablePath = resolveExecutable(rawExecutable)
    const interpreterPath = rawInterpreter ? resolveExecutable(rawInterpreter) : undefined

    const command: CommandSpec = {
      executable: executablePath ?? rawExecutable,
      ...(rawInterpreter !== undefined ? { interpreter: interpreterPath ?? rawInterpreter } : {}),
      ...(descriptor.command.argsPrefix ? { argsPrefix: descriptor.command.argsPrefix } : {}),
      ...(descriptor.command.env ? { env: descriptor.command.env } : {}),
    }

    const base: ResolvedIdentity = {
      descriptor,
      command,
      env: collectEnv(descriptor, env),
      ...(executablePath !== undefined ? { executablePath } : {}),
      ...(interpreterPath !== undefined ? { interpreterPath } : {}),
      ...(overrideModel !== undefined ? { model: overrideModel } : {}),
    }

    if (descriptor.unsupported) {
      return { ...base, reason: descriptor.unsupported.reason }
    }
    if (!executablePath) {
      return { ...base, reason: notFoundReason('executable', rawExecutable, prefix) }
    }
    if (rawInterpreter && !interpreterPath) {
      return { ...base, reason: notFoundReason('interpreter', rawInterpreter, prefix) }
    }
    return base
  }

  async function probeOne(descriptor: AgentDescriptor): Promise<ProbeResult> {
    const resolved = resolve(descriptor.id)
    const identity = {
      id: descriptor.id,
      displayName: descriptor.displayName,
      family: descriptor.family,
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
