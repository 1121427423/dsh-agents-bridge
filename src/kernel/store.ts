/**
 * Session-mapping store.
 *
 * Only routing metadata is persisted (sessionId → agent / backend session id /
 * cwd / status). Transcripts stay in memory: v1 does not want the write
 * amplification of streaming every event to disk (design doc §7), and `send`
 * only needs the backend session id to resume.
 *
 * Durability rules:
 *   - atomic write: temp file in the same directory, then `rename` (same
 *     filesystem ⇒ rename is atomic, so a reader never sees a half-written
 *     `sessions.json`),
 *   - merge on write: the writer re-reads the file, applies ITS OWN pending
 *     changes to it, and only then rewrites. Two stores over the same
 *     directory therefore both survive — the second writer adds a row instead
 *     of publishing only its own in-memory table and silently dropping the
 *     first writer's row (the lost-update this file used to have),
 *   - a missing or corrupt file degrades to an empty table with a warning —
 *     losing session bookkeeping must never break the bridge.
 *
 * @module dsh-agents-bridge/kernel/store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AgentId, AgentRunStatus, BridgeLogger } from './types.ts'

/** One persisted session mapping. */
export interface StoredSession {
  readonly sessionId: string
  readonly agentId: AgentId
  readonly status: AgentRunStatus
  readonly startedAt: number
  readonly endedAt?: number
  /** The dialect's own conversation id, used as `resumeSessionId` by `send`. */
  readonly backendSessionId?: string
  readonly cwd?: string
  readonly model?: string
  /** Session this run resumes, when it was started by `send`. */
  readonly resumedFrom?: string
  /**
   * Process-group leader pid while the run is live.
   *
   * Persisted so a host that dies mid-run can still reap the detached process
   * TREE it left behind: the child is its own process-group leader (`detached:
   * true`), so the pid is also the pgid. Absent once the run settles, and never
   * trusted blindly on recovery — see `recoverOrphans` in `manager.ts`.
   */
  readonly pid?: number
}

export interface SessionStoreOptions {
  /** Overrides the default `~/.dsh/state/dsh-agents-bridge` directory. */
  readonly dir?: string
  readonly logger?: BridgeLogger
}

export interface SessionStore {
  readonly filePath: string
  readonly records: readonly StoredSession[]
  /** Read from disk; returns the validated rows (never throws). */
  reload(): readonly StoredSession[]
  upsert(record: StoredSession): void
  remove(sessionId: string): void
  /** Write pending changes (no-op when nothing is dirty). */
  flush(): void
}

const STORE_VERSION = 1
const FILE_NAME = 'sessions.json'
const MAX_RECORDS = 500

/**
 * Process-wide temp-file counter.
 *
 * Deliberately NOT per-store-instance. Two stores over the same directory in one
 * process (a second manager after an HMR reload, or a test that builds two) each
 * started their own counter at 0 and therefore chose the SAME temp path — the
 * second `rename` moved a file the first writer had already replaced, and the
 * first writer's records were lost with no error anywhere. One counter per
 * process removes the collision entirely.
 */
let tmpSequence = 0

/** Unique per (process, store instance, write): pid + counter is enough. */
function nextTmpPath(filePath: string): string {
  tmpSequence += 1
  return `${filePath}.${process.pid}.${tmpSequence}.tmp`
}

/** `~/.dsh/state/dsh-agents-bridge`, honouring `DSH_HOME` when set. */
export function defaultStoreDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env['DSH_HOME']?.trim()
  const root = home && home !== '' ? home : path.join(os.homedir(), '.dsh')
  return path.join(root, 'state', 'dsh-agents-bridge')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STATUSES: readonly AgentRunStatus[] = ['running', 'completed', 'failed', 'cancelled', 'timeout']

function coerceSession(value: unknown): StoredSession | undefined {
  if (!isRecord(value)) return undefined
  const { sessionId, agentId, status, startedAt } = value
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof agentId !== 'string' || agentId === '') return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (typeof status !== 'string' || !STATUSES.includes(status as AgentRunStatus)) return undefined
  const out: Record<string, unknown> = {
    sessionId,
    agentId,
    status,
    startedAt,
  }
  for (const key of ['endedAt'] as const) {
    const raw = value[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
  }
  // `pid` is the one numeric field that is not a timestamp: a live process-group
  // id must be a positive integer, and anything else is treated as absent rather
  // than forwarded to `process.kill`.
  const pid = value['pid']
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) out['pid'] = pid
  for (const key of ['backendSessionId', 'cwd', 'model', 'resumedFrom'] as const) {
    const raw = value[key]
    if (typeof raw === 'string' && raw !== '') out[key] = raw
  }
  return out as unknown as StoredSession
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const logger = options.logger
  const dir = options.dir ?? defaultStoreDir()
  const filePath = path.join(dir, FILE_NAME)

  const table = new Map<string, StoredSession>()
  /**
   * This store's changes not yet merged onto disk.
   *
   * `{ record }` is an upsert, `{}` is a removal. Tracking changes rather than
   * a single `dirty` bit is what makes the write a MERGE: `persist()` re-reads
   * whatever is on disk (possibly written by another store instance over the
   * same directory) and applies only these entries, so a second writer cannot
   * silently drop a row it never saw.
   */
  const pending = new Map<string, { readonly record?: StoredSession }>()
  /** Set when a read had to drop unreadable rows, so the file gets rewritten. */
  let needsRewrite = false

  /** Read + validate the on-disk rows. Never throws: degrades to `[]`. */
  function readDiskRows(): readonly StoredSession[] {
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        logger?.warn('could not read session store; starting empty', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      logger?.warn('session store is corrupt; starting empty', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed['sessions'])
        ? parsed['sessions']
        : undefined
    if (!rows) {
      logger?.warn('session store has an unexpected shape; starting empty', { filePath })
      return []
    }
    const out: StoredSession[] = []
    let dropped = 0
    for (const row of rows) {
      const session = coerceSession(row)
      if (!session) {
        dropped += 1
        continue
      }
      out.push(session)
    }
    if (dropped > 0) {
      logger?.warn('dropped unreadable session rows', { filePath, dropped })
      needsRewrite = true
    }
    return out
  }

  /** Apply this store's pending changes on top of `rows` (a fresh Map). */
  function mergePending(rows: readonly StoredSession[]): Map<string, StoredSession> {
    const merged = new Map<string, StoredSession>()
    for (const row of rows) merged.set(row.sessionId, row)
    for (const [sessionId, change] of pending) {
      if (change.record === undefined) merged.delete(sessionId)
      else merged.set(sessionId, change.record)
    }
    // Keep the file bounded: oldest rows first (Map preserves insertion order).
    while (merged.size > MAX_RECORDS) {
      const oldest = merged.keys().next()
      if (oldest.done) break
      merged.delete(oldest.value)
    }
    return merged
  }

  function adopt(merged: ReadonlyMap<string, StoredSession>): void {
    table.clear()
    for (const [sessionId, record] of merged) table.set(sessionId, record)
  }

  function persist(): void {
    if (pending.size === 0 && !needsRewrite) return
    // Re-read the file so a row another writer added between our last flush and
    // this one is NOT lost (the lost-update this store used to have). Validated
    // `readDiskRows` also means a corrupt file is repaired in place.
    const merged = mergePending(readDiskRows())
    const payload = JSON.stringify(
      { version: STORE_VERSION, sessions: [...merged.values()] },
      null,
      2,
    )
    const tmpPath = nextTmpPath(filePath)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
      // Same-directory rename: readers see either the old or the new file.
      fs.renameSync(tmpPath, filePath)
      adopt(merged)
      pending.clear()
      needsRewrite = false
      logger?.debug('persisted session store', { filePath, sessions: merged.size })
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true })
      } catch {
        /* best effort */
      }
      // Degrade, never throw: losing session bookkeeping must not fail the run
      // that triggered the write. The caller (a run settling) has already done
      // its real work by this point. `pending` is deliberately NOT cleared: a
      // transient write failure must not permanently drop a record.
      logger?.warn('failed to persist session store', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function reload(): readonly StoredSession[] {
    // Pending (unsaved) local changes are folded back in: a reload must not be
    // able to discard a record this store already accepted.
    const merged = mergePending(readDiskRows())
    adopt(merged)
    return [...table.values()]
  }

  return {
    filePath,
    get records() {
      return [...table.values()]
    },
    reload,
    upsert(record) {
      table.set(record.sessionId, record)
      while (table.size > MAX_RECORDS) {
        const oldest = table.keys().next()
        if (oldest.done) break
        table.delete(oldest.value)
      }
      pending.set(record.sessionId, { record })
      persist()
    },
    remove(sessionId) {
      if (!table.delete(sessionId)) return
      pending.set(sessionId, {})
      persist()
    },
    flush: persist,
  }
}
