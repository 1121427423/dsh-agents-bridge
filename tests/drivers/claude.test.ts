/**
 * The claude stream-json dialect: argv, event normalization, auto-approval,
 * usage, the terminal contract and cancellation.
 *
 * Fixtures are real captured frames (`testdata/` shapes from Claude Code
 * 2.1.220 and CodeBuddy 2.137.1), not hand-invented JSON. No test spawns a real
 * CLI: the runtime seam takes a fake `SpawnFn`.
 */
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentMessage,
  DriverDeps,
} from '../../src/kernel/types.ts'
import type {
  ProcessExit,
  SpawnFn,
  SpawnSpec,
  SpawnedProcess,
} from '../../src/drivers/argv.ts'
import { clearDriverRuntime, createBackendWithRuntime } from '../../src/drivers/index.ts'
import {
  CLAUDE_DIALECT,
  ClaudeStreamParser,
  buildClaudeArgs,
  buildClaudeInput,
  claudeRootSudoPreflightError,
  claudeTerminalReasonFailure,
  claudeToolResultHasAsyncLaunch,
  resumeWasRejected,
  sanitizeClaudeChildEnv,
} from '../../src/drivers/claude.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

const CLAUDE_BASIC = fixture('claude-basic.ndjson')
const CLAUDE_CONTROL = fixture('claude-control-request.ndjson')
const CLAUDE_EXHAUSTED = fixture('claude-context-exhausted.ndjson')

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return {
    command: { executable: 'claude' },
    env: {},
    logger: silentLogger,
    ...overrides,
  }
}

/** In-memory `SpawnedProcess`: no real process is ever created. */
class FakeChild implements SpawnedProcess {
  readonly pid = 4242
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdinText: string[] = []
  readonly exited: Promise<ProcessExit>
  terminated = false
  #settleExit: (exit: ProcessExit) => void

  constructor() {
    this.#settleExit = () => {}
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.#settleExit = resolve
    })
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinText.push(chunk.toString('utf8'))
    })
    this.stdin.on('error', () => {})
  }

  /** The prompt/approval frames the driver wrote, as one string. */
  get input(): string {
    return this.stdinText.join('')
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

  failToStart(error: string): void {
    this.stdout.end()
    this.stderr.end()
    this.#settleExit({ code: null, signal: null, error })
  }

  stderrText(text: string): void {
    this.stderr.write(text)
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

afterEach(() => {
  clearDriverRuntime()
})

function collectSink(): {
  messages: AgentMessage[]
  frames: string[]
  sink: { emit: (m: AgentMessage) => void; writeFrame: (f: string) => void; closeInput: () => void }
  closed: () => boolean
} {
  const messages: AgentMessage[] = []
  const frames: string[] = []
  let closed = false
  return {
    messages,
    frames,
    closed: () => closed,
    sink: {
      emit: (m) => messages.push(m),
      writeFrame: (f) => frames.push(f),
      closeInput: () => {
        closed = true
      },
    },
  }
}

describe('buildClaudeArgs', () => {
  it('emits the fixed protocol flags and nothing else by default', () => {
    expect(buildClaudeArgs({})).toEqual([
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
    ])
  })

  it('orders model, effort, max-turns and resume, and filters blocked extras', () => {
    const args = buildClaudeArgs({
      model: 'claude-sonnet-4-5',
      effort: 'high',
      maxTurns: 25,
      resumeSessionId: 'sess-1',
      extraArgs: ['--output-format', 'text', '--max-budget-usd', '1.00'],
    })
    expect(args.slice(10)).toEqual([
      '--model',
      'claude-sonnet-4-5',
      '--effort',
      'high',
      '--max-turns',
      '25',
      '--resume',
      'sess-1',
      '--max-budget-usd',
      '1.00',
    ])
    expect(args).not.toContain('text')
  })

  it('enables strict MCP mode for a managed config and never inlines a system prompt', () => {
    const args = buildClaudeArgs({
      mcpConfigPath: '/tmp/mcp.json',
      systemPrompt: 'the entire runtime brief',
    })
    expect(args).toContain('--strict-mcp-config')
    // Claude Code loads the per-task CLAUDE.md, so --append-system-prompt would
    // duplicate the brief on every turn (multica MUL-5392).
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('the entire runtime brief')
  })
})

describe('buildClaudeInput', () => {
  it('is exactly one stream-json user frame', () => {
    const frame = buildClaudeInput('hello "world"')
    expect(frame.endsWith('\n')).toBe(true)
    expect(JSON.parse(frame)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello "world"' }] },
    })
  })
})

describe('ClaudeStreamParser', () => {
  it('normalizes a real captured stream and tolerates unknown event types', () => {
    const { sink, messages } = collectSink()
    const parser = new ClaudeStreamParser(CLAUDE_DIALECT, sink)
    for (const line of CLAUDE_BASIC.split('\n')) parser.handleLine(line)

    expect(messages.map((m) => m.type)).toEqual([
      'status',
      'log',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
    ])
    expect(messages[2]).toMatchObject({
      type: 'thinking',
      content: 'I should list the directory first.',
    })
    expect(messages[3]).toMatchObject({
      type: 'tool_use',
      tool: 'Bash',
      callId: 'toolu_1',
      input: { command: 'ls -1' },
    })
    expect(messages[4]).toMatchObject({
      type: 'tool_result',
      callId: 'toolu_1',
      output: 'alpha.txt\nbeta.txt',
    })
    expect(messages[5]).toMatchObject({
      type: 'text',
      content: 'Two files: alpha.txt and beta.txt.',
    })

    // The `file-history-snapshot` frame in the fixture must be ignored silently
    // (a fork adds event types without warning): it is counted as a decoded
    // event but produces no message and no invalid-event noise.
    expect(parser.state.invalidEventCount).toBe(0)
    expect(parser.state.eventCount).toBe(8)
    expect(parser.state.sessionId).toBe('7ff8bf88-4d29-47f6-8c54-87f7ec0b080b')
    expect(parser.state.sawResult).toBe(true)
    expect(parser.state.finalResultText).toBe('Two files: alpha.txt and beta.txt.')
    expect(parser.state.lastAssistantText).toBe('Two files: alpha.txt and beta.txt.')
    expect(parser.state.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 120,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
    })
  })

  it('does not let pre-tool narration become the final answer', () => {
    const { sink } = collectSink()
    const parser = new ClaudeStreamParser(CLAUDE_DIALECT, sink)
    parser.handleLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
      }),
    )
    expect(parser.state.lastAssistantText).toBe('Let me check.')
    parser.handleLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'b',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        },
      }),
    )
    expect(parser.state.lastAssistantText).toBe('')
  })

  it('auto-approves control requests and forces foreground execution', () => {
    const { sink, frames, closed } = collectSink()
    const parser = new ClaudeStreamParser(CLAUDE_DIALECT, sink)
    for (const line of CLAUDE_CONTROL.split('\n')) parser.handleLine(line)

    expect(frames).toHaveLength(2)
    const first = JSON.parse(frames[0] ?? '{}')
    expect(first).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-42',
        response: { behavior: 'allow', updatedInput: { command: 'pwd' } },
      },
    })
    // Byte-compat with claude: its permission client reads `behavior`, and the
    // `allowed` key CodeBuddy needs must never appear on claude's wire.
    expect(first.response.response).not.toHaveProperty('allowed')
    const second = JSON.parse(frames[1] ?? '{}')
    expect(second.response.response.updatedInput).toEqual({
      command: 'sleep 60',
      run_in_background: false,
    })
    // The terminal result closes stdin, after which no approval is written.
    expect(closed()).toBe(true)
    expect(parser.state.finalResultText).toBe('done after control')
  })

  it('ignores malformed lines instead of failing the run', () => {
    const { sink } = collectSink()
    const parser = new ClaudeStreamParser(CLAUDE_DIALECT, sink)
    parser.handleLine('not json at all')
    parser.handleLine('')
    expect(parser.state.invalidEventCount).toBe(1)
    expect(parser.state.eventCount).toBe(0)
  })
})

describe('claude helpers', () => {
  it('recognizes the structured context-exhaustion reason', () => {
    expect(claudeTerminalReasonFailure('prompt_too_long', 'Prompt is too long')).toMatch(
      /terminal_reason=prompt_too_long.*Prompt is too long/,
    )
    expect(claudeTerminalReasonFailure('error_max_turns', 'x')).toBe('')
    expect(claudeTerminalReasonFailure(undefined, undefined)).toBe('')
  })

  it('detects async background launches in every tool-result shape', () => {
    expect(claudeToolResultHasAsyncLaunch({ status: 'async_launched' })).toBe(true)
    expect(
      claudeToolResultHasAsyncLaunch({ content: [{ status: 'async_launched' }] }),
    ).toBe(true)
    expect(claudeToolResultHasAsyncLaunch([{ status: 'async_launched' }])).toBe(true)
    expect(claudeToolResultHasAsyncLaunch('{"status":"async_launched"}')).toBe(true)
    expect(claudeToolResultHasAsyncLaunch('plain text')).toBe(false)
  })

  it('strips only internal runtime markers from the child environment', () => {
    const env = sanitizeClaudeChildEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDECODE_FOO: 'x',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe',
      PATH: '/usr/bin',
    })
    expect(env).toEqual({
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe',
      PATH: '/usr/bin',
    })
  })

  it('refuses bypassPermissions under root without a sandbox marker', () => {
    const args = ['--permission-mode', 'bypassPermissions']
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect(claudeRootSudoPreflightError(args, {})).toMatch(/refuses bypassPermissions/)
      expect(claudeRootSudoPreflightError(args, { IS_SANDBOX: '1' })).toBeUndefined()
    } else {
      expect(claudeRootSudoPreflightError(args, {})).toBeUndefined()
    }
    expect(claudeRootSudoPreflightError(['--model', 'x'], {})).toBeUndefined()
  })

  it('flags a refused resume from stderr and from a differing session id', () => {
    expect(
      resumeWasRejected('sess-a', 'sess-a', true, ['No conversation found with session ID']),
    ).toBe(true)
    expect(resumeWasRejected('sess-a', 'sess-b', true, [''])).toBe(true)
    expect(resumeWasRejected('sess-a', 'sess-a', false, [''])).toBe(false)
    expect(resumeWasRejected('', '', true, [''])).toBe(false)
  })
})

describe('run() over a fake child', () => {
  it('spawns with the built argv, streams the fixture and settles completed', async () => {
    const child = new FakeChild()
    let spec: SpawnSpec | undefined
    const runtime = {
      spawn: (s: SpawnSpec) => {
        spec = s
        return child
      },
      now: () => 1000,
    }
    const backend = createBackendWithRuntime('claude', makeDeps(), runtime)
    const controller = new AbortController()
    const handle = await backend.run(
      { agent: 'claude', prompt: 'list the files' },
      makeDeps(),
      controller.signal,
    )
    expect(handle.sessionId).toMatch(/^dsh-claude-/)
    expect(handle.snapshot().status).toBe('running')

    // Emit BEFORE the prompt write is observed: the reader must already be
    // attached, which is the ordering multica's deadlock test protects.
    child.emit(CLAUDE_BASIC)
    child.finish(0)
    const result = await handle.done

    expect(spec?.command).toBe('claude')
    expect(spec?.args.slice(0, 2)).toEqual(['-p', '--output-format'])
    expect(result.status).toBe('completed')
    expect(result.text).toBe('Two files: alpha.txt and beta.txt.')
    expect(result.exitCode).toBe(0)
    expect(result.usage?.inputTokens).toBe(1000)
    expect(result.backendSessionId).toBe('7ff8bf88-4d29-47f6-8c54-87f7ec0b080b')
    expect(result.error).toBeUndefined()

    // The prompt frame went to stdin, and stdin was closed at the result event.
    expect(child.input).toContain('"type":"user"')
    expect(child.input).toContain('list the files')
    expect(child.stdin.writableEnded).toBe(true)
    expect(handle.snapshot().terminal).toBe(true)
    expect(handle.messages.length).toBe(6)
  })

  it('marks an error result as failed and reports no text', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit(
      `${JSON.stringify({ type: 'result', is_error: true, result: 'rate limited', session_id: 's' })}\n`,
    )
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe('rate limited')
    expect(result.text).toBe('')
  })

  it('fails a clean exit that never produced a result event', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit(`${JSON.stringify({ type: 'system', session_id: 's' })}\n`)
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe('claude stream ended without terminal result')
  })

  it('surfaces the structured context-exhaustion failure', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit(CLAUDE_EXHAUSTED)
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/terminal_reason=prompt_too_long/)
    expect(result.text).toBe('')
  })

  it('reports a missing executable instead of hanging', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.failToStart('spawn claude ENOENT')
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/claude exited with error: spawn claude ENOENT/)
  })

  it('cancels through the abort signal and terminates the process group', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const controller = new AbortController()
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x' },
      makeDeps(),
      controller.signal,
    )
    controller.abort()
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(child.terminated).toBe(true)
    expect(handle.snapshot().status).toBe('cancelled')
  })

  it('honours a hard timeout', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x', timeoutMs: 10 },
      makeDeps(),
      new AbortController().signal,
    )
    const result = await handle.done
    expect(result.status).toBe('timeout')
    expect(result.error).toBe('claude timed out after 10ms')
  })

  it('drops a resume pointer the CLI refused, keeping the stderr diagnosis', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x', resumeSessionId: 'sess-dead' },
      makeDeps(),
      new AbortController().signal,
    )
    child.stderrText('No conversation found with session ID: sess-dead\n')
    child.emit(
      `${JSON.stringify({ type: 'result', is_error: true, result: 'boom', session_id: 'sess-other' })}\n`,
    )
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.backendSessionId).toBeUndefined()
    expect(result.error).toMatch(/boom.*No conversation found/)
  })

  it('fails the run when a tool result reports an async background launch', async () => {
    const child = new FakeChild()
    const backend = createBackendWithRuntime('claude', makeDeps(), {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit(
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-async',
              content: { status: 'async_launched', message: 'background task launched' },
            },
          ],
        },
      })}\n`,
    )
    child.emit(
      `${JSON.stringify({ type: 'result', is_error: false, result: 'parent turn completed early', session_id: 's' })}\n`,
    )
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/async background task/)
  })

  it('passes the interpreter rule straight through to spawn', async () => {
    const child = new FakeChild()
    let spec: SpawnSpec | undefined
    const deps = makeDeps({
      command: {
        executable: '/Applications/WorkBuddy.app/cli/bin/codebuddy',
        interpreter: '/Applications/WorkBuddy.app/node',
        argsPrefix: ['--profile', 'workbuddy'],
      },
    })
    const backend = createBackendWithRuntime(
      'claude',
      deps,
      {
        spawn: (s) => {
          spec = s
          return child
        },
        now: () => 0,
      },
    )
    const handle = await backend.run(
      { agent: 'claude', prompt: 'x' },
      deps,
      new AbortController().signal,
    )
    child.finish(0)
    await handle.done
    expect(spec?.command).toBe('/Applications/WorkBuddy.app/node')
    expect(spec?.args.slice(0, 3)).toEqual([
      '/Applications/WorkBuddy.app/cli/bin/codebuddy',
      '--profile',
      'workbuddy',
    ])
  })
})
