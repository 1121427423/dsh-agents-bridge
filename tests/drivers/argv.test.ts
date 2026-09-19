/**
 * Shared driver plumbing: the blocked-flag table, shell-quote stripping, the
 * launch prefix, the interpreter rule, and the session handle.
 *
 * The filter cases mirror multica's own `TestFilterCustomArgsBlocksProtocolFlags`
 * / `TestFilterCustomArgsStripsShellQuotes`, which are the gold standard for
 * this behaviour.
 */
import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'

import {
  DriverSession,
  argsContainFlag,
  assertArgvSafeValue,
  buildCommandLine,
  clearDriverRuntime,
  filterCustomArgs,
  filterLaunchPrefix,
  getDriverRuntime,
  isArgvSafeValue,
  readLines,
  setDriverRuntime,
  unshellQuoteArg,
  type BlockedArgs,
  type SpawnSpec,
  type SpawnedProcess,
} from '../../src/drivers/argv.ts'
import {
  MAX_STREAM_LINE_BYTES,
  MAX_STREAM_TOTAL_BYTES,
  type StreamOverflowError,
} from '../../src/kernel/stream-limits.ts'
import { createBackend, DRIVER_FAMILIES } from '../../src/drivers/index.ts'
import type { AgentMessage, DriverDeps } from '../../src/kernel/types.ts'

const BLOCKED: BlockedArgs = {
  '--output-format': 'withValue',
  '--permission-mode': 'withValue',
  '-p': 'standalone',
  '--optional': 'optionalValue',
}

describe('filterCustomArgs', () => {
  it('drops a blocked flag together with its separate value', () => {
    const result = filterCustomArgs(
      ['--output-format', 'text', '--model', 'o3'],
      BLOCKED,
    )
    expect(result).toEqual(['--model', 'o3'])
  })

  it('drops an inline value without swallowing the next argument', () => {
    const result = filterCustomArgs(
      ['--permission-mode=plan', '--model', 'o3'],
      BLOCKED,
    )
    expect(result).toEqual(['--model', 'o3'])
  })

  it('drops a standalone flag and keeps everything else', () => {
    const result = filterCustomArgs(['-p', '--verbose'], BLOCKED)
    expect(result).toEqual(['--verbose'])
  })

  it('consumes an optional value only when it is not another flag', () => {
    expect(filterCustomArgs(['--optional', 'plan'], BLOCKED)).toEqual([])
    expect(filterCustomArgs(['--optional', '--model', 'o3'], BLOCKED)).toEqual([
      '--model',
      'o3',
    ])
  })

  it('strips one layer of shell quotes from flag values', () => {
    expect(unshellQuoteArg("--deny-tool='write'")).toBe('--deny-tool=write')
    expect(unshellQuoteArg('--deny-tool="write"')).toBe('--deny-tool=write')
    expect(unshellQuoteArg("'standalone'")).toBe('standalone')
    // Assignment syntax is left alone: the quotes may be semantic for the child.
    expect(unshellQuoteArg('model="o3"')).toBe('model="o3"')
    expect(
      filterCustomArgs(["--deny-tool='write'", '--model', 'o3'], BLOCKED),
    ).toEqual(['--deny-tool=write', '--model', 'o3'])
  })

  it('never mutates the input array', () => {
    const input = ['--output-format', 'text', '--model', 'o3']
    filterCustomArgs(input, BLOCKED)
    expect(input).toEqual(['--output-format', 'text', '--model', 'o3'])
  })
})

describe('filterLaunchPrefix', () => {
  it('keeps positional tokens (the command identity) and drops blocked flags', () => {
    const result = filterLaunchPrefix(
      ['--profile', 'autoclaw', '--output-format', 'text', 'agent'],
      BLOCKED,
    )
    expect(result).toEqual(['--profile', 'autoclaw', 'agent'])
  })
})

describe('buildCommandLine', () => {
  it('prepends the interpreter and the fixed args prefix', () => {
    const built = buildCommandLine(
      {
        executable: '/Applications/WorkBuddy.app/cli/bin/codebuddy',
        interpreter: '/Applications/WorkBuddy.app/node',
        argsPrefix: ['--profile', 'workbuddy'],
      },
      ['-p', '--output-format', 'stream-json'],
    )
    expect(built.command).toBe('/Applications/WorkBuddy.app/node')
    expect(built.args).toEqual([
      '/Applications/WorkBuddy.app/cli/bin/codebuddy',
      '--profile',
      'workbuddy',
      '-p',
      '--output-format',
      'stream-json',
    ])
  })

  it('omits the interpreter entirely when none is configured', () => {
    const built = buildCommandLine({ executable: 'openclaw', argsPrefix: ['agent'] }, [
      '--json',
    ])
    expect(built.command).toBe('openclaw')
    expect(built.args).toEqual(['agent', '--json'])
  })
})

describe('argsContainFlag', () => {
  it('recognises both bare and inline forms', () => {
    expect(argsContainFlag(['--agent', 'x'], '--agent')).toBe(true)
    expect(argsContainFlag(['--agent=x'], '--agent')).toBe(true)
    expect(argsContainFlag(['--agentx', 'x'], '--agent')).toBe(false)
  })
})

describe('readLines — the shared protocol reader', () => {
  function collect(): { stream: PassThrough; lines: string[]; read: (text: string) => void } {
    const stream = new PassThrough()
    const lines: string[] = []
    readLines(stream, (line) => lines.push(line))
    return { stream, lines, read: (text) => stream.write(text) }
  }

  it('drops blank lines by default (the protocol-frame contract)', () => {
    const { stream, lines, read } = collect()
    read('a\n\n\nb\n')
    expect(lines).toEqual(['a', 'b'])
    stream.end()
  })

  it('preserves blank and whitespace-only lines when asked (IM-9)', () => {
    const stream = new PassThrough()
    const lines: string[] = []
    readLines(stream, (line) => lines.push(line), { preserveBlankLines: true })
    stream.write('a\n\n   \nb\n')
    stream.end()
    expect(lines).toEqual(['a', '', '   ', 'b'])
  })

  it('fails loudly on a single line over the cap instead of holding it (MI-4)', () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const overflows: StreamOverflowError[] = []
    const reader = readLines(stream, (line) => lines.push(line), {
      maxLineBytes: 16,
      onOverflow: (overflow) => overflows.push(overflow),
    })
    stream.write('x'.repeat(64))

    expect(overflows).toHaveLength(1)
    expect(overflows[0]?.kind).toBe('line')
    expect(overflows[0]?.limitBytes).toBe(16)
    expect(overflows[0]?.bytes).toBeGreaterThanOrEqual(16)
    expect(overflows[0]?.message).toMatch(/no newline|line/i)
    // The oversized run is NEVER handed to the caller: a silent truncation
    // would look like a complete protocol frame.
    expect(lines).toEqual([])
    // The reader releases the stream so a newline-less writer cannot keep
    // growing the buffer after the failure.
    expect(stream.listenerCount('data')).toBe(0)
    stream.end()
    return expect(reader.flushed).resolves.toBeUndefined()
  })

  it('bounds the total bytes a stream may deliver (MI-4)', () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const overflows: StreamOverflowError[] = []
    readLines(stream, (line) => lines.push(line), {
      maxTotalBytes: 16,
      onOverflow: (overflow) => overflows.push(overflow),
    })
    // 10 bytes, then 10 more: the second chunk crosses the budget.
    stream.write('aaaa\nbbbb\n')
    stream.write('cccc\ndddd\n')

    expect(lines).toEqual(['aaaa', 'bbbb'])
    expect(overflows).toHaveLength(1)
    expect(overflows[0]?.kind).toBe('total')
    expect(overflows[0]?.limitBytes).toBe(16)
    expect(overflows[0]?.bytes).toBe(20)
    stream.end()
  })

  it('bounds a newline-less writer with the shipped defaults', () => {
    // The shipped caps must be generous enough for a real protocol frame and
    // finite enough that a writer that never emits `\n` cannot grow the host.
    expect(MAX_STREAM_LINE_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    expect(MAX_STREAM_TOTAL_BYTES).toBeGreaterThanOrEqual(MAX_STREAM_LINE_BYTES)

    const stream = new PassThrough()
    const lines: string[] = []
    const overflows: StreamOverflowError[] = []
    readLines(stream, (line) => lines.push(line), {
      onOverflow: (overflow) => overflows.push(overflow),
    })
    // One chunk one byte over the line cap: the ledger's "newline-less writer"
    // oracle, at the bound itself rather than at an arbitrary 50 MB.
    stream.write(Buffer.alloc(MAX_STREAM_LINE_BYTES + 1, 0x61))

    expect(overflows).toHaveLength(1)
    expect(overflows[0]?.kind).toBe('line')
    expect(overflows[0]?.bytes).toBeGreaterThan(MAX_STREAM_LINE_BYTES)
    expect(lines).toEqual([])
    stream.end()
  })
})

describe('DriverSession', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  it('buffers messages, settles once and reports a terminal snapshot', async () => {
    let cancels = 0
    const session = new DriverSession({
      sessionId: 's1',
      agentId: 'claude',
      startedAt: 1000,
      logger,
      onCancel: () => {
        cancels++
      },
    })
    const message: AgentMessage = { type: 'text', content: 'hi', at: 1001 }
    session.push(message)
    expect(session.messages).toEqual([message])
    expect(session.snapshot().terminal).toBe(false)

    session.finish({
      sessionId: 's1',
      agentId: 'claude',
      status: 'completed',
      exitCode: 0,
      text: 'hi',
      durationMs: 5,
    })
    const result = await session.done
    expect(result.status).toBe('completed')
    expect(session.snapshot().terminal).toBe(true)
    expect(session.snapshot().messageCount).toBe(1)

    // Idempotent both ways.
    session.finish({
      sessionId: 's1',
      agentId: 'claude',
      status: 'failed',
      exitCode: 1,
      text: '',
      durationMs: 9,
    })
    expect((await session.done).status).toBe('completed')

    await session.cancel('stop')
    await session.cancel('stop again')
    expect(cancels).toBe(1)
  })

  it('ignores events pushed after the terminal state', () => {
    const session = new DriverSession({
      sessionId: 's2',
      agentId: 'claude',
      startedAt: 0,
      logger,
      onCancel: () => {},
    })
    session.finish({
      sessionId: 's2',
      agentId: 'claude',
      status: 'failed',
      exitCode: 1,
      text: '',
      durationMs: 1,
    })
    session.push({ type: 'text', content: 'late', at: 2 })
    expect(session.messages).toEqual([])
  })
})

describe('driver runtime seam', () => {
  it('reports a readable error when no runtime is installed', () => {
    clearDriverRuntime()
    expect(() => getDriverRuntime()).toThrowError(/setDriverRuntime/)
  })

  it('installs and clears a runtime', () => {
    const spec: SpawnSpec = { command: 'x', args: [], env: {} }
    const fake = { spawn: () => ({}) as SpawnedProcess }
    setDriverRuntime(fake)
    expect(getDriverRuntime().spawn(spec)).toBeDefined()
    clearDriverRuntime()
    expect(() => getDriverRuntime()).toThrowError(/setDriverRuntime/)
  })
})

describe('createBackend', () => {
  const deps: DriverDeps = {
    command: { executable: 'whatever' },
    env: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }

  it('builds a backend for every advertised family', () => {
    // Iterates the ADVERTISED list rather than a copy of it, so a family added
    // to `DRIVER_FAMILIES` without a `createBackend` case fails here instead of
    // shipping an entry the compiler cannot see.
    for (const family of DRIVER_FAMILIES) {
      expect(createBackend(family, deps).family).toBe(family)
    }
    for (const family of ['claude', 'codebuddy', 'codex', 'openclaw', 'acp', 'generic'] as const) {
      expect(createBackend(family, deps).family).toBe(family)
    }
  })

  it('rejects an unknown family with a readable error', () => {
    expect(() => createBackend('no-such-dialect' as never, deps)).toThrowError(
      /unknown protocol family "no-such-dialect".*Known families: claude, codebuddy, codex, openclaw, acp, generic/s,
    )
  })
})

// ── D43: the shared argv-token guard ───────────────────────────────────────

describe('assertArgvSafeValue — model-supplied argv slots take tokens only', () => {
  it('accepts the shapes real CLIs use', () => {
    for (const ok of [
      'claude-sonnet-4.5',
      'gpt-5.1-codex',
      'openrouter/openai/o3',
      'sess_01a0b6dd',
      'high',
      'o3:high',
      'a+b',
      '0.154.0',
    ]) {
      expect(isArgvSafeValue(ok)).toBe(true)
      expect(assertArgvSafeValue('some slot', ok)).toBe(ok)
    }
  })

  it('trims surrounding whitespace and returns the clean token', () => {
    expect(assertArgvSafeValue('some slot', '  high  ')).toBe('high')
    expect(isArgvSafeValue('  high  ')).toBe(true)
  })

  it('rejects anything that could smuggle a flag, a space, or shell/TOML syntax', () => {
    for (const bad of ['--sandbox', '-p', 'a b', 'a"b', "a'b", '', '   ', '-1', 'a\nb', 'a=b']) {
      expect(isArgvSafeValue(bad)).toBe(false)
    }
  })

  it('names the slot, the offending value, and the rule, so the error is actionable', () => {
    expect(() => assertArgvSafeValue('codex model', '--danger')).toThrow(
      /codex model must be an argv-safe token/,
    )
    expect(() => assertArgvSafeValue('codex model', '--danger')).toThrow(/--danger/)
    expect(() => assertArgvSafeValue('codex model', '--danger')).toThrow(/ARGV_SAFE_VALUE_PATTERN/)
  })
})
