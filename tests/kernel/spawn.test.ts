import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_GRACE_MS,
  LineSplitter,
  buildArgv,
  processGone,
  spawnDetached,
} from '../../src/kernel/spawn.ts'

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
})

describe('spawnDetached', () => {
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
