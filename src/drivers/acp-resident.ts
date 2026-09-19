/**
 * dsh-agents-bridge / drivers — ACP resident process pool.
 *
 * An ACP engine is a PERSISTENT SERVER: after answering `session/prompt` it
 * keeps running until its stdin closes or it is signalled. The driver normally
 * closes stdin after every turn, which makes every `agents_run` pay the full
 * cold-start cost (spawn → initialize → command-table load → session/new). This
 * pool is the other half of that decision: when residency is enabled, a
 * completed turn leaves the engine process alive and parked here, and the next
 * run adopts it and skips everything except the prompt itself.
 *
 * The pool is keyed by `agentId::cwd` — two identities or working directories
 * never share a process. An entry is single-user (`inUse`), so a concurrent run
 * simply spawns a second process instead of queueing on a hot one. Idle entries
 * are terminated after `idleMs` (default 1h) and `dispose()` tears everything
 * down on plugin unload.
 *
 * @module dsh-agents-bridge/drivers/acp-resident
 */

import type { BridgeLogger } from '../kernel/types.ts'
import type { SpawnedProcess } from './argv.ts'
import { clampTimerDelay } from './argv.ts'
import { AcpClient } from './acp.ts'

/** One live engine process parked in the pool. */
export interface AcpResidentEntry {
  readonly key: string
  readonly agentId: string
  readonly cwd: string
  readonly client: AcpClient
  readonly child: SpawnedProcess
  /** The backend session id the parked process is currently bound to. */
  sessionId: string
  lastUsedAt: number
  /** True while a run owns the entry; the pool never hands it out twice. */
  inUse: boolean
  /** Set once the child process has exited. */
  dead: boolean
  /** Idle-eviction timer; owned by the pool. */
  idleTimer: NodeJS.Timeout | undefined
}

export interface AcpResidentPool {
  /** False when residency is disabled (`idleMs <= 0`); acquire/release are no-ops. */
  readonly enabled: boolean
  /** Number of parked processes. */
  readonly size: number
  /**
   * Take a live, idle entry for `key`, marking it in use. Returns undefined when
   * no compatible entry exists (or the only one is busy/dead).
   */
  acquire(key: string): AcpResidentEntry | undefined
  /**
   * Park `entry` again after a completed run (creating it on first use), bind it
   * to `sessionId`, and re-arm the idle eviction timer.
   */
  release(entry: AcpResidentEntry, sessionId: string): void
  /** Terminate and forget the entry for `key`, if any. */
  evict(key: string): Promise<void>
  /** Terminate every parked process (plugin unload). */
  dispose(): Promise<void>
}

export interface AcpResidentPoolOptions {
  /** Idle time before a parked process is terminated; `<= 0` disables residency. */
  readonly idleMs: number
  readonly logger: BridgeLogger
  readonly now?: () => number
}

export function createAcpResidentPool(options: AcpResidentPoolOptions): AcpResidentPool {
  const { idleMs, logger } = options
  const now = options.now ?? Date.now
  const entries = new Map<string, AcpResidentEntry>()

  function clearIdle(entry: AcpResidentEntry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  function armIdle(entry: AcpResidentEntry): void {
    clearIdle(entry)
    if (idleMs <= 0) return
    // An entry a run currently HOLDS must never carry an idle timer. `acquire`
    // keeps the taken entry in the map and relies on this invariant (it clears
    // the timer once); a `release` for a different entry must not re-arm it, or
    // the timer would `evict(entry.key)` and kill the engine mid-run.
    if (entry.inUse) return
    const timer = setTimeout(() => {
      // Defensive, and deliberately NOT rescheduled: the invariant above should
      // make this unreachable, but a timer that outlived a `acquire` must not
      // evict a process a run is using.
      if (entry.inUse) return
      logger.debug('acp resident idle eviction', {
        key: entry.key,
        agentId: entry.agentId,
        idleMs,
      })
      void evict(entry.key)
    }, clampTimerDelay(idleMs))
    if (typeof timer.unref === 'function') timer.unref()
    entry.idleTimer = timer
  }

  /** Forget an entry the moment its child process dies on its own. */
  function watchExit(entry: AcpResidentEntry): void {
    void entry.child.exited
      .then(() => {
        entry.dead = true
        clearIdle(entry)
        if (!entry.inUse) entries.delete(entry.key)
      })
      .catch(() => {})
  }

  function acquire(key: string): AcpResidentEntry | undefined {
    const entry = entries.get(key)
    if (entry === undefined) return undefined
    if (entry.dead) {
      entries.delete(key)
      return undefined
    }
    if (entry.inUse) return undefined
    entry.inUse = true
    clearIdle(entry)
    return entry
  }

  function release(entry: AcpResidentEntry, sessionId: string): void {
    entry.sessionId = sessionId
    entry.lastUsedAt = now()
    entry.inUse = false
    if (entry.dead) {
      entries.delete(entry.key)
      return
    }
    const parked = entries.get(entry.key)
    if (parked !== undefined && parked !== entry) {
      // A concurrent run already parked a process for this key. Keep that one and
      // TERMINATE this surplus instead of dropping it: an entry that is not in
      // the map is invisible to `dispose()` (so it would outlive plugin unload)
      // and its idle timer would evict the PARKED entry by key instead of itself.
      clearIdle(entry)
      void entry.client.dispose().catch(() => {})
      void entry.child.terminate().catch(() => {})
      armIdle(parked)
      return
    }
    entries.set(entry.key, entry)
    watchExit(entry)
    armIdle(entry)
  }

  async function evict(key: string): Promise<void> {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    clearIdle(entry)
    entry.dead = true
    // `dispose()` owns the engine-created terminals; `terminate()` reaches the
    // engine process group itself. Both are idempotent and safe to fire here.
    await entry.client.dispose().catch(() => {})
    await entry.child.terminate().catch(() => {})
  }

  async function dispose(): Promise<void> {
    const keys = [...entries.keys()]
    await Promise.allSettled(keys.map((key) => evict(key)))
  }

  return {
    enabled: idleMs > 0,
    get size() {
      return entries.size
    },
    acquire,
    release,
    evict,
    dispose,
  }
}