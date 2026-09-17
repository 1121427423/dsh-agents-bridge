import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_GRACE_MS,
  LineSplitter,
  POST_EXIT_DRAIN_MS,
  buildArgv,
  processGone,
  processStartTimeMs,
  spawnDetached,
} from '../../src/kernel/spawn.ts'
import { MAX_STREAM_LINE_BYTES, StreamOverflowError } from '../../src/kernel/stream-limits.ts'

describe('buildArgv', () => {
  it('prepends the interpreter and argsPrefix in the frozen order', () => {
    expect(buildArgv({ executable: '/bin/codebuddy' }, ['--json'])).toEqual(['/bin/codebuddy', '--json'])
    expect(
      buildArgv({ executable: '/app/codebuddy', interpreter: '/opt/homebrew/bin/node' }, ['--json']),
    ).toEqual(['/opt/homebrew/bin/node', '/app/codebuddy', '--json'])
    expect(
      buildArgv(
        { executable: '/app/openclaw.mjs', interpreter: '/opt/homebrew/bin/node', argsPrefix: ['agent'] },
        ['--local'],
      ),
    ).toEqual(['/opt/homebrew/bin/node', '/app/openclaw.mjs', 'agent', '--local'])
  })
})

describe('LineSplitter', () => {
  it('reassembles lines across chunk boundaries and strips CRLF', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a":')).toEqual([])
    expect(splitter.push('1}\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.push('tail')).toEqual([])
    expect(splitter.flush()).toEqual(['tail'])
    expect(splitter.flush()).toEqual([])
  })

  it('accepts Buffers and preserves blank lines', () => {
    const splitter = new LineSplitter()
    expect(splitter.push(Buffer.from('a\n\nb', 'utf8'))).toEqual(['a', ''])
    expect(splitter.flush()).toEqual(['b'])
  })

  it('rejects a single line over the cap instead of growing the buffer (MI-4)', () => {
    const splitter = new LineSplitter({ maxLineBytes: 8 })
    expect(() => splitter.push('123456789')).toThrowError(StreamOverflowError)
    // The oversized run is not emitted, not truncated, and not kept.
    expect(splitter.flush()).toEqual([])
  })

  it('rejects a stream that exceeds the total byte budget (MI-4)', () => {
    const splitter = new LineSplitter({ maxTotalBytes: 8 })
    expect(() => splitter.push('ab\ncd\nef\n')).toThrowError(/total/i)
    expect(splitter.flush()).toEqual([])
  })

  it('is unaffected by the caps for ordinary protocol frames (control)', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a":1}\n')).toEqual(['{"a":1}'])
    expect(splitter.push('tail')).toEqual([])
    expect(splitter.flush()).toEqual(['tail'])
  })
})

describe('spawnDetached', () => {
  it('fails the run loudly when a child emits a line over the cap (MI-4)', async () => {
    const pidOf: number[] = []
    const handle = spawnDetached({
      // A writer that never emits a newline is the unbounded-memory case.
      command: { executable: process.execPath },
      args: ['-e', `process.stdout.write('x'.repeat(${MAX_STREAM_LINE_BYTES + 1}))`],
      // A reader must exist for the bound to be enforced at all; production
      // always attaches one (see `kernelSpawn` in integrate.ts).
      onStdoutLine: () => {},
    })
    if (handle.pid !== undefined) pidOf.push(handle.pid)

    const exit = await handle.exited
    expect(exit.error).toBeInstanceOf(Error)
    expect(exit.error?.message).toMatch(/line|newline/i)

    // The bound must terminate the group, not leave the writer running.
    const pid = pidOf[0]
    if (pid !== undefined) {
      const deadline = Date.now() + 4_000
      while (!processGone(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(processGone(pid)).toBe(true)
    }
  })
  it('normalizes a synchronous spawn failure into a settled handle', async () => {
    // An empty `file` makes child_process.spawn throw synchronously; the handle
    // must still behave like a process that failed to start.
    const handle = spawnDetached({ command: { executable: '' }, args: ['--version'] })

    expect(handle.pid).toBeUndefined()
    const exit = await handle.exited
    expect(exit.code).toBeNull()
    expect(exit.signal).toBeNull()
    expect(exit.error).toBeInstanceOf(Error)
    expect(exit.error?.message).toMatch(/file/i)
    // cancel() on a process that never existed must resolve, not throw.
    await expect(handle.cancel('nothing to kill')).resolves.toBeUndefined()
    handle.signal('SIGTERM')
  })

  it('never leaks a throw, even with a bogus cwd value', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const handle = spawnDetached({
      command: { executable: process.execPath },
      // Invalid type on purpose: the point is that the failure is contained.
      cwd: 42 as unknown as string,
      logger,
    })
    const exit = await handle.exited
    expect(exit.error).toBeInstanceOf(Error)
    expect(handle.pid).toBeUndefined()
  })

  it('kills a signal-ignoring child within the configured grace window', async () => {
    // The child ignores SIGTERM (`process.on` with an empty handler), which is
    // exactly the shape that makes a naive SIGTERM-only cancel leak a process.
    // A short grace keeps the test fast; the assertion is that cancel() still
    // resolves and the process really is gone afterwards.
    const handle = spawnDetached({
      command: {
        executable: process.execPath,
        argsPrefix: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      },
      graceMs: 50,
    })
    const pid = handle.pid
    expect(pid).toBeGreaterThan(0)

    await handle.cancel('test: ignores SIGTERM')

    // cancel() resolving is not the claim — the process being gone is.
    expect(processGone(pid!)).toBe(true)
    await expect(handle.exited).resolves.toBeDefined()
  })

  it('is idempotent: concurrent cancels share one escalation run', async () => {
    const handle = spawnDetached({
      command: {
        executable: process.execPath,
        argsPrefix: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      },
      graceMs: 50,
    })
    const pid = handle.pid
    const results = await Promise.all([
      handle.cancel('first'),
      handle.cancel('second'),
      handle.cancel('third'),
    ])
    expect(results).toEqual([undefined, undefined, undefined])
    // Still idempotent after the process is already dead.
    await expect(handle.cancel('after death')).resolves.toBeUndefined()
    await expect(handle.cancel('again')).resolves.toBeUndefined()
    expect(processGone(pid!)).toBe(true)
  })

  it('treats a non-finite grace as the default instead of firing immediately', async () => {
    // NaN would make setTimeout fire on the next tick, silently skipping the
    // graceful attempt; the guard maps it back to DEFAULT_GRACE_MS.
    const handle = spawnDetached({
      command: { executable: process.execPath, argsPrefix: ['-e', ''] },
      graceMs: Number.NaN,
    })
    await handle.exited
    expect(DEFAULT_GRACE_MS).toBe(5_000)
    await expect(handle.cancel('already exited')).resolves.toBeUndefined()
  })
})

describe('MI-6: exited settles on the child\'s exit, not a descendant\'s', () => {
  it('does not wait for a descendant holding the stdio pipes', async () => {
    // The shell exits at once, but the backgrounded `sleep` inherited stdout and
    // stderr, so Node's `close` cannot fire until it exits — the old behaviour
    // made `exited` wait the full 2 s. The bounded drain settles on `exit`.
    const lines: string[] = []
    const handle = spawnDetached({
      command: { executable: '/bin/sh' },
      args: ['-c', 'printf "tail-no-newline"; sleep 2 & exit 0'],
      onStdoutLine: (line) => lines.push(line),
    })
    const startedAt = Date.now()
    const exit = await handle.exited
    const elapsed = Date.now() - startedAt

    expect(exit.code).toBe(0)
    // The guardrail: settle on the drain window, NOT on the descendant's exit.
    expect(elapsed).toBeLessThan(1_500)
    expect(elapsed).toBeGreaterThanOrEqual(POST_EXIT_DRAIN_MS - 50)
    // The drain also flushes the trailing partial line the stream was holding.
    expect(lines).toEqual(['tail-no-newline'])
  })

  it('settles on close when no descendant holds the pipes (fast path unchanged)', async () => {
    const handle = spawnDetached({
      command: { executable: '/bin/sh' },
      args: ['-c', 'exit 7'],
    })
    const pid = handle.pid
    const startedAt = Date.now()
    const exit = await handle.exited
    expect(exit.code).toBe(7)
    // `close` wins the race, so the drain window is not paid — and therefore
    // RR-IM-4's drain-path group kill is never reached.
    expect(Date.now() - startedAt).toBeLessThan(POST_EXIT_DRAIN_MS)
    expect(processGone(pid!)).toBe(true)
  })
})

describe('RR-IM-4: the drain path must not leave the group alive', () => {
  it('kills a descendant that inherited the pipes once the child exits', async () => {
    // The case MI-6 exists for: the child exits 0 but backgrounded a helper (a
    // dev server, a test runner, an MCP helper) that inherited stdout/stderr.
    // Reaching the drain window is the SIGNAL that something still holds the
    // pipes — i.e. the group outlived the child — so settlement must kill it.
    // Otherwise the driver's settle-time `terminate()` is a no-op (cancel()
    // short-circuits on `exit !== undefined`) and the tree survives the run.
    const lines: string[] = []
    const handle = spawnDetached({
      command: { executable: '/bin/sh' },
      args: ['-c', 'sleep 30 & echo "pid:$!"; exit 0'],
      onStdoutLine: (line) => lines.push(line),
    })
    const shellPid = handle.pid
    let spawnedDescendant: number | undefined
    try {
      const exit = await handle.exited
      expect(exit.code).toBe(0)

      const reported = lines.find((line) => line.startsWith('pid:'))
      if (reported === undefined) {
        throw new Error(`the fixture never reported the descendant pid (lines: ${JSON.stringify(lines)})`)
      }
      const descendantPid = Number(reported.slice(4))
      spawnedDescendant = descendantPid
      expect(descendantPid).toBeGreaterThan(0)

      // SIGKILL is delivered, not necessarily reaped, by the time `exited`
      // resolves: give the OS a bounded moment to notice, as the overflow test
      // does. The claim under test is that the tree does not survive.
      const deadline = Date.now() + 2_000
      while (!processGone(descendantPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(processGone(descendantPid)).toBe(true)
    } finally {
      // Never leave the fixture's own `sleep 30` behind if the guard failed.
      if (spawnedDescendant !== undefined && !processGone(spawnedDescendant)) {
        process.kill(spawnedDescendant, 'SIGKILL')
      }
      if (shellPid !== undefined && !processGone(shellPid)) {
        process.kill(shellPid, 'SIGKILL')
      }
    }
  })

  it('negative control: a run with no descendant is unaffected', async () => {
    // The fast path must stay a fast path: no drain window, no signal, and the
    // child is simply gone because it exited.
    const handle = spawnDetached({
      command: { executable: '/bin/sh' },
      args: ['-c', 'exit 0'],
    })
    const pid = handle.pid
    const startedAt = Date.now()
    const exit = await handle.exited
    expect(exit.code).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(POST_EXIT_DRAIN_MS)
    expect(processGone(pid!)).toBe(true)
  })
})

/**
 * RR-MI-12 — the orphan reap must not depend on how `ps` writes a date.
 *
 * `processStartTimeMs` reads `ps -o lstart=` and hands the text to `Date.parse`.
 * `lstart` is LOCALIZED: with `LC_ALL=de_DE.UTF-8` the same `ps` prints
 * `Fr. 18 Sep. 03:23:00 2026` and with `zh_CN.UTF-8` `五  9月/18 03:23:00 2026`
 * — neither parses, so the reaper silently lost its pid-reuse guard on any host
 * that does not run in the C locale (a recycled pid then looks unidentifiable,
 * which is the safe direction, but the recovery it exists for never happens).
 *
 * These tests set the AMBIENT locale and read a REAL pid — no fake `ps`: the
 * oracle is the actual `/bin/ps` on this machine, and the assertion is that the
 * answer does not move when the operator's language does.
 */
describe('RR-MI-12: processStartTimeMs is independent of the locale', () => {
  /** Runs `fn` with `LC_ALL`/`LANG` forced to a localized value. */
  async function withLocale(locale: string, fn: () => number | undefined): Promise<number | undefined> {
    const saved = { LC_ALL: process.env['LC_ALL'], LANG: process.env['LANG'] }
    process.env['LC_ALL'] = locale
    process.env['LANG'] = locale
    try {
      return fn()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  const LOCALES = ['de_DE.UTF-8', 'zh_CN.UTF-8']

  for (const locale of LOCALES) {
    it(`reads a real pid's start time under ${locale}`, async () => {
      const started = await withLocale(locale, () => processStartTimeMs(process.pid))

      // The identity the reap depends on: a real epoch, in the past, for the
      // process we asked about — not `undefined`, which is what an unparsed
      // localized date used to produce.
      expect(started).toBeTypeOf('number')
      expect(Number.isFinite(started)).toBe(true)
      expect(started!).toBeLessThanOrEqual(Date.now())
      expect(started!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000)
    })
  }

  it('reads the same start time in every locale (negative control: the C-locale answer is unchanged)', async () => {
    const inC = processStartTimeMs(process.pid)
    const inGerman = await withLocale('de_DE.UTF-8', () => processStartTimeMs(process.pid))
    const inChinese = await withLocale('zh_CN.UTF-8', () => processStartTimeMs(process.pid))

    expect(inC).toBeTypeOf('number')
    expect(inGerman).toBe(inC)
    expect(inChinese).toBe(inC)
  })

  it('answers undefined for a pid that is gone, never a guess', () => {
    // The other half of "language-independent facts": a pid that no longer
    // exists has no start time, and the reap must not invent one.
    const dead = spawnDetached({ command: { executable: '/bin/sh' }, args: ['-c', 'exit 0'] })
    return dead.exited.then(() => {
      const pid = dead.pid!
      expect(processGone(pid)).toBe(true)
      expect(processStartTimeMs(pid)).toBeUndefined()
    })
  })
})
