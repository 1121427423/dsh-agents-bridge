/**
 * Credential-reader tests.
 *
 * Two things are being locked in here:
 *
 *  1. the readers answer from FILES ONLY and never throw. A missing, unreadable
 *     or malformed config is a normal host fact ("missing" / "unknown" plus a
 *     one-line detail), because `agents_probe` is a model-facing tool and must
 *     not fail because a config file moved.
 *  2. REDACTION IS ENFORCED IN CODE. Several tests assert that a fixture's fake
 *     key does not appear anywhere in the returned object, so the guarantee does
 *     not depend on a reviewer noticing an interpolated value.
 *
 * Every fixture is provided through `contents` / an injected `readFile`, so the
 * suite is hermetic: nothing here reads this machine's real config.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  CLAUDE_CREDENTIAL_FIELDS,
  credentialFromClaudeSettings,
  credentialFromCodexAuth,
  credentialFromOpenclawConfig,
  credentialStatusFor,
  healthFor,
  looksLikePlaceholder,
} from '../../src/tracks/health.ts'
import { expandHome, readHostFile, redactSecrets } from '../../src/tracks/host-files.ts'

/** Distinctive enough that a match in output could only come from a leak. */
const FAKE_KEY = 'sk-proj-FAKEKEY0000000000000000000000000000000000'
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxNTMzOTF9.FAKESIGNATURE0000000000'
const ANTHROPIC_PLACEHOLDER = 'sk-ant-YOUR_API_KEY_HERE'

const HOME = path.join(path.sep, 'fixture', 'home')
const at = (...parts: string[]): string => path.join(HOME, ...parts)

const CLAUDE_PATH = at('.claude', 'settings.json')
const CODEX_PATH = at('.codex', 'auth.json')
const OPENCLAW_PATH = at('.openclaw', 'openclaw.json')

function settingsJson(env: Record<string, unknown>): string {
  return JSON.stringify({ env, hooks: {} }, null, 2)
}

function notFound(file: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' })
}

const throwingReader = (error: unknown) => (): string => {
  throw error
}

describe('claude: ~/.claude/settings.json env', () => {
  it('reports a set key as present without ever echoing it', () => {
    const fragment = credentialStatusFor('claude', {
      home: HOME,
      contents: {
        [CLAUDE_PATH]: settingsJson({
          OPENAI_API_KEY: FAKE_KEY,
          CLAUDE_CODE_USE_OPENAI: '1',
          ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER,
        }),
      },
    })

    expect(fragment.credential).toBe('ok')
    expect(fragment.detail).toContain('OPENAI_API_KEY')
    expect(fragment.detail).toContain('no network check')
    expect(fragment.configPath).toBe(CLAUDE_PATH)
    // The redaction guarantee: no value, not even a prefix, in the whole object.
    expect(JSON.stringify(fragment)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(fragment)).not.toContain('sk-proj')
    expect(JSON.stringify(fragment)).not.toContain(ANTHROPIC_PLACEHOLDER)
  })

  it('names the mode flag without echoing its value', () => {
    const fragment = credentialFromClaudeSettings(
      settingsJson({ OPENAI_API_KEY: FAKE_KEY, CLAUDE_CODE_USE_OPENAI: '1' }),
      CLAUDE_PATH,
    )
    expect(fragment.detail).toContain('CLAUDE_CODE_USE_OPENAI')
    expect(fragment.detail).not.toContain('=1')
  })

  it('does not call the verified sk-ant-YOUR_ placeholder a credential', () => {
    const fragment = credentialFromClaudeSettings(
      settingsJson({ ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER }),
      CLAUDE_PATH,
    )
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toContain('ANTHROPIC_API_KEY is a placeholder')
    expect(JSON.stringify(fragment)).not.toContain(ANTHROPIC_PLACEHOLDER)
  })

  it('treats an empty value as missing, not as a credential', () => {
    const fragment = credentialFromClaudeSettings(settingsJson({ OPENAI_API_KEY: '   ' }), CLAUDE_PATH)
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toContain('no usable credential')
    for (const field of CLAUDE_CREDENTIAL_FIELDS) expect(fragment.detail).toContain(field)
  })

  it('reports an unparseable file as unknown, never as an exception', () => {
    const fragment = credentialFromClaudeSettings('{ "env": ', CLAUDE_PATH)
    expect(fragment.credential).toBe('unknown')
    expect(fragment.detail).toContain('not valid JSON')
    expect(fragment.detail.split('\n')).toHaveLength(1)
    expect(fragment.configPath).toBe(CLAUDE_PATH)
  })

  it('reports a file with no env object as missing', () => {
    const fragment = credentialFromClaudeSettings('{"hooks":{}}', CLAUDE_PATH)
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toContain('no "env" object')
  })
})

describe('codex: ~/.codex/auth.json', () => {
  it('accepts the OPENAI_API_KEY form', () => {
    const fragment = credentialStatusFor('codex', {
      home: HOME,
      contents: { [CODEX_PATH]: JSON.stringify({ OPENAI_API_KEY: FAKE_KEY }) },
    })
    expect(fragment.credential).toBe('ok')
    expect(fragment.detail).toContain('auth.json')
    expect(JSON.stringify(fragment)).not.toContain(FAKE_KEY)
  })

  it('accepts the ChatGPT-login token form', () => {
    const fragment = credentialFromCodexAuth(
      JSON.stringify({ tokens: { access_token: FAKE_JWT, id_token: FAKE_JWT } }),
      CODEX_PATH,
    )
    expect(fragment.credential).toBe('ok')
    expect(fragment.detail).toContain('tokens')
    expect(JSON.stringify(fragment)).not.toContain(FAKE_JWT)
  })

  it('reports an empty auth object as missing with the fields it looked for', () => {
    const fragment = credentialFromCodexAuth('{}', CODEX_PATH)
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toContain('OPENAI_API_KEY')
  })

  it('reports a placeholder as missing', () => {
    const fragment = credentialFromCodexAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-ant-YOUR_KEY' }), CODEX_PATH)
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toContain('placeholder')
  })

  it('reports a malformed file as unknown', () => {
    expect(credentialFromCodexAuth('not json at all', CODEX_PATH).credential).toBe('unknown')
  })
})

describe('openclaw-shaped configs', () => {
  it('finds a provider key by NAME only', () => {
    const fragment = credentialFromOpenclawConfig(
      JSON.stringify({ models: { providers: { zai: { apiKey: FAKE_KEY, models: [] } } } }),
      OPENCLAW_PATH,
    )
    expect(fragment.credential).toBe('ok')
    expect(fragment.detail).toContain('zai.apiKey')
    expect(JSON.stringify(fragment)).not.toContain(FAKE_KEY)
  })

  it('does not treat a token buried in a model header as the engine credential', () => {
    // The real ~/.openclaw-autoclaw/openclaw.json carries a bearer token at
    // models.providers.zai.models[].headers.X-Authorization. The reader is an
    // allow-list of field NAMES, so it must neither find it nor echo it.
    const fragment = credentialFromOpenclawConfig(
      JSON.stringify({
        models: {
          providers: {
            zai: {
              baseUrl: 'https://example.invalid/v1',
              models: [{ id: 'zai_auto', headers: { 'X-Authorization': `Bearer ${FAKE_JWT}` } }],
            },
          },
        },
      }),
      OPENCLAW_PATH,
    )
    expect(fragment.credential).toBe('missing')
    expect(JSON.stringify(fragment)).not.toContain(FAKE_JWT)
    expect(JSON.stringify(fragment)).not.toContain('Bearer')
  })

  it('reports the mcpServers-only shape this host actually has as missing', () => {
    const fragment = credentialFromOpenclawConfig(
      JSON.stringify({ mcpServers: { 'codebase-memory-mcp': { command: '/usr/local/bin/mcp' } } }),
      OPENCLAW_PATH,
    )
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toContain('models.providers')
    expect(fragment.detail.length).toBeLessThanOrEqual(200)
  })
})

describe('credentialStatusFor: identity plans', () => {
  it('never looks for a token on the desktop track', () => {
    for (const id of ['workbuddy', 'autoclaw', 'mimo']) {
      const fragment = credentialStatusFor(id, {
        home: HOME,
        // Not even reachable: a desktop login is not a file.
        readFile: throwingReader(new Error('the reader must not be called')),
      })
      expect(fragment.credential).toBe('not-applicable')
      expect(fragment.configPath).toBeUndefined()
      expect(fragment.detail).toContain('login')
    }
  })

  it('answers unknown (not missing) when no reader is registered', () => {
    expect(credentialStatusFor('generic').credential).toBe('unknown')
    expect(credentialStatusFor('not-an-engine').credential).toBe('unknown')
    expect(credentialStatusFor('not-an-engine').detail).toContain('not-an-engine')
  })

  it('reports an absent file as missing, with the path it looked at', () => {
    const fragment = credentialStatusFor('codex', { home: HOME, readFile: throwingReader(notFound(CODEX_PATH)) })
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toBe('auth.json not found')
    expect(fragment.configPath).toBe(CODEX_PATH)
  })

  it('reports an unreadable 0600-style file as missing and says why', () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const fragment = credentialStatusFor('codex', { home: HOME, readFile: throwingReader(denied) })
    expect(fragment.credential).toBe('missing')
    expect(fragment.detail).toContain('not readable (EACCES)')
    expect(fragment.configPath).toBe(CODEX_PATH)
  })

  it('reports a file it could not even attempt to read as unknown', () => {
    const fragment = credentialStatusFor('codex', {
      home: HOME,
      readFile: throwingReader(Object.assign(new Error('EMFILE'), { code: 'EMFILE' })),
    })
    expect(fragment.credential).toBe('unknown')
  })

  it('prefers pre-read contents and never touches the reader', () => {
    const fragment = credentialStatusFor('codex', {
      home: HOME,
      contents: { [CODEX_PATH]: JSON.stringify({ OPENAI_API_KEY: FAKE_KEY }) },
      readFile: throwingReader(new Error('contents must win')),
    })
    expect(fragment.credential).toBe('ok')
    expect(JSON.stringify(fragment)).not.toContain(FAKE_KEY)
  })

  it('never throws, whatever the reader throws', () => {
    for (const id of ['claude', 'codex', 'openclaw', 'workbuddy', 'autoclaw', 'mimo', 'generic', 'nope']) {
      for (const error of [null, undefined, 'a string', 42, new Error('reader exploded')]) {
        const fragment = credentialStatusFor(id, { home: HOME, readFile: throwingReader(error) })
        expect(typeof fragment.credential).toBe('string')
        expect(fragment.detail.length).toBeGreaterThan(0)
        expect(fragment.detail.split('\n')).toHaveLength(1)
      }
    }
  })

  it('composes the whole AgentHealth with healthFor', () => {
    const health = healthFor('workbuddy', 'ok')
    expect(health.launch).toBe('ok')
    expect(health.credential).toBe('not-applicable')
    expect(typeof health.detail).toBe('string')
  })

  it('leaks no fixture secret for ANY identity', () => {
    const contents: Record<string, string> = {
      [CLAUDE_PATH]: settingsJson({ OPENAI_API_KEY: FAKE_KEY, ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER }),
      [CODEX_PATH]: JSON.stringify({ OPENAI_API_KEY: FAKE_KEY, tokens: { access_token: FAKE_JWT } }),
      [OPENCLAW_PATH]: JSON.stringify({ apiKey: FAKE_KEY, models: { providers: { zai: { apiKey: FAKE_JWT } } } }),
    }
    for (const id of ['claude', 'codex', 'openclaw', 'workbuddy', 'autoclaw', 'mimo', 'generic']) {
      const serialized = JSON.stringify(credentialStatusFor(id, { home: HOME, contents }))
      expect(serialized).not.toContain(FAKE_KEY)
      expect(serialized).not.toContain(FAKE_JWT)
      expect(serialized).not.toContain('sk-proj')
      expect(serialized).not.toContain('YOUR_API_KEY')
    }
  })
})

describe('unreadable file on the real filesystem', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-health-'))
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('is missing, with the permission fact in the detail', () => {
    // A real 0o600 file owned by someone else, or a 0o000 file, is not ours to
    // read: that is `missing` with the permission fact, never an exception.
    const locked = path.join(tmpRoot, 'auth.json')
    fs.writeFileSync(locked, JSON.stringify({ OPENAI_API_KEY: FAKE_KEY }), { mode: 0o600 })
    fs.chmodSync(locked, 0o000)
    const readableAnyway = ((): boolean => {
      try {
        fs.readFileSync(locked, 'utf8')
        return true
      } catch {
        return false
      }
    })()

    if (!readableAnyway) {
      const fragment = credentialStatusFor('codex', { path: locked })
      expect(fragment.credential).toBe('missing')
      expect(fragment.detail).toContain('not readable')
      expect(fragment.configPath).toBe(locked)
      expect(JSON.stringify(fragment)).not.toContain(FAKE_KEY)
    }
    // A process that can read it anyway (root) still must not leak the value.
    fs.chmodSync(locked, 0o600)
    const asOwner = readHostFile(locked)
    expect(asOwner.ok).toBe(true)
    if (asOwner.ok) expect(asOwner.contents).toContain(FAKE_KEY)
    expect(credentialStatusFor('codex', { path: locked }).detail).not.toContain(FAKE_KEY)
  })
})

describe('redaction primitives', () => {
  it('masks JWTs, prefixed keys and bearer values', () => {
    expect(redactSecrets(`token=${FAKE_JWT}`)).not.toContain(FAKE_JWT)
    expect(redactSecrets(`Authorization: Bearer ${FAKE_JWT}`)).toBe('Authorization: [redacted]')
    expect(redactSecrets(FAKE_KEY)).toBe('[redacted]')
    expect(redactSecrets('OPENAI_API_KEY')).toBe('OPENAI_API_KEY')
    expect(redactSecrets('auth.json: OPENAI_API_KEY set')).toBe('auth.json: OPENAI_API_KEY set')
  })

  it('does not reshape ordinary prose', () => {
    const line = 'settings.json env: OPENAI_API_KEY set (presence only; no network check)'
    expect(redactSecrets(line)).toBe(line)
  })

  it('recognises the placeholder shapes and not a real-looking key', () => {
    expect(looksLikePlaceholder('sk-ant-YOUR_API_KEY_HERE')).toBe(true)
    expect(looksLikePlaceholder('<your-api-key>')).toBe(true)
    expect(looksLikePlaceholder('')).toBe(true)
    expect(looksLikePlaceholder('xxxx')).toBe(true)
    expect(looksLikePlaceholder(FAKE_KEY)).toBe(false)
  })

  it('expands ~ only at the front', () => {
    expect(expandHome('~', HOME)).toBe(HOME)
    expect(expandHome('~/.codex/auth.json', HOME)).toBe(CODEX_PATH)
    expect(expandHome('/absolute/path', HOME)).toBe('/absolute/path')
    expect(expandHome('relative/path', HOME)).toBe('relative/path')
  })
})
