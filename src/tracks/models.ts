/**
 * dsh-agents-bridge / tracks/models — "which model ids will this engine accept?".
 *
 * Decision D20: the bridge never asks an engine for its model list at probe
 * time (that would be a network call, or a nested agent run). It reads the
 * catalog each engine already keeps on this host:
 *
 *   | engine    | local catalog                                                            |
 *   |-----------|--------------------------------------------------------------------------|
 *   | claude    | `~/.claude/settings.json` → `env.*_MODEL`                                 |
 *   | codex     | `~/.codex/config.toml` → `model_catalog_json` → that JSON's `models[].slug`, |
 *   |           | falling back to the single `model = "..."` line                           |
 *   | codebuddy-code | `~/.codebuddy/models.json` → `models[].id` — a user-level cache that is  |
 *   |           | EMPTY on the target machine, so the honest answer is "not discovered"    |
 *   | workbuddy | `~/.workbuddy/cache/acc-product-config-v3.json` → `models[].id`            |
 *   | autoclaw  | `~/.openclaw-autoclaw/openclaw.json` → `models.providers.<p>.models[].id`  |
 *   | openclaw  | none (the CLI resolves models from its profile at run time)               |
 *   | mimo      | none (sealed desktop app, D8)                                             |
 *
 * ABSENT IS NOT NONE. `{ discovered: false, reason }` means "no local catalog
 * was found" — the engine may still accept any id its upstream knows. A
 * discovered-but-empty catalog is `{ discovered: true, models: [] }` and is a
 * different statement. `modelFieldsFor()` keeps the two apart in `ProbeResult`
 * by omitting `models` entirely in the first case.
 *
 * One deliberate exception, for a source that is a user CACHE rather than a
 * catalog: codebuddy-code's `~/.codebuddy/models.json` is empty on this host
 * while the engine's own `--help` advertises 18 ids, so an empty array is
 * reported as "not discovered" WITH its reason — `models: []` there would tell
 * the model the engine accepts no model at all.
 *
 * Two host facts are load-bearing and documented where they are handled:
 *
 *  - claude's `[1m]` suffix is a 1M-context VARIANT MARKER appended by that
 *    CLI, not part of the model id (`deepseek-v4-flash[1m]` → `deepseek-v4-flash`),
 *  - codex's TOML is read with tight line regexes over the ROOT table only. No
 *    hand-rolled TOML parser: multiline strings, inline tables and arrays are
 *    not supported, and a key that appears inside `[table]` is ignored.
 *
 * Reads go through `./host-files.ts`, so paths, ENOENT/EACCES wording and
 * redaction behave exactly as they do for the credential reader.
 *
 * @module dsh-agents-bridge/tracks/models
 */

import os from 'node:os'
import path from 'node:path'

import type { AgentId } from '../kernel/types.ts'
import {
  asArray,
  asRecord,
  expandHome,
  homeRelative,
  oneLine,
  parseJsonObject,
  readHostFile,
  redactSecrets,
  type HostFileOptions,
} from './host-files.ts'

export interface ModelReaderOptions extends HostFileOptions {
  /**
   * Override the engine's PRIMARY config file (absolute, or starting with `~`):
   * claude → `settings.json`, codex → `config.toml`,
   * workbuddy → `acc-product-config-v3.json`, autoclaw/openclaw → `openclaw.json`.
   */
  readonly path?: string
}

/* ---------------------------------------------------------------- results */

export interface ModelFound {
  readonly discovered: true
  /** De-duplicated, catalog order preserved. Empty means "declares none". */
  readonly models: readonly string[]
  /** One line for `ProbeResult.modelsSource`: where the ids came from. */
  readonly source: string
  /**
   * id → credit multiplier as the catalog spells it (`"x0.21"`). WorkBuddy is
   * the only engine that carries one; absent when the catalog has no such field.
   * Informational — the bridge never does arithmetic on it.
   */
  readonly creditMultipliers?: Readonly<Record<string, string>>
}

export interface ModelNotDiscovered {
  readonly discovered: false
  /**
   * Why nothing was found. NOT "the engine has no models" — say this out loud
   * when surfacing it, so the model does not over-read the absence.
   */
  readonly reason: string
}

export type ModelDiscovery = ModelFound | ModelNotDiscovered

/** The `ProbeResult` fields a discovery maps onto, ready to spread. */
export function modelFieldsFor(
  discovery: ModelDiscovery,
): { readonly models?: readonly string[]; readonly modelsSource?: string } {
  // Deliberately omitted when nothing was discovered: `models: []` would claim
  // the engine accepts no model at all, which is a stronger and falser statement.
  return discovery.discovered ? { models: discovery.models, modelsSource: discovery.source } : {}
}

/* --------------------------------------------------------- id normalising */

/**
 * A trailing bracketed context marker, e.g. the `[1m]` this host's `claude`
 * writes for `deepseek-v4-flash[1m]` / `ox-alpha-free[1m]` / `mimo-v2.5[1m]`.
 * It selects a 1M-token context variant INSIDE that CLI; it is not part of the
 * id an upstream accepts, so it is stripped before reporting.
 */
const CONTEXT_MARKER = /\s*\[\d+[kKmM]?\]\s*$/

/** Strip a trailing `[1m]`-style context marker. */
export function stripContextMarker(id: string): string {
  return id.replace(CONTEXT_MARKER, '').trim()
}

/** A catalog field that is a display label, never an id. */
const MODEL_DISPLAY_NAME = /_MODEL_NAME$/

/** Model-id fields `~/.claude/settings.json` writes, in priority order. */
export const CLAUDE_MODEL_FIELDS: readonly string[] = [
  'OPEN_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

/** Strip markers, drop non-strings/empties, de-duplicate, keep catalog order. */
export function collectModelIds(values: Iterable<unknown>): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const id = stripContextMarker(value)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function idCount(count: number): string {
  return `${count} ${count === 1 ? 'id' : 'ids'}`
}

/* ------------------------------------------------------------ pure parses */

export interface ParsedCatalog {
  readonly ok: true
  readonly ids: readonly string[]
  /** id → credit multiplier, when the catalog carries one (WorkBuddy). */
  readonly credits?: Readonly<Record<string, string>>
  /** Provider sections the ids came from, in file order (OpenClaw-shaped catalogs). */
  readonly providers?: readonly string[]
}

export interface CatalogFailure {
  readonly ok: false
  /** A fragment: the caller prefixes the file it belongs to. */
  readonly reason: string
}

export type CatalogParse = ParsedCatalog | CatalogFailure

/** `~/.claude/settings.json` → `env.*_MODEL`. */
export function claudeModelIdsFromSettings(contents: string): CatalogParse {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return { ok: false, reason: parsed.detail }
  const env = asRecord(parsed.value['env'])
  if (env === undefined) return { ok: false, reason: 'no "env" object' }

  const values: unknown[] = CLAUDE_MODEL_FIELDS.map((field) => env[field])
  // Any other `*_MODEL` key is picked up too, so a future CLI field is not
  // silently invisible. `*_MODEL_NAME` holds a display label ("OX Alpha") and is
  // excluded by the anchored pattern.
  for (const key of Object.keys(env).sort()) {
    if (!/_MODEL$/.test(key) || MODEL_DISPLAY_NAME.test(key)) continue
    if (CLAUDE_MODEL_FIELDS.includes(key)) continue
    values.push(env[key])
  }

  const ids = collectModelIds(values)
  if (ids.length === 0) return { ok: false, reason: 'no *_MODEL field under env' }
  return { ok: true, ids }
}

/** What `~/.codex/config.toml` says that this reader needs. */
export interface CodexConfigSummary {
  /** `model_catalog_json`, verbatim (may be `~`-prefixed or relative). */
  readonly catalogPath?: string
  /** `model`, the single configured model. */
  readonly model?: string
  /** `model_provider`, used for the source line only. */
  readonly provider?: string
}

const TOML_TABLE_HEADER = /^\[/
const TOML_KEY_VALUE = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/

/**
 * Tight line-based TOML reader: the ROOT table only.
 *
 * Limits, on purpose (documented rather than discovered): no multiline strings,
 * no inline tables, no arrays, no dotted keys; a key inside `[section]` is
 * ignored because the root table ends at the first header. Only three string
 * keys are wanted, and a hand-rolled TOML parser is not a dependency this
 * bridge is willing to carry.
 *
 * `model_providers.*.base_url` is deliberately NOT read even though it is right
 * there: a URL can carry userinfo (`https://user:pass@host`), and the provider
 * NAME is all the source line needs.
 */
export function parseCodexConfig(contents: string): CodexConfigSummary {
  let catalogPath: string | undefined
  let model: string | undefined
  let provider: string | undefined

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (TOML_TABLE_HEADER.test(line)) break
    const match = TOML_KEY_VALUE.exec(line)
    if (match === null) continue
    const key = match[1]
    if (key === undefined) continue
    const value = tomlStringValue(match[2] ?? '')
    if (value === undefined) continue
    if (key === 'model' && model === undefined) model = value
    else if (key === 'model_catalog_json' && catalogPath === undefined) catalogPath = value
    else if (key === 'model_provider' && provider === undefined) provider = value
  }

  return {
    ...(catalogPath !== undefined ? { catalogPath } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
  }
}

function tomlStringValue(raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    // Stop at the matching quote so an embedded `#` (a path, a comment-looking id)
    // survives; an unterminated string is treated as absent.
    const end = text.indexOf(quote, 1)
    return end > 0 ? text.slice(1, end) : undefined
  }
  const withoutComment = text.replace(/\s+#.*$/, '').trim()
  return withoutComment === '' ? undefined : withoutComment
}

/** Resolve `model_catalog_json`: `~` against home, relative against the config's dir. */
export function resolveCodexCatalogPath(raw: string, home: string, configDir: string): string {
  const expanded = expandHome(raw.trim(), home)
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(configDir, expanded)
}

/** `~/.codex/models.json` → `models[].slug`. */
export function codexCatalogModelIds(contents: string): CatalogParse {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return { ok: false, reason: parsed.detail }
  const models = asArray(parsed.value['models'])
  if (models === undefined) return { ok: false, reason: 'no "models" array' }
  const ids = collectModelIds(models.map((entry) => asRecord(entry)?.['slug'] ?? asRecord(entry)?.['id']))
  return { ok: true, ids }
}

/**
 * `~/.workbuddy/cache/acc-product-config-v3.json` → `models[].id`.
 *
 * Verified shape (51 entries): `{ models: [{ id, name, credits, vendor,
 * isDefault, maxInputTokens, ... }] }`. `credits` is the credit multiplier as a
 * string (`"x0.21"`); it is returned, never computed on.
 */
export function workbuddyModelsFromConfig(contents: string): CatalogParse {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return { ok: false, reason: parsed.detail }
  const models = asArray(parsed.value['models'])
  if (models === undefined) return { ok: false, reason: 'no "models" array' }

  const ids = collectModelIds(models.map((entry) => asRecord(entry)?.['id']))
  const credits: Record<string, string> = {}
  for (const entry of models) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const id = typeof record['id'] === 'string' ? stripContextMarker(record['id']) : ''
    const credit = record['credits']
    if (id === '' || typeof credit !== 'string' || credit.trim() === '') continue
    if (!(id in credits)) credits[id] = credit.trim()
  }

  return Object.keys(credits).length > 0 ? { ok: true, ids, credits } : { ok: true, ids }
}

/**
 * OpenClaw-shaped config (`~/.openclaw-autoclaw/openclaw.json`, and the same
 * shape if the CLI profile ever grows one) → `models.providers.<p>.models[].id`.
 *
 * Verified shape: one provider `zai` with 6 entries `{ id, name, contextWindow,
 * maxTokens, reasoning, cost, compat, input, headers }`. Only `id` is read:
 * `headers` carries a bearer token on this host, and it stays untouched.
 */
export function openclawModelsFromConfig(contents: string): CatalogParse {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return { ok: false, reason: parsed.detail }
  const providers = asRecord(asRecord(parsed.value['models'])?.['providers'])
  if (providers === undefined) return { ok: false, reason: 'no models.providers object' }

  const ids: string[] = []
  const names: string[] = []
  for (const name of Object.keys(providers)) {
    const provider = asRecord(providers[name])
    const models = asArray(provider?.['models'])
    if (provider === undefined || models === undefined) continue
    names.push(name)
    for (const id of collectModelIds(models.map((entry) => asRecord(entry)?.['id']))) ids.push(id)
  }
  return { ok: true, ids: collectModelIds(ids), providers: names }
}

/**
 * `~/.codebuddy/models.json` → `models[].id`.
 *
 * NOT a product catalog, and that is the whole point. On the target machine the
 * file is 19 bytes of `{"models": []}`, written by the CLI itself, and the
 * engine still advertises 18 selectable ids in its own `--help` and resolves
 * more from the account. An empty array here therefore means "nothing
 * discoverable", never "this engine accepts no model": reporting
 * `{ discovered: true, models: [] }` would make `ProbeResult.models` say
 * something false and stronger than the evidence. Same precedent as claude's
 * "no `*_MODEL` field under env" — a source that is present but says nothing is
 * a discovery failure, not an empty catalog.
 */
export function codebuddyCodeModelsFromConfig(contents: string): CatalogParse {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return { ok: false, reason: parsed.detail }
  const models = asArray(parsed.value['models'])
  if (models === undefined) return { ok: false, reason: 'no "models" array' }
  const ids = collectModelIds(models.map((entry) => asRecord(entry)?.['id']))
  if (ids.length === 0) {
    return {
      ok: false,
      reason: 'empty "models" array: a user-level cache, not the ids the CLI accepts (it advertises those in --help)',
    }
  }
  return { ok: true, ids }
}

/* ------------------------------------------------------------ orchestration */

function notDiscovered(reason: string): ModelNotDiscovered {
  return { discovered: false, reason: redactSecrets(oneLine(`not discovered: ${reason}`)) }
}

function discoveredIds(
  ids: readonly string[],
  source: string,
  credits?: Readonly<Record<string, string>>,
): ModelFound {
  return {
    discovered: true,
    models: ids,
    source: oneLine(source),
    ...(credits !== undefined && Object.keys(credits).length > 0 ? { creditMultipliers: credits } : {}),
  }
}

/** claude: `env.*_MODEL`, with the `[1m]` context marker stripped. */
function claudeModels(home: string, options: ModelReaderOptions): ModelDiscovery {
  const absolute = options.path !== undefined ? expandHome(options.path, home) : path.join(home, '.claude', 'settings.json')
  const display = homeRelative(absolute, home)
  const read = readHostFile(absolute, options)
  if (!read.ok) return notDiscovered(`${display} ${read.detail}`)

  const parsed = claudeModelIdsFromSettings(read.contents)
  if (!parsed.ok) return notDiscovered(`${display}: ${parsed.reason}`)
  return discoveredIds(parsed.ids, `${display} env (${idCount(parsed.ids.length)})`)
}

/**
 * codex: the JSON catalog `config.toml` points at, else the single `model` line.
 *
 * A catalog that is PRESENT but empty is reported as-is (none). The fallback is
 * for a catalog that is absent, unreadable, malformed or not declared at all.
 */
function codexModels(home: string, options: ModelReaderOptions): ModelDiscovery {
  const configPath = options.path !== undefined ? expandHome(options.path, home) : path.join(home, '.codex', 'config.toml')
  const display = homeRelative(configPath, home)
  const read = readHostFile(configPath, options)
  if (!read.ok) return notDiscovered(`${display} ${read.detail}`)

  const config = parseCodexConfig(read.contents)
  const provider = config.provider === undefined ? '' : `; provider ${config.provider}`

  if (config.catalogPath !== undefined) {
    const catalogPath = resolveCodexCatalogPath(config.catalogPath, home, path.dirname(configPath))
    const catalogDisplay = homeRelative(catalogPath, home)
    const catalogRead = readHostFile(catalogPath, options)
    if (catalogRead.ok) {
      const parsed = codexCatalogModelIds(catalogRead.contents)
      if (parsed.ok) {
        return discoveredIds(parsed.ids, `${catalogDisplay} (${idCount(parsed.ids.length)}${provider})`)
      }
      return codexFallback(config, display, provider, `${catalogDisplay}: ${parsed.reason}`)
    }
    return codexFallback(config, display, provider, `${catalogDisplay} ${catalogRead.detail}`)
  }
  return codexFallback(config, display, provider, undefined)
}

function codexFallback(
  config: CodexConfigSummary,
  display: string,
  provider: string,
  catalogNote: string | undefined,
): ModelDiscovery {
  if (config.model === undefined) {
    return notDiscovered(
      catalogNote === undefined
        ? `${display}: no model_catalog_json and no model = "..." line`
        : `${display}: ${catalogNote}; no model = "..." line to fall back to`,
    )
  }
  const ids = collectModelIds([config.model])
  if (ids.length === 0) return notDiscovered(`${display}: empty model = "..." line`)
  const note = catalogNote === undefined ? '' : `; ${catalogNote}`
  return discoveredIds(ids, `${display} model (${idCount(ids.length)}${provider}${note})`)
}

/**
 * workbuddy / workbuddy-ai: the app's own product-config cache.
 *
 * The two WorkBuddy desktop builds ship a byte-identical CLI and differ only in
 * `cli/product.json` `dataFolderName`, so the SAME parser reads a different home:
 * `.workbuddy` for the domestic build, `.workbuddy-ai` for the international one.
 * The catalogs really are different (51 domestic ids vs 22 international ids,
 * with `deepseek-v4.1-flash-sg`, `gpt-6-astra` and `gemini-3.5-flash` only in the
 * international build), so this is two readers sharing one parser — not one
 * reader with two names.
 */
function workbuddyModels(home: string, options: ModelReaderOptions, folder = '.workbuddy'): ModelDiscovery {
  const absolute =
    options.path !== undefined
      ? expandHome(options.path, home)
      : path.join(home, folder, 'cache', 'acc-product-config-v3.json')
  const display = homeRelative(absolute, home)
  const read = readHostFile(absolute, options)
  if (!read.ok) return notDiscovered(`${display} ${read.detail}`)

  const parsed = workbuddyModelsFromConfig(read.contents)
  if (!parsed.ok) return notDiscovered(`${display}: ${parsed.reason}`)
  return discoveredIds(parsed.ids, `${display} models (${idCount(parsed.ids.length)})`, parsed.credits)
}

/** autoclaw: the engine reads the `autoclaw` profile, so that is the file read here. */
function autoclawModels(home: string, options: ModelReaderOptions): ModelDiscovery {
  return openclawShapedModels(home, options, path.join(home, '.openclaw-autoclaw', 'openclaw.json'))
}

/**
 * openclaw on the CLI track: the default profile's config, if it ever has a
 * catalog. Verified on this host: `~/.openclaw/openclaw.json` holds
 * `mcpServers` only, so the honest answer is "not discovered" — never `[]`.
 */
function openclawModels(home: string, options: ModelReaderOptions): ModelDiscovery {
  return openclawShapedModels(
    home,
    options,
    path.join(home, '.openclaw', 'openclaw.json'),
    'the openclaw CLI resolves models from its own profile/session at run time',
  )
}

function openclawShapedModels(
  home: string,
  options: ModelReaderOptions,
  defaultPath: string,
  absenceNote?: string,
): ModelDiscovery {
  const absolute = options.path !== undefined ? expandHome(options.path, home) : defaultPath
  const display = homeRelative(absolute, home)
  const note = absenceNote === undefined ? '' : `; ${absenceNote}`
  const read = readHostFile(absolute, options)
  if (!read.ok) return notDiscovered(`${display} ${read.detail}${note}`)

  const parsed = openclawModelsFromConfig(read.contents)
  if (!parsed.ok) return notDiscovered(`${display}: ${parsed.reason}${note}`)
  const providers = parsed.providers ?? []
  const section = providers.length > 0 ? `.${providers.join(',')}` : ''
  return discoveredIds(parsed.ids, `${display} models.providers${section} (${idCount(parsed.ids.length)})`)
}

/**
 * codebuddy-code: `~/.codebuddy/models.json`, read as a cache rather than as a
 * catalog. See `codebuddyCodeModelsFromConfig` for why an empty array is
 * reported as "not discovered" instead of "declares none".
 */
function codebuddyCodeModels(home: string, options: ModelReaderOptions): ModelDiscovery {
  const absolute =
    options.path !== undefined ? expandHome(options.path, home) : path.join(home, '.codebuddy', 'models.json')
  const display = homeRelative(absolute, home)
  const read = readHostFile(absolute, options)
  if (!read.ok) return notDiscovered(`${display} ${read.detail}`)

  const parsed = codebuddyCodeModelsFromConfig(read.contents)
  if (!parsed.ok) return notDiscovered(`${display}: ${parsed.reason}`)
  return discoveredIds(parsed.ids, `${display} models (${idCount(parsed.ids.length)})`)
}

/**
 * Model discovery for one identity. The single place an agent id maps to a
 * catalog file — the registry stays id-agnostic and just asks.
 */
export function modelsFor(agentId: AgentId, options: ModelReaderOptions = {}): ModelDiscovery {
  const home = options.home ?? os.homedir()
  switch (agentId) {
    case 'claude':
      return claudeModels(home, options)
    case 'codex':
      return codexModels(home, options)
    case 'codebuddy-code':
      return codebuddyCodeModels(home, options)
    case 'workbuddy':
      return workbuddyModels(home, options)
    case 'workbuddy-ai':
      return workbuddyModels(home, options, '.workbuddy-ai')
    case 'autoclaw':
      return autoclawModels(home, options)
    case 'openclaw':
      return openclawModels(home, options)
    case 'mimo':
      return notDiscovered('MiMo is a sealed desktop app (D8): no CLI and no local model catalog')
    default:
      return notDiscovered(`no local model catalog reader is registered for identity "${agentId}"`)
  }
}

/**
 * Compact `id=credits` summary for `ProbeResult.notes` (WorkBuddy only).
 * Returns `undefined` when the catalog carried no multiplier at all.
 */
export function creditSummary(discovery: ModelDiscovery, limit = 6): string | undefined {
  if (!discovery.discovered) return undefined
  const credits = discovery.creditMultipliers
  if (credits === undefined) return undefined
  const entries = Object.entries(credits)
  if (entries.length === 0) return undefined
  const head = entries
    .slice(0, limit)
    .map(([id, value]) => `${id}=${value}`)
    .join(', ')
  return entries.length > limit ? `${head} (+${entries.length - limit} more)` : head
}
