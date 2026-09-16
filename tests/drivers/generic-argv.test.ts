/**
 * generic-argv: the one-shot fallback.
 *
 * The contract under test is multica's `TestQwenBackendDeliversPromptOnStdin`:
 * the prompt reaches the child byte-for-byte on stdin, never through argv, and
 * stdout is passed through verbatim with no dialect inference.
 */
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { DriverDeps } from '../../src/kernel/types.ts'
import type { ProcessExit, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import { createBackendWithRuntime } from '../../src/drivers/index.ts'
import {
  GENERIC_BLOCKED_ARGS,
  buildGenericArgs,
  genericResumeFlagFromEnv,
} from '../../src/drivers/generic-argv.ts'

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return { command: { executable: 'qwen' }, env: {}, logger: silentLogger, ...overrides }
}

class FakeChild implements SpawnedProcess {
  readonly pid = 4245
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
    this.stdout.write(text)
  }

  stderrText(text: string): void {
    this.stderr.write(text)
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

  terminate(): Promise<void> {
    if (this.terminated) return Promise.resolve()
    this.terminated = true
    this.stdout.end()
    this.stderr.end()
    this.#settleExit({ code: null, signal: 'SIGTERM' })
    return Promise.resolve()
  }
}

describe('buildGenericArgs', () => {
  it('keeps the identity prefix and injects only model and resume', () => {
    expect(
      buildGenericArgs({
        argsPrefix: ['--output-format', 'stream-json', '--yolo'],
        model: 'qwen3.8-max-preview',
        resumeSessionId: 'session-1',
      }),
    ).toEqual([
      '--output-format',
      'stream-json',
      '--yolo',
      '--model',
      'qwen3.8-max-preview',
      '--resume',
      'session-1',
    ])
  })

  it('never puts the prompt in argv and filters blocked flags from extras', () => {
    const args = buildGenericArgs({
      extraArgs: ['-p', 'hijack', '--prompt=replace', '--yolo', '--exclude-tools', 'monitor'],
    })
    expect(args).toEqual(['--exclude-tools', 'monitor'])
    expect(GENERIC_BLOCKED_ARGS['-p']).toBe('withValue')
  })

  it('drops a protocol flag smuggled into the identity prefix', () => {
    const args = buildGenericArgs({
      argsPrefix: ['--output-format', 'text', '--sandbox'],
      model: 'm',
    })
    expect(args).toEqual(['--sandbox', '--model', 'm'])
  })

  it('honours a configured resume flag and disables resume when it is empty', () => {
    expect(buildGenericArgs({ resumeSessionId: 's', resumeFlag: '-r' })).toEqual(['-r', 's'])
    expect(buildGenericArgs({ resumeSessionId: 's', resumeFlag: '' })).toEqual([])
  })

  it('reads the resume flag from the driver env namespace', () => {
    expect(genericResumeFlagFromEnv({})).toBe('--resume')
    expect(genericResumeFlagFromEnv({ DSH_AGENTS_BRIDGE_GENERIC_RESUME_FLAG: '--continue-with' })).toBe(
      '--continue-with',
    )
    expect(genericResumeFlagFromEnv({ DSH_AGENTS_BRIDGE_GENERIC_RESUME_FLAG: '' })).toBe('')
  })
})

describe('run() over a fake child', () => {
  const PROMPT = 'go build -ldflags "-X main.version=foo" — mind the em dash & the quotes'

  function launch(overrides: {
    env?: Record<string, string>
    command?: DriverDeps['command']
  } = {}): { child: FakeChild; specs: SpawnSpec[]; deps: DriverDeps; backend: ReturnType<typeof createBackendWithRuntime> } {
    const child = new FakeChild()
    const specs: SpawnSpec[] = []
    const deps = makeDeps({
      env: overrides.env ?? {},
      ...(overrides.command === undefined ? {} : { command: overrides.command }),
    })
    const backend = createBackendWithRuntime('generic', deps, {
      spawn: (spec) => {
        specs.push(spec)
        return child
      },
      now: () => 0,
    })
    return { child, specs, deps, backend }
  }

  it('delivers the prompt on stdin untouched and never through argv', async () => {
    const { child, specs, deps, backend } = launch()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      new AbortController().signal,
    )
    expect(child.input).toBe(PROMPT)
    expect(specs[0]?.args.join(' ')).not.toContain('go build')
    expect(specs[0]?.args).toEqual([])
    child.emit('ok\n')
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.text).toBe('ok')
  })

  it('emits the buffered stdout as one terminal text event', async () => {
    const { child, deps, backend } = launch()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      new AbortController().signal,
    )
    child.emit('first line\nsecond line\n')
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.text).toBe('first line\nsecond line')
    expect(handle.messages).toEqual([
      { type: 'text', content: 'first line\nsecond line', at: 0 },
    ])
  })

  it('reports a non-zero exit together with the stderr tail', async () => {
    const { child, deps, backend } = launch()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      new AbortController().signal,
    )
    child.stderrText('synthetic qwen stderr\n')
    child.finish(3)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.text).toBe('')
    expect(result.error).toMatch(/exit status 3[\s\S]*synthetic qwen stderr/)
  })

  it('reports a missing executable instead of hanging', async () => {
    const { child, deps, backend } = launch()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      new AbortController().signal,
    )
    child.failToStart('spawn qwen ENOENT')
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/generic agent failed to start: spawn qwen ENOENT/)
  })

  it('applies the configured resume flag', async () => {
    const { child, specs, deps, backend } = launch({
      env: { DSH_AGENTS_BRIDGE_GENERIC_RESUME_FLAG: '-r' },
    })
    const handle = await backend.run(
      { agent: 'generic', prompt: 'again', resumeSessionId: 'sess-9' },
      deps,
      new AbortController().signal,
    )
    child.finish(0)
    const result = await handle.done
    expect(specs[0]?.args).toEqual(['-r', 'sess-9'])
    expect(result.backendSessionId).toBe('sess-9')
  })

  it('cancels through the abort signal', async () => {
    const { child, deps, backend } = launch()
    const controller = new AbortController()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      controller.signal,
    )
    controller.abort()
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(child.terminated).toBe(true)
  })
})
