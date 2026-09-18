/**
 * dsh-agents-bridge / tracks/health — "does a credential appear to exist?".
 *
 * Each engine keeps its OWN credential and the bridge never holds, forwards or
 * prints one (docs/design-tracks.md §4). These readers answer exactly one
 * question per identity, from local FILES only:
 *
 *   - no network call, ever. `agents_probe` is called from a model-facing tool
 *     and has to stay cheap and silent; a 401 is something only a real run can
 *     discover, so "present" is reported as present, not as valid.
 *   - no credential VALUE in the result, not even a prefix. The readers decide
 *     *whether a field is set*, never *what it is*; the returned object carries
 *     a status word, a one-line reason and the config path.
 *   - a missing, unreadable or malformed file returns `missing` / `unknown` with
 *     a one-line detail. Nothing here throws.
 *
 * Status vocabulary (the meaning `AgentHealth.credential` already documents):
 *
 *   | status           | when                                                       |
 *   |------------------|------------------------------------------------------------|
 *   | `ok`             | a credential field is set and is not an obvious placeholder |
 *   | `missing`        | no credential field, only a placeholder, or no readable file |
 *   | `unknown`        | the file exists but its shape is not recognised             |
 *   | `invalid`        | never produced here: only a real run can observe a rejection |
 *   | `not-applicable` | a desktop app's own login is reused (WorkBuddy, AutoClaw, MiMo) |
 *
 * `ok` means "a credential appears to exist", nothing stronger; the detail line
 * says so in words. `unknown` is what remains when the evidence itself is
 * unusable (a config file that is not JSON, an identity with no reader).
 *
 * @module dsh-agents-bridge/tracks/health
 */

import os from 'node:os'
import path from 'node:path'

import type { AgentHealth, AgentId } from '../kernel/types.ts'
import {
  asRecord,
  expandHome,
  oneLine,
  parseJsonObject,
  readHostFile,
  redactSecrets,
  type HostFileOptions,
} from './host-files.ts'

/** The credential half of `AgentHealth`, ready to spread next to `launch`. */
export interface CredentialHealth {
  readonly credential: AgentHealth['credential']
  readonly detail: string
  readonly configPath?: string
}

export interface CredentialReaderOptions extends HostFileOptions {
  /**
   * Override the config file this identity's status is derived from
   * (absolute, or starting with `~`). Defaults to the engine's own file, so the
   * registry normally passes nothing.
   */
  readonly path?: string
}

/* --------------------------------------------------------------- fragments */

/**
 * THE redaction choke point: every fragment this module returns is built here,
 * so no detail can leave without being collapsed to one line and stripped of
 * credential-looking substrings.
 */
function fragment(
  credential: AgentHealth['credential'],
  detail: string,
  configPath?: string,
): CredentialHealth {
  const base: CredentialHealth = { credential, detail: redactSecrets(oneLine(detail)) }
  return configPath === undefined ? base : { ...base, configPath }
}

/* -------------------------------------------------------- field inspection */

/** What one credential-looking field in a config file turned out to be. */
type FieldState = 'set' | 'placeholder' | 'empty'

interface FieldSurvey {
  /** Fields whose value is a non-empty, non-placeholder string. */
  readonly set: readonly string[]
  /** Fields whose value is the shape of a placeholder ("sk-ant-YOUR_..."). */
  readonly placeholder: readonly string[]
}

/**
 * Shapes that are NOT credentials. The first entry is verified on this host:
 * `~/.claude/settings.json` carries `ANTHROPIC_API_KEY=sk-ant-YOUR_...`, and a
 * probe that called that a usable credential would be lying to the model.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^\s*$/, // empty / whitespace only
  /^sk-ant-YOUR_/i, // verified placeholder on the target machine
  /<[^>]*>/, // <your-api-key>
  // A stand-in WORD used as (or inside) the value: "YOUR_API_KEY_HERE",
  // "my-token", "changeme". The explicit non-alphanumeric lookaround is what
  // keeps a random key such as "...-FAKEKEY0000" (where "fake" runs straight
  // into "key") out of this rule.
  /(?:^|[^A-Za-z0-9])(?:your|my|fake|dummy|sample|example|placeholder|replace|change|insert|paste|todo|changeme)(?:[^A-Za-z0-9]|$)/i,
  /^(?:x{4,}|\.{3,}|-{4,}|_{4,})$/i,
  /^(?:none|null|undefined|todo|changeme|redacted|secret)$/i,
]

/** Does this value look like a stand-in rather than a credential? */
export function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()))
}

function fieldState(value: unknown): FieldState {
  if (typeof value !== 'string') return 'empty'
  const trimmed = value.trim()
  if (trimmed === '') return 'empty'
  return looksLikePlaceholder(trimmed) ? 'placeholder' : 'set'
}

/**
 * Classify the named fields of one JSON object. Only FIELD NAMES travel from
 * here — this function is where the rule "never return a credential" is kept.
 */
function surveyFields(record: Record<string, unknown>, fields: readonly string[]): FieldSurvey {
  const set: string[] = []
  const placeholder: string[] = []
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue
    const state = fieldState(record[field])
    if (state === 'set') set.push(field)
    else if (state === 'placeholder') placeholder.push(field)
  }
  return { set, placeholder }
}

function presentDetail(file: string, where: string, names: readonly string[], note = ''): string {
  const scope = where === '' ? file : `${file} ${where}`
  const suffix = note === '' ? '' : ` ${note}`
  return `${scope}: ${names.join(', ')} set (presence only; no network check)${suffix}`
}

function placeholderDetail(file: string, where: string, names: readonly string[]): string {
  const scope = where === '' ? file : `${file} ${where}`
  return `${scope}: ${names.map((name) => `${name} is a placeholder`).join('; ')}`
}

/** `CLAUDE_CODE_USE_OPENAI=1` / `true` / `yes` / `on`. The value never travels. */
function isTruthyFlag(value: unknown): boolean {
  if (typeof value !== 'string') return value === true
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/* ------------------------------------------------------------- claude CLI */

/** Credential fields `~/.claude/settings.json` keeps under `env`, in priority order. */
export const CLAUDE_CREDENTIAL_FIELDS: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]

/**
 * `~/.claude/settings.json` → the `env` object.
 *
 * On this host the CLI runs in OpenAI-compatible mode
 * (`CLAUDE_CODE_USE_OPENAI=1`, `OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`),
 * so `OPENAI_API_KEY` is the credential in play; the `ANTHROPIC_API_KEY` beside
 * it is the verified `sk-ant-YOUR_...` placeholder and is deliberately not
 * counted as one.
 */
export function credentialFromClaudeSettings(contents: string, absolutePath: string): CredentialHealth {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return fragment('unknown', `settings.json: ${parsed.detail}`, absolutePath)

  const env = asRecord(parsed.value['env'])
  if (env === undefined) {
    return fragment('missing', 'settings.json has no "env" object to read a credential from', absolutePath)
  }

  const survey = surveyFields(env, CLAUDE_CREDENTIAL_FIELDS)
  if (survey.set.length > 0) {
    const mode = isTruthyFlag(env['CLAUDE_CODE_USE_OPENAI']) ? ' [CLAUDE_CODE_USE_OPENAI]' : ''
    return fragment('ok', presentDetail('settings.json', 'env', survey.set, mode), absolutePath)
  }
  if (survey.placeholder.length > 0) {
    return fragment('missing', placeholderDetail('settings.json', 'env', survey.placeholder), absolutePath)
  }
  return fragment(
    'missing',
    `settings.json env declares no usable credential (none of ${CLAUDE_CREDENTIAL_FIELDS.join(' / ')} is set)`,
    absolutePath,
  )
}

/* -------------------------------------------------------------- codex CLI */

/** Codex keeps its API credential at the top level of `~/.codex/auth.json`. */
export const CODEX_CREDENTIAL_FIELDS: readonly string[] = ['OPENAI_API_KEY']
/** ...or a ChatGPT login under `tokens` (tolerated; not present on this host). */
export const CODEX_TOKEN_FIELDS: readonly string[] = ['access_token', 'id_token']

/** `~/.codex/auth.json` → `OPENAI_API_KEY` or a `tokens.*` OAuth entry. */
export function credentialFromCodexAuth(contents: string, absolutePath: string): CredentialHealth {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return fragment('unknown', `auth.json: ${parsed.detail}`, absolutePath)

  const survey = surveyFields(parsed.value, CODEX_CREDENTIAL_FIELDS)
  if (survey.set.length > 0) return fragment('ok', presentDetail('auth.json', '', survey.set), absolutePath)

  const tokens = asRecord(parsed.value['tokens'])
  if (tokens !== undefined) {
    const tokenSurvey = surveyFields(tokens, CODEX_TOKEN_FIELDS)
    if (tokenSurvey.set.length > 0) {
      return fragment(
        'ok',
        `auth.json tokens: ${tokenSurvey.set.join(', ')} set (ChatGPT login; presence only, no network check)`,
        absolutePath,
      )
    }
    if (tokenSurvey.placeholder.length > 0) {
      return fragment('missing', placeholderDetail('auth.json', 'tokens', tokenSurvey.placeholder), absolutePath)
    }
  }
  if (survey.placeholder.length > 0) {
    return fragment('missing', placeholderDetail('auth.json', '', survey.placeholder), absolutePath)
  }
  return fragment('missing', 'auth.json has no OPENAI_API_KEY and no tokens.access_token', absolutePath)
}

/* ------------------------------------------------------------ openclaw CLI */

/** Credential field names OpenClaw-shaped configs use at the top level. */
export const OPENCLAW_TOP_FIELDS: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'apiKey',
  'api_key',
  'token',
]
/** ...and per provider (`models.providers.<name>.*`). */
export const OPENCLAW_PROVIDER_FIELDS: readonly string[] = ['apiKey', 'api_key', 'token', 'key']

/**
 * `~/.openclaw/openclaw.json` (the CLI track's default profile).
 *
 * Deliberately a small allow-list of field NAMES rather than a recursive scan:
 * a scan would walk straight into `models.providers.*.models[].headers`
 * (AutoClaw's profile stores a bearer token there), and the bridge has no
 * business reading a header it does not understand. Verified on this host: the
 * CLI profile declares `mcpServers` only, so the honest answer is `missing`.
 */
export function credentialFromOpenclawConfig(contents: string, absolutePath: string): CredentialHealth {
  const parsed = parseJsonObject(contents)
  if (!parsed.ok) return fragment('unknown', `openclaw.json: ${parsed.detail}`, absolutePath)

  const root = surveyFields(parsed.value, OPENCLAW_TOP_FIELDS)
  if (root.set.length > 0) return fragment('ok', presentDetail('openclaw.json', '', root.set), absolutePath)

  const set: string[] = []
  const placeholders: string[] = []
  const providers = asRecord(asRecord(parsed.value['models'])?.['providers'])
  for (const providerName of Object.keys(providers ?? {}).sort()) {
    const provider = asRecord(providers?.[providerName])
    if (provider === undefined) continue
    const survey = surveyFields(provider, OPENCLAW_PROVIDER_FIELDS)
    for (const field of survey.set) set.push(`${providerName}.${field}`)
    for (const field of survey.placeholder) placeholders.push(`${providerName}.${field}`)
  }
  if (set.length > 0) {
    return fragment('ok', presentDetail('openclaw.json', 'models.providers', set), absolutePath)
  }
  if (root.placeholder.length > 0) {
    return fragment('missing', placeholderDetail('openclaw.json', '', root.placeholder), absolutePath)
  }
  if (placeholders.length > 0) {
    return fragment('missing', placeholderDetail('openclaw.json', 'models.providers', placeholders), absolutePath)
  }
  return fragment(
    'missing',
    `openclaw.json declares no credential field (top-level ${OPENCLAW_TOP_FIELDS.join(
      '/',
    )}; or models.providers.*.${OPENCLAW_PROVIDER_FIELDS.join('/')})`,
    absolutePath,
  )
}

/* ---------------------------------------------------------------- plans */

type CredentialPlan =
  /** The engine authenticates through its desktop app: no file, no token, ever. */
  | { readonly kind: 'delegated'; readonly detail: string }
  /** No reader is known: honest `unknown`, which is NOT the same as `missing`. */
  | { readonly kind: 'unsourced'; readonly detail: string }
  | {
      readonly kind: 'file'
      readonly file: (home: string) => string
      readonly parse: (contents: string, absolutePath: string) => CredentialHealth
    }

/**
 * One row per identity. This is the ONLY place in the bridge that maps an agent
 * id to a credential file; the registry stays id-agnostic and just asks.
 */
const CREDENTIAL_PLANS: Readonly<Record<AgentId, CredentialPlan>> = {
  claude: {
    kind: 'file',
    file: (home) => path.join(home, '.claude', 'settings.json'),
    parse: credentialFromClaudeSettings,
  },
  codex: {
    kind: 'file',
    file: (home) => path.join(home, '.codex', 'auth.json'),
    parse: credentialFromCodexAuth,
  },
  // Verified on the target machine: `~/.codebuddy` holds NO readable credential
  // file at all. `settings.json` declares `enabledPlugins` and nothing else, and
  // the account state lives in the CLI's own store (opaque `local_storage/*.info`
  // entries the bridge will not open). Its auth is therefore the CLI's own
  // account login, not a credential the bridge can classify — `unknown`, which
  // is NOT `missing` and NOT `not-applicable` (a desktop login is not reused
  // here: an unsigned-in headless run answers "Authentication required. Please
  // use /login command"). No file is read, so no value can leak.
  'codebuddy-code': {
    kind: 'unsourced',
    detail:
      'the CodeBuddy CLI keeps its own account login: ~/.codebuddy holds no api-key or token file (settings.json declares enabledPlugins only), so there is no credential file for the bridge to read',
  },
  openclaw: {
    kind: 'file',
    file: (home) => path.join(home, '.openclaw', 'openclaw.json'),
    parse: credentialFromOpenclawConfig,
  },
  workbuddy: {
    kind: 'delegated',
    detail:
      'auth is the WorkBuddy desktop login (reused via copilot.tencent.com); no token file exists and none is read',
  },
  'workbuddy-ai': {
    kind: 'delegated',
    detail:
      'auth is the WorkBuddy AI (international) desktop login, reused via www.workbuddy.ai; no token file exists and none is read',
  },
  autoclaw: {
    kind: 'delegated',
    detail: 'auth is the AutoClaw desktop login, reused by its bundled engine; the bridge reads no token',
  },
  mimo: {
    kind: 'delegated',
    detail: 'MiMo keeps its login inside the app bundle; there is no credential file for the bridge to read',
  },
  'qoder-cn': {
    // `unsourced` — and it STAYS `unsourced` now that a credential actually
    // exists. The engine reads its own store (~/.qoder-cn/.auth/user, an opaque
    // non-JSON blob this bridge has no contract for), so `unknown` is the
    // honest status: "the bridge has no reader", which is NOT the same as "the
    // credential is absent". Reading it is not the bridge's job and it is not
    // needed — the engine does that itself on launch.
    //
    // What must NOT be claimed: that a bare launch inherits the DESKTOP login.
    // It does not. The app keeps its own encrypted store
    // (…/com.qodercn.app.stable/auth.v1.dat) and mints a PER-JOB token for its
    // own workers, so nothing it does populates the CLI store. A working bare
    // launch depends on that store being filled out of band — proven both ways:
    // while it was empty every run died at `session/new` with -32000, and after
    // `qoderclicn login` wrote it, the same descriptor completed a full turn.
    kind: 'unsourced',
    detail:
      'the desktop login is not delegated to a bare launch: the app keeps its own encrypted store and mints a per-job token for its own workers. A launched Qoder CN reads ~/.qoder-cn/.auth itself, which is an opaque non-JSON blob this bridge has no reader for — hence unknown, not missing. Populate it out of band with `qoderclicn login`',
  },
  generic: {
    kind: 'unsourced',
    detail:
      'no credential reader for a generic CLI: the target executable (GENERIC_PATH) keeps its own auth, which the bridge has no contract for',
  },
}

/* ----------------------------------------------------------------- public */

/**
 * Credential status for one identity.
 *
 * Pure with respect to the host when the caller passes `contents` (or a
 * `readFile`): the returned fragment has no dependency on this machine. The
 * registry calls it as `credentialStatusFor(result.id)` and spreads the result
 * next to `launch`.
 */
export function credentialStatusFor(agentId: AgentId, options: CredentialReaderOptions = {}): CredentialHealth {
  const plan = CREDENTIAL_PLANS[agentId]
  if (plan === undefined) {
    return fragment('unknown', `no credential reader is registered for identity "${agentId}"`)
  }
  if (plan.kind === 'delegated') return fragment('not-applicable', plan.detail)
  if (plan.kind === 'unsourced') return fragment('unknown', plan.detail)

  const home = options.home ?? os.homedir()
  const absolute = options.path !== undefined ? expandHome(options.path, home) : plan.file(home)
  const read = readHostFile(absolute, options)
  if (!read.ok) {
    // `missing` covers "no readable file", `unknown` covers "could not even try".
    return fragment(
      read.failure === 'error' ? 'unknown' : 'missing',
      `${path.basename(absolute)} ${read.detail}`,
      absolute,
    )
  }
  return plan.parse(read.contents, absolute)
}

/** `credentialStatusFor` plus the launch half, i.e. the whole `AgentHealth`. */
export function healthFor(
  agentId: AgentId,
  launch: AgentHealth['launch'],
  options: CredentialReaderOptions = {},
): AgentHealth {
  return { launch, ...credentialStatusFor(agentId, options) }
}
