/**
 * RR-MI-5 — every driver-side timer whose delay comes from the caller
 * (`AgentRunOptions.timeoutMs` / `idleTimeoutMs`) or from a descriptor env var
 * must be clamped to the runtime's timer ceiling.
 *
 * `setTimeout` does not reject a delay above 2^31-1. It silently rewrites it to
 * **1 ms** and emits `TimeoutOverflowWarning`, so a caller's "effectively no
 * deadline" becomes an immediate timeout: the child is signalled right after
 * spawn and the run is reported as a timeout it never had. The tests below fail
 * on exactly that collapse; the negative controls prove the same timers still
 * fire on a normal (sub-ceiling) value.
 *
 * The ceiling is the kernel's own `MAX_TIMER_DELAY_MS` — this file declares no
 * second number, and a structural guard keeps the drivers honest.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentResult,
  AgentSessionHandle,
  BridgeLogger,
  DriverDeps,
  ProtocolFamily,
} from '../../src/kernel/types.ts'
import type { ProcessExit, SpawnedProcess } from '../../src/drivers/argv.ts'
import { clearDriverRuntime, createBackendWithRuntime } from '../../src/drivers/index.ts'
import { ZCODE_BUILTIN_PROVIDER_CONFIG_ENV } from '../../src/drivers/zcode.ts'
import { MAX_TIMER_DELAY_MS } from '../../src/kernel/watchdog.ts'

/** Node's timer ceiling; also the value every driver must import, not restate. */
const OVERFLOW_MS = MAX_TIMER_DELAY_MS + 1
const NORMAL_TIMEOUT_MS = 25

const silentLogger: BridgeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** In-memory `SpawnedProcess`: no real process is ever created. */
class FakeChild implements SpawnedProcess {
  readonly pid = 9090
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly exited: Promise<ProcessExit>
  terminated = false
  #settleExit: (exit: ProcessExit) => void = () => {}

  constructor() {
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.#settleExit = resolve
    })
    this.stdin.on('error', () => {})
  }

  emit(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim() !== '') this.stdout.write(`${line}\n`)
    }
  }

  finish(code: number | null = 0): void {
    this.stdout.end()
    this.stderr.end()
    this.#settleExit({ code, signal: null })
  }

  terminate(): Promise<void> {
    if (this.terminated) return Promise.resolve()
    this.terminated = true
    this.stdout.end()
    this.stderr.end()
    this.#settleExit({ code: null, signal: 'SIGTERM' })
    return Promise.resolve()
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Capture `TimeoutOverflowWarning`s emitted from now on. `stop()` returns
 * everything seen, so a test can assert the runtime never rewrote the delay.
 */
function watchOverflowWarnings(): { stop: () => string[] } {
  const seen: string[] = []
  const onWarning = (warning: unknown): void => {
    const err = warning as { code?: string; name?: string; message?: string }
    if (
      err.code === 'TimeoutOverflowWarning' ||
      /TimeoutOverflow/i.test(err.name ?? '') ||
      /TimeoutOverflow/i.test(err.message ?? '')
    ) {
      seen.push(err.message ?? String(warning))
    }
  }
  process.on('warning', onWarning)
  return {
    stop: () => {
      process.off('warning', onWarning)
      return seen
    },
  }
}

interface DriverCase {
  readonly id: ProtocolFamily
  readonly agent: string
}

/**
 * All six dialects that own a timer. `acp` is included even though its real
 * tests spawn a real engine: the timer seam is the same, and a fake child keeps
 * this file fast and deterministic.
 */
const DRIVERS: readonly DriverCase[] = [
  { id: 'claude', agent: 'claude' },
  { id: 'codex', agent: 'codex' },
  { id: 'generic', agent: 'generic' },
  { id: 'openclaw', agent: 'openclaw' },
  { id: 'zcode', agent: 'zcode' },
  { id: 'acp', agent: 'codebuddy-code-acp' },
]

function depsFor(driver: DriverCase, env: Record<string, string>): DriverDeps {
  return {
    command: {
      executable: `fake-${driver.id}`,
      ...(driver.id === 'acp' ? { protocolArgs: ['--acp'] } : {}),
    },
    env,
    logger: silentLogger,
  }
}

async function launch(
  driver: DriverCase,
  opts: { timeoutMs?: number; idleTimeoutMs?: number },
  env: Record<string, string> = {},
): Promise<{ child: FakeChild; handle: AgentSessionHandle }> {
  const child = new FakeChild()
  const deps = depsFor(driver, env)
  const backend = createBackendWithRuntime(driver.id, deps, { spawn: () => child, now: () => 0 })
  const handle = await backend.run(
    { agent: driver.agent, prompt: 'hi', ...opts },
    deps,
    new AbortController().signal,
  )
  return { child, handle }
}

/** Settle a handle that the test deliberately left running, without leaking. */
async function reap(handle: AgentSessionHandle, child: FakeChild): Promise<AgentResult> {
  if (handle.snapshot().terminal) return handle.done
  await handle.cancel('test cleanup')
  const result = await handle.done
  await child.exited
  return result
}

afterEach(() => {
  clearDriverRuntime()
})

describe('RR-MI-5 · the shared ceiling', () => {
  it("is Node's own timer limit, imported from the kernel (no second number)", () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1)
  })

  it('every driver file that arms a timer routes its delay through clampTimerDelay', () => {
    const dir = fileURLToPath(new URL('../../src/drivers/', import.meta.url))
    const offenders: string[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue
      const source = readFileSync(path.join(dir, name), 'utf8')
      // argv.ts owns the helper; it is the one file allowed to name the constant.
      if (name === 'argv.ts') continue
      if (/setTimeout\(/.test(source) && !source.includes('clampTimerDelay(')) offenders.push(name)
      // A literal here would be a second ceiling, which the finding forbids.
      if (/2147483647|2_147_483_647/.test(source)) offenders.push(`${name} (hard-coded ceiling)`)
    }
    expect(offenders).toEqual([])
  })
})

describe('RR-MI-5 · caller-supplied windows above the ceiling', () => {
  for (const driver of DRIVERS) {
    it(`${driver.id}: an over-ceiling timeoutMs does not collapse to 1 ms`, async () => {
      const warnings = watchOverflowWarnings()
      const { child, handle } = await launch(driver, { timeoutMs: OVERFLOW_MS })
      await delay(80)
      // The collapse: `setTimeout(cb, 2^31)` fires ~1 ms later and the run is
      // reported as a timeout the caller never asked for.
      expect(handle.snapshot().status).toBe('running')
      expect(warnings.stop()).toEqual([])
      await reap(handle, child)
    })

    it(`${driver.id}: an over-ceiling idleTimeoutMs does not collapse to 1 ms`, async () => {
      const warnings = watchOverflowWarnings()
      const { child, handle } = await launch(driver, { idleTimeoutMs: OVERFLOW_MS })
      await delay(80)
      expect(handle.snapshot().status).toBe('running')
      expect(warnings.stop()).toEqual([])
      await reap(handle, child)
    })

    it(`${driver.id}: negative control — a sub-ceiling timeout still fires`, async () => {
      const warnings = watchOverflowWarnings()
      const { child, handle } = await launch(driver, { timeoutMs: NORMAL_TIMEOUT_MS })
      const result = await handle.done
      expect(result.status).toBe('timeout')
      expect(result.error).toContain(`after ${NORMAL_TIMEOUT_MS}ms`)
      expect(warnings.stop()).toEqual([])
      await child.exited
    })
  }
})

describe('RR-MI-5 · config-supplied graces above the ceiling', () => {
  /** Real bytes: the captured CONFIGURATION_ERROR `turn.failed`. */
  const ZCODE_TERMINAL = readFileSync(
    new URL('../fixtures/zcode-turn-failed.ndjson', import.meta.url),
    'utf8',
  )
  /** Real bytes: the pretty-printed result blob the CLI prints before lingering. */
  const OPENCLAW_RESULT = readFileSync(
    new URL('../fixtures/openclaw-result.ndjson', import.meta.url),
    'utf8',
  )

  it('zcode: an over-ceiling terminal grace does not collapse to 1 ms', async () => {
    const warnings = watchOverflowWarnings()
    const { child, handle } = await launch(
      { id: 'zcode', agent: 'zcode' },
      {},
      {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]: '/Applications/ZCode.app/builtin.json',
        DSH_AGENTS_BRIDGE_ZCODE_TERMINAL_GRACE_MS: String(OVERFLOW_MS),
      },
    )
    // A terminal frame ARMS the grace timer; with the collapse it fires ~1 ms
    // later and settles the run behind the caller's back.
    child.emit(ZCODE_TERMINAL)
    await delay(80)
    expect(handle.snapshot().status).toBe('running')
    expect(warnings.stop()).toEqual([])
    child.finish(0)
    void handle.done.catch(() => {})
  })

  it('openclaw: an over-ceiling result-idle grace does not collapse to 1 ms', async () => {
    const warnings = watchOverflowWarnings()
    const { child, handle } = await launch(
      { id: 'openclaw', agent: 'openclaw' },
      {},
      { DSH_AGENTS_BRIDGE_OPENCLAW_IDLE_GRACE_MS: String(OVERFLOW_MS) },
    )
    // A complete result blob ARMS the boundary timer.
    child.emit(OPENCLAW_RESULT)
    await delay(80)
    expect(handle.snapshot().status).toBe('running')
    expect(warnings.stop()).toEqual([])
    child.finish(0)
    void handle.done.catch(() => {})
  })
})
