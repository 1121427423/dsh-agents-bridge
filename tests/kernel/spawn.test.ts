import { describe, expect, it, vi } from 'vitest'

import { LineSplitter, buildArgv, spawnDetached } from '../../src/kernel/spawn.ts'

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
})
