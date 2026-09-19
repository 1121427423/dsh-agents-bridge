/**
 * ZCode driver: argv, the ZCode Protocol envelope parser, the terminal-event
 * protocol boundary (the engine MAY NOT EXIT after `turn.failed` — proven,
 * docs/findings-zcode-headless.md §3), and the provider-config env contract.
 *
 * Fixture policy: `zcode-turn-failed.ndjson` is a captured live line; the
 * success stream is DERIVED (record 8 blocks a real one) — see
 * tests/fixtures/zcode-provenance.md. Nothing here pretends a model call was
 * exercised: every status asserted is one the driver READ OFF A LINE, not one
 * observed end-to-end.
 */
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { AgentMessage, DriverDeps } from '../../src/kernel/types.ts'
import type { ProcessExit, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import { createBackendWithRuntime, DRIVER_FAMILIES } from '../../src/drivers/index.ts'
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_ENV,
  ZCODE_BLOCKED_ARGS,
  ZcodeEventParser,
  buildZcodeArgs,
  deriveZcodeProviderConfigFile,
} from '../../src/drivers/zcode.ts'
import { RecordingSignal } from '../helpers/recording-signal.ts'

const ZCODE_TURN_FAILED = readFileSync(
  new URL('../fixtures/zcode-turn-failed.ndjson', import.meta.url),
  'utf8',
)
const ZCODE_BASIC = readFileSync(
  new URL('../fixtures/zcode-basic-turn.derived.ndjson', import.meta.url),
  'utf8',
)

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return {
    command: {
      executable: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      interpreter: '/opt/homebrew/bin/node',
    },
    env: {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]: '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json',
      // Boundary tests must not pay the real 2s flush grace; env-specific
      // tests override this map wholesale.
      ...IMMEDIATE_GRACE,
    },
    logger: silentLogger,
    ...overrides,
  }
}

class FakeChild implements SpawnedProcess {
  readonly pid = 4245
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

  /** Real exits close their pipes; `finish()` models that jointly. */
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

const IMMEDIATE_GRACE = { DSH_AGENTS_BRIDGE_ZCODE_TERMINAL_GRACE_MS: '0' }

function launch(
  deps: DriverDeps,
  runOpts: { prompt?: string; model?: string; resumeSessionId?: string; extraArgs?: readonly string[] } = {},
) {
  const child = new FakeChild()
  let spec: SpawnSpec | undefined
  const backend = createBackendWithRuntime('zcode', deps, {
    spawn: (s) => {
      spec = s
      return child
    },
    now: () => 7,
  })
  const handlePromise = backend.run(
    {
      agent: 'zcode',
      prompt: runOpts.prompt ?? 'hi',
      ...(runOpts.model === undefined ? {} : { model: runOpts.model }),
      ...(runOpts.resumeSessionId === undefined ? {} : { resumeSessionId: runOpts.resumeSessionId }),
      ...(runOpts.extraArgs === undefined ? {} : { extraArgs: runOpts.extraArgs }),
    },
    deps,
    new AbortController().signal,
  )
  return { child, handlePromise, specOf: () => spec as SpawnSpec }
}

describe('buildZcodeArgs', () => {
  it('emits the prompt in argv and locks the protocol flag', () => {
    expect(buildZcodeArgs({ prompt: 'PROMPT' })).toEqual([
      '--prompt',
      'PROMPT',
      '--output-format',
      'stream-json',
    ])
  })

  it('passes --resume through with the sess_ selector', () => {
    const args = buildZcodeArgs({ prompt: 'P', resumeSessionId: 'sess_abc' })
    expect(args.slice(-2)).toEqual(['--resume', 'sess_abc'])
  })

  it('D43: refuses a resume id shaped like a flag instead of slotting it', () => {
    expect(() => buildZcodeArgs({ prompt: 'P', resumeSessionId: '--danger' })).toThrow(
      /resume session id must be an argv-safe token/,
    )
    expect(() => buildZcodeArgs({ prompt: 'P', resumeSessionId: '--danger' })).toThrow(/--danger/)
  })

  it('blocks every token that could steal the prompt, protocol, selection or resume', () => {
    const args = buildZcodeArgs({
      prompt: 'P',
      extraArgs: ['--model', 'x', '--max-turns', '9', '--prompt', 'injected', '--output-format', 'text', '--continue', '--keep-me'],
    })
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--max-turns')
    expect(args).not.toContain('injected')
    expect(args).not.toContain('--continue')
    // The protocol pair appears exactly once, with the driver's own values.
    expect(args.filter((a) => a === '--prompt')).toEqual(['--prompt'])
    expect(args.filter((a) => a === '--output-format')).toEqual(['--output-format'])
    expect(args).toContain('--keep-me')
  })

  it('blocks the two flags 0.16.5 rejects but its help advertises', () => {
    // Proven divergence (findings §2): the table must cover them so a future
    // parser that accepts them cannot silently take over the run.
    expect(ZCODE_BLOCKED_ARGS['--model']).toBe('withValue')
    expect(ZCODE_BLOCKED_ARGS['--max-turns']).toBe('withValue')
  })
})

describe('ZcodeEventParser — the proven failure line is the oracle', () => {
  it('reads the captured CONFIGURATION_ERROR as a failed terminal with the sess_ selector', () => {
    const messages: AgentMessage[] = []
    const parser = new ZcodeEventParser((m) => messages.push(m), () => 1)
    parser.handleLine(ZCODE_TURN_FAILED.trim())
    const state = parser.finish()
    expect(state.terminalSeen).toBe('failed')
    expect(state.status).toBe('failed')
    expect(state.error).toContain('Select a model before continuing')
    expect(state.error).toContain('CONFIGURATION_ERROR')
    expect(state.backendSessionId).toMatch(/^sess_/)
    expect(state.output).toBe('')
  })

  it('ignores non-JSON noise and unknown event types without failing the run', () => {
    const parser = new ZcodeEventParser(() => {}, () => 1)
    parser.handleLine('not json at all')
    parser.handleLine('{"type":"mystery.future.event","payload":{"whatever":true}}')
    parser.handleLine('{"noType":true}')
    parser.handleLine('')
    const state = parser.finish()
    expect(state.unknownEventCount).toBe(3) // two envelopes + one broken JSON
    expect(state.sawAnyEvent).toBe(true) // the two TYPED envelopes counted as seen
    expect(state.terminalSeen).toBeUndefined()
    expect(state.status).toBe('completed') // untouched: no terminal observed
  })

  it('accumulates text from BOTH documented delta spellings', () => {
    const parser = new ZcodeEventParser(() => {}, () => 1)
    for (const line of ZCODE_BASIC.trim().split('\n')) parser.handleLine(line)
    const state = parser.finish()
    expect(state.output).toBe('Hello world')
    expect(state.terminalSeen).toBe('completed')
    expect(state.unknownEventCount).toBeGreaterThanOrEqual(1) // mystery + lifecycle extras
  })

  it('surfaces tool lifecycle as transcript messages', () => {
    const messages: AgentMessage[] = []
    const parser = new ZcodeEventParser((m) => messages.push(m), () => 1)
    for (const line of ZCODE_BASIC.trim().split('\n')) parser.handleLine(line)
    const use = messages.find((m) => m.type === 'tool_use')
    const result = messages.find((m) => m.type === 'tool_result')
    expect(use?.tool).toBe('Read')
    expect(use?.callId).toBe('call_1')
    expect(result?.output).toBe('contents')
  })
})

describe('run() — the terminal event is the protocol boundary', () => {
  it('settles COMPLETED and kills a child that never exits (the proven hang)', async () => {
    const { child, handlePromise, specOf } = launch(makeDeps({ env: { ...IMMEDIATE_GRACE } }))
    const handle = await handlePromise
    child.emit(ZCODE_BASIC)
    // NOTE: deliberately no child.finish() — the live engine hung after its
    // terminal once [proven]; the boundary must not wait for it.
    const result = await handle.done
    expect(result.status).toBe('completed')
    expect(result.text).toBe('Hello world')
    expect(result.backendSessionId).toBe('sess_derived01')
    expect(child.terminated).toBe(true)
    expect(specOf().env?.[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]).toBeDefined()
  })

  it('settles FAILED from the proven line and reports no text', async () => {
    const { child, handlePromise } = launch(makeDeps({ env: { ...IMMEDIATE_GRACE } }))
    const handle = await handlePromise
    child.emit(ZCODE_TURN_FAILED)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.text).toBe('')
    expect(result.error).toContain('Select a model before continuing')
    expect(child.terminated).toBe(true)
  })

  it('a stream that ends WITHOUT a terminal event fails — silence is not an answer', async () => {
    const { child, handlePromise } = launch(makeDeps())
    const handle = await handlePromise
    child.emit('{"seq":1,"sessionId":"sess_x","type":"turn.started","payload":{}}\n')
    child.finish(0)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toContain('without a terminal event')
  })

  it('an exit with zero events names the provider-config env in the diagnosis', async () => {
    const { child, handlePromise } = launch(makeDeps())
    const handle = await handlePromise
    child.stderrText('无法定位 CLI ZCode Built-in Provider Config：…')
    child.finish(1)
    const result = await handle.done
    expect(result.status).toBe('failed')
    expect(result.error).toContain(ZCODE_BUILTIN_PROVIDER_CONFIG_ENV)
    expect(result.error).toContain('无法定位') // the engine's own words survive
  })

  it('cancelling terminates the group and reports cancelled', async () => {
    const { child, handlePromise } = launch(makeDeps())
    const handle = await handlePromise
    void handle.cancel('operator stopped it')
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(child.terminated).toBe(true)
  })

  it('releases the abort listener when a cancelled run settles (MI-18)', async () => {
    const child = new FakeChild()
    const deps = makeDeps({ env: { ...IMMEDIATE_GRACE } })
    const backend = createBackendWithRuntime('zcode', deps, {
      spawn: () => child,
      now: () => 7,
    })
    const signal = new RecordingSignal()
    const handle = await backend.run(
      { agent: 'zcode', prompt: 'hi' },
      deps,
      signal.asAbortSignal(),
    )
    expect(signal.listenerCount()).toBe(1)

    // Cancel through the SESSION (the manager's kill path), where the abort
    // event never fires — see the note in the generic driver's twin test.
    await handle.cancel('operator stopped it')
    const result = await handle.done
    expect(result.status).toBe('cancelled')
    expect(signal.listenerCount()).toBe(0)
  })

  it('never puts --model or --max-turns in argv even when the caller asks', async () => {
    const { child, handlePromise, specOf } = launch(makeDeps(), { model: 'GLM-5.3' })
    const handle = await handlePromise
    child.emit(ZCODE_TURN_FAILED)
    await handle.done
    const args = specOf().args ?? []
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--max-turns')
  })
})

describe('the provider-config contract', () => {
  it('a descriptor-supplied env value is passed through untouched', async () => {
    const { child, handlePromise, specOf } = launch(
      makeDeps({ env: { [ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]: '/given/path.json', ...IMMEDIATE_GRACE } }),
    )
    const handle = await handlePromise
    child.emit(ZCODE_TURN_FAILED)
    await handle.done
    expect(specOf().env?.[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]).toBe('/given/path.json')
  })

  it('derives the in-bundle location from the executable when env is missing', async () => {
    const { child, handlePromise, specOf } = launch(makeDeps({ env: { ...IMMEDIATE_GRACE } }))
    const handle = await handlePromise
    child.emit(ZCODE_TURN_FAILED)
    await handle.done
    expect(specOf().env?.[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV]).toBe(
      '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json',
    )
  })

  it('the derivation walks from .../glm/zcode.cjs to .../config/provider/ (relative bundle math)', () => {
    expect(deriveZcodeProviderConfigFile('/any/where/Resources/glm/zcode.cjs')).toBe(
      '/any/where/Resources/config/provider/zcode-builtin.json',
    )
  })
})

describe('family wiring', () => {
  it('zcode is a registered backend family (createBackendWithRuntime above proves the switch)', () => {
    expect(DRIVER_FAMILIES).toContain('zcode')
  })
})
