/**
 * codebuddy-code: the standalone Tencent CodeBuddy Code CLI on the CLI track.
 *
 * The fixture is a REAL capture — `@tencent-ai/codebuddy-code` 2.151.0 driven
 * exactly the way the bridge drives it, which is the point:
 *
 *   printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: OK"}]}}' \
 *     | codebuddy-code -p --output-format stream-json --input-format stream-json \
 *         --verbose --permission-mode bypassPermissions \
 *         --disallowedTools AskUserQuestion EnterPlanMode ExitPlanMode
 *
 * Every flag of the CodeBuddy fixed argv is accepted (exit 0), the prompt is
 * read from stdin as one stream-json line, and the engine answers with the
 * CodeBuddy/claude dialect. The turn FAILED for an honest reason — this host is
 * not signed in — which is exactly why the capture is worth checking in: the
 * terminal frame is the error shape (`subtype: "error_during_execution"`,
 * `is_error: true`, `errors: [...]`, and NO `result` field), and the stderr tail
 * is empty. Timestamps, session ids, uuids and the cwd are sanitized; no frame
 * type was removed (see tests/fixtures/codebuddy-code-auth-required.ndjson).
 *
 * Locked in here:
 *  1. the dialect decision — the frames are the CodeBuddy dialect (five frame
 *     types, byte-comparable to WorkBuddy's bundled CodeBuddy capture), so the
 *     identity rides the shared claude engine with `CODEBUDDY_DIALECT`;
 *  2. the parser tolerates everything this engine emits, including a DUPLICATED
 *     `system/init` frame and the undocumented `system/status` /
 *     `file-history-snapshot` frames;
 *  3. the terminal-error gap is characterized, not papered over: the engine's
 *     own message lives in `errors[]`, which the shared stream-json engine does
 *     NOT read, so the run reports a generic failure while the transcript still
 *     carries the engine's words.
 */
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { AgentMessage, DriverDeps } from '../../src/kernel/types.ts'
import type { ProcessExit, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import { createBackendWithRuntime } from '../../src/drivers/index.ts'
import { CODEBUDDY_DIALECT, buildCodebuddyArgs } from '../../src/drivers/codebuddy.ts'
import { ClaudeStreamParser, type ClaudeStreamSink } from '../../src/drivers/claude.ts'
import { createRegistry } from '../../src/kernel/registry.ts'
import { CLI_TRACK_DESCRIPTORS } from '../../src/tracks/index.ts'

const CAPTURE = readFileSync(
  new URL('../fixtures/codebuddy-code-auth-required.ndjson', import.meta.url),
  'utf8',
)

const SESSION = '11111111-1111-4111-8111-111111111111'
const ENGINE_MESSAGE = 'Authentication required. Please use /login command to sign in to your account'

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** The npm shim this identity resolves to, and the node that must run it. */
const SHIM = '/Users/fixture/.nvm/versions/node/v22.22.3/bin/codebuddy-code'
const NODE = '/Users/fixture/.nvm/versions/node/v22.22.3/bin/node'

function makeDeps(overrides: Partial<DriverDeps> = {}): DriverDeps {
  return {
    command: { executable: SHIM, interpreter: NODE },
    env: {},
    logger: silentLogger,
    ...overrides,
  }
}

class FakeChild implements SpawnedProcess {
  readonly pid = 4244
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

interface Recorded {
  readonly messages: AgentMessage[]
  readonly frames: string[]
  readonly parser: ClaudeStreamParser
  readonly closed: boolean
}

function replayFixture(text: string): Recorded {
  const messages: AgentMessage[] = []
  const frames: string[] = []
  let closed = false
  const sink: ClaudeStreamSink = {
    emit: (message) => messages.push(message),
    writeFrame: (frame) => frames.push(frame),
    closeInput: () => {
      closed = true
    },
  }
  const parser = new ClaudeStreamParser(CODEBUDDY_DIALECT, sink)
  for (const line of text.split('\n')) parser.handleLine(line)
  return {
    messages,
    frames,
    parser,
    get closed() {
      return closed
    },
  }
}

describe('the codebuddy-code descriptor', () => {
  const descriptor = CLI_TRACK_DESCRIPTORS.find((entry) => entry.id === 'codebuddy-code')

  it('is registered on the CLI track under the CodeBuddy dialect', () => {
    expect(descriptor).toBeDefined()
    if (descriptor === undefined) return
    // The dialect decision: this engine is the standalone CodeBuddy CLI, so it
    // rides the CodeBuddy dialect (which itself reuses the claude stream-json
    // engine) rather than the Anthropic-Claude assumptions. See the report.
    expect(descriptor.track).toBe('cli')
    expect(descriptor.family).toBe('codebuddy')
    expect(descriptor.command.executable).toBe('codebuddy-code')
    expect(descriptor.envPrefix).toBe('CODEBUDDY')
    expect(descriptor.capabilities).toEqual({
      resume: true,
      model: true,
      effort: true,
      mcpConfig: true,
    })
  })

  it('names the verified invocation line and what could not be verified', () => {
    // `notes` travels into probe output, so it must not overclaim: the run was
    // verified up to the engine's own credential, and no completed turn was.
    const notes = descriptor?.notes ?? ''
    expect(notes).toContain('codebuddy-code -p --output-format stream-json')
    expect(notes).toContain('--disallowedTools AskUserQuestion EnterPlanMode ExitPlanMode')
    expect(notes).toContain('NOT verified')
    expect(notes).toContain('Authentication required')
    expect(notes).toContain('2.151.0')
  })

  it('is resolvable through the registry and reaches the shared alias of the claude engine', () => {
    const registry = createRegistry({ env: { PATH: '' }, probeVersion: async () => '2.151.0' })
    expect(registry.get('codebuddy-code')?.family).toBe('codebuddy')
    // The descriptor must not promise a family the driver table cannot build.
    const backend = createBackendWithRuntime('codebuddy', makeDeps(), {
      spawn: () => new FakeChild(),
    })
    expect(backend.family).toBe('codebuddy')
  })
})

describe('the real capture replayed through the parser', () => {
  it('normalizes every frame the engine emitted', () => {
    const replayed = replayFixture(CAPTURE)
    expect(replayed.messages.map((message) => message.type)).toEqual([
      // system/init (model + permission mode), system/status, then a DUPLICATE
      // system/init. The engine really emits init twice, and the collapse rule
      // is set-based precisely so the repeat is suppressed even though a
      // different text (the plain `system/status`) sits between the two copies:
      // an "only if different from the previous one" rule emitted it a third
      // time and buried the transcript under A-B-A noise.
      'status',
      'status',
      'text',
    ])
    expect(replayed.messages[0]?.content).toBe('running (model=hy3, permissionMode=bypassPermissions)')
    expect(replayed.messages[1]?.content).toBe('running')
    // index 2, not 3: the duplicated `system/init` no longer produces a message.
    expect(replayed.messages[2]?.content).toBe(ENGINE_MESSAGE)
    expect(replayed.messages).toHaveLength(3)

    const state = replayed.parser.state
    expect(state.eventCount).toBe(6)
    expect(state.invalidEventCount).toBe(0)
    expect(state.toolUseCount).toBe(0)
    expect(state.sessionId).toBe(SESSION)
    expect(state.sawResult).toBe(true)
    expect(state.resultIsError).toBe(true)
    // The failed result carries no `result` field at all.
    expect(state.finalResultText).toBe('')
    // This engine emits no `terminal_reason` either, so the claude-only reader
    // has nothing to add — which is why the CodeBuddy dialect has it off.
    expect(state.terminalReasonError).toBe('')
    // The fallback answer is retained, but a failed run never reports it as the
    // result text (asserted through run() below).
    expect(state.lastAssistantText).toBe(ENGINE_MESSAGE)
    // modelUsage is present and all-zero on an auth failure: reporting
    // `usage: {0,0}` would claim a real measurement, so nothing is reported.
    expect(state.usage).toBeUndefined()
  })

  it('ignores the two undocumented frames instead of failing on them', () => {
    // `system/status` (status: null) and `file-history-snapshot` are the two
    // frames WorkBuddy's bundled CodeBuddy also emits. Neither is terminal and
    // neither carries a model id, a tool call or an answer.
    const only = CAPTURE.split('\n').filter((line) => line.includes('"file-history-snapshot"')).join('\n')
    const replayed = replayFixture(only)
    expect(replayed.messages).toEqual([])
    expect(replayed.parser.state.eventCount).toBe(1)
    expect(replayed.parser.state.invalidEventCount).toBe(0)
    expect(replayed.parser.state.sawResult).toBe(false)
  })

  it('closes stdin at the terminal result frame', () => {
    const replayed = replayFixture(CAPTURE)
    expect(replayed.closed).toBe(true)
  })

  it('agrees frame-for-frame with the CodeBuddy fixture WorkBuddy ships', () => {
    // Lineage proof, from bytes: the same five top-level frame types, in the
    // same order, with the same apiKeySource endpoint. `system/status` and
    // `file-history-snapshot` are present in BOTH captures.
    const workbuddy = readFileSync(new URL('../fixtures/codebuddy-capture.ndjson', import.meta.url), 'utf8')
    const shape = (text: string): string[] =>
      text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const frame = JSON.parse(line) as { type: string; subtype?: string }
          return frame.subtype === undefined ? frame.type : `${frame.type}/${frame.subtype}`
        })

    expect(shape(CAPTURE)).toEqual([
      'system/init',
      'system/status',
      'file-history-snapshot',
      'system/init',
      'assistant',
      'result/error_during_execution',
    ])
    expect(shape(workbuddy)).toEqual([
      'system/init',
      'system/status',
      'file-history-snapshot',
      // two assistant frames there: a `thinking` block, then the `text` block
      'assistant',
      'assistant',
      'result/success',
    ])
    // No frame type in this capture is absent from the WorkBuddy one.
    const known = new Set(shape(workbuddy).map((name) => name.split('/')[0]))
    for (const name of shape(CAPTURE)) expect(known.has(name.split('/')[0] ?? '')).toBe(true)

    const apiKeySource = (text: string): unknown =>
      (JSON.parse(text.split('\n')[0] ?? '{}') as { apiKeySource?: unknown }).apiKeySource
    expect(apiKeySource(CAPTURE)).toBe(apiKeySource(workbuddy))
    expect(apiKeySource(CAPTURE)).toBe('copilot.tencent.com')
  })
})

describe('a full run through the codebuddy backend', () => {
  it('spawns [node, codebuddy-code, ...CodeBuddy fixed flags] with the prompt on stdin', async () => {
    const child = new FakeChild()
    let spec: SpawnSpec | undefined
    const deps = makeDeps()
    const backend = createBackendWithRuntime('codebuddy', deps, {
      spawn: (spawnSpec) => {
        spec = spawnSpec
        return child
      },
      now: () => 1_000,
    })

    const handle = await backend.run(
      { agent: 'codebuddy-code', prompt: 'Reply with exactly: OK' },
      deps,
      new AbortController().signal,
    )
    child.emit(CAPTURE)
    child.finish(0)
    const result = await handle.done

    // The identity is a `#!/usr/bin/env node` npm shim, so the CLI track's
    // interpreter repair is what makes it launchable (asserted in
    // tests/tracks/cli.test.ts against the real descriptor).
    expect(spec?.command).toBe(NODE)
    expect(spec?.args[0]).toBe(SHIM)
    const args = spec?.args.slice(1) ?? []
    expect(args.slice(0, 8)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ])
    // CodeBuddy's three-tool deny list, each tool its own argv value, because
    // this fork exempts AskUserQuestion/ExitPlanMode from permission-mode
    // finalization and a headless turn then stalls forever (GitHub #6012).
    const denyAt = args.indexOf('--disallowedTools')
    expect(args.slice(denyAt + 1, denyAt + 4)).toEqual([
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    // Never `--strict-mcp-config`: measured on CodeBuddy 2.x, it drops the
    // user/project/local MCP scopes instead of unioning them (MUL-5846).
    expect(args).not.toContain('--strict-mcp-config')
    expect(args.join(' ')).not.toContain('Reply with exactly')

    // The prompt is one stream-json line on stdin, never argv.
    expect(child.input).toBe(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] },
      })}\n`,
    )

    expect(result.status).toBe('failed')
    // A failed run reports empty text so a partial transcript cannot be read as
    // an answer, even though an assistant frame carried one.
    expect(result.text).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.backendSessionId).toBe(SESSION)
    expect(result.usage).toBeUndefined()
  })

  it("surfaces the engine's own words as the terminal error", async () => {
    // The terminal frame carries `errors: ["…Authentication required…"]` and NO
    // `result` field. The shared stream-json engine therefore falls back, in
    // this order: `result` → `errors[0]` → the last assistant text → a generic
    // sentence. A caller that reads only the terminal error now learns WHY the
    // run failed instead of reading "<label> returned an error result without
    // details" while the reason sat unread in the transcript.
    const child = new FakeChild()
    const deps = makeDeps()
    const backend = createBackendWithRuntime('codebuddy', deps, { spawn: () => child, now: () => 1_000 })
    const handle = await backend.run(
      { agent: 'codebuddy-code', prompt: 'Reply with exactly: OK' },
      deps,
      new AbortController().signal,
    )
    child.emit(CAPTURE)
    child.finish(0)
    const result = await handle.done

    expect(result.error).toBe(ENGINE_MESSAGE)
    // ...and the transcript the caller can still read carries the real reason.
    const transcriptText = handle.messages
      .filter((message) => message.type === 'text')
      .map((message) => message.content ?? '')
    expect(transcriptText).toContain(ENGINE_MESSAGE)
    expect(CAPTURE).toContain(ENGINE_MESSAGE)
  })
})

describe('malformed and partial frames', () => {
  it('counts a non-JSON line instead of failing the run', () => {
    const replayed = replayFixture('not json at all\n{"type":"result","is_error":false,"result":"OK"}\n')
    expect(replayed.parser.state.invalidEventCount).toBe(1)
    expect(replayed.parser.state.eventCount).toBe(1)
    expect(replayed.parser.state.finalResultText).toBe('OK')
  })

  it('counts a truncated terminal frame and still ends without a result', () => {
    const replayed = replayFixture('{"type":"result","is_error":tr\n')
    expect(replayed.parser.state.invalidEventCount).toBe(1)
    expect(replayed.parser.state.sawResult).toBe(false)
    expect(replayed.closed).toBe(false)
  })

  it('drops the fallback answer when an assistant frame cannot be read', () => {
    const replayed = replayFixture(
      [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]}}',
        '{"type":"assistant"}',
        '',
      ].join('\n'),
    )
    expect(replayed.parser.state.lastAssistantText).toBe('')
  })

  it('keeps a thinking-only turn from becoming the answer', () => {
    // CodeBuddy writes `thinking`, not `text` (the claude struct reads `text`).
    const replayed = replayFixture(
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"pondering"}],"model":"hy3"}}\n',
    )
    expect(replayed.messages.map((message) => message.type)).toEqual(['thinking'])
    expect(replayed.messages[0]?.content).toBe('pondering')
    expect(replayed.parser.state.lastAssistantText).toBe('')
  })

  it('ignores an unknown frame type and an unknown content block without counting either as invalid', () => {
    const replayed = replayFixture(
      [
        '{"type":"stream_event","event":{"type":"content_block_delta"}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"image","source":{}}]}}',
        '',
      ].join('\n'),
    )
    expect(replayed.parser.state.invalidEventCount).toBe(0)
    expect(replayed.parser.state.eventCount).toBe(2)
    expect(replayed.messages.map((message) => message.type)).toEqual(['text'])
    // An unreadable block means the turn is not fully understood, so its text
    // must not be promoted to the fallback answer.
    expect(replayed.parser.state.lastAssistantText).toBe('')
  })

  it('treats an empty result frame as a terminal result with empty text', () => {
    const replayed = replayFixture('{"type":"result"}\n')
    expect(replayed.parser.state.sawResult).toBe(true)
    expect(replayed.parser.state.finalResultText).toBe('')
    expect(replayed.parser.state.resultIsError).toBe(false)
    expect(replayed.closed).toBe(true)
  })

  it('reads neither `errors` nor a missing `result`: the documented gap', () => {
    const replayed = replayFixture(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"],"modelUsage":{}}\n',
    )
    expect(replayed.parser.state.resultIsError).toBe(true)
    expect(replayed.parser.state.finalResultText).toBe('')
    // The information the frame DOES carry, which the shared engine drops today.
    expect(replayed.parser.state.terminalReasonError).toBe('')
  })

  it('answers a control_request, forcing foreground execution', () => {
    const replayed = replayFixture(
      [
        '{"type":"control_request","request_id":"req-1","request":{"input":{"run_in_background":true}}}',
        '{"type":"result","is_error":false,"result":"OK"}',
        '',
      ].join('\n'),
    )
    expect(replayed.frames).toHaveLength(1)
    const response = JSON.parse(replayed.frames[0] ?? '{}') as {
      type: string
      response: { subtype: string; request_id: string; response: { behavior: string; updatedInput: { run_in_background: boolean } } }
    }
    expect(response.type).toBe('control_response')
    expect(response.response.subtype).toBe('success')
    expect(response.response.request_id).toBe('req-1')
    expect(response.response.response.behavior).toBe('allow')
    expect(response.response.response.updatedInput.run_in_background).toBe(false)
  })

  it('sends `allowed: true` alongside `behavior` — a missing key reads as a DENIAL', () => {
    const replayed = replayFixture(
      [
        '{"type":"control_request","request_id":"req-allow","request":{"input":{"command":"pwd"}}}',
        '{"type":"result","is_error":false,"result":"OK"}',
        '',
      ].join('\n'),
    )
    expect(replayed.frames).toHaveLength(1)
    const response = JSON.parse(replayed.frames[0] ?? '{}') as {
      type: string
      response: {
        subtype: string
        request_id: string
        response: { allowed?: boolean; behavior: string; updatedInput: Record<string, unknown> }
      }
    }
    expect(response.type).toBe('control_response')
    expect(response.response.subtype).toBe('success')
    // The request_id must be echoed or the CLI cannot match the decision.
    expect(response.response.request_id).toBe('req-allow')
    // PROVEN against the shipped bundle (WorkBuddy.app 5.5.6,
    // cli/dist/codebuddy-headless.js): `SdkPermissionClientImpl.handleResponse`
    // resolves `allowed: response.allowed ?? false`, so an approval that omits
    // this key is read as a denial. `behavior` is kept because the fork still
    // honours Claude Code's spelling on its other permission paths.
    expect(response.response.response.allowed).toBe(true)
    expect(response.response.response.behavior).toBe('allow')
    expect(response.response.response.updatedInput).toEqual({ command: 'pwd' })
  })

  it('does not answer a control_request that arrives after the terminal result', () => {
    const replayed = replayFixture(
      [
        '{"type":"result","is_error":false,"result":"OK"}',
        '{"type":"control_request","request_id":"req-2","request":{"input":{}}}',
        '',
      ].join('\n'),
    )
    expect(replayed.frames).toEqual([])
  })

  it('ignores blank lines entirely', () => {
    const replayed = replayFixture('\n\n   \n')
    expect(replayed.parser.state.eventCount).toBe(0)
    expect(replayed.parser.state.invalidEventCount).toBe(0)
  })
})

describe('argv for this identity', () => {
  it('carries --model and --resume on top of the CodeBuddy fixed flags', () => {
    const args = buildCodebuddyArgs({ model: 'fast-model', resumeSessionId: SESSION })
    expect(args[args.indexOf('--model') + 1]).toBe('fast-model')
    expect(args[args.indexOf('--resume') + 1]).toBe(SESSION)
    // `--effort` exists on this CLI (verified in its --help), so the shared
    // builder may inject it.
    expect(buildCodebuddyArgs({ effort: 'low' })).toContain('--effort')
  })
})
