/**
 * codebuddy / WorkBuddy: the argv differences from claude, the interpreter
 * rule, and proof that the claude parser is genuinely reused (not copied).
 *
 * Fixture is a real CodeBuddy 2.137.1 `-p --output-format stream-json` capture,
 * including two event types the claude parser must tolerate without complaint:
 * `system/status` and `file-history-snapshot`.
 */
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { DriverDeps } from '../../src/kernel/types.ts'
import type { ProcessExit, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import { createBackendWithRuntime } from '../../src/drivers/index.ts'
import {
  CODEBUDDY_BLOCKED_ARGS,
  CODEBUDDY_DIALECT,
  buildCodebuddyArgs,
} from '../../src/drivers/codebuddy.ts'
import { ClaudeStreamParser } from '../../src/drivers/claude.ts'

const CODEBUDDY_CAPTURE = readFileSync(
  new URL('../fixtures/codebuddy-capture.ndjson', import.meta.url),
  'utf8',
)

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return { command: { executable: 'codebuddy' }, env: {}, logger: silentLogger, ...overrides }
}

class FakeChild implements SpawnedProcess {
  readonly pid = 4243
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdinText: string[] = []
  readonly exited: Promise<ProcessExit>
  terminated = false
  #settleExit: (exit: ProcessExit) => void = () => {}

  constructor() {
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.#settleExit = resolve
    })
    this.stdin.on('data', (chunk: Buffer) => this.stdinText.push(chunk.toString('utf8')))
    this.stdin.on('error', () => {})
  }

  get input(): string {
    return this.stdinText.join('')
  }

  emit(text: string): void {
    for (const line of text.split('\n')) if (line.trim() !== '') this.stdout.write(`${line}\n`)
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

describe('buildCodebuddyArgs', () => {
  it('matches the measured CodeBuddy argv order', () => {
    const args = buildCodebuddyArgs({
      model: 'claude-sonnet-4-20250514',
      maxTurns: 25,
      systemPrompt: 'You are an agent.',
    })
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--disallowedTools',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      '--model',
      'claude-sonnet-4-20250514',
      '--max-turns',
      '25',
      '--append-system-prompt',
      'You are an agent.',
    ])
  })

  it('passes each interactive tool as its own argv value', () => {
    const args = buildCodebuddyArgs({})
    const idx = args.indexOf('--disallowedTools')
    expect(idx).toBeGreaterThan(-1)
    // The CLI matches tool names exactly, so a comma-joined string matches
    // nothing despite its own help text.
    expect(args.slice(idx + 1, idx + 4)).toEqual([
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
  })

  it('never passes --strict-mcp-config (it would drop the user/project scopes)', () => {
    const args = buildCodebuddyArgs({ mcpConfigPath: '/tmp/mcp.json' })
    expect(args).not.toContain('--strict-mcp-config')
  })

  it('injects --effort once and drops a caller override', () => {
    const args = buildCodebuddyArgs({
      effort: 'medium',
      extraArgs: ['--effort', 'max', '--max-budget-usd', '2.00'],
    })
    const efforts = args.filter((a) => a === '--effort')
    expect(efforts).toHaveLength(1)
    expect(args[args.indexOf('--effort') + 1]).toBe('medium')
    expect(args).toContain('--max-budget-usd')
  })

  it('omits --effort entirely when no effort is requested', () => {
    expect(buildCodebuddyArgs({})).not.toContain('--effort')
  })

  it('filters blocked protocol flags from extra args', () => {
    const args = buildCodebuddyArgs({
      extraArgs: ['--output-format', 'text', '--permission-mode', 'plan', '--verbose'],
    })
    expect(args.join(' ')).not.toContain('--output-format text')
    expect(args.join(' ')).not.toContain('--permission-mode plan')
    expect(args).toContain('--verbose')
  })

  it('carries --resume when a session is resumed', () => {
    const args = buildCodebuddyArgs({ resumeSessionId: 'sess-abc123' })
    const idx = args.indexOf('--resume')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('sess-abc123')
  })

  it('blocks the same protocol flags as claude', () => {
    expect(Object.keys(CODEBUDDY_BLOCKED_ARGS).sort()).toEqual(
      ['-p', '--effort', '--input-format', '--mcp-config', '--output-format', '--permission-mode'].sort(),
    )
  })

  it('declares the two dialect differences from claude', () => {
    expect(CODEBUDDY_DIALECT.strictMcpConfigWhenManaged).toBe(false)
    expect(CODEBUDDY_DIALECT.forwardSystemPrompt).toBe(true)
    // codebuddy.go's switch reads no terminal_reason and no async-launch flag.
    expect(CODEBUDDY_DIALECT.readsTerminalReason).toBe(false)
    expect(CODEBUDDY_DIALECT.detectsAsyncLaunch).toBe(false)
  })
})

describe('the claude parser reused for codebuddy', () => {
  it('normalizes the captured codebuddy stream', () => {
    const messages: string[] = []
    const parser = new ClaudeStreamParser(CODEBUDDY_DIALECT, {
      emit: (m) => messages.push(m.type),
      writeFrame: () => {},
      closeInput: () => {},
    })
    for (const line of CODEBUDDY_CAPTURE.split('\n')) parser.handleLine(line)

    // Two system frames (init + status), a tolerated snapshot frame, a thinking
    // block, a text block, then the result.
    expect(messages).toEqual(['status', 'status', 'thinking', 'text'])
    expect(parser.state.sessionId).toBe('6581ce83-6a1d-4f6f-9a3d-2f5d0b6b6f11')
    expect(parser.state.finalResultText).toBe('PONG')
    expect(parser.state.sawResult).toBe(true)
    expect(parser.state.toolUseCount).toBe(0)
    expect(parser.state.invalidEventCount).toBe(0)
    // modelUsage wins over the flat usage object, and the fork's snake_case
    // cache fields map onto our buckets.
    expect(parser.state.usage).toEqual({
      inputTokens: 22408,
      outputTokens: 100,
      cacheReadTokens: 11264,
      cacheWriteTokens: 11144,
    })
  })

  it('emits the codebuddy thinking text (field name is `thinking`, not `text`)', () => {
    const contents: string[] = []
    const parser = new ClaudeStreamParser(CODEBUDDY_DIALECT, {
      emit: (m) => contents.push(m.content ?? ''),
      writeFrame: () => {},
      closeInput: () => {},
    })
    for (const line of CODEBUDDY_CAPTURE.split('\n')) parser.handleLine(line)
    expect(contents).toContain('The user wants exactly PONG.')
  })
})

describe('run() with an interpreter', () => {
  it('spawns [interpreter, executable, ...argsPrefix, ...args] and settles completed', async () => {
    const child = new FakeChild()
    let spec: SpawnSpec | undefined
    const deps = makeDeps({
      command: {
        executable: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
        interpreter: '/Applications/WorkBuddy.app/Contents/Resources/node',
        argsPrefix: ['--profile', 'workbuddy'],
      },
    })
    const backend = createBackendWithRuntime('codebuddy', deps, {
      spawn: (s) => {
        spec = s
        return child
      },
      now: () => 500,
    })
    const handle = await backend.run(
      { agent: 'workbuddy', prompt: 'Reply with exactly: PONG' },
      deps,
      new AbortController().signal,
    )
    child.emit(CODEBUDDY_CAPTURE)
    child.finish(0)
    const result = await handle.done

    expect(spec?.command).toBe('/Applications/WorkBuddy.app/Contents/Resources/node')
    expect(spec?.args[0]).toBe(
      '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    )
    expect(spec?.args.slice(1, 3)).toEqual(['--profile', 'workbuddy'])
    expect(spec?.args).toContain('EnterPlanMode')
    expect(result.status).toBe('completed')
    expect(result.text).toBe('PONG')
    expect(result.usage?.cacheWriteTokens).toBe(11144)
    expect(result.backendSessionId).toBe('6581ce83-6a1d-4f6f-9a3d-2f5d0b6b6f11')
    // The stream-json prompt frame went to stdin, not argv.
    expect(child.input).toContain('Reply with exactly: PONG')
    expect(spec?.args.join(' ')).not.toContain('Reply with exactly')
  })
})
