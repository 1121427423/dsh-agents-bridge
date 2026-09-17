/**
 * Store robustness: concurrent writers, corrupt files, bounds, write failure.
 *
 * The store is bookkeeping, not data of record — its whole design brief is that
 * LOSING it must never break a run (design doc §7). That makes the interesting
 * tests the ones where the filesystem misbehaves: a half-written file, a second
 * writer racing the first, a directory that cannot be written to at all.
 *
 * `tests/kernel/store.test.ts` covers the happy path and the shape validation.
 * This suite covers what happens when the write itself goes wrong.
 *
 * @module tests/kernel/store-robustness
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSessionStore, type StoredSession } from '../../src/kernel/store.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-store-r-'))
})

afterEach(() => {
  // Restore permissions before deleting, or a chmod-ed dir cannot be removed.
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* best effort */
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function record(sessionId: string, extra: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId,
    agentId: 'claude',
    status: 'completed',
    startedAt: 1_000,
    endedAt: 2_000,
    backendSessionId: 'backend-1',
    cwd: '/tmp/work',
    ...extra,
  } as StoredSession
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('concurrent writers', () => {
  it('does not lose a row another store added (merge on write)', () => {
    // IM-6, reproduced by the reviewer against the old whole-table write:
    //   s1.upsert(A)            disk = A
    //   s2(reload).upsert(B)    disk = A,B
    //   s1.upsert(C)  <-- the write published only s1's table, so disk = A,C
    //                      and B vanished permanently.
    // A write now re-reads the file and merges this store's pending change onto
    // it, so the last writer adds rather than replaces.
    const s1 = createSessionStore({ dir })
    s1.upsert(record('sess_A'))

    const s2 = createSessionStore({ dir })
    s2.reload()
    s2.upsert(record('sess_B'))

    s1.upsert(record('sess_C'))

    const fresh = createSessionStore({ dir }).reload()
    expect(fresh.map((r) => r.sessionId).sort()).toEqual(['sess_A', 'sess_B', 'sess_C'])
  })

  it('keeps a concurrent writer\'s removal from resurrecting', () => {
    const s1 = createSessionStore({ dir })
    s1.upsert(record('sess_A'))
    const s2 = createSessionStore({ dir })
    s2.reload()
    s2.upsert(record('sess_B'))

    s2.remove('sess_A')
    s1.upsert(record('sess_C'))

    const fresh = createSessionStore({ dir }).reload()
    expect(fresh.map((r) => r.sessionId).sort()).toEqual(['sess_B', 'sess_C'])
  })

  it('two instances in one process do not collide on the temp filename', () => {
    // Regression (two bugs, one test):
    //   1. the temp name used to be `<file>.<pid>.<per-instance-counter>`, so two
    //      stores over the same directory both chose `...<pid>.0.tmp`, and
    //   2. the write used to publish only the writer's OWN table, so `b` silently
    //      dropped `a`'s row (IM-6, the lost update).
    // Writes now MERGE onto a re-read of the file, so both rows survive and a
    // stale temp carrying the old colliding name can never be renamed over the
    // real store.
    const a = createSessionStore({ dir })
    const b = createSessionStore({ dir })

    a.upsert(record('sess_a'))
    // A stale temp with the OLD colliding name must not be renamed over the
    // real store by a later write.
    const staleName = path.join(dir, `sessions.json.${process.pid}.0.tmp`)
    fs.writeFileSync(staleName, 'GARBAGE FROM ANOTHER WRITER')
    b.upsert(record('sess_b'))

    const revived = createSessionStore({ dir }).reload()
    // BOTH writers survive: `b` merged onto the file `a` had already written
    // instead of overwriting it with its own single-row table.
    expect(revived.map((r) => r.sessionId)).toEqual(['sess_a', 'sess_b'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))).toBeTruthy()
  })

  it('leaves no temp file behind after a burst of writes from two instances', () => {
    const a = createSessionStore({ dir })
    const b = createSessionStore({ dir })
    for (let index = 0; index < 50; index += 1) {
      a.upsert(record(`a_${index}`, { startedAt: index }))
      b.upsert(record(`b_${index}`, { startedAt: index }))
    }
    // The only file a reader may find is the store itself.
    expect(fs.readdirSync(dir)).toEqual(['sessions.json'])
  })

  it('produces a file that always parses, never a partial write', () => {
    const store = createSessionStore({ dir })
    for (let index = 0; index < 30; index += 1) {
      store.upsert(record(`sess_${index}`, { startedAt: index }))
      // Read after every single write: a torn file would throw here.
      const raw = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')
      expect(() => JSON.parse(raw)).not.toThrow()
      expect(JSON.parse(raw).version).toBe(1)
    }
  })
})

describe('corrupt and half-written files degrade to empty', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['truncated JSON', '{"version":1,"sessions":[{"sessionId":"sess_1"'],
    ['empty file', ''],
    ['whitespace only', '   \n  '],
    ['not JSON at all', 'this is not json'],
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['an array of garbage', '[1,2,3]'],
    ['wrong shape', '{"version":1,"sessions":"nope"}'],
  ]

  for (const [label, contents] of cases) {
    it(`starts empty for ${label}, with a warning and no throw`, () => {
      fs.writeFileSync(path.join(dir, 'sessions.json'), contents)
      const log = logger()
      const store = createSessionStore({ dir, logger: log })

      expect(() => store.reload()).not.toThrow()
      expect(store.reload()).toEqual([])
      // An unusable file is worth a warning; it is not worth an exception.
      expect(log.warn).toHaveBeenCalled()
    })
  }

  it('still accepts new writes after degrading from a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{corrupt')
    const store = createSessionStore({ dir })
    store.reload()
    store.upsert(record('sess_after'))
    expect(createSessionStore({ dir }).reload().map((r) => r.sessionId)).toEqual(['sess_after'])
  })

  it('keeps the valid rows when only some are unreadable', () => {
    fs.writeFileSync(
      path.join(dir, 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [record('sess_ok'), { sessionId: 42 }, null, record('sess_ok2')],
      }),
    )
    const store = createSessionStore({ dir })
    expect(store.reload().map((r) => r.sessionId).sort()).toEqual(['sess_ok', 'sess_ok2'])
  })
})

describe('bounds', () => {
  it('never grows past the cap, and keeps the most recent rows', () => {
    const store = createSessionStore({ dir })
    const total = 1_200
    for (let index = 0; index < total; index += 1) {
      store.upsert(record(`sess_${index}`, { startedAt: index }))
    }
    expect(store.records.length).toBeLessThanOrEqual(500)
    // The newest survive; the oldest are evicted.
    expect(store.records.some((r) => r.sessionId === `sess_${total - 1}`)).toBe(true)
    expect(store.records.some((r) => r.sessionId === 'sess_0')).toBe(false)
    // And the bound holds on the file, not just in memory.
    expect(createSessionStore({ dir }).reload().length).toBeLessThanOrEqual(500)
  })

  it('re-upserting an existing session does not grow the table', () => {
    const store = createSessionStore({ dir })
    for (let index = 0; index < 100; index += 1) {
      store.upsert(record('sess_same', { startedAt: index }))
    }
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.startedAt).toBe(99)
  })

  it('a bounded write is still valid JSON the next instance can read', () => {
    const store = createSessionStore({ dir })
    for (let index = 0; index < 800; index += 1) {
      store.upsert(record(`sess_${index}`, { startedAt: index }))
    }
    const raw = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(JSON.parse(raw).sessions.length).toBeLessThanOrEqual(500)
  })
})

describe('write failure degrades instead of failing the caller', () => {
  it('does not throw when the store directory cannot be written', () => {
    const log = logger()
    const store = createSessionStore({ dir, logger: log })
    // Read-only directory: mkdir succeeds (already there) but the temp write does not.
    fs.chmodSync(dir, 0o500)

    expect(() => store.upsert(record('sess_1'))).not.toThrow()
    expect(log.warn).toHaveBeenCalled()
  })

  it('keeps the in-memory table usable after a failed write', () => {
    const store = createSessionStore({ dir })
    fs.chmodSync(dir, 0o500)
    store.upsert(record('sess_1'))
    // The run that triggered the write is unaffected: the record is still there
    // for `status()`/`list()`, only durability was lost.
    expect(store.records.map((r) => r.sessionId)).toEqual(['sess_1'])
    fs.chmodSync(dir, 0o700)
  })

  it('recovers on the next write once the directory is writable again', () => {
    const store = createSessionStore({ dir })
    fs.chmodSync(dir, 0o500)
    store.upsert(record('sess_lost'))
    fs.chmodSync(dir, 0o700)

    store.upsert(record('sess_saved'))
    // Both rows are on disk: a failed write leaves the table dirty, so the next
    // successful write flushes everything rather than only the newest record.
    // That is the desired behaviour — a transient permission error must not
    // permanently drop a record the bridge already accepted.
    expect(createSessionStore({ dir }).reload().map((r) => r.sessionId)).toEqual([
      'sess_lost',
      'sess_saved',
    ])
  })

  it('leaves no temp file behind when the write fails', () => {
    const store = createSessionStore({ dir })
    fs.chmodSync(dir, 0o500)
    store.upsert(record('sess_1'))
    fs.chmodSync(dir, 0o700)
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('treats an unwritable store dir as a warning, not a bridge failure', () => {
    // A nested path that cannot be created (a FILE sits where the dir should be).
    const blocked = path.join(dir, 'blocker')
    fs.writeFileSync(blocked, 'not a directory')
    const log = logger()
    const store = createSessionStore({ dir: path.join(blocked, 'nested'), logger: log })
    expect(() => store.upsert(record('sess_1'))).not.toThrow()
    expect(log.warn).toHaveBeenCalled()
    expect(store.records).toHaveLength(1)
  })
})
