/**
 * Model-catalog reader tests.
 *
 * The fixtures reproduce the SHAPES verified on the target machine, trimmed to
 * the fields the readers use:
 *
 *   - `~/.claude/settings.json` → `env.*_MODEL`, with the CLI's `[1m]`
 *     context-variant marker (`deepseek-v4-flash[1m]`);
 *   - `~/.codex/config.toml` → `model_catalog_json` → `{ models: [{ slug }] }`,
 *     else the single `model = "..."` line;
 *   - `~/.codebuddy/models.json` → `{ models: [{ id }] }`, an EMPTY user cache
 *     on the target machine (so "not discovered", never an empty catalog);
 *   - `~/.workbuddy/cache/acc-product-config-v3.json` → `{ models: [{ id, credits }] }`;
 *   - `~/.openclaw-autoclaw/openclaw.json` → `models.providers.<p>.models[].id`.
 *
 * Absent is not none: `{ discovered: false, reason }` (no local catalog) is
 * asserted separately from `{ discovered: true, models: [] }` (a catalog that
 * declares nothing) everywhere both are reachable.
 */

import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { credentialStatusFor } from '../../src/tracks/health.ts'
import {
  CLAUDE_MODEL_FIELDS,
  claudeModelIdsFromSettings,
  codebuddyCodeModelsFromConfig,
  codexCatalogModelIds,
  collectModelIds,
  creditSummary,
  modelFieldsFor,
  modelsFor,
  openclawModelsFromConfig,
  parseCodexConfig,
  resolveCodexCatalogPath,
  stripContextMarker,
  workbuddyModelsFromConfig,
} from '../../src/tracks/models.ts'

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxNTMzOTF9.FAKESIGNATURE0000000000'

const HOME = path.join(path.sep, 'fixture', 'home')
const at = (...parts: string[]): string => path.join(HOME, ...parts)
const CLAUDE_PATH = at('.claude', 'settings.json')
const CODEX_CONFIG = at('.codex', 'config.toml')
const CODEX_CATALOG = at('.codex', 'models.json')
const CODEBUDDY_CODE_PATH = at('.codebuddy', 'models.json')
const WORKBUDDY_PATH = at('.workbuddy', 'cache', 'acc-product-config-v3.json')
const AUTOCLAW_PATH = at('.openclaw-autoclaw', 'openclaw.json')
const OPENCLAW_PATH = at('.openclaw', 'openclaw.json')

/** The `env` block this host's claude profile actually carries (values verified). */
const CLAUDE_ENV = {
  OPENAI_API_KEY: 'sk-proj-FAKE0000000000000000000000000000000000',
  OPENAI_BASE_URL: 'https://example.invalid/v1',
  CLAUDE_CODE_USE_OPENAI: '1',
  OPEN_MODEL: 'deepseek-v4-flash[1m]',
  OPENAI_DEFAULT_SONNET_MODEL: 'ox-alpha-free[1m]',
  OPENAI_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash[1m]',
  OPENAI_DEFAULT_HAIKU_MODEL: 'mimo-v2.5[1m]',
  OPENAI_DEFAULT_SONNET_MODEL_NAME: 'OX Alpha',
  OPENAI_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4-flash',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
}

const CODEX_TOML = [
  'model_provider = "OpenAI"',
  'model = "deepseek-v4-flash"',
  `model_catalog_json = "${CODEX_CATALOG}"`,
  'model_context_window = 1_000_000',
  '',
  '[model_providers.OpenAI]',
  'name = "OpenAI"',
  'base_url = "http://127.0.0.1:8080"',
  'wire_api = "responses"',
  '',
].join('\n')

const CODEX_CATALOG_JSON = JSON.stringify({
  models: [
    { slug: 'deepseek-v4-flash', context_window: 1_000_000 },
    { slug: 'deepseek-v4-pro', context_window: 1_000_000 },
  ],
})

const WORKBUDDY_JSON = JSON.stringify({
  $schema: 'x',
  agents: [],
  models: [
    { id: 'fast-model', name: '快速', credits: 'x0.21', isDefault: true, vendor: 'f' },
    { id: 'deep-model', name: '深度', credits: 'x1.20', vendor: 'd' },
    { id: 'hy3', name: '混元3', isDefault: false },
    { id: 'deepseek-v4.1-flash', name: 'DS', credits: 'x0.30' },
    { id: 'kimi-k3-1', name: 'Kimi' },
  ],
  prompts: [],
})

const AUTOCLAW_JSON = JSON.stringify({
  mcp: {},
  models: {
    providers: {
      zai: {
        baseUrl: 'https://example.invalid/v1',
        models: [
          { id: 'zai_auto', name: 'Auto', contextWindow: 1048576 },
          {
            id: 'zaicoding_glm-5.3',
            name: 'GLM-5.3',
            headers: { 'X-Authorization': `Bearer ${FAKE_JWT}`, 'X-Product': 'autoclaw' },
          },
        ],
      },
    },
  },
})

function throwingReader(error: unknown) {
  return (): string => {
    throw error
  }
}

function notFound(file: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' })
}

describe('claude: env.*_MODEL', () => {
  it('strips the [1m] context-variant marker and de-duplicates', () => {
    const discovery = modelsFor('claude', {
      home: HOME,
      contents: { [CLAUDE_PATH]: JSON.stringify({ env: CLAUDE_ENV, hooks: {} }) },
    })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    // OPEN_MODEL first, then the declared priority order; the repeated
    // deepseek-v4-flash[1m] under OPENAI_DEFAULT_OPUS_MODEL collapses.
    expect(discovery.models).toEqual([
      'deepseek-v4-flash',
      'ox-alpha-free',
      'mimo-v2.5',
      'claude-sonnet-4-6',
    ])
    expect(discovery.models.join(' ')).not.toContain('[1m]')
    expect(discovery.source).toBe('~/.claude/settings.json env (4 ids)')
    // The three ids the task names explicitly.
    for (const id of ['deepseek-v4-flash', 'ox-alpha-free', 'mimo-v2.5']) {
      expect(discovery.models).toContain(id)
    }
  })

  it('ignores *_MODEL_NAME display labels but picks up an unknown *_MODEL field', () => {
    const parsed = claudeModelIdsFromSettings(
      JSON.stringify({
        env: {
          OPENAI_DEFAULT_SONNET_MODEL_NAME: 'OX Alpha',
          SOME_FUTURE_MODEL: 'new-model[200k]',
        },
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.ids).toEqual(['new-model'])
    expect(parsed.ids).not.toContain('OX Alpha')
  })

  it('leaks no key value while reading the same file', () => {
    const discovery = modelsFor('claude', {
      home: HOME,
      contents: { [CLAUDE_PATH]: JSON.stringify({ env: CLAUDE_ENV }) },
    })
    const serialized = JSON.stringify(discovery)
    expect(serialized).not.toContain('sk-proj')
    expect(serialized).not.toContain(CLAUDE_ENV.OPENAI_API_KEY)
  })

  it('reports a file with no *_MODEL field as not discovered', () => {
    const discovery = modelsFor('claude', {
      home: HOME,
      contents: { [CLAUDE_PATH]: JSON.stringify({ env: { OPENAI_API_KEY: 'x' } }) },
    })
    expect(discovery.discovered).toBe(false)
    if (discovery.discovered) return
    expect(discovery.reason).toContain('~/.claude/settings.json')
    expect(discovery.reason).toContain('no *_MODEL field under env')
  })

  it('reports an absent file as not discovered, naming the file', () => {
    const discovery = modelsFor('claude', { home: HOME, readFile: throwingReader(notFound(CLAUDE_PATH)) })
    expect(discovery.discovered).toBe(false)
    if (discovery.discovered) return
    expect(discovery.reason).toBe('not discovered: ~/.claude/settings.json not found')
  })

  it('reads a file that is present but not JSON as not discovered', () => {
    const discovery = modelsFor('claude', { home: HOME, contents: { [CLAUDE_PATH]: '{ oops' } })
    expect(discovery.discovered).toBe(false)
    if (discovery.discovered) return
    expect(discovery.reason).toContain('not valid JSON')
    // The parse error's own message quotes the input; the reader must not.
    expect(discovery.reason).not.toContain('oops')
  })
})

describe('codex: config.toml + JSON catalog', () => {
  it('reads slugs from the catalog config.toml points at', () => {
    const discovery = modelsFor('codex', {
      home: HOME,
      contents: { [CODEX_CONFIG]: CODEX_TOML, [CODEX_CATALOG]: CODEX_CATALOG_JSON },
    })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    expect(discovery.models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(discovery.source).toBe('~/.codex/models.json (2 ids; provider OpenAI)')
  })

  it('expands ~ and resolves a relative catalog path against the config directory', () => {
    expect(resolveCodexCatalogPath('~/.codex/models.json', HOME, at('.codex'))).toBe(CODEX_CATALOG)
    expect(resolveCodexCatalogPath('./models.json', HOME, at('.codex'))).toBe(CODEX_CATALOG)
    expect(resolveCodexCatalogPath('/etc/models.json', HOME, at('.codex'))).toBe('/etc/models.json')

    const relative = CODEX_TOML.replace(`"${CODEX_CATALOG}"`, '"models.json"')
    const discovery = modelsFor('codex', {
      home: HOME,
      contents: { [CODEX_CONFIG]: relative, [CODEX_CATALOG]: CODEX_CATALOG_JSON },
    })
    expect(discovery.discovered).toBe(true)
  })

  it('falls back to the single configured model when the catalog is absent', () => {
    const discovery = modelsFor('codex', { home: HOME, contents: { [CODEX_CONFIG]: CODEX_TOML } })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    expect(discovery.models).toEqual(['deepseek-v4-flash'])
    expect(discovery.source).toBe('~/.codex/config.toml model (1 id; provider OpenAI; ~/.codex/models.json not found)')
  })

  it('falls back when the catalog is not valid JSON, and says why', () => {
    const discovery = modelsFor('codex', {
      home: HOME,
      contents: { [CODEX_CONFIG]: CODEX_TOML, [CODEX_CATALOG]: 'nope' },
    })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    expect(discovery.models).toEqual(['deepseek-v4-flash'])
    expect(discovery.source).toContain('~/.codex/models.json: not valid JSON')
  })

  it('keeps "a catalog that declares nothing" distinct from "no catalog at all"', () => {
    const empty = modelsFor('codex', {
      home: HOME,
      contents: { [CODEX_CONFIG]: CODEX_TOML, [CODEX_CATALOG]: JSON.stringify({ models: [] }) },
    })
    expect(empty.discovered).toBe(true)
    if (empty.discovered) expect(empty.models).toEqual([])
    expect(modelFieldsFor(empty)).toEqual({ models: [], modelsSource: '~/.codex/models.json (0 ids; provider OpenAI)' })

    const none = modelsFor('codex', { home: HOME, contents: { [CODEX_CONFIG]: 'model = "m"' } })
    expect(none.discovered).toBe(true)
    expect(modelFieldsFor(none)).toEqual({ models: ['m'], modelsSource: '~/.codex/config.toml model (1 id)' })

    const absent = modelsFor('codex', { home: HOME, readFile: throwingReader(notFound(CODEX_CONFIG)) })
    expect(absent.discovered).toBe(false)
    // Not "no models": the field is omitted so ProbeResult cannot claim `[]`.
    expect(modelFieldsFor(absent)).toEqual({})
    expect('models' in modelFieldsFor(absent)).toBe(false)
  })

  it('reports "no catalog and no model line" as not discovered', () => {
    const discovery = modelsFor('codex', { home: HOME, contents: { [CODEX_CONFIG]: 'approval_policy = "never"' } })
    expect(discovery.discovered).toBe(false)
    if (discovery.discovered) return
    expect(discovery.reason).toContain('no model_catalog_json and no model = "..." line')
  })

  it('ignores keys that belong to a [table], root table only', () => {
    const nested = [
      'model = "root-model"',
      '',
      '[model_providers.OpenAI]',
      'model = "should-not-be-used"',
      'model_catalog_json = "/etc/nope.json"',
      '',
    ].join('\n')
    const config = parseCodexConfig(nested)
    expect(config.model).toBe('root-model')
    expect(config.catalogPath).toBeUndefined()

    const tableOnly = ['[model_providers.OpenAI]', 'model = "nope"', ''].join('\n')
    expect(parseCodexConfig(tableOnly).model).toBeUndefined()
    expect(modelsFor('codex', { home: HOME, contents: { [CODEX_CONFIG]: tableOnly } }).discovered).toBe(false)
  })

  it('handles quoted values, comments and repeated keys (first wins)', () => {
    const toml = [
      "# a comment",
      "model = 'single-quoted'   # trailing comment",
      'model = "second-ignored"',
      'model_catalog_json = "a # b.json"',
      '',
    ].join('\n')
    const config = parseCodexConfig(toml)
    expect(config.model).toBe('single-quoted')
    expect(config.catalogPath).toBe('a # b.json')
    expect(parseCodexConfig('model = "unterminated').model).toBeUndefined()
  })

  it('accepts an id field as well as a slug in the catalog', () => {
    const parsed = codexCatalogModelIds(JSON.stringify({ models: [{ id: 'by-id' }, { slug: 'by-slug' }] }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.ids).toEqual(['by-id', 'by-slug'])
    expect(codexCatalogModelIds(JSON.stringify({ nope: 1 })).ok).toBe(false)
  })
})

describe('workbuddy: acc-product-config-v3.json', () => {
  it('reads model ids and the credit multiplier they carry', () => {
    const discovery = modelsFor('workbuddy', {
      home: HOME,
      contents: { [WORKBUDDY_PATH]: WORKBUDDY_JSON },
    })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    expect(discovery.models).toEqual(['fast-model', 'deep-model', 'hy3', 'deepseek-v4.1-flash', 'kimi-k3-1'])
    expect(discovery.source).toBe('~/.workbuddy/cache/acc-product-config-v3.json models (5 ids)')
    expect(discovery.creditMultipliers).toEqual({
      'fast-model': 'x0.21',
      'deep-model': 'x1.20',
      'deepseek-v4.1-flash': 'x0.30',
    })
    expect(creditSummary(discovery, 2)).toBe('fast-model=x0.21, deep-model=x1.20 (+1 more)')
    expect(creditSummary(discovery, 10)).toBe('fast-model=x0.21, deep-model=x1.20, deepseek-v4.1-flash=x0.30')
  })

  it('omits the credit map when the catalog carries no multiplier', () => {
    const parsed = workbuddyModelsFromConfig(JSON.stringify({ models: [{ id: 'a' }, { id: 'b' }] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.credits).toBeUndefined()
    const discovery = modelsFor('workbuddy', {
      home: HOME,
      contents: { [WORKBUDDY_PATH]: JSON.stringify({ models: [{ id: 'a' }] }) },
    })
    expect(discovery.discovered).toBe(true)
    if (discovery.discovered) expect(discovery.creditMultipliers).toBeUndefined()
    expect(creditSummary(discovery)).toBeUndefined()
  })

  it('separates an empty catalog from a missing one', () => {
    const empty = modelsFor('workbuddy', {
      home: HOME,
      contents: { [WORKBUDDY_PATH]: JSON.stringify({ models: [] }) },
    })
    expect(empty.discovered).toBe(true)
    if (empty.discovered) expect(empty.models).toEqual([])

    const noKey = modelsFor('workbuddy', {
      home: HOME,
      contents: { [WORKBUDDY_PATH]: JSON.stringify({ agents: [] }) },
    })
    expect(noKey.discovered).toBe(false)
    if (!noKey.discovered) expect(noKey.reason).toContain('no "models" array')

    const absent = modelsFor('workbuddy', { home: HOME, readFile: throwingReader(notFound(WORKBUDDY_PATH)) })
    expect(absent.discovered).toBe(false)
    if (!absent.discovered) expect(absent.reason).toBe('not discovered: ~/.workbuddy/cache/acc-product-config-v3.json not found')
  })
})

/**
 * The international build (P3 completion of the two outstanding rows).
 *
 * `workbuddy-ai` is a SEPARATE identity, not a locale flag: its bundle's
 * `product.json` sets `dataFolderName=.workbuddy-ai`, so the byte-identical
 * launcher reads its own home. The model catalog therefore has to be read from
 * `~/.workbuddy-ai/...`, and the two catalogs really do differ (22 international
 * ids against 51 domestic ones on the target machine).
 */
describe('workbuddy-ai: the international build reads its own home', () => {
  const AI_PATH = at('.workbuddy-ai', 'cache', 'acc-product-config-v3.json')

  it('reads ~/.workbuddy-ai/cache/acc-product-config-v3.json, not the domestic path', () => {
    const discovery = modelsFor('workbuddy-ai', {
      home: HOME,
      contents: { [AI_PATH]: WORKBUDDY_JSON },
    })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    expect(discovery.models).toEqual(['fast-model', 'deep-model', 'hy3', 'deepseek-v4.1-flash', 'kimi-k3-1'])
    expect(discovery.source).toBe('~/.workbuddy-ai/cache/acc-product-config-v3.json models (5 ids)')
    // The evidence names the international home, which is the whole point.
    expect(discovery.source).toContain('.workbuddy-ai')
    expect(discovery.source).not.toContain('~/.workbuddy/cache')
    // The same parser, so a credit multiplier is carried through identically.
    expect(discovery.creditMultipliers).toEqual({
      'fast-model': 'x0.21',
      'deep-model': 'x1.20',
      'deepseek-v4.1-flash': 'x0.30',
    })
  })

  it('does NOT read the domestic catalog when asked for the international build', () => {
    // Only the DOMESTIC file exists. The international identity must report
    // "not discovered" rather than silently borrowing the other build's list —
    // that would tell the model the engine accepts ids it may not.
    const discovery = modelsFor('workbuddy-ai', {
      home: HOME,
      contents: { [WORKBUDDY_PATH]: WORKBUDDY_JSON },
      readFile: throwingReader(notFound(AI_PATH)),
    })
    expect(discovery.discovered).toBe(false)
    if (discovery.discovered) return
    expect(discovery.reason).toContain('.workbuddy-ai')
    expect(discovery.reason).toContain('not found')
  })

  it('degrades to "not discovered" when the cache file is absent (D19)', () => {
    // The file is a SERVER-PUSHED cache, so its absence is routine — a user who
    // has never signed in, or an app that has not synced yet. That must be a
    // discovery failure, never a throw.
    const absent = modelsFor('workbuddy-ai', { home: HOME, readFile: throwingReader(notFound(AI_PATH)) })
    expect(absent.discovered).toBe(false)
    if (!absent.discovered) {
      expect(absent.reason).toBe('not discovered: ~/.workbuddy-ai/cache/acc-product-config-v3.json not found')
    }
    expect(() => modelsFor('workbuddy-ai', { home: HOME, readFile: throwingReader(notFound(AI_PATH)) })).not.toThrow()
  })

  it('degrades to "not discovered" when the cache file is unreadable or malformed', () => {
    const unreadable = modelsFor('workbuddy-ai', {
      home: HOME,
      readFile: () => {
        const error = new Error('EACCES: permission denied') as Error & { code?: string }
        error.code = 'EACCES'
        throw error
      },
    })
    expect(unreadable.discovered).toBe(false)
    if (!unreadable.discovered) expect(unreadable.reason).toContain('not readable')

    const malformed = modelsFor('workbuddy-ai', {
      home: HOME,
      contents: { [AI_PATH]: '{ this is not json' },
    })
    expect(malformed.discovered).toBe(false)
    if (!malformed.discovered) expect(malformed.reason).toContain('.workbuddy-ai')
    // The parse error's POSITION is reported, never a snippet of the file, so a
    // truncated cache cannot put its own bytes into probe output.
    if (!malformed.discovered) expect(malformed.reason).toContain('position')

    const noModels = modelsFor('workbuddy-ai', {
      home: HOME,
      contents: { [AI_PATH]: JSON.stringify({ agents: [] }) },
    })
    expect(noModels.discovered).toBe(false)
    if (!noModels.discovered) expect(noModels.reason).toContain('no "models" array')
  })

  it('is a different identity from workbuddy, reading a different file', () => {
    // Same content in both files: the two identities still report different
    // sources, proving they are not one reader wearing two names.
    const both = {
      [WORKBUDDY_PATH]: WORKBUDDY_JSON,
      [AI_PATH]: WORKBUDDY_JSON,
    }
    const domestic = modelsFor('workbuddy', { home: HOME, contents: both })
    const international = modelsFor('workbuddy-ai', { home: HOME, contents: both })
    expect(domestic.discovered && international.discovered).toBe(true)
    if (!domestic.discovered || !international.discovered) return
    expect(domestic.source).toContain('.workbuddy/cache')
    expect(international.source).toContain('.workbuddy-ai/cache')
    expect(domestic.source).not.toBe(international.source)
  })
})

describe('autoclaw: openclaw.json models.providers', () => {
  it('flattens every provider, in file order, and names them in the source', () => {
    const discovery = modelsFor('autoclaw', {
      home: HOME,
      contents: { [AUTOCLAW_PATH]: AUTOCLAW_JSON },
    })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    expect(discovery.models).toEqual(['zai_auto', 'zaicoding_glm-5.3'])
    expect(discovery.source).toBe('~/.openclaw-autoclaw/openclaw.json models.providers.zai (2 ids)')
  })

  it('never surfaces the bearer token stored in a model header', () => {
    const discovery = modelsFor('autoclaw', {
      home: HOME,
      contents: { [AUTOCLAW_PATH]: AUTOCLAW_JSON },
    })
    const serialized = JSON.stringify(discovery)
    expect(serialized).not.toContain(FAKE_JWT)
    expect(serialized).not.toContain('Bearer')
    expect(serialized).not.toContain('X-Authorization')
  })

  it('reads several providers and keeps an empty one as "none"', () => {
    const parsed = openclawModelsFromConfig(
      JSON.stringify({
        models: {
          providers: {
            alpha: { models: [{ id: 'a-one' }, { id: 'a-two' }] },
            beta: { models: [] },
            gamma: { models: [{ id: 'g-one' }, { id: 'a-one' }] },
          },
        },
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.providers).toEqual(['alpha', 'beta', 'gamma'])
    expect(parsed.ids).toEqual(['a-one', 'a-two', 'g-one'])
  })

  it('reports an absent file and a missing providers object as not discovered', () => {
    const absent = modelsFor('autoclaw', { home: HOME, readFile: throwingReader(notFound(AUTOCLAW_PATH)) })
    expect(absent.discovered).toBe(false)
    if (!absent.discovered) expect(absent.reason).toBe('not discovered: ~/.openclaw-autoclaw/openclaw.json not found')

    const parsed = openclawModelsFromConfig(JSON.stringify({ models: { mode: 'merge' } }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toBe('no models.providers object')
  })
})

describe('codebuddy-code: ~/.codebuddy/models.json is a cache, not a catalog', () => {
  it('reads models[].id if the cache is ever populated', () => {
    const discovery = modelsFor('codebuddy-code', {
      home: HOME,
      contents: { [CODEBUDDY_CODE_PATH]: JSON.stringify({ models: [{ id: 'fast-model' }, { id: 'deep-model' }] }) },
    })
    expect(discovery.discovered).toBe(true)
    if (!discovery.discovered) return
    expect(discovery.models).toEqual(['fast-model', 'deep-model'])
    expect(discovery.source).toBe('~/.codebuddy/models.json models (2 ids)')
  })

  it('reports the empty cache this host actually has as NOT discovered', () => {
    // The real file is 19 bytes of `{"models": []}` while the CLI advertises 18
    // selectable ids in its own --help. `{ discovered: true, models: [] }` would
    // tell the model this engine accepts no model at all — false, and stronger
    // than the evidence — so the field is omitted entirely.
    const discovery = modelsFor('codebuddy-code', {
      home: HOME,
      contents: { [CODEBUDDY_CODE_PATH]: '{\n  "models": []\n}\n' },
    })
    expect(discovery.discovered).toBe(false)
    if (discovery.discovered) return
    expect(discovery.reason).toContain('~/.codebuddy/models.json')
    expect(discovery.reason).toContain('empty "models" array')
    expect(modelFieldsFor(discovery)).toEqual({})
    expect('models' in modelFieldsFor(discovery)).toBe(false)
  })

  it('never invents the ids the CLI advertises in --help', () => {
    const discovery = modelsFor('codebuddy-code', {
      home: HOME,
      contents: { [CODEBUDDY_CODE_PATH]: JSON.stringify({ models: [] }) },
    })
    const serialized = JSON.stringify(discovery)
    for (const advertised of ['fast-model', 'deep-model', 'glm-5.3', 'kimi-k3', 'minimax-m3']) {
      expect(serialized).not.toContain(advertised)
    }
  })

  it('reports an absent, malformed or shapeless cache as not discovered, naming the file', () => {
    const absent = modelsFor('codebuddy-code', {
      home: HOME,
      readFile: throwingReader(notFound(CODEBUDDY_CODE_PATH)),
    })
    expect(absent.discovered).toBe(false)
    if (!absent.discovered) expect(absent.reason).toBe('not discovered: ~/.codebuddy/models.json not found')

    const malformed = modelsFor('codebuddy-code', { home: HOME, contents: { [CODEBUDDY_CODE_PATH]: '{ oops' } })
    expect(malformed.discovered).toBe(false)
    if (!malformed.discovered) {
      expect(malformed.reason).toContain('not valid JSON')
      // The parse error quotes its input; the reader must not.
      expect(malformed.reason).not.toContain('oops')
    }

    const shapeless = codebuddyCodeModelsFromConfig(JSON.stringify({ version: 1 }))
    expect(shapeless.ok).toBe(false)
    if (!shapeless.ok) expect(shapeless.reason).toBe('no "models" array')
  })

  it('drops non-string and duplicate ids without inventing any', () => {
    const parsed = codebuddyCodeModelsFromConfig(
      JSON.stringify({ models: [{ id: 'a' }, { id: 'a' }, {}, { id: 42 }, { id: '' }] }),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.ids).toEqual(['a'])
  })
})

describe('engines with no local catalog', () => {
  it('reports openclaw as not discovered, never as an empty list', () => {
    // This host's ~/.openclaw/openclaw.json really does hold mcpServers only.
    const discovery = modelsFor('openclaw', {
      home: HOME,
      contents: { [OPENCLAW_PATH]: JSON.stringify({ mcpServers: { one: { command: '/bin/x' } } }) },
    })
    expect(discovery.discovered).toBe(false)
    if (discovery.discovered) return
    expect(discovery.reason).toContain('~/.openclaw/openclaw.json')
    expect(discovery.reason).toContain('no models.providers object')
    expect(modelFieldsFor(discovery)).toEqual({})
  })

  it('reports openclaw as not discovered when the profile file is absent', () => {
    const discovery = modelsFor('openclaw', { home: HOME, readFile: throwingReader(notFound(OPENCLAW_PATH)) })
    expect(discovery.discovered).toBe(false)
    if (!discovery.discovered) expect(discovery.reason).toContain('the openclaw CLI resolves models')
  })

  it('reads a catalog if the openclaw profile ever grows one', () => {
    const discovery = modelsFor('openclaw', {
      home: HOME,
      contents: { [OPENCLAW_PATH]: JSON.stringify({ models: { providers: { p: { models: [{ id: 'm1' }] } } } }) },
    })
    expect(discovery.discovered).toBe(true)
    if (discovery.discovered) expect(discovery.models).toEqual(['m1'])
  })

  it('reports mimo and unknown identities as not discovered', () => {
    const mimo = modelsFor('mimo')
    expect(mimo.discovered).toBe(false)
    if (!mimo.discovered) expect(mimo.reason).toContain('sealed desktop app')

    const unknown = modelsFor('not-an-engine')
    expect(unknown.discovered).toBe(false)
    if (!unknown.discovered) expect(unknown.reason).toContain('not-an-engine')
  })

  it('is silent about the credential reader: two different questions', () => {
    expect(credentialStatusFor('mimo').credential).toBe('not-applicable')
    expect(modelsFor('mimo').discovered).toBe(false)
  })
})

describe('id normalising and robustness', () => {
  it('strips only a trailing bracketed context marker', () => {
    expect(stripContextMarker('deepseek-v4-flash[1m]')).toBe('deepseek-v4-flash')
    expect(stripContextMarker('ox-alpha-free[1m]')).toBe('ox-alpha-free')
    expect(stripContextMarker('mimo-v2.5[200k]')).toBe('mimo-v2.5')
    expect(stripContextMarker('model[abc]')).toBe('model[abc]')
    expect(stripContextMarker('  plain  ')).toBe('plain')
  })

  it('collects ids without inventing, duplicating or reordering any', () => {
    expect(collectModelIds(['b', 'a', 'b', '', '  ', 42, null, 'a[1m]'])).toEqual(['b', 'a'])
  })

  it('exposes the claude field priority it reads', () => {
    expect(CLAUDE_MODEL_FIELDS[0]).toBe('OPEN_MODEL')
    expect(CLAUDE_MODEL_FIELDS).toContain('OPENAI_DEFAULT_SONNET_MODEL')
    expect(CLAUDE_MODEL_FIELDS).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL')
    for (const field of CLAUDE_MODEL_FIELDS) expect(field.endsWith('_MODEL')).toBe(true)
  })

  it('never throws, whatever the reader throws', () => {
    for (const id of [
      'claude',
      'codex',
      'codebuddy-code',
      'workbuddy',
      'autoclaw',
      'openclaw',
      'mimo',
      'generic',
      'nope',
    ]) {
      for (const error of [null, undefined, 'a string', 42, new Error('reader exploded')]) {
        const discovery = modelsFor(id, { home: HOME, readFile: throwingReader(error) })
        if (discovery.discovered) {
          expect(Array.isArray(discovery.models)).toBe(true)
        } else {
          expect(discovery.reason).toContain('not discovered')
        }
      }
    }
  })

  it('reports a directory where a config should be as not discovered', () => {
    const eisdir = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' })
    const discovery = modelsFor('claude', { home: HOME, readFile: throwingReader(eisdir) })
    expect(discovery.discovered).toBe(false)
    if (!discovery.discovered) expect(discovery.reason).toContain('is a directory')
  })
})
