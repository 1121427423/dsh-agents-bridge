/**
 * ACP driver: handshake, update normalization, usage reconciliation, the
 * client-side `fs/*` + `terminal/*` capabilities, permission policy, terminal
 * states, and the read/write concurrency contract.
 *
 * Every test spawns the REAL `tests/fixtures/fake-acp-cli.mjs` with a REAL
 * child process over real pipes. That is deliberate: the failure this driver
 * most needs protection from is a BIDIRECTIONAL PIPE DEADLOCK, which a
 * `PassThrough`-based fake cannot reproduce (an in-memory stream never fills a
 * 64 KiB kernel buffer, so the bug would pass every test and appear only in
 * production). The fixture's `deadlock` scenario writes ~1 MB before it needs a
 * reply, so the driver must genuinely read and write concurrently to finish.
 *
 * Frame shapes come from a real `codebuddy-code --acp` capture; see
 * `tests/fixtures/ACP-PROVENANCE.md`.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentMessage, AgentResult, DriverDeps } from '../../src/kernel/types.ts'
import type { DriverRuntime, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import {
  ACP_BLOCKED_ARGS,
  ACP_FAILURE_STOP_REASONS,
  ACP_SESSION_SCOPED_OPTION_IDS,
  buildAcpArgs,
  confineToRoot,
  isGrantKind,
  parseAcpUsage,
  promptResultUsage,
  selectPermissionOption,
  toAgentUsage,
  updateTypeFromName,
} from '../../src/drivers/acp.ts'
import { createBackendWithRuntime } from '../../src/drivers/index.ts'

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-acp-cli.mjs', import.meta.url))

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** A runtime that really spawns, so the pipes and their buffers are real. */
const realRuntime: DriverRuntime = {
  spawn(spec: SpawnSpec): SpawnedProcess {
    const child = nodeSpawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    const exited = new Promise<{ code: number | null; signal: string | null; error?: string }>(
      (resolve) => {
        child.on('error', (err) => {
          if (settled) return
          settled = true
          resolve({ code: null, signal: null, error: err.message })
        })
        child.on('exit', (code, signal) => {
          if (settled) return
          settled = true
          resolve({ code, signal })
        })
      },
    )
    return {
      pid: child.pid ?? -1,
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      exited,
      terminate() {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        return Promise.resolve()
      },
    }
  },
}

function makeDeps(scenario: string, overrides: Partial<DriverDeps> = {}): DriverDeps {
  return {
    command: {
      executable: process.execPath,
      argsPrefix: [FIXTURE, '--scenario', scenario],
      protocolArgs: ['--acp'],
    },
    env: {},
    logger: silentLogger,
    ...overrides,
  }
}

const workdirs: string[] = []
function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-driver-test-'))
  workdirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of workdirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Capabilities are OPT-IN through `DriverDeps.env` on purpose: advertising
 * `fs`/`terminal` to an engine and then refusing every call is worse than not
 * advertising at all, so the bridge only claims what the caller asked it to
 * serve. Tests that exercise them must turn them on explicitly.
 */
const CAPS_ON = {
  DSH_AGENTS_BRIDGE_ACP_FS: '1',
  DSH_AGENTS_BRIDGE_ACP_TERMINAL: '1',
}

/** Start a run and wait for it to settle, returning the transcript + result. */
async function runToCompletion(
  scenario: string,
  opts: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<{ messages: readonly AgentMessage[]; result: AgentResult; cwd: string }> {
  const cwd = opts.cwd ?? makeWorkdir()
  const env = { ...CAPS_ON, ...(opts.env ?? {}) }
  const deps = makeDeps(scenario, { env })
  const backend = createBackendWithRuntime('acp', deps, realRuntime)
  const controller = new AbortController()
  const handle = await backend.run({ agent: 'codebuddy-code-acp', prompt: 'do the thing', cwd }, deps, controller.signal)
  const result = await handle.done
  return { messages: handle.messages, result, cwd }
}

const texts = (messages: readonly AgentMessage[]): string =>
  messages.filter((m) => m.type === 'text').map((m) => m.content ?? '').join('')

const ofType = (messages: readonly AgentMessage[], type: string): readonly AgentMessage[] =>
  messages.filter((m) => m.type === type)

// ── argv & capability table (pure, no process) ──────────────────────────────

describe('buildAcpArgs', () => {
  it('puts the descriptor protocol selector first and appends extras', () => {
    expect(buildAcpArgs({ protocolArgs: ['--acp'], extraArgs: ['--verbose'] })).toEqual([
      '--acp',
      '--verbose',
    ])
  })

  it('drops a caller-supplied --acp instead of duplicating the protocol flag', () => {
    // `--acp` is standalone: a second copy would be harmless to this engine but
    // is still a protocol flag the caller must not be able to re-add.
    expect(buildAcpArgs({ protocolArgs: ['--acp'], extraArgs: ['--acp', '--keep'] })).toEqual([
      '--acp',
      '--keep',
    ])
  })

  it('drops a caller-supplied --acp-transport together with its value', () => {
    expect(
      buildAcpArgs({
        protocolArgs: ['--acp'],
        extraArgs: ['--acp-transport', 'stdio', '--keep'],
      }),
    ).toEqual(['--acp', '--keep'])
  })

  it('blocks both protocol flags, in the right value mode', () => {
    expect(ACP_BLOCKED_ARGS['--acp']).toBe('standalone')
    expect(ACP_BLOCKED_ARGS['--acp-transport']).toBe('withValue')
  })
})

describe('updateTypeFromName', () => {
  it('maps every sessionUpdate name the real engine emits', () => {
    expect(updateTypeFromName('agent_message_chunk')).toBe('agent_message_chunk')
    expect(updateTypeFromName('agent_thought_chunk')).toBe('agent_thought_chunk')
    expect(updateTypeFromName('tool_call')).toBe('tool_call')
    expect(updateTypeFromName('tool_call_update')).toBe('tool_call_update')
    expect(updateTypeFromName('usage_update')).toBe('usage_update')
    expect(updateTypeFromName('config_option_update')).toBe('config_option_update')
    expect(updateTypeFromName('available_commands_update')).toBe('available_commands_update')
    expect(updateTypeFromName('session_info_update')).toBe('session_info_update')
    expect(updateTypeFromName('plan')).toBe('plan')
    expect(updateTypeFromName('current_mode_update')).toBe('current_mode_update')
  })

  it('classifies an unknown future update as "unknown" rather than dropping it', () => {
    expect(updateTypeFromName('some_future_update')).toBe('unknown')
  })
})

// ── usage (pure) ────────────────────────────────────────────────────────────

describe('parseAcpUsage', () => {
  it('reads camelCase and snake_case spellings of every bucket', () => {
    const camel = parseAcpUsage({ inputTokens: 5, outputTokens: 3, cachedReadTokens: 2 })
    const snake = parseAcpUsage({ input_tokens: 5, output_tokens: 3, cached_read_tokens: 2 })
    expect(camel.input).toBe(5)
    expect(snake.input).toBe(5)
    expect(snake.cacheRead).toBe(2)
  })

  it('accepts numeric strings, which some runtimes emit', () => {
    expect(parseAcpUsage({ inputTokens: '120' }).input).toBe(120)
  })

  it('normalizes input ONLY when totalTokens proves the cache-inclusive shape', () => {
    // total == input + output => cached reads are inside input; re-bucket.
    expect(parseAcpUsage({ inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 20 }).input).toBe(100)
    // No total => the shape is unproven, so input is left alone.
    expect(parseAcpUsage({ inputTokens: 120, outputTokens: 30, cachedReadTokens: 20 }).input).toBe(120)
    // A total that contradicts inclusivity => also left alone.
    expect(
      parseAcpUsage({ inputTokens: 120, outputTokens: 30, totalTokens: 200, cachedReadTokens: 20 }).input,
    ).toBe(120)
  })
})

describe('promptResultUsage', () => {
  it('prefers the top-level usage and fills gaps from _meta', () => {
    const usage = promptResultUsage({
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 30 },
      _meta: { inputTokens: 999, usage: { inputTokens: 999, cacheReadTokens: 20, cacheWriteTokens: 5 } },
    })
    // The top-level input wins (not 999) and the meta-only cache buckets fill in.
    expect(usage.input).toBe(100)
    expect(usage.output).toBe(30)
    expect(usage.cacheRead).toBe(20)
    expect(usage.cacheWrite).toBe(5)
  })

  it('uses the nested _meta.usage over its flat mirror', () => {
    const usage = promptResultUsage({
      stopReason: 'end_turn',
      _meta: { usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }, cachedReadTokens: 20 },
    })
    expect(usage.input).toBe(100)
    expect(usage.cacheRead).toBe(20)
  })
})

describe('toAgentUsage', () => {
  it('omits an all-zero accumulator entirely (absent is not zero)', () => {
    expect(toAgentUsage({ ...emptyAcc(), fields: 0 }, 0)).toBeUndefined()
  })

  it('reports only non-zero buckets, keeping them mutually exclusive', () => {
    const usage = toAgentUsage(
      { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, fields: 0, ambiguousInput: 0, hasAmbiguousInput: false, normalizedInput: 0, normalizedTotal: 0, hasNormalized: false },
      0,
    )
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 })
  })

  it('carries reasoningTokens as a disclosure, not a bucket', () => {
    const usage = toAgentUsage(
      { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, fields: 0, ambiguousInput: 0, hasAmbiguousInput: false, normalizedInput: 0, normalizedTotal: 0, hasNormalized: false },
      7,
    )
    expect(usage?.reasoningTokens).toBe(7)
    expect(usage?.outputTokens).toBe(4)
  })
})

/** Local helper: the zero-value accumulator, for the pure projection tests. */
function emptyAcc() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    fields: 0,
    ambiguousInput: 0,
    hasAmbiguousInput: false,
    normalizedInput: 0,
    normalizedTotal: 0,
    hasNormalized: false,
  }
}

// ── permission policy (pure) ────────────────────────────────────────────────

describe('selectPermissionOption', () => {
  it('prefers a known session-scoped grant over allow_once', () => {
    const selection = selectPermissionOption([
      { optionId: 'allow_once', kind: 'allow_once' },
      { optionId: 'allow_session', kind: 'allow_always' },
    ])
    expect(selection).toEqual({ optionId: 'allow_session', grant: true, ok: true })
  })

  it('takes an allow_once grant when nothing session-scoped is offered', () => {
    const selection = selectPermissionOption([
      { optionId: 'whatever-the-vendor-calls-it', kind: 'allow_once' },
    ])
    expect(selection.grant).toBe(true)
    expect(selection.optionId).toBe('whatever-the-vendor-calls-it')
  })

  it('NEVER selects a permanent allow_always grant', () => {
    // allow_always persists to the runtime owner's on-disk allowlist and would
    // outlive the task. Selecting reject_once instead denies only this action.
    const selection = selectPermissionOption([
      { optionId: 'allow_always', kind: 'allow_always' },
      { optionId: 'reject_once', kind: 'reject_once' },
    ])
    expect(selection.grant).toBe(false)
    expect(selection.optionId).toBe('reject_once')
  })

  it('fails closed (ok=false) when nothing is safely selectable', () => {
    expect(selectPermissionOption([{ optionId: 'allow_always', kind: 'allow_always' }]).ok).toBe(false)
    expect(selectPermissionOption([{ optionId: 'reject_always', kind: 'reject_always' }]).ok).toBe(false)
    expect(selectPermissionOption([]).ok).toBe(false)
  })

  it('treats an unknown kind as non-granting', () => {
    expect(isGrantKind('allow_once')).toBe(true)
    expect(isGrantKind('allow_always')).toBe(true)
    expect(isGrantKind('ALLOW_ONCE')).toBe(true)
    expect(isGrantKind('permit')).toBe(false)
    expect(isGrantKind('reject_once')).toBe(false)
  })

  it('recognises exactly the two known session-scoped ids', () => {
    expect([...ACP_SESSION_SCOPED_OPTION_IDS]).toEqual(['allow_session', 'approve_for_session'])
  })
})

// ── path confinement (pure) ─────────────────────────────────────────────────

describe('confineToRoot', () => {
  it('allows a path inside the root and returns it absolute', () => {
    const root = makeWorkdir()
    expect(confineToRoot(root, 'a/b.txt')).toBe(path.join(root, 'a', 'b.txt'))
  })

  it('allows "." and the root itself', () => {
    const root = makeWorkdir()
    expect(confineToRoot(root, '.')).toBe(root)
  })

  it('refuses a lexical escape', () => {
    const root = makeWorkdir()
    expect(() => confineToRoot(root, '../../etc/passwd')).toThrowError(/refusing .*passwd/)
  })

  it('refuses an absolute path outside the root', () => {
    const root = makeWorkdir()
    expect(() => confineToRoot(root, '/etc/passwd')).toThrowError(/refusing "\/etc\/passwd"/)
  })

  it('refuses a SYMLINK that tunnels out of the root', () => {
    // The trap: `/tmp/x/link -> /etc` is lexically inside the root, so a
    // string-prefix check passes while the real file is not in the run dir.
    const root = makeWorkdir()
    const outside = makeWorkdir()
    writeFileSync(path.join(outside, 'secret.txt'), 'not yours')
    const { symlinkSync } = require('node:fs') as typeof import('node:fs')
    symlinkSync(outside, path.join(root, 'link'))
    expect(() => confineToRoot(root, 'link/secret.txt')).toThrowError(/refusing .*secret\.txt/)
  })
})

// ── a real run, through the real fixture peer ───────────────────────────────

describe('acp driver, real pipes', () => {
  it(
    'completes a turn: handshake, streamed text, and a normalized transcript',
    async () => {
      const { messages, result } = await runToCompletion('success')

      expect(result.status).toBe('completed')
      // Frames arrive in chunks; the deliverable is their concatenation.
      expect(texts(messages)).toBe('The answer is 41.')
      expect(ofType(messages, 'thinking').map((m) => m.content).join('')).toBe('let me think about that. ')
      expect(result.backendSessionId).toBe('fake-acp-session-0001')
    },
    20_000,
  )

  it(
    'reports the engine requires auth, and does NOT treat that as the answer',
    async () => {
      const { messages, result } = await runToCompletion('success')
      const statuses = ofType(messages, 'status').map((m) => m.content ?? '').join('|')
      // The fixture advertises authMethods, so the driver reports it and says
      // how to act on it — it never picks a login flow on the user's behalf.
      expect(statuses).toContain('engine requires authentication')
      expect(statuses).toContain('iOA')
      // And the handshake's config echo must never become the deliverable: it
      // arrives before the prompt, so the update gate is still closed.
      expect(texts(messages)).not.toContain('Permission Mode')
      expect(result.text).toBe('The answer is 41.')
    },
    20_000,
  )

  it(
    'reconciles usage across the notification stream and the terminal frame',
    async () => {
      const { result } = await runToCompletion('success')
      // The stream reported input/output/total/cacheRead; the terminal frame
      // added cacheWrite and omitted nothing. Per-bucket maxima merge both.
      expect(result.usage?.inputTokens).toBe(100)
      expect(result.usage?.outputTokens).toBe(30)
      expect(result.usage?.cacheReadTokens).toBe(20)
      expect(result.usage?.cacheWriteTokens).toBe(5)
    },
    20_000,
  )

  it(
    'normalizes tool calls to tool_use with the id the engine assigned',
    async () => {
      const { messages } = await runToCompletion('tools')
      const calls = ofType(messages, 'tool_use')
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls[0]?.callId).toBe('call-1')
      // The `kind` is authoritative for the TOOL NAME: an ACP title is free
      // text ("Read file"), so naming the tool after it would make the same
      // tool appear under a different name in every runtime.
      expect(calls[0]?.tool).toBe('read_file')
      expect(calls[0]?.input).toEqual({ path: 'README.md' })
    },
    20_000,
  )

  it(
    'keeps the answer that follows the last tool call',
    async () => {
      const { messages, result } = await runToCompletion('tools')
      // Deliverable tracking: text after the latest tool call is the answer.
      expect(result.text).toContain('Wrote out/answer.txt.')
      expect(texts(messages)).toContain('Wrote out/answer.txt.')
    },
    20_000,
  )

  it(
    'serves a client fs/write_text_file INSIDE the run cwd',
    async () => {
      const cwd = makeWorkdir()
      await runToCompletion('tools', { cwd })
      expect(existsSync(path.join(cwd, 'out', 'answer.txt'))).toBe(true)
      expect(readFileSync(path.join(cwd, 'out', 'answer.txt'), 'utf8')).toBe('HELLO')
    },
    20_000,
  )

  it(
    'serves a client fs/read_text_file from inside the run cwd',
    async () => {
      const cwd = makeWorkdir()
      writeFileSync(path.join(cwd, 'README.md'), '# hello from the run dir')
      const { messages } = await runToCompletion('tools', { cwd })
      expect(texts(messages)).toContain('hello from the run dir')
    },
    20_000,
  )

  it(
    'REFUSES an fs/read_text_file that escapes the run cwd, and says why',
    async () => {
      const { messages, result } = await runToCompletion('escape')
      const text = texts(messages)
      // The refusal must be diagnosable: it names the requested path, where it
      // would have landed, and the boundary it crossed. "denied" alone would
      // leave a caller unable to tell a policy refusal from a typo.
      expect(text).toContain('refusing')
      expect(text).toContain('passwd')
      expect(text).toContain('outside this run')
      expect(text).not.toContain('root:')
      expect(result.status).toBe('completed')
    },
    20_000,
  )

  it(
    'serves the full terminal/* lifecycle',
    async () => {
      const { messages } = await runToCompletion('terminal')
      const text = texts(messages)
      expect(text).toContain('TERMINAL_OK')
      expect(text).toContain('exitCode')
    },
    20_000,
  )

  it(
    'answers session/request_permission by the multica policy',
    async () => {
      const { messages, result } = await runToCompletion('permission')
      const text = texts(messages)
      // 1. session-scoped grant wins; 2. permanent grant refused, reject_once
      // taken instead; 3. permanent-only => a protocol error, not a guess.
      expect(text).toContain('allow_session')
      expect(text).toContain('reject_once')
      expect(text).toContain('no auto-selectable permission option offered')
      expect(text).not.toContain('allow_always')
      expect(result.status).toBe('completed')
    },
    20_000,
  )

  it(
    'reports an unauthenticated engine as FAILED, not as a refusal by the model',
    async () => {
      const { result } = await runToCompletion('upstream-error')
      // MEASURED: the real host exits 0 with stopReason "refusal" and carries
      // the 401 only in _meta. Calling that "completed" would report a dead
      // credential as a turn in which the model declined.
      expect(result.status).toBe('failed')
      expect(result.error).toContain('Authentication required')
      expect(result.text).toBe('')
    },
    20_000,
  )

  it(
    'reports a JSON-RPC error from session/prompt as FAILED',
    async () => {
      const { result } = await runToCompletion('rpc-error')
      expect(result.status).toBe('failed')
      expect(result.error).toContain('model unavailable')
    },
    20_000,
  )

  it(
    'keeps a final chunk that arrives AFTER the prompt response',
    async () => {
      // multica has a dedicated test for this. Concluding the run at the
      // response boundary would drop the actual answer and report a truncated
      // transcript as a completed turn.
      const { messages, result } = await runToCompletion('late-chunk')
      expect(result.status).toBe('completed')
      expect(texts(messages)).toBe('Let me check. The answer is 42.')
      expect(result.text).toBe('Let me check. The answer is 42.')
    },
    20_000,
  )

  it(
    'does not deadlock when the engine fills stdout before needing our reply',
    async () => {
      // ~1 MB of notifications land before the fixture asks us to write a file
      // and read it back. A driver that awaited a stdin write inline on the read
      // path would hang here with both pipes full; the timeout is the assertion.
      const { messages, result } = await runToCompletion('deadlock')
      expect(result.status).toBe('completed')
      expect(texts(messages)).toContain('read ok: DRAINED')
    },
    30_000,
  )

  it(
    'survives an agent->client request that carries NO id',
    async () => {
      // The real engine sends `_codebuddy.ai/command` without an id. Replying
      // would be a protocol violation, and treating it as a response to one of
      // our own pending calls would corrupt the pending map.
      const { result } = await runToCompletion('success')
      expect(result.status).toBe('completed')
    },
    20_000,
  )

  it(
    'returns the session handle IMMEDIATELY, before the handshake finishes',
    async () => {
      // Invariant 1: the tool surface must get a sessionId back without waiting
      // for the ACP handshake + session/new round trip. If `run()` awaited the
      // handshake this whole test would still be inside the first await while
      // the fixture is deliberately slow to answer.
      const cwd = makeWorkdir()
      const deps = makeDeps('cancel', { env: CAPS_ON })
      const backend = createBackendWithRuntime('acp', deps, realRuntime)
      const started = Date.now()
      const handle = await backend.run(
        { agent: 'codebuddy-code-acp', prompt: 'go', cwd },
        deps,
        new AbortController().signal,
      )
      const elapsed = Date.now() - started
      // Generous, but far below the fixture's own handshake latency budget: the
      // point is that no round trip is awaited, not a tight timing number.
      expect(elapsed).toBeLessThan(1_000)
      expect(handle.sessionId).toMatch(/^dsh-acp-/)
      expect(handle.snapshot().status).toBe('running')
      await handle.cancel('test over')
      await handle.done
    },
    20_000,
  )

  it(
    'cancels a running turn and reports status "cancelled"',
    async () => {
      const cwd = makeWorkdir()
      const backend = createBackendWithRuntime('acp', makeDeps('cancel'), realRuntime)
      const controller = new AbortController()
      const handle = await backend.run(
        { agent: 'codebuddy-code-acp', prompt: 'go', cwd },
        makeDeps('cancel'),
        controller.signal,
      )
      // Give the handshake and the prompt a moment to be in flight.
      await new Promise((resolve) => setTimeout(resolve, 600))
      await handle.cancel('test cancel')
      const result = await handle.done
      expect(result.status).toBe('cancelled')
      expect(handle.snapshot().terminal).toBe(true)
    },
    20_000,
  )

  it(
    'fails with a readable error when the engine binary does not exist',
    async () => {
      const deps: DriverDeps = {
        command: { executable: '/nonexistent/acp-engine-xyz' },
        env: {},
        logger: silentLogger,
      }
      const backend = createBackendWithRuntime('acp', deps, realRuntime)
      const handle = await backend.run(
        { agent: 'codebuddy-code-acp', prompt: 'go', cwd: makeWorkdir() },
        deps,
        new AbortController().signal,
      )
      const result = await handle.done
      expect(result.status).toBe('failed')
      expect(result.error ?? '').toMatch(/ENOENT|not found|no such file/i)
    },
    20_000,
  )
})

describe('ACP_FAILURE_STOP_REASONS', () => {
  it('covers the three stop reasons that mean the turn did not happen', () => {
    expect([...ACP_FAILURE_STOP_REASONS].sort()).toEqual([
      'max_tokens',
      'max_turn_requests',
      'refusal',
    ])
  })

  it('does NOT treat end_turn or cancelled as an upstream failure', () => {
    expect(ACP_FAILURE_STOP_REASONS.has('end_turn')).toBe(false)
    expect(ACP_FAILURE_STOP_REASONS.has('cancelled')).toBe(false)
  })
})
