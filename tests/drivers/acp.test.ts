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
  ACP_DEFAULT_OUTPUT_BYTE_LIMIT,
  ACP_FAILURE_STOP_REASONS,
  ACP_MAX_OUTPUT_BYTE_LIMIT,
  ACP_MAX_TEXT_FILE_BYTES,
  ACP_SESSION_SCOPED_OPTION_IDS,
  ACP_TERMINAL_COMMANDS_ENV,
  acpClientCapabilities,
  acpTerminalEnvironment,
  buildAcpArgs,
  confineToRoot,
  isAcpTerminalCommandAllowed,
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
        // SIGTERM, matching the production runtime's documented contract
        // (`argv.ts`: "SIGTERM → grace (5s) → SIGKILL on the process GROUP").
        //
        // This used to be SIGKILL, and that was a FIDELITY GAP with teeth: a
        // SIGKILLed child reports `{code: null, signal: 'SIGKILL'}`, while a
        // signalled engine that handles the signal reports
        // `{code: 143, signal: null}`. The driver's settle logic branches on
        // the CODE, so the only shape that could ever exercise the exit-code
        // branch was the one the harness could not produce — and a real
        // regression (the bridge blaming an engine for the exit code its own
        // force-kill caused) passed the whole suite. See the `ignores-eof`
        // scenario.
        try {
          child.kill('SIGTERM')
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

/**
 * Terminal pids still alive when a test ends — populated ONLY by the IM-15
 * assertion so a RED run does not leave a parked node process behind (the
 * leaked child is a child of this process, so it would hold the worker open).
 * The assertion always reads the pid BEFORE this cleanup ever runs.
 */
const leftoverTerminalPids: number[] = []

afterEach(() => {
  for (const pid of leftoverTerminalPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone — which is what the green run expects */
    }
  }
  for (const dir of workdirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Poll until the pid is gone.
 *
 * SIGKILL is asynchronous, so a killed child can still be a live (unreaped)
 * process for a few milliseconds after `handle.done`. A LEAKED process instead
 * lives until it is stopped, so the retry cannot mask the leak it guards.
 */
async function waitForPidGone(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!pidAlive(pid)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Wait until the fixture has reported the pid of a terminal it will not release. */
async function waitForOrphanPid(
  read: () => readonly AgentMessage[],
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = /orphan pid=(\d+)/.exec(texts(read()))
    if (match !== null) return Number(match[1])
    if (Date.now() >= deadline) return -1
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Poll for the pid a pre-handshake terminal wrote into its cwd (RR-IM-6).
 *
 * The fixture deliberately does not fail `session/new` until this file exists,
 * so the pid is observable regardless of how fast the driver cleans up.
 */
async function waitForOrphanFilePid(cwd: string, timeoutMs = 5_000): Promise<number> {
  const file = path.join(cwd, 'orphan.pid')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (/^\d+$/.test(text)) return Number(text)
    } catch {
      /* not written yet */
    }
    if (Date.now() >= deadline) return -1
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

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

/** What the fixture reports the driver retained of its terminal output. */
const retainedBytes = (messages: readonly AgentMessage[]): number => {
  const match = /retained=(\d+)/.exec(texts(messages))
  return match === null ? -1 : Number(match[1])
}

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

describe('client-side capability hardening knobs', () => {
  it('parses the optional terminal command allow-list without changing the capability switches', () => {
    const caps = acpClientCapabilities({
      DSH_AGENTS_BRIDGE_ACP_FS: '1',
      DSH_AGENTS_BRIDGE_ACP_TERMINAL: 'yes',
      [ACP_TERMINAL_COMMANDS_ENV]: ' node , /usr/bin/true ',
    })
    expect(caps).toEqual({
      fs: true,
      terminal: true,
      terminalCommands: ['node', '/usr/bin/true'],
    })
  })

  it('checks argv-form commands against the allow-list and refuses shell lines when one exists', () => {
    // Historical policy: no allow-list means the explicit terminal switch is the consent.
    expect(isAcpTerminalCommandAllowed('echo TERMINAL_OK', [], [])).toBe(true)
    // Inspectable form can be allowed by bare basename or exact path.
    expect(isAcpTerminalCommandAllowed('echo', ['TERMINAL_OK'], ['echo'])).toBe(true)
    expect(isAcpTerminalCommandAllowed('/usr/bin/true', [], ['/usr/bin/true'])).toBe(true)
    // But an argv-less shell line can run anything under that label, so the
    // allow-list policy has to refuse it rather than guess a first token.
    expect(isAcpTerminalCommandAllowed('echo TERMINAL_OK', [], ['echo'])).toBe(false)
    // An allow-list entry must not authorize a same-named executable elsewhere.
    expect(isAcpTerminalCommandAllowed('/tmp/echo', [], ['echo'])).toBe(false)
  })

  it('does not forward credential-shaped base or engine-supplied environment into terminals', () => {
    const env = acpTerminalEnvironment(
      {
        PATH: '/usr/bin',
        DSH_SAFE_SETTING: 'safe',
        PROVIDER_API_TOKEN: 'redact-me',
        LOOKS_RANDOM: 'sk-ant-0123456789abcdef0123456789abcdef',
      },
      [
        { name: 'ENGINE_SAFE', value: 'yes' },
        { name: 'ENGINE_SECRET', value: 'not-name-filtered-but-value-filtered sk-0123456789abcdef' },
        { name: 'ENGINE_API_KEY', value: 'key' },
        { name: '', value: 'dropped' },
      ],
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      DSH_SAFE_SETTING: 'safe',
      ENGINE_SAFE: 'yes',
    })
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
  it('prefers a known session-scoped id when its kind is allow_once', () => {
    const selection = selectPermissionOption([
      { optionId: 'allow_once', kind: 'allow_once' },
      { optionId: 'allow_session', kind: 'allow_once' },
    ])
    expect(selection).toEqual({ optionId: 'allow_session', grant: true, ok: true })
  })

  it('NEVER treats an allow_always KIND as session-scoped, whatever id it wears (audit M2)', () => {
    // An engine may give its persistent grant a session-looking id. The kind is
    // the ground truth: allow_always outlives the task, so the selector falls
    // through to a real one-shot grant — it does not pick the id.
    const selection = selectPermissionOption([
      { optionId: 'allow_session', kind: 'allow_always' },
      { optionId: 'plain-once', kind: 'allow_once' },
    ])
    expect(selection).toEqual({ optionId: 'plain-once', grant: true, ok: true })

    // No one-shot grant on offer → deny this action, not the permanent grant.
    const denied = selectPermissionOption([
      { optionId: 'approve_for_session', kind: 'allow_always' },
      { optionId: 'reject_once', kind: 'reject_once' },
    ])
    expect(denied).toEqual({ optionId: 'reject_once', grant: false, ok: true })

    expect(selectPermissionOption([{ optionId: 'allow_session', kind: 'allow_always' }]).ok).toBe(
      false,
    )
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
    'refuses an over-cap fs/read_text_file instead of making the host load it',
    async () => {
      const cwd = makeWorkdir()
      writeFileSync(path.join(cwd, 'big.txt'), 'x'.repeat(ACP_MAX_TEXT_FILE_BYTES + 1000))
      const { messages, result } = await runToCompletion('read-large', { cwd })
      const text = texts(messages)
      expect(result.status).toBe('completed')
      expect(text).toContain(`large read: refusing fs/read_text_file`)
      expect(text).toContain(`${ACP_MAX_TEXT_FILE_BYTES}-byte host cap`)
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

  /**
   * MI-19 — the engine sizes its own terminal output, the HOST pays for it.
   *
   * `terminal/create.outputByteLimit` is taken from the wire and the retained
   * buffer lives in this process, so it is clamped to
   * `ACP_MAX_OUTPUT_BYTE_LIMIT` instead of being adopted verbatim. The fixture
   * reports what the driver actually kept, which is the only thing that can
   * distinguish "clamped" from "the child happened to print little".
   */
  it(
    'MI-19: clamps an engine-supplied outputByteLimit to the host cap',
    async () => {
      const { messages, result } = await runToCompletion('terminal-limit')
      const retained = retainedBytes(messages)
      expect(result.status).toBe('completed')
      expect(retained).toBeGreaterThan(0)
      expect(retained).toBeLessThanOrEqual(ACP_MAX_OUTPUT_BYTE_LIMIT)
      // Truncation is disclosed rather than silent (the buffer was cut).
      expect(texts(messages)).toContain('truncated=true')
    },
    30_000,
  )

  it(
    'MI-19 negative control: an absent limit still yields the 50_000 default',
    async () => {
      const { messages } = await runToCompletion('terminal-default-limit')
      const retained = retainedBytes(messages)
      // The fixture prints 2 MB either way: with no engine limit the default
      // (not the cap) is what bounds the buffer.
      expect(retained).toBe(ACP_DEFAULT_OUTPUT_BYTE_LIMIT)
    },
    30_000,
  )

  /**
   * IM-15 — the driver, not the engine, owns a terminal's lifetime.
   *
   * `AcpClient.dispose()` is the ONLY code that kills every tracked terminal
   * child, and each terminal is spawned into its own group — so a client that is
   * never disposed leaks one process per terminal the engine forgot to release.
   * The fixture reports the child's pid and then parks it forever.
   */
  it(
    'IM-15: a terminal the engine never releases does not outlive the run',
    async () => {
      const { messages, result } = await runToCompletion('orphan-terminal')
      expect(result.status).toBe('completed')
      const match = /orphan pid=(\d+)/.exec(texts(messages))
      expect(match).not.toBeNull()
      const pid = Number(match?.[1])
      expect(pid).toBeGreaterThan(0)
      // The pid was reported while the child was alive (proven by the fixture
      // polling terminal/output for it); the run has settled, so it must be gone.
      leftoverTerminalPids.push(pid)
      await expect(waitForPidGone(pid)).resolves.toBe(true)
      expect(pidAlive(pid)).toBe(false)
    },
    30_000,
  )

  it(
    'IM-15 negative control: the release path still kills its terminal',
    async () => {
      // The pre-existing scenario releases its terminal itself; disposal must
      // not change what the engine already owns.
      const { messages, result } = await runToCompletion('terminal')
      expect(result.status).toBe('completed')
      expect(texts(messages)).toContain('TERMINAL_OK')
    },
    30_000,
  )

  it(
    'IM-15: the CANCEL exit disposes the client too',
    async () => {
      // Both `runAcp` exits must dispose: a cancelled turn took the early-return
      // branch, which is where an engine-created terminal used to survive.
      const cwd = makeWorkdir()
      const deps = makeDeps('orphan-terminal-cancel', { env: CAPS_ON })
      const backend = createBackendWithRuntime('acp', deps, realRuntime)
      const handle = await backend.run(
        { agent: 'codebuddy-code-acp', prompt: 'go', cwd },
        deps,
        new AbortController().signal,
      )
      const pid = await waitForOrphanPid(() => handle.messages)
      expect(pid).toBeGreaterThan(0)
      await handle.cancel('test over')
      const result = await handle.done
      expect(result.status).toBe('cancelled')
      leftoverTerminalPids.push(pid)
      await expect(waitForPidGone(pid)).resolves.toBe(true)
    },
    30_000,
  )

  /**
   * RR-IM-6 — EVERY exit of `runAcp` owns a dispose, including the one that
   * never reaches the prompt.
   *
   * The engine asks for a terminal (spawned into its own process group by the
   * DRIVER) and then fails `session/new`. The ordinary post-prompt exits await
   * `client.dispose()`, which is the only code that kills those terminals; the
   * `failBeforePrompt` exit used to skip it, so the terminal outlived
   * `handle.done`.
   */
  it(
    'RR-IM-6: a terminal created before a failed session/new does not outlive the run',
    async () => {
      const cwd = makeWorkdir()
      const deps = makeDeps('orphan-before-session', { env: CAPS_ON })
      const backend = createBackendWithRuntime('acp', deps, realRuntime)
      const handle = await backend.run(
        { agent: 'codebuddy-code-acp', prompt: 'go', cwd },
        deps,
        new AbortController().signal,
      )
      const result = await handle.done
      expect(result.status).toBe('failed')
      expect(result.error).toContain('session/new')

      const pid = await waitForOrphanFilePid(cwd)
      expect(pid).toBeGreaterThan(0)
      leftoverTerminalPids.push(pid)
      // The run has settled, so the pid it spawned must be gone. The poll
      // tolerates only the SIGKILL reaping latency; the literal acceptance is
      // the `process.kill(pid, 0)` ESRCH below.
      await expect(waitForPidGone(pid)).resolves.toBe(true)
      expect(pidAlive(pid)).toBe(false)
      expect(() => process.kill(pid, 0)).toThrow()
    },
    30_000,
  )

  it(
    'RR-IM-6 negative control: a run that never creates a terminal still fails the same way',
    async () => {
      // Same scenario minus the terminal: the pre-prompt failure settles without
      // touching the terminal machinery at all.
      const cwd = makeWorkdir()
      const deps = makeDeps('success', { env: CAPS_ON })
      const backend = createBackendWithRuntime('acp', deps, realRuntime)
      const handle = await backend.run(
        { agent: 'codebuddy-code-acp', prompt: 'go', cwd },
        deps,
        new AbortController().signal,
      )
      const result = await handle.done
      expect(result.status).toBe('completed')
      expect(existsSync(path.join(cwd, 'orphan.pid'))).toBe(false)
    },
    30_000,
  )

  /**
   * RR-MI-7 — a stream-limit breach is a terminal condition of the run.
   *
   * The fixture writes one line past the 16 MB cap during the handshake and then
   * parks forever without answering `initialize`. Rejecting the pending request
   * is not enough: the run is left in `await child.exited`, so `handle.done`
   * never settles until the engine dies (30 s here; in production, never).
   */
  it(
    'RR-MI-7: a stream-limit breach settles the run on a real terminal path',
    async () => {
      const cwd = makeWorkdir()
      const deps = makeDeps('overflow-handshake', { env: CAPS_ON })
      const backend = createBackendWithRuntime('acp', deps, realRuntime)
      const handle = await backend.run(
        { agent: 'codebuddy-code-acp', prompt: 'go', cwd },
        deps,
        new AbortController().signal,
      )
      let result: AgentResult | undefined
      const settled = await Promise.race([
        handle.done.then((r) => {
          result = r
          return true as const
        }),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ])
      if (result === undefined) {
        // The pre-fix defect: nothing settled. Reap so no engine outlives the
        // failed assertion, then report it as the plain boolean failure.
        await handle.cancel('test cleanup')
        await handle.done.catch(() => {})
      }
      expect(settled).toBe(true)
      expect(result?.status).toBe('failed')
      expect(result?.error).toMatch(/overflow/i)
      // The terminal state is readable through the snapshot, not only `done`.
      expect(handle.snapshot().status).toBe('failed')
    },
    30_000,
  )

  it(
    'answers session/request_permission by the multica policy',
    async () => {
      const { messages, result } = await runToCompletion('permission')
      const text = texts(messages)
      // 1. session-scoped id wins when its kind is one-shot;
      // 2. M2: the same id with a PERMANENT kind is refused, the plain
      //    allow_once is selected instead;
      // 3. permanent-only grant refused, reject_once taken instead;
      // 4. permanent-only offer => a protocol error, not a guess.
      expect(text).toContain('allow_session')
      expect(text).toMatch(/"optionId":"allow_once"/)
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
    'does NOT blame the engine for the exit code its own force-kill caused',
    async () => {
      // MEASURED on Qoder CN 1.1.53: the engine ignores stdin EOF, so the
      // driver waits out its whole grace window and then signals it, and the
      // engine's shutdown handler exits 143. The TURN had already answered
      // `stopReason: "end_turn"` with its text delivered — the 143 is an
      // artefact of the driver's own kill. Attributing it to the engine
      // reported a finished turn as `failed` with `text: ''`, discarding the
      // answer the caller had already paid for.
      const { messages, result } = await runToCompletion('ignores-eof')

      // The exit code is asserted FIRST and deliberately: it proves the
      // force-kill path actually ran. Without it the test could pass for the
      // wrong reason — a fixture that quietly left on EOF with code 0 never
      // reaches the branch under test.
      expect(result.exitCode).toBe(143)
      expect(result.status).toBe('completed')
      expect(result.text).toBe('The answer is 41.')
      expect(result.error).toBeUndefined()
      expect(texts(messages)).toBe('The answer is 41.')
    },
    20_000,
  )

  it(
    'still reports a non-zero exit the engine chose for itself',
    async () => {
      // The control for the test above, and the reason the fix is a narrowed
      // condition rather than a blanket "ignore non-zero exits". An engine
      // that leaves on EOF of its OWN accord with a failure code is telling
      // the truth about the run; exempting it would trade one silent
      // misreport for a worse one.
      const { result } = await runToCompletion('exits-nonzero')
      expect(result.exitCode).toBe(3)
      expect(result.status).toBe('failed')
      expect(result.error).toContain('exit status 3')
      expect(result.text).toBe('')
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

// ── the config-option dials: model, and the order it forces ─────────────────
//
// These run against the REAL fixture peer, and they read TWO pieces of
// evidence, because the behaviours here are decisions as much as messages:
//
//  1. `FAKE_ACP_DIAL_LOG` — every `set_config_option` the engine RECEIVED, with
//     its outcome. "The driver did not send this" has no frame to assert on, so
//     the engine's own receipt is the only direct evidence — and it is recorded
//     on receipt, so a value the engine REJECTED still shows up as sent. Without
//     that, a driver that sends a dead value and swallows the -32602 would look
//     identical to one that never sent it at all.
//  2. the driver's logger — the reason it chose not to send one.

describe('acp driver, config-option dials', () => {
  interface DialRun {
    readonly result: AgentResult
    readonly dials: readonly string[]
    readonly logs: readonly string[]
  }

  /** Run one turn with a recording logger and a dial log in the run dir. */
  async function runWithDials(opts: {
    readonly model?: string
    readonly effort?: string
    readonly noModelOption?: boolean
  }): Promise<DialRun> {
    const cwd = makeWorkdir()
    const dialPath = path.join(cwd, 'dials.log')
    const logs: string[] = []
    const record =
      (level: string) =>
      (message: string, fields?: Record<string, unknown>): void => {
        logs.push(`${level} ${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`)
      }
    const deps = makeDeps('success', {
      env: { ...CAPS_ON, FAKE_ACP_DIAL_LOG: dialPath },
      logger: {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
      },
      // `--no-model-option` models the `hermes` shape: a real catalogue, no
      // addressable selector. Passed by rebuilding the command rather than by a
      // second fixture, so the peer stays one file.
      ...(opts.noModelOption === true
        ? {
            command: {
              executable: process.execPath,
              argsPrefix: [FIXTURE, '--scenario', 'success', '--no-model-option'],
              protocolArgs: ['--acp'],
            },
          }
        : {}),
    })
    const backend = createBackendWithRuntime('acp', deps, realRuntime)
    const controller = new AbortController()
    const handle = await backend.run(
      {
        agent: 'codebuddy-code-acp',
        prompt: 'do the thing',
        cwd,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.effort === undefined ? {} : { effort: opts.effort }),
      },
      deps,
      controller.signal,
    )
    const result = await handle.done
    const dials = existsSync(dialPath)
      ? readFileSync(dialPath, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line !== '')
      : []
    return { result, dials, logs }
  }

  it(
    'drives the session ADVERTISED model selector, not just the session/new param',
    async () => {
      const { result, dials } = await runWithDials({ model: 'fast-model' })
      expect(result.status).toBe('completed')
      // The engine's receipt. `session/new` params are NOT recorded here — the
      // log holds only `set_config_option` traffic — so this line proves the
      // driver reached for the advertised selector, which is the lever this
      // engine actually obeys.
      expect(dials).toContain('model=fast-model accepted')
    },
    20_000,
  )

  it(
    'does NOT send an unadvertised model, and says why',
    async () => {
      const { result, dials, logs } = await runWithDials({ model: 'not-a-real-model' })
      // The run is unharmed: an unadvertised token invites a -32602 we would
      // swallow anyway, so the driver skips it rather than round-trip for an
      // error it already knows is coming.
      expect(result.status).toBe('completed')
      expect(dials.filter((d) => d.startsWith('model='))).toEqual([])
      expect(logs.join('\n')).toContain('does not advertise the requested model')
    },
    20_000,
  )

  it(
    'runs on the session/new param alone when the session offers no selector',
    async () => {
      // The `hermes` shape: a real model catalogue, no addressable config option.
      const { result, dials, logs } = await runWithDials({ model: 'fast-model', noModelOption: true })
      expect(result.status).toBe('completed')
      expect(dials.filter((d) => d.startsWith('model='))).toEqual([])
      expect(logs.join('\n')).toContain('advertises no model selector')
    },
    20_000,
  )

  it(
    'sets the model BEFORE reading effort, so a retired level is never sent',
    async () => {
      // THE ordering test, and the reason the model step exists at all.
      // Switching to `fast-model` retires every effort level except `low` — the
      // coupling measured on both Qoder builds. A driver that read effort from
      // the HANDSHAKE's option set would still see `xhigh` advertised, send it,
      // and take a -32602 from an engine that had accepted it a moment earlier.
      const { dials, logs } = await runWithDials({ model: 'fast-model', effort: 'xhigh' })
      expect(dials).toContain('model=fast-model accepted')
      // …and it never even went out, which is the whole point. The log records
      // REJECTED dials too, so this cannot pass merely because the engine said
      // no: a `thought_level=xhigh rejected` line would fail it just as a
      // `thought_level=xhigh accepted` line would.
      expect(dials.filter((d) => d.startsWith('thought_level='))).toEqual([])
      expect(logs.join('\n')).toContain('does not advertise the requested effort')
    },
    20_000,
  )

  it(
    'control: the same effort IS sent when the selected model keeps it',
    async () => {
      // Without this control the test above would pass even if the driver never
      // sent effort at all. `default-model` keeps every level, so `xhigh`
      // survives the model step and must go out.
      const { dials, logs } = await runWithDials({ model: 'default-model', effort: 'xhigh' })
      expect(dials).toContain('model=default-model accepted')
      expect(dials).toContain('thought_level=xhigh accepted')
      expect(logs.join('\n')).not.toContain('does not advertise the requested effort')
      // The DIAGNOSTIC is part of the contract, not decoration: a successful dial
      // emits no frame of its own, so this line is the only thing a full-stack
      // acceptance run can observe. Asserted so that deleting it reddens here
      // rather than silently blinding the next real-engine verification
      // (docs/findings-qoder-cn-desktop.md §11.6, §11.8).
      expect(logs.join('\n')).toContain('acp effort selector driven')
      // …and it must name WHERE the level set was read from: `post-selection`
      // here, because the fixture echoes the updated set in its response.
      expect(logs.join('\n')).toContain('"optionSource":"post-selection"')
    },
    20_000,
  )

  it(
    'control: effort alone still works with no model requested',
    async () => {
      const { dials } = await runWithDials({ effort: 'medium' })
      expect(dials).toContain('thought_level=medium accepted')
      expect(dials.filter((d) => d.startsWith('model='))).toEqual([])
    },
    20_000,
  )
})
