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
import { MAX_STREAM_LINE_BYTES } from '../../src/kernel/stream-limits.ts'
import { RecordingSignal } from '../helpers/recording-signal.ts'

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

  it('passes the identity prefix through verbatim, since it carries the CLI protocol', () => {
    const args = buildGenericArgs({
      argsPrefix: ['--output-format', 'stream-json', '--sandbox'],
      model: 'm',
    })
    expect(args).toEqual(['--output-format', 'stream-json', '--sandbox', '--model', 'm'])
    // The driver's own flags come last, so last-wins parsing keeps them decisive.
    expect(args.indexOf('--model')).toBeGreaterThan(args.indexOf('--sandbox'))
  })

  it('honours a configured resume flag and disables resume when it is empty', () => {
    expect(buildGenericArgs({ resumeSessionId: 's', resumeFlag: '-r' })).toEqual(['-r', 's'])
    expect(buildGenericArgs({ resumeSessionId: 's', resumeFlag: '' })).toEqual([])
  })

  it('D43: refuses flag-shaped model/resume values instead of placing them', () => {
    expect(() => buildGenericArgs({ model: '--danger' })).toThrow(
      /model must be an argv-safe token/,
    )
    expect(() => buildGenericArgs({ resumeSessionId: '--danger', resumeFlag: '-r' })).toThrow(
      /resume session id must be an argv-safe token/,
    )
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

  it('keeps blank and whitespace-only lines: stdout is verbatim, not line-reassembled (IM-9)', async () => {
    const { child, deps, backend } = launch()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      new AbortController().signal,
    )
    // The header's contract is "whatever the CLI printed becomes the run's
    // text, untouched apart from a surrounding-whitespace trim". A blank line
    // (or a line that is only spaces) is part of what it printed.
    child.emit('line1\n\nline2\n\n\nline3\n')
    child.emit('gap\n   \nend\n')
    child.finish(0)
    const result = await handle.done
    const expected = 'line1\n\nline2\n\n\nline3\ngap\n   \nend'
    expect(result.status).toBe('completed')
    expect(result.text).toBe(expected)
    expect(handle.messages).toEqual([{ type: 'text', content: expected, at: 0 }])
  })

  it('fails the run and kills the process when stdout overruns the cap (MI-4)', async () => {
    const { child, deps, backend } = launch()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      new AbortController().signal,
    )
    // This driver RETAINS every line it reads, so a newline-less writer is the
    // unbounded-memory case — inside the host process.
    child.stdout.write(Buffer.alloc(MAX_STREAM_LINE_BYTES + 1, 0x61))

    // Bounded wait so the pre-fix behaviour (the run simply keeps growing) is
    // observed as a failed assertion rather than as a 5 s test timeout.
    const settled = await Promise.race([
      handle.done.then((result) => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'pending' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'pending' }), 2_000)
      }),
    ])
    expect(settled.kind).toBe('result')
    if (settled.kind !== 'result') return

    expect(settled.result.status).toBe('failed')
    expect(settled.result.text).toBe('')
    expect(settled.result.error).toMatch(/no newline/i)
    expect(child.terminated).toBe(true)
  })

  it('releases the abort listener when a cancelled run settles (MI-18)', async () => {
    const { child, deps, backend } = launch()
    const signal = new RecordingSignal()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      signal.asAbortSignal(),
    )
    expect(signal.listenerCount()).toBe(1)

    // Cancel through the SESSION, not through the signal: the manager's kill
    // path is `session.cancel()` → `onCancel` → a terminal result, and the
    // abort event never fires. (An abort-driven cancel cannot show this leak —
    // the platform releases a `once` listener itself the moment it fires —
    // which is exactly why the listener must be released on every settle path.)
    await handle.cancel('operator stopped it')
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(child.terminated).toBe(true)
    // The settle task returns as soon as `terminalReason` is set, so a removal
    // placed after that return never runs: a cancelled run used to keep the
    // run-scoped closure reachable from the caller's AbortController forever.
    expect(signal.listenerCount()).toBe(0)
  })

  it('releases the abort listener after a natural completion (control)', async () => {
    const { child, deps, backend } = launch()
    const signal = new RecordingSignal()
    const handle = await backend.run(
      { agent: 'generic', prompt: PROMPT },
      deps,
      signal.asAbortSignal(),
    )
    child.emit('done\n')
    child.finish(0)
    await handle.done
    expect(signal.listenerCount()).toBe(0)
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
