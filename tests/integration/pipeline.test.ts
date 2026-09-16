/**
 * End-to-end pipeline test: kernel + drivers + the integration adapter.
 *
 * The per-file unit tests (tests/kernel, tests/drivers) prove each side alone.
 * This suite proves the seam that nobody owned during the parallel build:
 * `createAgentManager` + `createBackend` + `installDriverRuntime()` running a
 * real child process and surfacing its transcript through the tool-facing API.
 *
 * The fake CLI replays a capture from a real codebuddy run, so this also
 * regression-guards the driver's tolerance of `system/status` and
 * `file-history-snapshot` (see docs/findings-engines.md §5.1).
 *
 * @module tests/integration/pipeline
 */

import { mkdtempSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createBackend } from '../../src/drivers/index.ts'
import { installDriverRuntime } from '../../src/integrate.ts'
import { createLogger } from '../../src/kernel/logger.ts'
import { createAgentManager } from '../../src/kernel/manager.ts'
import { BUILTIN_DESCRIPTORS } from '../../src/kernel/registry.ts'
import type { AgentDescriptor, AgentManager, SessionSnapshot } from '../../src/kernel/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = path.join(here, '..', 'fixtures', 'fake-stream-json-cli.mjs')
const SLOW_CLI = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

/** The node running this test doubles as the engine interpreter. */
const NODE = process.execPath

const live: AgentManager[] = []

/**
 * Point every built-in identity at a fake CLI.
 *
 * `mergeDescriptors` merges `command` per-field, so overriding executable +
 * argsPrefix is enough — the driver still appends its own dialect flags, which
 * the fake CLI ignores.
 *
 * `scan: false` keeps this suite off the host: since P3 the desktop track
 * auto-scans `/Applications` on the first cold `probe()`, and this suite DOES
 * probe (`manager.probe()` below). Without it the test would read whatever the
 * developer happens to have installed, and its result count would differ per
 * machine. The scan's own behaviour is covered in tests/tracks/scan.test.ts
 * against tmp-dir fixtures.
 */
function makeManager(script: string): AgentManager {
  installDriverRuntime()
  const override: Partial<AgentDescriptor> = {
    command: { executable: NODE, argsPrefix: [script] },
  }
  const manager = createAgentManager({
    logger: createLogger('integration'),
    storeDir: mkdtempSync(path.join(tmpdir(), 'bridge-store-')),
    defaultCwd: tmpdir(),
    overrides: { claude: override, workbuddy: override, openclaw: override, autoclaw: override },
    createBackend,
    scan: false,
  })
  live.push(manager)
  return manager
}

async function waitTerminal(
  manager: AgentManager,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<SessionSnapshot> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = manager.status(sessionId)
    if (snapshot?.terminal === true) return snapshot
    if (Date.now() > deadline) {
      throw new Error(
        `session ${sessionId} never reached a terminal state (last: ${JSON.stringify(snapshot)})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((manager) => manager.dispose()))
})

describe('agents pipeline (kernel + drivers + adapter)', () => {
  it('runs a real child process and surfaces its transcript', async () => {
    const manager = makeManager(FAKE_CLI)

    const started = await manager.run({ agent: 'claude', prompt: 'Reply with exactly: PONG' })
    expect(started.status).toBe('running')
    expect(started.terminal).toBe(false)

    const finished = await waitTerminal(manager, started.sessionId)
    expect(finished.status).toBe('completed')
    expect(finished.result?.text).toBe('PONG')

    // Usage buckets come from the capture's `cache_*` field names.
    expect(finished.result?.usage?.inputTokens).toBe(22408)
    expect(finished.result?.usage?.outputTokens).toBe(100)
    expect(finished.result?.usage?.cacheReadTokens).toBe(11264)
    expect(finished.result?.usage?.cacheWriteTokens).toBe(11144)

    // The resume pointer is captured from `system/init`, before any result.
    expect(finished.result?.backendSessionId).toBe('fake-session-0001')

    const output = manager.output(started.sessionId)
    expect(output).toBeDefined()
    expect(output?.status).toBe('completed')

    const kinds = new Set(output?.messages.map((message) => message.type))
    expect(kinds.has('text')).toBe(true)
    // `system/status` and `file-history-snapshot` must be tolerated, not fatal.
    expect(output?.messages.some((message) => message.content?.includes('PONG'))).toBe(true)
  })

  it('reads the transcript incrementally through nextIndex', async () => {
    const manager = makeManager(FAKE_CLI)
    const started = await manager.run({ agent: 'claude', prompt: 'ping' })
    await waitTerminal(manager, started.sessionId)

    const first = manager.output(started.sessionId)
    expect(first).toBeDefined()
    expect(first!.messages.length).toBeGreaterThan(0)

    const second = manager.output(started.sessionId, { sinceIndex: first!.nextIndex })
    expect(second?.messages.length).toBe(0)
    expect(second?.nextIndex).toBe(first!.nextIndex)

    // Re-reading from 0 must be stable (the buffer is append-only).
    const replay = manager.output(started.sessionId, { sinceIndex: 0 })
    expect(replay?.messages.length).toBe(first!.messages.length)
  })

  it('cancels a live child process', async () => {
    const manager = makeManager(SLOW_CLI)
    const started = await manager.run({ agent: 'claude', prompt: 'stay alive' })

    // Give the child a moment to actually start before cancelling it, so the
    // test proves escalation against a running process rather than a race.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(manager.status(started.sessionId)?.status).toBe('running')

    const cancelled = await manager.cancel(started.sessionId, 'test cancel')
    expect(cancelled).toBe(true)

    const finished = await waitTerminal(manager, started.sessionId)
    expect(['cancelled', 'failed']).toContain(finished.status)
    expect(finished.terminal).toBe(true)
  })

  it('rejects an unknown agent id with a readable error', async () => {
    const manager = makeManager(FAKE_CLI)
    await expect(manager.run({ agent: 'definitely-not-an-agent', prompt: 'hi' })).rejects.toThrow(
      /definitely-not-an-agent/,
    )
  })

  it('probes identities without running them', async () => {
    const manager = makeManager(FAKE_CLI)
    const results = await manager.probe()
    expect(results.length).toBeGreaterThan(0)
    const claude = results.find((entry) => entry.id === 'claude')
    expect(claude).toBeDefined()
    expect(claude?.family).toBe('claude')
  })

  it('probes without reading the host: scan: false walks nothing', async () => {
    // The hermeticity PROOF for this suite, and it is DELIBERATELY written
    // against the filesystem syscall rather than against the result count.
    //
    // A count-based assertion is not enough: this host's `/Applications` holds
    // bundles that shadow onto ids the built-in table ALREADY has (WorkBuddy,
    // AutoClaw), so a leaked scan can leave the id list looking identical and
    // the leak would go unnoticed. Patching `fs.readdirSync` and asserting the
    // scan touches NOTHING is deterministic on every machine.
    const hostReads: string[] = []
    const realReaddir = fs.readdirSync
    const spy = (target: fs.PathLike, ...rest: unknown[]): string[] => {
      const asString = String(target)
      if (asString === '/Applications' || asString === '/Applications/') hostReads.push(asString)
      return (realReaddir as (...args: unknown[]) => string[])(target, ...rest)
    }
    ;(fs as unknown as { readdirSync: typeof spy }).readdirSync = spy
    let results: Awaited<ReturnType<AgentManager['probe']>>
    try {
      const manager = makeManager(FAKE_CLI)
      results = await manager.probe()
    } finally {
      ;(fs as unknown as { readdirSync: typeof realReaddir }).readdirSync = realReaddir
    }
    expect(hostReads).toEqual([])
    // And the redundant belt-and-braces check that nothing was appended.
    expect(results.map((entry) => entry.id).sort()).toEqual([...BUILTIN_DESCRIPTORS.map((d) => d.id)].sort())
  })
})
