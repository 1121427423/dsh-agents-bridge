/**
 * ACP resident pool: a completed turn leaves the engine process alive, and the
 * next run adopts it and skips the cold start (spawn → initialize →
 * command-table load → session/new).
 *
 * These tests spawn the REAL `tests/fixtures/fake-acp-cli.mjs` child, exactly
 * like the rest of the ACP driver suite — process reuse is the whole feature,
 * so it must be asserted against real pipes and a real pid, not a mock.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRunOptions, DriverDeps } from '../../src/kernel/types.ts'
import type { DriverRuntime, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import { createAcpBackend } from '../../src/drivers/acp.ts'
import { createAcpResidentPool, type AcpResidentEntry } from '../../src/drivers/acp-resident.ts'

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-acp-cli.mjs', import.meta.url))

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** A runtime that really spawns, so pipes, pids and exit codes are real. */
const realRuntime: DriverRuntime = {
  spawn(spec: SpawnSpec): SpawnedProcess {
    const child = nodeSpawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    const exited = new Promise<{ code: number | null; signal: string | null; error?: string }>(
      (resolve) => {
        child.on('error', (err) => {
          if (settled) return
          settled = true
          resolve({ code: null, signal: null, error: err.message })
        })
        child.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          resolve({ code, signal })
        })
      },
    )
    return {
      pid: child.pid ?? -1,
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      exited,
      terminate() {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        return Promise.resolve()
      },
    }
  },
}

function makeDeps(scenario = 'success'): DriverDeps {
  return {
    command: {
      executable: process.execPath,
      argsPrefix: [FIXTURE, '--scenario', scenario],
      protocolArgs: ['--acp'],
    },
    env: {},
    logger: silentLogger,
  }
}

function makeRun(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return { agent: 'qoderclicn', prompt: 'Reply with exactly: PONG', cwd: '/tmp', ...overrides }
}

/** Pids the suite may have left parked; a RED test must not leak the fixture. */
const leftoverPids: number[] = []

afterEach(() => {
  for (const pid of leftoverPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForPidGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  return waitFor(() => !pidAlive(pid), timeoutMs)
}

describe('acp resident pool', () => {
  it('reuses the same engine process for a second run, skipping the cold start', async () => {
    const pool = createAcpResidentPool({ idleMs: 60_000, logger: silentLogger })
    const backend = createAcpBackend(makeDeps(), realRuntime, pool)

    const first = await backend.run(makeRun(), makeDeps(), new AbortController().signal)
    const firstResult = await first.done
    expect(firstResult.status).toBe('completed')
    expect(firstResult.text).toBe('The answer is 41.')
    const firstPid = first.pid
    expect(firstPid).toBeTypeOf('number')
    if (firstPid !== undefined) leftoverPids.push(firstPid)
    expect(pool.size).toBe(1)

    // The second run must reuse the SAME child process: no spawn, no initialize,
    // no command-table load — just session/new + prompt on the parked engine.
    const second = await backend.run(makeRun(), makeDeps(), new AbortController().signal)
    const secondResult = await second.done
    expect(secondResult.status).toBe('completed')
    expect(secondResult.text).toBe('The answer is 41.')
    expect(second.pid).toBe(firstPid)
    expect(pool.size).toBe(1)

    await pool.dispose()
    expect(pool.size).toBe(0)
    if (firstPid !== undefined) {
      expect(await waitForPidGone(firstPid)).toBe(true)
    }
  })

  it('keeps exactly ONE process when two runs for the SAME key overlap', async () => {
    // The pool never hands one process to two runs, so two OVERLAPPING runs on
    // the same agent+cwd each spawn. Both then reach `release` — and the pool
    // must keep exactly one: park the first, TERMINATE the second. Before this
    // was fixed the second was dropped from the map (so `dispose()` could never
    // reach it) while its idle timer evicted the PARKED entry instead — the
    // orphan then lived for the life of the host.
    const pool = createAcpResidentPool({ idleMs: 60_000, logger: silentLogger })
    const backend = createAcpBackend(makeDeps(), realRuntime, pool)

    const [first, second] = await Promise.all([
      backend.run(makeRun(), makeDeps(), new AbortController().signal),
      backend.run(makeRun(), makeDeps(), new AbortController().signal),
    ])
    const [firstResult, secondResult] = await Promise.all([first.done, second.done])
    expect(firstResult.status).toBe('completed')
    expect(secondResult.status).toBe('completed')

    // Both really spawned their OWN process — otherwise the overlap never
    // happened and the assertions below would be vacuous.
    const pids = [first.pid, second.pid].filter((pid): pid is number => pid !== undefined)
    expect(pids).toHaveLength(2)
    expect(pids[0]).not.toBe(pids[1])
    leftoverPids.push(...pids)

    expect(pool.size).toBe(1)
    // Exactly one survives `release`: the surplus was terminated, not orphaned.
    // 5s rather than the 3s default: this waits on a real SIGTERM→exit under a
    // full-suite load, and a false red here would look like the leak again.
    expect(await waitFor(() => pids.filter(pidAlive).length === 1, 5_000)).toBe(true)

    // …and the process the pool still holds is the one `dispose()` reaps.
    const survivor = pids.find((pid) => pidAlive(pid))
    expect(survivor).toBeTypeOf('number')
    await pool.dispose()
    expect(pool.size).toBe(0)
    if (survivor !== undefined) {
      expect(await waitForPidGone(survivor, 5_000)).toBe(true)
    }
  })

  it('never evicts an entry a run is HOLDING, even when a concurrent run finishes', async () => {
    // `acquire` keeps the taken entry IN the map and only clears its timer, so a
    // `release` for a DIFFERENT (surplus) entry must not re-arm a timer on it:
    // that timer fires `evict(key)` and SIGTERMs the engine a live run is using.
    // Real pids, so "not evicted" is observable rather than asserted in the
    // abstract.
    const pool = createAcpResidentPool({ idleMs: 150, logger: silentLogger })
    const spawnChild = (): SpawnedProcess => {
      const child = nodeSpawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] })
      return {
        pid: child.pid ?? -1,
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr!,
        exited: new Promise((resolve) => {
          child.on('exit', (code, signal) => resolve({ code, signal }))
        }),
        terminate() {
          try {
            child.kill('SIGTERM')
          } catch {
            /* already gone */
          }
          return Promise.resolve()
        },
      }
    }
    const entryOf = (child: SpawnedProcess, sessionId: string): AcpResidentEntry => ({
      key: 'qoderclicn::/tmp',
      agentId: 'qoderclicn',
      cwd: '/tmp',
      client: { dispose: async () => {} } as unknown as AcpResidentEntry['client'],
      child,
      sessionId,
      lastUsedAt: 0,
      inUse: true,
      dead: false,
      idleTimer: undefined,
    })

    const heldChild = spawnChild()
    const surplusChild = spawnChild()
    const heldPid = heldChild.pid ?? -1
    leftoverPids.push(heldPid, surplusChild.pid ?? -1)

    pool.release(entryOf(heldChild, 'held'), 'held')
    const held = pool.acquire('qoderclicn::/tmp')
    expect(held).toBeDefined()
    expect(held?.inUse).toBe(true)

    // A concurrent run finishes while the other run still HOLDS its process.
    pool.release(entryOf(surplusChild, 'surplus'), 'surplus')

    // Past the idle window the holder must still be alive and still in use.
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(held?.inUse).toBe(true)
    expect(pidAlive(heldPid)).toBe(true)

    await pool.dispose()
  })

  it('falls back to the handshake when a later dial on an adopted client emits no option update', async () => {
    // Exerciser for the reused-client fallback. The fixture refreshes the option
    // set only for the FIRST dial on a process (`--notify-set-model-once`), so
    // the SECOND dial — which lands on the SAME, adopted `AcpClient` — has no
    // notification of its own. The driver must fall back to this session's
    // handshake instead of reading back the previous conversation's capture and
    // passing it off as `post-selection`.
    const pool = createAcpResidentPool({ idleMs: 60_000, logger: silentLogger })
    const logs: string[] = []
    const recordingLogger: DriverDeps['logger'] = {
      ...silentLogger,
      debug: (message: string, fields?: Record<string, unknown>) => {
        logs.push(`${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`)
      },
    }
    const deps: DriverDeps = {
      command: {
        executable: process.execPath,
        argsPrefix: [FIXTURE, '--scenario', 'success', '--notify-set-model-once'],
        protocolArgs: ['--acp'],
      },
      env: {},
      logger: recordingLogger,
    }
    const backend = createAcpBackend(deps, realRuntime, pool)

    // Turn 1 dials (its notification IS emitted) and parks the process.
    const first = await backend.run(
      makeRun({ model: 'default-model' }),
      deps,
      new AbortController().signal,
    )
    const firstResult = await first.done
    expect(firstResult.status).toBe('completed')
    if (first.pid !== undefined) leftoverPids.push(first.pid)
    expect(pool.size).toBe(1)

    // Turn 2 adopts it; this dial emits no notification.
    logs.length = 0
    const second = await backend.run(
      makeRun({ model: 'fast-model' }),
      deps,
      new AbortController().signal,
    )
    const secondResult = await second.done
    expect(secondResult.status).toBe('completed')
    expect(second.pid).toBe(first.pid) // adopted, not a fresh spawn

    const turn2 = logs.join('\n')
    expect(turn2).toContain('acp set_model emitted no config_option_update')
    expect(turn2).toContain('"optionSetEchoed":false')
    expect(turn2).not.toContain('"optionSetEchoed":true')

    await pool.dispose()
  })

  it('reuses the same process and backend session on resume (agents_send path)', async () => {
    const pool = createAcpResidentPool({ idleMs: 60_000, logger: silentLogger })
    const backend = createAcpBackend(makeDeps(), realRuntime, pool)

    const first = await backend.run(makeRun(), makeDeps(), new AbortController().signal)
    const firstResult = await first.done
    expect(firstResult.status).toBe('completed')
    const firstPid = first.pid
    if (firstPid !== undefined) leftoverPids.push(firstPid)

    // Continue the SAME conversation: the adopted process skips session/new and
    // the model/effort dials entirely, going straight to session/prompt.
    const resumed = await backend.run(
      makeRun({ resumeSessionId: firstResult.backendSessionId }),
      makeDeps(),
      new AbortController().signal,
    )
    const resumedResult = await resumed.done
    expect(resumedResult.status).toBe('completed')
    expect(resumedResult.text).toBe('The answer is 41.')
    expect(resumed.pid).toBe(firstPid)
    expect(resumed.backendSessionId).toBe(firstResult.backendSessionId)

    await pool.dispose()
  })

  it('evicts an idle resident process after the idle window', async () => {
    const pool = createAcpResidentPool({ idleMs: 40, logger: silentLogger })
    const backend = createAcpBackend(makeDeps(), realRuntime, pool)

    const handle = await backend.run(makeRun(), makeDeps(), new AbortController().signal)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(pool.size).toBe(1)
    const pid = handle.pid
    if (pid !== undefined) leftoverPids.push(pid)

    expect(await waitFor(() => pool.size === 0, 3_000)).toBe(true)
    if (pid !== undefined) {
      expect(await waitForPidGone(pid)).toBe(true)
    }
  })

  it('dispose() terminates every parked process (plugin unload)', async () => {
    const pool = createAcpResidentPool({ idleMs: 60_000, logger: silentLogger })
    const backend = createAcpBackend(makeDeps(), realRuntime, pool)

    const pids: number[] = []
    // Two DIFFERENT cwds produce two pool keys, so two processes stay parked.
    const cwds = ['/tmp', '/private/tmp']
    for (let i = 0; i < cwds.length; i++) {
      const handle = await backend.run(makeRun({ prompt: `run ${i}`, cwd: cwds[i] }), makeDeps(), new AbortController().signal)
      const result = await handle.done
      expect(result.status).toBe('completed')
      if (handle.pid !== undefined) pids.push(handle.pid)
    }
    expect(pool.size).toBe(2)

    await pool.dispose()
    expect(pool.size).toBe(0)
    for (const pid of pids) {
      leftoverPids.push(pid)
      expect(await waitForPidGone(pid)).toBe(true)
    }
  })

  it('falls back to one-shot behaviour when residency is disabled', async () => {
    const pool = createAcpResidentPool({ idleMs: 0, logger: silentLogger })
    const backend = createAcpBackend(makeDeps(), realRuntime, pool)

    const first = await backend.run(makeRun(), makeDeps(), new AbortController().signal)
    const firstResult = await first.done
    expect(firstResult.status).toBe('completed')
    const firstPid = first.pid
    if (firstPid !== undefined) leftoverPids.push(firstPid)

    // Disabled pool: the second run spawns a NEW process (different pid).
    const second = await backend.run(makeRun(), makeDeps(), new AbortController().signal)
    const secondResult = await second.done
    expect(secondResult.status).toBe('completed')
    expect(second.pid).not.toBe(firstPid)
    if (second.pid !== undefined) leftoverPids.push(second.pid)
    expect(pool.size).toBe(0)
  })
})