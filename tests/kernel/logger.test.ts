import { describe, expect, it } from 'vitest'

import {
  REDACTED,
  createLogger,
  isSensitiveKey,
  looksLikeSecret,
  redactArgs,
  redactFields,
} from '../../src/kernel/logger.ts'

describe('logger redaction', () => {
  it('classifies field names without over-matching ordinary words', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('session_token')).toBe(true)
    expect(isSensitiveKey('authorization')).toBe(true)
    expect(isSensitiveKey('key')).toBe(true)
    expect(isSensitiveKey('privateKeys')).toBe(true)
    // must survive: these are not credentials
    expect(isSensitiveKey('author')).toBe(false)
    expect(isSensitiveKey('keyCount')).toBe(false)
    expect(isSensitiveKey('monkey')).toBe(false)
  })

  it('recognizes well-known token shapes', () => {
    expect(looksLikeSecret('sk-abcdefghijklmnop')).toBe(true)
    expect(looksLikeSecret('ghp_abcdefghijklmnopqrst')).toBe(true)
    expect(looksLikeSecret('Authorization: Bearer abcdefghijkl')).toBe(true)
    expect(looksLikeSecret('opus')).toBe(false)
    expect(looksLikeSecret('please summarize this file')).toBe(false)
  })

  it('redacts sensitive fields recursively and keeps the rest', () => {
    const input = {
      model: 'opus',
      apiKey: 'sk-abcdefghijklmnop',
      nested: { headers: { cookie: 'a=b' }, note: 'ok' },
      items: [{ token: 'abc' }, 'plain'],
    }
    const out = redactFields(input)
    expect(out).toEqual({
      model: 'opus',
      apiKey: REDACTED,
      nested: { headers: { cookie: REDACTED }, note: 'ok' },
      items: [{ token: REDACTED }, 'plain'],
    })
    // input is untouched
    expect(input.apiKey).toBe('sk-abcdefghijklmnop')
  })

  it('redacts argv values after sensitive flags and token-shaped args', () => {
    expect(redactArgs(['claude', '--api-key', 'sk-abcdefghijklmnop', '--model', 'opus'])).toEqual([
      'claude',
      '--api-key',
      REDACTED,
      '--model',
      'opus',
    ])
    expect(redactArgs(['--token=abc123'])).toEqual([`--token=${REDACTED}`])
    expect(redactArgs(['--header', 'Authorization: Bearer abcdefghijkl'])).toEqual(['--header', REDACTED])
    expect(redactArgs(['--message', 'hello world'])).toEqual(['--message', 'hello world'])
  })

  it('never lets a secret reach the sink', () => {
    const lines: string[] = []
    const log = createLogger('t', { sink: (_level, line) => lines.push(line), debugEnabled: true })
    log.info('spawning', {
      argv: ['--api-key', 'sk-abcdefghijklmnop'],
      apiKey: 'sk-abcdefghijklmnop',
      model: 'opus',
    })
    log.debug('still here')
    expect(lines).toHaveLength(2)
    const joined = lines.join('\n')
    expect(joined).not.toContain('sk-abcdefghijklmnop')
    expect(joined).toContain(REDACTED)
    expect(joined).toContain('"model":"opus"')
  })

  it('prefixes child scopes and gates debug output', () => {
    const lines: string[] = []
    const log = createLogger('a', {
      sink: (level, line) => lines.push(`${level}|${line}`),
      debugEnabled: false,
    })
    expect(typeof log.child).toBe('function')
    log.child?.('b').debug('hidden')
    log.child?.('b').warn('shown')
    expect(lines).toEqual(['warn|[dsh-agents-bridge:a:b] shown'])
  })

  it('survives unserializable and circular payloads', () => {
    const lines: string[] = []
    const log = createLogger('t', { sink: (_level, line) => lines.push(line) })
    const circular: Record<string, unknown> = { model: 'opus' }
    circular['self'] = circular
    expect(() => log.info('circular', circular)).not.toThrow()
    expect(lines).toHaveLength(1)
  })
})
