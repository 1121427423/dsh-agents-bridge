/**
 * openclaw / AutoClaw: argv (including the mandatory session selector), NDJSON
 * events, the pretty-printed whole-buffer result, the complete-result protocol
 * boundary, and the config-invalid diagnosis.
 *
 * Fixtures are real captured output (`openclaw agent --local --json` stdout and
 * a streaming-event capture), not hand-invented JSON.
 */
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { DriverDeps } from '../../src/kernel/types.ts'
import type { ProcessExit, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import { createBackendWithRuntime } from '../../src/drivers/index.ts'
import {
  OPENCLAW_BLOCKED_ARGS,
  OPENCLAW_NO_PARSEABLE_OUTPUT,
  OpenclawStreamParser,
  buildOpenclawArgs,
  newOpenclawSessionId,
  openclawConfigDiagnosis,
  openclawProfileFromArgsPrefix,
  parseOpenclawUsage,
  parseWholeBufferOpenclawResult,
} from '../../src/drivers/openclaw.ts'

const OPENCLAW_RESULT = readFileSync(
  new URL('../fixtures/openclaw-result.ndjson', import.meta.url),
  'utf8',
)
const OPENCLAW_EVENTS = readFileSync(
  new URL('../fixtures/openclaw-events.ndjson', import.meta.url),
  'utf8',
)

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return { command: { executable: 'openclaw' }, env: {}, logger: silentLogger, ...overrides }
}

class FakeChild implements SpawnedProcess {
  readonly pid = 4244
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
    for (const line of text.split('\n')) if (line.trim() !== '') this.stdout.write(`${line}\n`)
  }

  stderrText(text: string): void {
    this.stderr.write(text)
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

describe('buildOpenclawArgs', () => {
  it('emits agent, --local, --json, the session selector and the inline message', () => {
    expect(
      buildOpenclawArgs({ prompt: 'hello', sessionId: 'ses-1' }),
    ).toEqual(['agent', '--local', '--json', '--session-id', 'ses-1', '--message', 'hello'])
  })

  it('always carries a session selector — openclaw refuses to run without one', () => {
    const args = buildOpenclawArgs({ prompt: 'x', sessionId: 'ses-1' })
    expect(args).toContain('--session-id')
    expect(args[args.indexOf('--session-id') + 1]).toBe('ses-1')
  })

  it('maps model to --agent but lets caller args win', () => {
    const injected = buildOpenclawArgs({ prompt: 'x', sessionId: 's', model: 'main' })
    expect(injected.slice(injected.indexOf('--agent'), injected.indexOf('--agent') + 2)).toEqual([
      '--agent',
      'main',
    ])
    const overridden = buildOpenclawArgs({
      prompt: 'x',
      sessionId: 's',
      model: 'main',
      extraArgs: ['--agent', 'other'],
    })
    expect(overridden.filter((a) => a === '--agent')).toHaveLength(1)
    expect(overridden[overridden.indexOf('--agent') + 1]).toBe('other')
  })

  it('maps effort to --thinking, after the caller args so last-wins favours it', () => {
    const args = buildOpenclawArgs({
      prompt: 'x',
      sessionId: 's',
      effort: 'high',
      extraArgs: ['--verbose', 'on'],
    })
    expect(args[args.indexOf('--thinking') + 1]).toBe('high')
    expect(args.indexOf('--thinking')).toBeGreaterThan(args.indexOf('--verbose'))
    expect(args[args.length - 2]).toBe('--message')
  })

  it('converts the timeout to whole seconds and omits it when unset', () => {
    const withTimeout = buildOpenclawArgs({ prompt: 'x', sessionId: 's', timeoutMs: 12_500 })
    expect(withTimeout[withTimeout.indexOf('--timeout') + 1]).toBe('12')
    expect(buildOpenclawArgs({ prompt: 'x', sessionId: 's' })).not.toContain('--timeout')
    expect(buildOpenclawArgs({ prompt: 'x', sessionId: 's', timeoutMs: 0 })).not.toContain('--timeout')
  })

  it('blocks the protocol flags from caller args', () => {
    const args = buildOpenclawArgs({
      prompt: 'x',
      sessionId: 's',
      extraArgs: [
        '--json',
        '--local',
        '--session-id',
        'other',
        '--message',
        'hijack',
        '--model',
        'gpt',
        '--system-prompt',
        'nope',
        '--channel',
        'cli',
      ],
    })
    expect(args.filter((a) => a === '--json')).toHaveLength(1)
    expect(args.filter((a) => a === '--local')).toHaveLength(1)
    expect(args.filter((a) => a === '--message')).toHaveLength(1)
    expect(args).not.toContain('other')
    expect(args).not.toContain('hijack')
    expect(args).not.toContain('--system-prompt')
    // Non-protocol caller flags survive.
    expect(args.slice(-4)).toEqual(['--channel', 'cli', '--message', 'x'])
    expect(Object.keys(OPENCLAW_BLOCKED_ARGS)).toContain('--json')
  })

  it('folds a system prompt into --message (there is no --system-prompt flag)', () => {
    const args = buildOpenclawArgs({ prompt: 'task', sessionId: 's', systemPrompt: 'rules' })
    expect(args[args.length - 1]).toBe('rules\n\ntask')
  })

  it('drops --local in gateway mode', () => {
    expect(buildOpenclawArgs({ prompt: 'x', sessionId: 's', mode: 'connect' })).toEqual([
      'agent',
      '--json',
      '--session-id',
      's',
      '--message',
      'x',
    ])
  })

  it('mints a UUID session id when the caller is not resuming', () => {
    expect(newOpenclawSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})

describe('OpenclawStreamParser', () => {
  function parse(text: string): {
    parser: OpenclawStreamParser
    messages: { type: string; content?: string; tool?: string; callId?: string }[]
  } {
    const messages: { type: string; content?: string; tool?: string; callId?: string }[] = []
    const parser = new OpenclawStreamParser({ emit: (m) => messages.push(m) })
    for (const line of text.split('\n')) parser.handleLine(line)
    return { parser, messages }
  }

  it('normalizes streaming NDJSON events', () => {
    const { parser, messages } = parse(OPENCLAW_EVENTS)
    const state = parser.finish()
    expect(state.output).toBe('Hello world')
    expect(state.sessionId).toBe('ses_stream_123')
    expect(state.gotEvents).toBe(true)
    expect(messages.map((m) => m.type)).toEqual([
      'status',
      'tool_use',
      'tool_result',
      'text',
      'text',
    ])
    expect(messages[1]).toMatchObject({ type: 'tool_use', tool: 'bash', callId: 'call_1' })
    expect(messages[2]).toMatchObject({ type: 'tool_result', callId: 'call_1' })
    expect(state.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
    })
  })

  it('parses the pretty-printed whole-buffer result that the line scanner cannot', () => {
    const whole = parseWholeBufferOpenclawResult(OPENCLAW_RESULT)
    expect(whole).toBeDefined()
    expect(whole?.payloads?.[0]?.text).toBe('hi from the raw fallback')

    const { parser, messages } = parse(OPENCLAW_RESULT)
    const state = parser.finish()
    expect(state.output).toBe('hi from the raw fallback')
    expect(state.sessionId).toBe('4dcd853a-6e6d-45af-977d-092f909a7a99')
    expect(state.model).toBe('anthropic/claude-opus-4.7')
    expect(state.usage).toEqual({
      inputTokens: 34620,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 46482,
    })
    expect(messages).toEqual([{ type: 'text', content: 'hi from the raw fallback', at: expect.any(Number) }])
  })

  it('falls back to raw stdout when nothing is JSON', () => {
    const { parser } = parse('plain log line\nanother line\n')
    const state = parser.finish()
    expect(state.status).toBe('completed')
    expect(state.output).toBe('plain log line\nanother line')
  })

  it('fails with the canonical message when stdout is empty', () => {
    const { parser } = parse('')
    expect(parser.finish()).toMatchObject({
      status: 'failed',
      error: OPENCLAW_NO_PARSEABLE_OUTPUT,
    })
  })

  it('fails on an error event and on a failing lifecycle phase', () => {
    const errorEvent = parse('{"type":"error","text":"model not found: gpt-99"}\n')
    expect(errorEvent.parser.finish()).toMatchObject({
      status: 'failed',
      error: 'model not found: gpt-99',
    })

    const lifecycle = parse(
      '{"type":"lifecycle","phase":"failed","error":{"name":"ProviderError","data":{"message":"boom"}}}\n',
    )
    expect(lifecycle.parser.finish()).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('tolerates the usage field-name variants', () => {
    expect(parseOpenclawUsage({ input_tokens: 1, output_tokens: 2, cached_input_tokens: 3 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    })
  })
})

describe('openclaw config diagnosis', () => {
  const failure = [
    'OpenClaw config is invalid',
    'File: ~/.openclaw/openclaw.json',
    'Problem: - <root>: Invalid input',
    'Fix: openclaw doctor --fix',
  ].join('\n')

  it('turns the invalid-config failure into the --profile autoclaw hint', () => {
    const diagnosis = openclawConfigDiagnosis(failure, ['agent'])
    expect(diagnosis).toMatch(/OpenClaw config is invalid/)
    expect(diagnosis).toMatch(/~\/\.openclaw\/openclaw\.json/)
    expect(diagnosis).toMatch(/--profile autoclaw/)
    expect(diagnosis).toMatch(/openclaw doctor --fix/)
  })

  it('points at the profile already in use instead when one is set', () => {
    const diagnosis = openclawConfigDiagnosis(failure, ['--profile', 'autoclaw', 'agent'])
    expect(diagnosis).toMatch(/already passes `--profile autoclaw`/)
    expect(diagnosis).toMatch(/~\/\.openclaw-autoclaw\/openclaw\.json/)
  })

  it('is silent for unrelated failures', () => {
    expect(openclawConfigDiagnosis('some other error', ['agent'])).toBe('')
  })

  it('reads the profile out of a prefix in both spellings', () => {
    expect(openclawProfileFromArgsPrefix(['--profile', 'autoclaw', 'agent'])).toBe('autoclaw')
    expect(openclawProfileFromArgsPrefix(['--profile=autoclaw'])).toBe('autoclaw')
    expect(openclawProfileFromArgsPrefix(['agent'])).toBeUndefined()
  })
})

describe('run() over a fake child', () => {
  it('requires a session selector and reports it as the resume pointer', async () => {
    const child = new FakeChild()
    let spec: SpawnSpec | undefined
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: (s) => {
        spec = s
        return child
      },
      now: () => 7,
    })
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'hi' },
      deps,
      new AbortController().signal,
    )
    child.emit(OPENCLAW_EVENTS)
    child.finish(0)
    const result = await handle.done

    const args = spec?.args ?? []
    const sessionSelector = args[args.indexOf('--session-id') + 1]
    expect(sessionSelector).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.status).toBe('completed')
    expect(result.text).toBe('Hello world')
    expect(result.backendSessionId).toBe(sessionSelector)
    expect(result.usage?.outputTokens).toBe(100)
  })

  it('keeps the caller-supplied session id when resuming', async () => {
    const child = new FakeChild()
    let spec: SpawnSpec | undefined
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: (s) => {
        spec = s
        return child
      },
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'again', resumeSessionId: 'ses-existing' },
      deps,
      new AbortController().signal,
    )
    child.emit('{"payloads":[{"text":"second turn"}],"meta":{"durationMs":5}}\n')
    child.finish(0)
    const result = await handle.done
    expect(spec?.args).toContain('ses-existing')
    expect(result.text).toBe('second turn')
    expect(result.backendSessionId).toBe('ses-existing')
  })

  it('applies the autoclaw profile prefix before the agent subcommand', async () => {
    const child = new FakeChild()
    let spec: SpawnSpec | undefined
    const deps = makeDeps({
      command: {
        executable: '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs',
        interpreter: '/Applications/AutoClaw.app/Contents/Resources/node',
        argsPrefix: ['--profile', 'autoclaw'],
      },
    })
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: (s) => {
        spec = s
        return child
      },
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'autoclaw', prompt: 'hi' },
      deps,
      new AbortController().signal,
    )
    child.emit('{"payloads":[{"text":"ok"}],"meta":{"durationMs":1}}\n')
    child.finish(0)
    await handle.done
    expect(spec?.args.slice(0, 5)).toEqual([
      '/Applications/AutoClaw.app/Contents/Resources/gateway/openclaw/openclaw.mjs',
      '--profile',
      'autoclaw',
      'agent',
      '--local',
    ])
  })

  it('treats a complete result as the protocol boundary when the CLI lingers', async () => {
    const child = new FakeChild()
    const deps = makeDeps({ env: { DSH_AGENTS_BRIDGE_OPENCLAW_IDLE_GRACE_MS: '10' } })
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'hi' },
      deps,
      new AbortController().signal,
    )
    // Emit the complete blob and deliberately never end stdout: this is the
    // production hang (result written at T+24s, process alive at T+8min).
    child.emit(OPENCLAW_RESULT)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.text).toBe('hi from the raw fallback')
    expect(child.terminated).toBe(true)
  })

  it('reports a config-invalid run as a failure with the profile hint', async () => {
    const child = new FakeChild()
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'hi' },
      deps,
      new AbortController().signal,
    )
    // Printed as plain stdout text and exiting 0 — without the signature check
    // this would be reported as a *successful* answer.
    child.emit('OpenClaw config is invalid\nFile: ~/.openclaw/openclaw.json\n')
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/--profile autoclaw/)
    expect(result.text).toBe('')
  })

  it('fails with the canonical message when nothing parses', async () => {
    const child = new FakeChild()
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'hi' },
      deps,
      new AbortController().signal,
    )
    child.finish(1)
    const result = await handle.done
    expect(result.status).toBe('failed')
    // multica keeps processOutput's own verdict here: a non-zero exit does not
    // replace "nothing parsed", because the exit code is a *consequence* of the
    // same failure and the canonical string is what alerts grep for.
    expect(result.error).toBe(OPENCLAW_NO_PARSEABLE_OUTPUT)
  })

  it('reports a non-zero exit when the stream did parse cleanly', async () => {
    const child = new FakeChild()
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'hi' },
      deps,
      new AbortController().signal,
    )
    child.emit(OPENCLAW_EVENTS)
    child.finish(1)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/openclaw exited with error: exit status 1/)
  })

  it('adds the upgrade hint when stderr carried the JSON blob instead of stdout', async () => {
    const child = new FakeChild()
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: () => child,
      now: () => 0,
    })
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'hi' },
      deps,
      new AbortController().signal,
    )
    child.stderrText('{"payloads":[{"text":"old build"}],"meta":{"durationMs":3}}\n')
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/older than 2026\.5\.5/)
  })

  it('cancels through the abort signal', async () => {
    const child = new FakeChild()
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: () => child,
      now: () => 0,
    })
    const controller = new AbortController()
    const handle = await backend.run(
      { agent: 'openclaw', prompt: 'hi' },
      deps,
      controller.signal,
    )
    controller.abort()
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(child.terminated).toBe(true)
  })

  it('refuses gateway/connect mode with a readable error', async () => {
    const child = new FakeChild()
    const deps = makeDeps()
    const backend = createBackendWithRuntime('openclaw', deps, {
      spawn: () => child,
      now: () => 0,
    })
    await expect(
      backend.run({ agent: 'openclaw', prompt: 'hi', mode: 'connect' }, deps, new AbortController().signal),
    ).rejects.toThrowError(/gateway\/connect mode is not implemented in v1/)
  })
})
