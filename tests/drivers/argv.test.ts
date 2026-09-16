/**
 * Shared driver plumbing: the blocked-flag table, shell-quote stripping, the
 * launch prefix, the interpreter rule, and the session handle.
 *
 * The filter cases mirror multica's own `TestFilterCustomArgsBlocksProtocolFlags`
 * / `TestFilterCustomArgsStripsShellQuotes`, which are the gold standard for
 * this behaviour.
 */
import { describe, expect, it } from 'vitest'

import {
  DriverSession,
  argsContainFlag,
  buildCommandLine,
  clearDriverRuntime,
  filterCustomArgs,
  filterLaunchPrefix,
  getDriverRuntime,
  setDriverRuntime,
  unshellQuoteArg,
  type BlockedArgs,
  type SpawnSpec,
  type SpawnedProcess,
} from '../../src/drivers/argv.ts'
import { createBackend } from '../../src/drivers/index.ts'
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
    for (const family of ['claude', 'codebuddy', 'openclaw', 'generic'] as const) {
      expect(createBackend(family, deps).family).toBe(family)
    }
  })

  it('rejects an unknown family with a readable error', () => {
    expect(() => createBackend('no-such-dialect' as never, deps)).toThrowError(
      /unknown protocol family "no-such-dialect".*Known families: claude, codebuddy, openclaw, generic/s,
    )
  })
})
