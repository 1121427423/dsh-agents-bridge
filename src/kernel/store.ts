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
  let dirty = false

  function persist(): void {
    if (!dirty) return
    const payload = JSON.stringify(
      { version: STORE_VERSION, sessions: [...table.values()] },
      null,
      2,
    )
    const tmpPath = nextTmpPath(filePath)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
      // Same-directory rename: readers see either the old or the new file.
      fs.renameSync(tmpPath, filePath)
      dirty = false
      logger?.debug('persisted session store', { filePath, sessions: table.size })
    } catch (err) {
      try {
        fs.rmSync(tmpPath, { force: true })
      } catch {
        /* best effort */
      }
      // Degrade, never throw: losing session bookkeeping must not fail the run
      // that triggered the write. The caller (a run settling) has already done
      // its real work by this point.
      logger?.warn('failed to persist session store', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function reload(): readonly StoredSession[] {
    table.clear()
    dirty = false
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
    let dropped = 0
    for (const row of rows) {
      const session = coerceSession(row)
      if (!session) {
        dropped += 1
        continue
      }
      table.set(session.sessionId, session)
    }
    if (dropped > 0) {
      logger?.warn('dropped unreadable session rows', { filePath, dropped })
      dirty = true
    }
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
      // Keep the file bounded: oldest rows first (Map preserves insertion order).
      while (table.size > MAX_RECORDS) {
        const oldest = table.keys().next()
        if (oldest.done) break
        table.delete(oldest.value)
      }
      dirty = true
      persist()
    },
    remove(sessionId) {
      if (!table.delete(sessionId)) return
      dirty = true
      persist()
    },
    flush: persist,
  }
}
