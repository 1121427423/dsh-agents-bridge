import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSessionStore, defaultStoreDir } from '../../src/kernel/store.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-store-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function record(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    agentId: 'claude',
    status: 'completed' as const,
    startedAt: 1_000,
    endedAt: 2_000,
    backendSessionId: 'backend-1',
    cwd: '/tmp/work',
    ...extra,
  }
}

describe('createSessionStore', () => {
  it('round-trips session mappings through a fresh instance', () => {
    const store = createSessionStore({ dir })
    store.upsert(record('sess_1'))
    store.upsert(record('sess_2', { status: 'timeout', backendSessionId: undefined }))

    const reopened = createSessionStore({ dir })
    const rows = reopened.reload()
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['sess_1', 'sess_2'])
    const first = rows.find((r) => r.sessionId === 'sess_1')
    expect(first?.backendSessionId).toBe('backend-1')
    expect(first?.cwd).toBe('/tmp/work')
    expect(rows.find((r) => r.sessionId === 'sess_2')?.status).toBe('timeout')
  })

  it('writes atomically: no temp files survive the rename', () => {
    const store = createSessionStore({ dir })
    store.upsert(record('sess_atomic'))

    const entries = fs.readdirSync(dir)
    expect(entries).toEqual(['sessions.json'])
    const parsed = JSON.parse(fs.readFileSync(store.filePath, 'utf8')) as {
      version: number
      sessions: unknown[]
    }
    expect(parsed.version).toBe(1)
    expect(parsed.sessions).toHaveLength(1)
  })

  it('does not record a transcript', () => {
    const store = createSessionStore({ dir })
    store.upsert(record('sess_meta'))
    const raw = fs.readFileSync(store.filePath, 'utf8')
    expect(raw).not.toContain('messages')
    expect(raw).not.toContain('transcript')
  })

  it('degrades to an empty table when the file is corrupt', () => {
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{ this is not json', 'utf8')
    const warn = vi.fn()
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }
    const store = createSessionStore({ dir, logger })
    expect(store.reload()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      'session store is corrupt; starting empty',
      expect.objectContaining({ filePath: store.filePath }),
    )
  })

  it('degrades when the shape is unexpected', () => {
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: {} }), 'utf8')
    const warn = vi.fn()
    const store = createSessionStore({ dir, logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } })
    expect(store.reload()).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('drops unreadable rows and keeps valid ones', () => {
    fs.writeFileSync(
      path.join(dir, 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [{ sessionId: 'ok', agentId: 'claude', status: 'failed', startedAt: 5 }, { nope: true }],
      }),
      'utf8',
    )
    const warn = vi.fn()
    const store = createSessionStore({ dir, logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } })
    expect(store.reload().map((r) => r.sessionId)).toEqual(['ok'])
    expect(warn).toHaveBeenCalledWith('dropped unreadable session rows', expect.objectContaining({ dropped: 1 }))
  })

  it('starts empty when the file does not exist', () => {
    const store = createSessionStore({ dir: path.join(dir, 'nested', 'deeper') })
    expect(store.reload()).toEqual([])
    store.upsert(record('sess_nested'))
    expect(fs.existsSync(store.filePath)).toBe(true)
  })

  it('removes rows', () => {
    const store = createSessionStore({ dir })
    store.upsert(record('sess_keep'))
    store.upsert(record('sess_drop'))
    store.remove('sess_drop')
    expect(store.records.map((r) => r.sessionId)).toEqual(['sess_keep'])
    expect(createSessionStore({ dir }).reload().map((r) => r.sessionId)).toEqual(['sess_keep'])
  })

  it('keeps the file bounded', () => {
    const store = createSessionStore({ dir })
    for (let index = 0; index < 520; index += 1) {
      store.upsert(record(`sess_${index}`, { startedAt: index }))
    }
    expect(store.records.length).toBeLessThanOrEqual(500)
    expect(store.records.some((r) => r.sessionId === 'sess_519')).toBe(true)
    expect(store.records.some((r) => r.sessionId === 'sess_0')).toBe(false)
  })

  it('defaults to ~/.dsh/state/dsh-agents-bridge (honouring DSH_HOME)', () => {
    expect(defaultStoreDir({})).toBe(path.join(os.homedir(), '.dsh', 'state', 'dsh-agents-bridge'))
    expect(defaultStoreDir({ DSH_HOME: '/custom/dsh' })).toBe(
      path.join('/custom/dsh', 'state', 'dsh-agents-bridge'),
    )
  })
})
