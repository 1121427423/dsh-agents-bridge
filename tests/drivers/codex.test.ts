/**
 * The codex `exec --json` dialect: argv, the resume subcommand, event
 * normalization, the terminal contract, stdin handling and cancellation.
 *
 * Fixtures are REAL captures from codex-cli 0.154.0 — obtained by pointing the
 * real binary at `tests/fixtures/stub-responses-server.mjs`, because this host's
 * stored credential is rejected by its configured gateway and a live run cannot
 * succeed. One fixture (`codex-mcp-tool-call.derived.ndjson`) is a transcription
 * of the upstream `exec_events.rs` struct rather than a capture; its name says so
 * and `tests/fixtures/CODEX-PROVENANCE.md` records the difference.
 *
 * No test spawns a real CLI: the runtime seam takes a fake `SpawnFn`.
 */
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentMessage, DriverDeps } from '../../src/kernel/types.ts'
import type { ProcessExit, SpawnFn, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import {
  clearDriverRuntime,
  createBackend,
  createBackendWithRuntime,
  DRIVER_FAMILIES,
} from '../../src/drivers/index.ts'
import {
  CODEX_BLOCKED_ARGS,
  CodexStreamParser,
  DEFAULT_CODEX_IDLE_TIMEOUT_MS,
  buildCodexArgs,
  codexSandboxFromEnv,
  codexStderrDiagnosis,
  codexToolInput,
  codexToolOutput,
  parseCodexUsage,
} from '../../src/drivers/codex.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

/** Real bytes: `codex exec --json` against the responses stub, scenario `plain`. */
const CODEX_SUCCESS = fixture('codex-success.ndjson')
/** Real bytes: scenario `tools` — reasoning + `exec_command`. */
const CODEX_TOOLS = fixture('codex-tools.ndjson')
/** Real bytes: scenario `patch` — `apply_patch` producing a `file_change` item. */
const CODEX_FILE_CHANGE = fixture('codex-file-change.ndjson')
/** Real bytes: the credential-rejected run (5 retries → `turn.failed`, exit 1). */
const CODEX_FAILURE = fixture('codex-failure.ndjson')
/** Transcribed from upstream `exec_events.rs`, NOT captured. */
const CODEX_MCP_DERIVED = fixture('codex-mcp-tool-call.derived.ndjson')

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return {
    command: { executable: 'codex' },
    env: {},
    logger: silentLogger,
    ...overrides,
  }
}

/** In-memory `SpawnedProcess`: no real process is ever created. */
class FakeChild implements SpawnedProcess {
  readonly pid = 5150
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

  /** Anything the driver wrote to stdin — must stay empty for codex. */
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

function collectSink(): { messages: AgentMessage[]; sink: { emit: (m: AgentMessage) => void } } {
  const messages: AgentMessage[] = []
  return { messages, sink: { emit: (m) => messages.push(m) } }
}

function parseAll(text: string): { messages: AgentMessage[]; parser: CodexStreamParser } {
  const { messages, sink } = collectSink()
  const parser = new CodexStreamParser(sink, () => 1234)
  for (const line of text.split('\n')) parser.handleLine(line)
  return { messages, parser }
}

/** Wire a fake child into a codex backend, returning the captured spawn spec. */
function harness(
  child: FakeChild,
  deps: DriverDeps = makeDeps(),
): { backend: ReturnType<typeof createBackendWithRuntime>; spec: () => SpawnSpec | undefined } {
  let spec: SpawnSpec | undefined
  const spawn: SpawnFn = (s) => {
    spec = s
    return child
  }
  return {
    backend: createBackendWithRuntime('codex', deps, { spawn, now: () => 5000 }),
    spec: () => spec,
  }
}

describe('codex registration', () => {
  it('is in DRIVER_FAMILIES and the factory switches', () => {
    expect(DRIVER_FAMILIES).toContain('codex')
    // Both switches must know the family: the plain factory throws if it does
    // not, which would leave `createBackend('codex', …)` unreachable at runtime.
    expect(createBackend('codex', makeDeps()).family).toBe('codex')
    expect(createBackendWithRuntime('codex', makeDeps(), { spawn: () => new FakeChild() }).family).toBe(
      'codex',
    )
  })
})

describe('buildCodexArgs', () => {
  it('emits the fixed protocol flags with the prompt last', () => {
    expect(buildCodexArgs({ prompt: 'reply with OK' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      'reply with OK',
    ])
  })

  it('orders cwd, model, sandbox and effort, then filters blocked extras', () => {
    const args = buildCodexArgs({
      prompt: 'go',
      cwd: '/work/project',
      model: 'gpt-5-codex',
      sandbox: 'workspace-write',
      effort: 'high',
      extraArgs: ['--json', '--cd', '/elsewhere', '-C', '/other', '-s', 'read-only', '--color', 'never'],
    })
    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/work/project',
      '-m',
      'gpt-5-codex',
      '-s',
      'workspace-write',
      // The value is quoted because `-c` parses its value as TOML.
      '-c',
      'model_reasoning_effort="high"',
      '--color',
      'never',
      'go',
    ])
    // The protocol flag never reaches the CLI twice, and a blocked flag's value
    // token is dropped with it (otherwise `/elsewhere` becomes the prompt).
    expect(args.filter((a) => a === '--json')).toHaveLength(1)
    expect(args).not.toContain('/elsewhere')
    expect(args).not.toContain('/other')
    expect(args).not.toContain('read-only')
    expect(CODEX_BLOCKED_ARGS['-C']).toBe('withValue')
  })

  it('uses the resume subcommand, which does not accept -C or -s', () => {
    const args = buildCodexArgs({
      prompt: 'second turn',
      cwd: '/work/project',
      resumeSessionId: '01a0a0a0-1111-7000-8000-000000000001',
      sandbox: 'workspace-write',
      model: 'gpt-5-codex',
    })
    expect(args).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-m',
      'gpt-5-codex',
      '01a0a0a0-1111-7000-8000-000000000001',
      'second turn',
    ])
    // `codex exec resume --help` lists neither -C/--cd nor -s/--sandbox; passing
    // them makes clap reject the whole invocation.
    expect(args).not.toContain('-C')
    expect(args).not.toContain('-s')
  })

  /**
   * MI-20 — the resume id lands in a POSITIONAL slot, so it must be an id.
   *
   * `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` reads its positionals in
   * order: an id that starts with `-` is parsed as a flag instead (clap then
   * rejects the whole invocation, or worse, silently consumes the prompt as the
   * session id), and an empty one would push the prompt into the SESSION_ID
   * slot. Validation therefore belongs in the ONE place that owns the slot.
   */
  describe('MI-20: a resume id that is not an id is refused, never slotted', () => {
    it('throws a naming error for a "-"-leading id instead of placing it', () => {
      expect(() => buildCodexArgs({ resumeSessionId: '--sandbox', prompt: 'p' })).toThrow(
        /resume session id/i,
      )
      expect(() => buildCodexArgs({ resumeSessionId: '--sandbox', prompt: 'p' })).toThrow(
        /--sandbox/,
      )
    })

    it('throws a naming error for an empty id', () => {
      expect(() => buildCodexArgs({ resumeSessionId: '   ', prompt: 'p' })).toThrow(
        /resume session id/i,
      )
    })

    it('negative control: a UUID id still lands in the resume slot', () => {
      const args = buildCodexArgs({
        prompt: 'p',
        resumeSessionId: '01a0a0a0-1111-7000-8000-000000000001',
      })
      expect(args).toEqual([
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '01a0a0a0-1111-7000-8000-000000000001',
        'p',
      ])
    })

    it('negative control: no resume id at all still means a fresh run', () => {
      expect(buildCodexArgs({ prompt: 'p' })).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        'p',
      ])
    })
  })
})

describe('codexSandboxFromEnv', () => {
  it('reads the sandbox backdoor and ignores an empty value', () => {
    expect(codexSandboxFromEnv({})).toBeUndefined()
    expect(codexSandboxFromEnv({ DSH_AGENTS_BRIDGE_CODEX_SANDBOX: '' })).toBeUndefined()
    expect(
      codexSandboxFromEnv({ DSH_AGENTS_BRIDGE_CODEX_SANDBOX: 'danger-full-access' }),
    ).toBe('danger-full-access')
  })
})

describe('parseCodexUsage', () => {
  it('maps the dialect fields onto the frozen usage buckets', () => {
    expect(
      parseCodexUsage({
        input_tokens: 1624,
        cached_input_tokens: 1280,
        cache_write_input_tokens: 64,
        output_tokens: 48,
        reasoning_output_tokens: 16,
      }),
    ).toEqual({
      inputTokens: 1624,
      outputTokens: 48,
      cacheReadTokens: 1280,
      cacheWriteTokens: 64,
      reasoningTokens: 16,
    })
  })

  it('returns undefined for absent or all-zero usage', () => {
    expect(parseCodexUsage(undefined)).toBeUndefined()
    expect(parseCodexUsage({})).toBeUndefined()
    expect(parseCodexUsage({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
  })
})

describe('CodexStreamParser', () => {
  it('normalizes the real captured success stream', () => {
    const { messages, parser } = parseAll(CODEX_SUCCESS)

    expect(messages.map((m) => m.type)).toEqual(['status', 'error', 'status', 'error', 'text'])
    expect(messages.every((m) => m.at === 1234)).toBe(true)
    // Both `error` items are non-fatal warnings that the real CLI emits before a
    // successful turn; they must be reported without failing the run.
    expect(messages[1]).toMatchObject({ type: 'error', level: 'error' })
    expect(messages[1]?.content).toMatch(/loading hooks from both/)
    expect(messages[3]?.content).toMatch(/Skill descriptions were shortened/)
    expect(messages[4]).toMatchObject({ type: 'text', content: 'OK' })

    expect(parser.state.sawTurnCompleted).toBe(true)
    expect(parser.state.sawTurnFailed).toBe(false)
    expect(parser.state.finalAgentText).toBe('OK')
    expect(parser.state.threadId).toBe('01a0a0a0-1111-7000-8000-000000000001')
    expect(parser.state.usage).toEqual({
      inputTokens: 812,
      outputTokens: 24,
      cacheReadTokens: 640,
      cacheWriteTokens: 0,
      reasoningTokens: 8,
    })
    expect(parser.state.invalidLineCount).toBe(0)
    expect(parser.state.unknownEventCount).toBe(0)
  })

  it('turns reasoning into thinking and command execution into tool_use + tool_result', () => {
    const { messages, parser } = parseAll(CODEX_TOOLS)

    expect(messages.map((m) => m.type)).toEqual([
      'status',
      'error',
      'status',
      'error',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
    ])
    expect(messages[4]).toMatchObject({
      type: 'thinking',
      content: 'I should run a command to check.',
    })
    expect(messages[5]).toMatchObject({
      type: 'tool_use',
      tool: 'command_execution',
      callId: 'item_3',
      input: { command: "/bin/zsh -lc 'echo stub-tool-output'" },
    })
    expect(messages[6]).toMatchObject({
      type: 'tool_result',
      tool: 'command_execution',
      callId: 'item_3',
      output: 'stub-tool-output\n',
    })
    expect(parser.state.toolUseCount).toBe(1)
    expect(parser.state.finalAgentText).toBe('OK')
  })

  it('normalizes a file_change item and announces it exactly once', () => {
    const { messages, parser } = parseAll(CODEX_FILE_CHANGE)
    const tools = messages.filter((m) => m.type === 'tool_use')
    const results = messages.filter((m) => m.type === 'tool_result')

    // The item arrives as started → completed; that is ONE call, not two.
    expect(tools).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      type: 'tool_use',
      tool: 'file_change',
      callId: 'item_2',
      input: { changes: [{ path: '/work/project/stub-patched.txt', kind: 'add' }] },
    })
    expect(results[0]).toMatchObject({
      type: 'tool_result',
      tool: 'file_change',
      callId: 'item_2',
      output: 'add /work/project/stub-patched.txt',
    })
    expect(parser.state.toolUseCount).toBe(1)
  })

  it('normalizes MCP tool calls and survives an unmapped item type', () => {
    const { messages, parser } = parseAll(CODEX_MCP_DERIVED)

    expect(messages.map((m) => m.type)).toEqual([
      'status',
      'status',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'log',
      'log',
      'text',
    ])
    expect(messages[2]).toMatchObject({
      type: 'tool_use',
      tool: 'mcp_tool_call',
      callId: 'item_2',
      input: { server: 'stub', tool: 'stub_echo', arguments: { text: 'hello from stub' } },
    })
    expect(messages[3]?.output).toContain('stub-mcp-output:hello from stub')
    // A failed MCP call still produces a result, carrying the server's error.
    expect(messages[5]).toMatchObject({ type: 'tool_result', callId: 'item_3' })
    expect(messages[5]?.output).toBe('error: unknown tool: stub_missing')
    // `web_search` is a tool call in this dialect, not an unknown frame.
    expect(messages[6]).toMatchObject({ type: 'tool_use', tool: 'web_search', callId: 'item_4' })
    // `todo_list` and a future item type are logged, never fatal.
    expect(messages[8]?.type).toBe('log')
    expect(messages[8]?.content).toMatch(/unmapped codex item type "todo_list"/)
    expect(messages[9]?.content).toMatch(/unmapped codex item type "future_dialect_item"/)
    expect(parser.state.unknownEventCount).toBe(2)
    expect(parser.state.finalAgentText).toBe('OK')
    expect(parser.state.usage).toEqual({
      inputTokens: 2048,
      outputTokens: 64,
      cacheReadTokens: 1792,
      cacheWriteTokens: 64,
      reasoningTokens: 32,
    })
  })

  it('records turn.failed and the retry errors from the real credential rejection', () => {
    const { messages, parser } = parseAll(CODEX_FAILURE)

    // 2 non-fatal `error` items + 5 retry `error` frames + the final `error`
    // frame + the `turn.failed` message.
    expect(messages.filter((m) => m.type === 'error')).toHaveLength(9)
    expect(messages.every((m) => m.type === 'error' || m.type === 'status')).toBe(true)
    expect(parser.state.sawTurnCompleted).toBe(false)
    expect(parser.state.sawTurnFailed).toBe(true)
    expect(parser.state.turnFailure).toMatch(/401 Unauthorized/)
    expect(parser.state.lastError).toMatch(/401 Unauthorized/)
    expect(parser.state.finalAgentText).toBe('')
    expect(parser.state.threadId).toBe('01a0a0a0-4444-7000-8000-000000000004')
  })

  it('tolerates non-JSON lines, unknown event types and malformed items', () => {
    const { messages, parser } = parseAll(
      [
        'banner: codex-cli 0.154.0 starting',
        '{"type":"future.envelope","payload":42}',
        '{"type":"item.completed"}',
        '{"type":"item.completed","item":"not-an-object"}',
        '{"type":"thread.started","thread_id":"t-1"}',
        '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}',
      ].join('\n'),
    )

    expect(parser.state.invalidLineCount).toBe(1)
    expect(messages[0]).toMatchObject({
      type: 'log',
      level: 'debug',
      content: 'banner: codex-cli 0.154.0 starting',
    })
    expect(messages[1]?.type).toBe('log')
    expect(messages[1]?.content).toMatch(/unrecognized codex event type "future\.envelope"/)
    expect(parser.state.unknownEventCount).toBe(1)
    // The malformed item frames contribute nothing but still let the run settle.
    expect(parser.state.sawTurnCompleted).toBe(true)
    expect(parser.state.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('is tolerant of blank lines and of an item with a missing type', () => {
    const { messages, parser } = parseAll('\n   \n  \n')
    expect(messages).toEqual([])
    expect(parser.state.lineCount).toBe(0)

    const second = parseAll('{"type":"item.completed","item":{"id":"x"}}')
    expect(second.messages[0]?.content).toMatch(/unmapped codex item type ""/)
  })
})

describe('codex helper functions', () => {
  it('annotates a non-zero command exit instead of dropping it', () => {
    expect(
      codexToolOutput({
        type: 'command_execution',
        aggregated_output: '',
        exit_code: 1,
        status: 'failed',
      }),
    ).toBe('\n[exit_code=1 status=failed]')
    expect(
      codexToolOutput({
        type: 'command_execution',
        aggregated_output: 'ok\n',
        exit_code: 0,
        status: 'completed',
      }),
    ).toBe('ok\n')
  })

  it('exposes the invocation identity for each tool item type', () => {
    expect(codexToolInput({ type: 'command_execution', command: 'ls' })).toEqual({ command: 'ls' })
    expect(codexToolInput({ type: 'file_change', changes: [{ path: 'a', kind: 'add' }] })).toEqual({
      changes: [{ path: 'a', kind: 'add' }],
    })
    expect(
      codexToolInput({ type: 'mcp_tool_call', server: 's', tool: 't', arguments: { a: 1 } }),
    ).toEqual({ server: 's', tool: 't', arguments: { a: 1 } })
  })

  it('drops known stderr noise but keeps a real diagnosis', () => {
    const noise = [
      'Reading additional input from stdin...',
      '2026-09-16T15:28:45Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
      '2026-09-16T15:28:44Z ERROR codex_skills_extension::loader::host: skills scan reached its traversal limit (root: file:///Users/example/.codex/skills)',
    ].join('\n')
    expect(codexStderrDiagnosis(noise)).toBe('')
    expect(codexStderrDiagnosis(`${noise}\nError: stream disconnected before completion`)).toBe(
      'Error: stream disconnected before completion',
    )
  })

  it('declares a 300s idle watchdog', () => {
    expect(DEFAULT_CODEX_IDLE_TIMEOUT_MS).toBe(300_000)
  })
})

describe('run() over a fake child', () => {
  it('spawns the built argv, closes stdin, streams the capture and settles completed', async () => {
    const child = new FakeChild()
    const { backend, spec } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'reply with OK', cwd: '/work/project' },
      makeDeps(),
      new AbortController().signal,
    )
    expect(handle.sessionId).toMatch(/^dsh-codex-/)
    expect(handle.snapshot().status).toBe('running')

    child.emit(CODEX_SUCCESS)
    child.finish(0)
    const result = await handle.done

    expect(spec()?.command).toBe('codex')
    expect(spec()?.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/work/project',
      'reply with OK',
    ])
    expect(spec()?.cwd).toBe('/work/project')
    expect(result.status).toBe('completed')
    expect(result.text).toBe('OK')
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.usage).toEqual({
      inputTokens: 812,
      outputTokens: 24,
      cacheReadTokens: 640,
      cacheWriteTokens: 0,
      reasoningTokens: 8,
    })
    expect(result.backendSessionId).toBe('01a0a0a0-1111-7000-8000-000000000001')
    expect(result.durationMs).toBe(0)

    // The prompt travelled positionally and stdin was CLOSED IMMEDIATELY: with an
    // open pipe codex blocks forever waiting for stdin (measured, 0 output/25s).
    expect(child.input).toBe('')
    expect(child.stdin.writableEnded).toBe(true)
    expect(handle.snapshot().terminal).toBe(true)
    expect(handle.messages.map((m) => m.type)).toEqual([
      'status',
      'error',
      'status',
      'error',
      'text',
    ])
  })

  it('fails on the real credential-rejected capture with the last error text and exit 1', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit(CODEX_FAILURE)
    child.finish(1)
    const result = await handle.done

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
    expect(result.text).toBe('')
    expect(result.error).toMatch(/401 Unauthorized/)
    // A failed run still reports its thread: `thread.started` arrives before the
    // model call, and the id is the launcher's own resume pointer.
    expect(result.backendSessionId).toBe('01a0a0a0-4444-7000-8000-000000000004')
  })

  it('treats error events as non-terminal when the turn then completes', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit('{"type":"error","message":"Reconnecting... 1/5"}\n')
    child.emit('{"type":"error","message":"Reconnecting... 2/5"}\n')
    child.emit(CODEX_SUCCESS)
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.text).toBe('OK')
    expect(result.error).toBeUndefined()
  })

  it('fails a non-zero exit that never reached a terminal turn event', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit('{"type":"thread.started","thread_id":"t"}\n')
    child.emit('{"type":"error","message":"stream disconnected"}\n')
    child.finish(2)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(2)
    expect(result.error).toBe('stream disconnected (codex exit status 2)')
    expect(result.text).toBe('')
  })

  it('fails a clean exit that produced no terminal turn event', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit('{"type":"thread.started","thread_id":"t"}\n')
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe('codex stream ended without a terminal turn event')
    expect(result.text).toBe('')
  })

  it('never fails a run for the MCP-transport noise codex writes to stderr', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.stderrText(
      '2026-09-16T15:28:45.382368Z ERROR rmcp::transport::worker: worker quit with fatal: ' +
        'Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed")))\n',
    )
    child.emit(CODEX_SUCCESS)
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.error).toBeUndefined()
  })

  it('appends only the non-noise part of stderr to a failure', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.stderrText(
      'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\n' +
        'Error: no such conversation\n',
    )
    child.emit('{"type":"turn.failed","error":{"message":"resume rejected"}}\n')
    child.finish(1)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe('resume rejected: Error: no such conversation')
    expect(result.error).not.toMatch(/rmcp/)
  })

  it('does not let a non-JSON banner on stdout kill the run', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit('codex-cli 0.154.0\nthis line is not JSON\n')
    child.emit(CODEX_SUCCESS)
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.text).toBe('OK')
    expect(handle.messages[0]).toMatchObject({ type: 'log', level: 'debug' })
  })

  it('reports a missing executable instead of hanging', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    child.failToStart('spawn codex ENOENT')
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toBe('codex failed to start: spawn codex ENOENT')
  })

  it('cancels through the abort signal and terminates the process group', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const controller = new AbortController()
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      controller.signal,
    )
    controller.abort()
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('execution cancelled')
    expect(child.terminated).toBe(true)
    expect(handle.snapshot().status).toBe('cancelled')
  })

  it('cancels through the session handle', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x' },
      makeDeps(),
      new AbortController().signal,
    )
    await handle.cancel('user stopped it')
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('user stopped it')
    expect(child.terminated).toBe(true)
  })

  it('honours a hard timeout', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x', timeoutMs: 10 },
      makeDeps(),
      new AbortController().signal,
    )
    const result = await handle.done
    expect(result.status).toBe('timeout')
    expect(result.error).toBe('codex timed out after 10ms')
    expect(child.terminated).toBe(true)
  })

  /**
   * MI-21 — a terminal frame already in hand must beat the timer.
   *
   * The driver settles only at exit + flush, so between `turn.completed` and the
   * process actually dying a timer can fire. It used to latch `timeout` with
   * empty text, discarding a turn the parser had already read — the answer was
   * on the wire and got thrown away. zcode settles from the parser state at the
   * same boundary; this mirrors it.
   */
  it('MI-21: settles from the parser state when turn.completed already arrived before the timeout', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x', timeoutMs: 25 },
      makeDeps(),
      new AbortController().signal,
    )
    // The whole turn is on stdout — answer AND terminal frame — but the fake
    // child deliberately stays alive, so the hard timer wins the race with the
    // exit+flush settle.
    child.emit(CODEX_SUCCESS)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.text).toBe('OK')
    expect(child.terminated).toBe(true)
  })

  it('MI-21 negative control: without the terminal frame the same timer still reports timeout', async () => {
    const child = new FakeChild()
    const { backend } = harness(child)
    const handle = await backend.run(
      { agent: 'codex', prompt: 'x', timeoutMs: 25 },
      makeDeps(),
      new AbortController().signal,
    )
    // Identical stream MINUS `turn.completed`: nothing proves a finished turn,
    // so the timer verdict stands and the partial text is withheld.
    child.emit(
      CODEX_SUCCESS.split('\n')
        .filter((line) => !line.includes('"turn.completed"'))
        .join('\n'),
    )
    const result = await handle.done
    expect(result.status).toBe('timeout')
    expect(result.text).toBe('')
  })

  it('passes the interpreter rule and a filtered launch prefix straight to spawn', async () => {
    const child = new FakeChild()
    const deps = makeDeps({
      command: {
        executable: '/opt/codex/bin/codex',
        interpreter: '/opt/codex/node',
        argsPrefix: ['--json', '--profile', 'work'],
      },
    })
    const { backend, spec } = harness(child, deps)
    const handle = await backend.run({ agent: 'codex', prompt: 'x' }, deps, new AbortController().signal)
    child.finish(0)
    await handle.done
    expect(spec()?.command).toBe('/opt/codex/node')
    // The prefix's protocol flag is dropped, its positional tokens are not.
    expect(spec()?.args.slice(0, 4)).toEqual([
      '/opt/codex/bin/codex',
      '--profile',
      'work',
      'exec',
    ])
  })

  it('resumes with the subcommand argv and keeps the returned thread id', async () => {
    const child = new FakeChild()
    const { backend, spec } = harness(child)
    const handle = await backend.run(
      {
        agent: 'codex',
        prompt: 'follow up',
        cwd: '/work/project',
        resumeSessionId: '01a0a0a0-1111-7000-8000-000000000001',
      },
      makeDeps(),
      new AbortController().signal,
    )
    child.emit(CODEX_SUCCESS)
    child.finish(0)
    const result = await handle.done
    expect(spec()?.args).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '01a0a0a0-1111-7000-8000-000000000001',
      'follow up',
    ])
    expect(result.status).toBe('completed')
    // Verified live: a resumed run re-emits the SAME thread_id, so the pointer a
    // caller holds across `agents_send` stays valid.
    expect(result.backendSessionId).toBe('01a0a0a0-1111-7000-8000-000000000001')
  })

  it('emits -s only when the sandbox backdoor is set', async () => {
    const child = new FakeChild()
    const deps = makeDeps({ env: { DSH_AGENTS_BRIDGE_CODEX_SANDBOX: 'workspace-write' } })
    const { backend, spec } = harness(child, deps)
    const handle = await backend.run({ agent: 'codex', prompt: 'x' }, deps, new AbortController().signal)
    child.finish(0)
    await handle.done
    expect(spec()?.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'workspace-write',
      'x',
    ])
  })
})
