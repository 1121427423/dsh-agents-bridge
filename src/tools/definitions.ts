/**
 * dsh-agents-bridge — the six model-facing tool definitions.
 *
 * This module is deliberately PURE: it touches no `ctx`, starts no process, and
 * holds no mutable state. `register.ts` owns the wiring, `index.ts` owns the
 * lifecycle. Keeping the definitions free of host access means they can be
 * unit-tested (and re-registered under a different scope) without a harness.
 *
 * Contract source of truth: `docs/design.md` §5. Names and parameters are
 * frozen there — a rename here breaks the published tool surface.
 *
 * The one hard design constraint lives in `agents_run`: its `execute` MUST
 * return as soon as the child is spawned. A tool call carries a cooperative
 * timeout budget while an agent CLI task is minutes long, so waiting here would
 * abort every real task. The model is told to poll `agents_output` instead —
 * see the same promise in `index.ts`'s system-prompt section.
 *
 * @module dsh-agents-bridge/tools/definitions
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentManager, AgentMessage, SessionSnapshot } from '../kernel/types.ts'

/** Lifecycle states a session can be in, in the order a model should reason about them. */
const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'timeout'] as const

/** Transport modes v1 understands (`connect` is reserved, not implemented). */
const TRANSPORT_MODES = ['spawn', 'connect'] as const

/**
 * Event kinds rendered by `agents_output`. Mirrors `AgentMessageType`.
 *
 * Kept as a local tuple rather than imported: `defineTool` needs a literal
 * tuple for `enum` inference, and `AgentMessageType` is a type (no runtime
 * value to spread). A drift is caught by the `enum` schema in the output
 * contract — the kernel validates every emitted message against it.
 */
const MESSAGE_TYPES = ['text', 'thinking', 'tool_use', 'tool_result', 'status', 'log', 'error'] as const

/** One text block. Every `render` returns content in this shape. */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * Render a millisecond duration compactly. Models reason about wall-clock
 * budget when deciding whether to keep polling, so a raw `183421` is worse
 * than `3m3s`.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h${minutes}m`
  return `${minutes}m${seconds}s`
}

/**
 * Render one normalized agent event as a single readable line.
 *
 * Format (`docs/design.md` §5 and the integration test expectations):
 *   `[tool_use] Bash`
 *   `[text] <first line of the assistant text>`
 *   `[error] <message>`
 *
 * Long payloads are truncated per line and fully elided beyond a small count;
 * a model that needs the whole transcript should narrow its `limit` instead of
 * receiving a payload that crowds out its context window.
 */
export function renderMessage(message: AgentMessage, index: number): string {
  const prefix = `#${index} [${message.type}]`
  switch (message.type) {
    case 'tool_use':
      return `${prefix} ${message.tool ?? 'unknown'}${message.input === undefined ? '' : ` ${truncate(compactJson(message.input), 200)}`}`
    case 'tool_result': {
      const body = message.output ?? message.content ?? ''
      return `${prefix} ${message.tool ?? 'unknown'}${body.length === 0 ? '' : ` → ${truncate(firstLine(body), 200)}`}`
    }
    case 'text':
    case 'thinking':
    case 'status':
    case 'log':
      return `${prefix} ${truncate(firstLine(message.content ?? ''), 400)}`
    case 'error':
      return `${prefix} ${truncate(firstLine(message.content ?? 'unknown error'), 400)}`
    default:
      // Unreachable for the frozen union, but an unknown future type must not
      // crash a render: the model still gets to see that something happened.
      return `${prefix} ${truncate(firstLine(message.content ?? ''), 200)}`
  }
}

/** First non-empty line of a payload, so a multi-line text event stays one row. */
function firstLine(value: string): string {
  const lines = value.split('\n')
  for (const line of lines) {
    if (line.trim().length > 0) return line.trim()
  }
  return ''
}

/** Best-effort JSON for tool inputs; never throws on a cycle or a getter. */
function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Hard cap one rendered line so a single event cannot flood the result. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Per-line and total caps for one `agents_output` read. */
const MAX_RENDERED_MESSAGES = 80
const MAX_RENDERED_CHARS = 12_000

/**
 * Render a probe table. Unavailable identities are shown WITH their reason.
 *
 * The parameter is a structural projection rather than `ProbeResult[]` so the
 * renderer also accepts the schema-inferred value (this repo's
 * `noUncheckedIndexedAccess` turns every inferred key optional — see the note
 * in the `agents_status` render). At runtime the registry has already validated
 * the value against `output.schema`, so the fallbacks below are unreachable for
 * a conforming kernel; they exist so a render can never throw.
 */
function renderProbe(
  results: readonly {
    readonly id?: string | undefined
    readonly displayName?: string | undefined
    readonly family?: string | undefined
    readonly available?: boolean | undefined
    readonly executable?: string | undefined
    readonly version?: string | undefined
    readonly reason?: string | undefined
  }[],
): ContentBlock[] {
  if (results.length === 0) {
    return text('No agent identities are registered. Add one to the plugin config (`descriptors`) or the kernel registry.')
  }
  const lines = results.map(result => {
    const path = result.executable ?? '-'
    const version = result.version === undefined ? '' : ` v${result.version}`
    const status = result.available === true ? 'available' : `unavailable (${result.reason ?? 'reason not reported'})`
    return `${result.available === true ? '✓' : '✗'} ${result.id ?? 'unknown'} [${result.family ?? 'unknown'}] ${result.displayName ?? ''} — ${status}; path=${path}${version}`
  })
  const usable = results.filter(r => r.available === true).map(r => r.id ?? 'unknown')
  const tail = usable.length === 0
    ? 'Nothing is drivable on this host: do not call agents_run.'
    : `Drivable now: ${usable.join(', ')}. Pass one of these ids as agents_run.agent.`
  return text([...lines, '', tail].join('\n'))
}


/**
 * The six tools. `AgentManager` is closed over per-tool via a factory so the
 * same definition table cannot accidentally capture a stale manager: the entry
 * passes the live one once, at registration time.
 */
export function createToolDefinitions(manager: AgentManager) {
  /** `agents_probe` — is anything drivable on this host? The smoke tool. */
  const probe = defineTool({
    name: 'agents_probe',
    description:
      'Probe this host for drivable agent CLIs (Claude Code, CodeBuddy/WorkBuddy, OpenClaw/AutoClaw, …). '
      + 'Call this before the first agents_run of a session to learn which agent ids exist, and to see why a '
      + 'known-but-undrivable app (sealed desktop bundle) is unavailable. Results are cached; pass refresh to re-probe.',
    parameters: {
      refresh: {
        type: 'boolean',
        description: 'Bypass the probe cache and re-resolve executables and versions on PATH.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            track: { type: 'string', enum: ['cli', 'desktop'] },
            family: { type: 'string', enum: ['claude', 'codebuddy', 'codex', 'openclaw', 'acp', 'generic'] },
            available: { type: 'boolean' },
            executable: { type: 'string' },
            version: { type: 'string' },
            reason: { type: 'string' },
            notes: { type: 'string' },
            health: {
              type: 'object',
              additionalProperties: false,
              properties: {
                launch: { type: 'string', enum: ['ok', 'missing', 'unsupported'] },
                credential: {
                  type: 'string',
                  enum: ['ok', 'missing', 'invalid', 'unknown', 'not-applicable'],
                },
                detail: { type: 'string' },
                configPath: { type: 'string' },
              },
            },
            models: { type: 'array', items: { type: 'string' } },
            modelsSource: { type: 'string' },
            authMethods: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      render: (_args, value) => renderProbe(value),
    },
    execute: async (args) => {
      const results = await manager.probe(args.refresh === undefined ? {} : { refresh: args.refresh })
      // Spread into mutable JSON arrays: the kernel returns `readonly` views,
      // and `output.schema` materialization must see plain lossless JSON.
      return results.map(({ models, authMethods, ...rest }) => ({
        ...rest,
        // `ProbeResult.models` is a readonly view; materialization needs a
        // plain mutable array to satisfy the schema type. Same for the ACP-only
        // `authMethods`.
        ...(models === undefined ? {} : { models: [...models] }),
        ...(authMethods === undefined ? {} : { authMethods: [...authMethods] }),
      }))
    },
  })

  /** `agents_run` — fire and forget. Returns the session id and nothing else. */
  const run = defineTool({
    name: 'agents_run',
    description:
      'Start an agent CLI task in the background on this host. Returns IMMEDIATELY with a sessionId — it never '
      + 'waits for the task to finish (these tasks take minutes; a tool call does not). Poll events with '
      + 'agents_output using the returned sessionId, and use agents_status for a cheap liveness check. The '
      + 'session keeps running even if this conversation moves on.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'Agent identity to drive, as reported by agents_probe (e.g. workbuddy, autoclaw, claude).',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The task / instruction handed to the delegated agent, in full. It cannot see this conversation.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the delegated agent. Defaults to the bridge default (usually the current project).',
      },
      model: {
        type: 'string',
        description: 'Model override for dialects that support one. Ignored by dialects that do not.',
      },
      effort: {
        type: 'string',
        description: 'Runtime-native reasoning effort (e.g. low / medium / high) where the dialect supports it.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Hard wall-clock deadline in ms. 0 or omitted = no deadline (idle watchdog only).',
      },
      mode: {
        type: 'string',
        enum: [...TRANSPORT_MODES],
        description: "Transport mode. v1 implements 'spawn'; 'connect' is reserved and not implemented.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          agent: { type: 'string' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          startedAt: { type: 'integer' },
        },
      },
      render: (_args, value) => text(
        [
          `started ${value.agent} session ${value.sessionId} (status=${value.status})`,
          '',
          `Next: agents_output { "sessionId": "${value.sessionId}", "sinceIndex": 0 } to pull events,`,
          `or agents_status { "sessionId": "${value.sessionId}" } for a one-line liveness check.`,
          'Do not re-run the task while it is running; keep the returned nextIndex and pass it back to read only new events.',
        ].join('\n'),
      ),
    },
    execute: async (args) => {
      // The kernel's `run()` resolves once the child is spawned and the session
      // is registered — it does NOT await `done`. Everything optional is spread
      // conditionally so an omitted knob is absent rather than `undefined`.
      const snapshot = await manager.run({
        agent: args.agent,
        prompt: args.prompt,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.effort === undefined ? {} : { effort: args.effort }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
      })
      return {
        sessionId: snapshot.sessionId,
        agent: snapshot.agentId,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
      }
    },
  })

  /** `agents_status` — cheap liveness. No sessionId = every live session. */
  const status = defineTool({
    name: 'agents_status',
    description:
      'List session snapshots. Pass sessionId for one session, or omit it for every session this plugin owns '
      + '(running first, then most recently ended). Cheap: use it to decide whether to keep waiting instead of '
      + 'pulling events with agents_output.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Session to inspect. Omit to list all live and retained sessions.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                agentId: { type: 'string' },
                status: { type: 'string', enum: [...RUN_STATUSES] },
                startedAt: { type: 'integer' },
                endedAt: { type: 'integer' },
                messageCount: { type: 'integer' },
                terminal: { type: 'boolean' },
                lastMessageType: { type: 'string', enum: [...MESSAGE_TYPES] },
                lastMessage: { type: 'string' },
                resultStatus: { type: 'string', enum: [...RUN_STATUSES] },
                exitCode: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // NOTE on `?? []`: this repo compiles with `noUncheckedIndexedAccess`,
        // which makes every key of an inferred object schema optional from the
        // renderer's point of view. The schema still REQUIRES them at runtime
        // (the registry validates before render), so the fallback is dead code
        // for a conforming value and only exists to keep the render pure-typed.
        const sessions = value.sessions ?? []
        if (sessions.length === 0) {
          return text('No sessions yet. Start one with agents_run.')
        }
        const lines = sessions.map(session => {
          const ended = session.endedAt === undefined ? '' : ` ended=${new Date(session.endedAt).toISOString()}`
          const last = session.lastMessage === undefined ? '' : `\n    last[${session.lastMessageType ?? 'log'}] ${session.lastMessage}`
          const result = session.resultStatus === undefined
            ? ''
            : `\n    result: ${session.resultStatus}${session.exitCode === undefined ? '' : ` exit=${session.exitCode}`}${session.error === undefined ? '' : ` error=${session.error}`}`
          return `• ${session.sessionId} agent=${session.agentId} status=${session.status} messages=${session.messageCount}${ended}${last}${result}`
        })
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const snapshots = args.sessionId === undefined
        ? manager.list()
        : [manager.status(args.sessionId)].filter((value): value is SessionSnapshot => value !== undefined)
      // Running sessions first, then the most recently started — that ordering
      // matches the question the model is usually asking ("what is still alive?").
      const ordered = [...snapshots].sort((left, right) => {
        if (left.terminal !== right.terminal) return left.terminal ? 1 : -1
        return right.startedAt - left.startedAt
      })
      return {
        sessions: ordered.map(session => {
          const result = session.result
          return {
            sessionId: session.sessionId,
            agentId: session.agentId,
            status: session.status,
            startedAt: session.startedAt,
            ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
            messageCount: session.messageCount,
            terminal: session.terminal,
            ...(session.lastMessage === undefined ? {} : { lastMessageType: session.lastMessage.type, lastMessage: renderMessage(session.lastMessage, session.messageCount - 1) }),
            ...(result === undefined ? {} : {
              resultStatus: result.status,
              ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
              ...(result.error === undefined ? {} : { error: result.error }),
            }),
          }
        }),
      }
    },
  })

  /** `agents_output` — the incremental event read. The model's only window in. */
  const output = defineTool({
    name: 'agents_output',
    description:
      'Read new events from a session since an index. Returns normalized messages plus nextIndex — pass that '
      + 'nextIndex back on the next call to receive only what is new (do not re-read from 0). Use limit to cap a '
      + 'burst. Call repeatedly while status is running; when it is terminal, read the final result here.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Session id returned by agents_run.',
      },
      sinceIndex: {
        type: 'integer',
        description: 'Index of the first event to return. Start at 0, then pass the previous call\'s nextIndex.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of events to return in this read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          nextIndex: { type: 'integer' },
          terminal: { type: 'boolean' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                type: { type: 'string', enum: [...MESSAGE_TYPES] },
                text: { type: 'string' },
                tool: { type: 'string' },
                callId: { type: 'string' },
                level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
                at: { type: 'integer' },
              },
            },
          },
          result: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: [...RUN_STATUSES] },
              text: { type: 'string' },
              error: { type: 'string' },
              exitCode: { type: 'integer' },
              durationMs: { type: 'integer' },
              backendSessionId: { type: 'string' },
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              // Disclosure, not a bucket to add up: codex counts reasoning
              // INSIDE output_tokens (see AgentUsage.reasoningTokens).
              reasoningTokens: { type: 'integer' },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        // `?? []` — see the note in the agents_status render above.
        const messages = value.messages ?? []
        // One readable line per event. A `[text]` payload may itself be
        // multi-line: it is shown rather than clipped to its first line,
        // because this render is the model's only window into the transcript.
        // Consecutive `text`/`thinking` events are joined — some dialects emit
        // one event per streamed delta and a line per fragment is pure noise.
        let textSeen = false
        const blocks: string[] = []
        for (const message of messages) {
          const prefix = `#${message.index} [${message.type}]`
          const isText = message.type === 'text' || message.type === 'thinking'
          if (isText && textSeen && blocks.length > 0) {
            const last = blocks.length - 1
            blocks[last] = `${blocks[last] ?? ''}${message.text ?? ''}`
            continue
          }
          switch (message.type) {
            case 'tool_use':
            case 'tool_result':
              blocks.push(`${prefix} ${message.tool ?? 'unknown'}${message.text === undefined ? '' : ` → ${message.text}`}`)
              break
            default:
              blocks.push(`${prefix} ${message.text ?? ''}`)
              break
          }
          if (isText) textSeen = true
        }
        const header = `session ${value.sessionId} status=${value.status} events=${messages.length} nextIndex=${value.nextIndex}`
        const body: string[] = [header]
        if (blocks.length === 0) {
          body.push(value.terminal === true ? '(no new events)' : '(no new events yet — the agent is still working)')
        } else {
          body.push('', ...blocks)
        }
        const result = value.result
        if (result !== undefined) {
          const usage = result.inputTokens === undefined
            ? ''
            : ` tokens=${result.inputTokens}in/${result.outputTokens ?? 0}out`
          body.push('', `result: ${result.status} duration=${formatDuration(result.durationMs ?? 0)}${usage}`)
          if (result.error !== undefined) body.push(`error: ${result.error}`)
          if ((result.text ?? '').length > 0) body.push('', 'final text:', result.text ?? '')
          if (result.backendSessionId !== undefined) {
            body.push('', `resumable backend session: ${result.backendSessionId}`)
          }
        }
        body.push('', `Next: agents_output { "sessionId": "${value.sessionId}", "sinceIndex": ${value.nextIndex} }${value.terminal === true ? ' (terminal — no further events will arrive)' : ''}`)
        return text(body.join('\n'))
      },
    },
    execute: async (args) => {
      const read = manager.output(args.sessionId, {
        ...(args.sinceIndex === undefined ? {} : { sinceIndex: args.sinceIndex }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      if (read === undefined) {
        throw new Error(`unknown session "${args.sessionId}" — list live sessions with agents_status`)
      }
      const sinceIndex = args.sinceIndex ?? 0
      // Truncate before rendering: the render layer caps characters, and a
      // model that asked for 10k events would otherwise blow its own context.
      const messages = read.messages.slice(0, MAX_RENDERED_MESSAGES).map((message, offset) => ({
        index: sinceIndex + offset,
        type: message.type,
        ...(message.content === undefined ? {} : { text: truncate(message.content, 4_000) }),
        ...(message.tool === undefined ? {} : { tool: message.tool }),
        ...(message.callId === undefined ? {} : { callId: message.callId }),
        ...(message.level === undefined ? {} : { level: message.level }),
        at: message.at,
      }))
      const snapshot = manager.status(args.sessionId)
      const result = snapshot?.result
      const hint = read.status === 'running'
        ? `Still running. Call agents_output again with sinceIndex=${read.nextIndex} to read only new events.`
        : `Session is ${read.status}. Read the final result above, then report it; no further events will arrive.`
      return {
        sessionId: read.sessionId,
        status: read.status,
        nextIndex: read.nextIndex,
        terminal: snapshot?.terminal ?? read.status !== 'running',
        messages,
        ...(result === undefined ? {} : {
          result: {
            status: result.status,
            text: truncate(result.text, MAX_RENDERED_CHARS),
            ...(result.error === undefined ? {} : { error: result.error }),
            ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
            durationMs: result.durationMs,
            ...(result.backendSessionId === undefined ? {} : { backendSessionId: result.backendSessionId }),
            ...(result.usage === undefined
              ? {}
              : {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  ...(result.usage.reasoningTokens === undefined
                    ? {}
                    : { reasoningTokens: result.usage.reasoningTokens }),
                }),
          },
        }),
        hint,
      }
    },
  })

  /** `agents_cancel` — graceful signal, then a process-group kill. Idempotent. */
  const cancel = defineTool({
    name: 'agents_cancel',
    description:
      'Cancel a running session. Idempotent: cancelling an already-terminal session reports cancelled=false and '
      + 'does not change its recorded outcome. Cancellation signals the whole process group, so a delegated agent '
      + "cannot leave orphaned children behind. Pass reason to record why (it is logged and shown to the child on "
      + 'platforms that deliver it).',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Session to cancel, as returned by agents_run.',
      },
      reason: {
        type: 'string',
        description: 'Short human-readable reason recorded with the cancellation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          cancelled: { type: 'boolean' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => text(
        `${value.cancelled ? 'cancelling' : 'not cancelled'} session ${value.sessionId} (status=${value.status})`
        + `\n${value.note}`,
      ),
    },
    execute: async (args) => {
      const requested = await manager.cancel(args.sessionId, args.reason)
      const snapshot = manager.status(args.sessionId)
      const status = snapshot?.status ?? 'cancelled'
      const note = !requested
        ? 'Nothing to cancel: the session is unknown or already terminal.'
        : status === 'running'
          // Three-phase cancel is asynchronous by design (SIGTERM → grace →
          // SIGKILL process group); the model must not assume it is done.
          ? 'Cancellation requested. The child is being signalled and will be killed after its grace window — re-check with agents_status.'
          : 'Cancellation settled. Read the tail of the transcript with agents_output for any partial output.'
      return { sessionId: args.sessionId, cancelled: requested, status, note }
    },
  })

  /** `agents_send` — continue a finished conversation (v1: best-effort resume). */
  const send = defineTool({
    name: 'agents_send',
    description:
      'Continue a previous session with a new prompt, reusing the delegated agent\'s backend conversation when the '
      + 'dialect supports resume. v1 is best-effort: if the dialect cannot resume, the kernel starts a fresh '
      + 'session for the prompt. Returns immediately like agents_run, then poll agents_output with the returned '
      + 'sessionId.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Session to continue, as returned by agents_run.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'Follow-up instruction for the delegated agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          status: { type: 'string', enum: [...RUN_STATUSES] },
          resumed: { type: 'boolean' },
          messageCount: { type: 'integer' },
        },
      },
      render: (_args, value) => text(
        [
          `${value.resumed ? 'continued' : 'started a follow-up in'} ${value.sessionId} (status=${value.status}, messages=${value.messageCount})`,
          '',
          `Next: agents_output { "sessionId": "${value.sessionId}", "sinceIndex": ${value.messageCount} } to read only the new turns` +
          ' (or sinceIndex=0 to re-read the whole transcript).',
        ].join('\n'),
      ),
    },
    execute: async (args) => {
      const snapshot = await manager.send(args.sessionId, args.prompt)
      return {
        sessionId: snapshot.sessionId,
        status: snapshot.status,
        resumed: snapshot.sessionId === args.sessionId,
        messageCount: snapshot.messageCount,
      }
    },
  })

  return [probe, run, status, output, cancel, send] as const
}

/** The full definition table shape, for `register.ts` and tests. */
export type ToolDefinitions = ReturnType<typeof createToolDefinitions>

/** Convenience export used by the system-prompt section to name the surface. */
export const TOOL_NAMES = [
  'agents_probe',
  'agents_run',
  'agents_status',
  'agents_output',
  'agents_cancel',
  'agents_send',
] as const
