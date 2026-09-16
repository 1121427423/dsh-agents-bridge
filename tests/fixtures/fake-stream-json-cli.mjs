#!/usr/bin/env node
/**
 * Fake stream-json CLI for integration tests.
 *
 * It replays the event sequence captured from a REAL codebuddy 2.137.1 run
 * (see docs/findings-engines.md §5.1), including the two event types that are
 * not in the claude documentation (`system/status`, `file-history-snapshot`).
 * That is the point: the drivers must tolerate them, and a fixture drawn from
 * real output catches a regression that a hand-written happy path would not.
 *
 * argv is ignored on purpose — the driver passes dialect flags (`--model`,
 * `--output-format stream-json`, …) that this script must not care about.
 */
const sessionId = 'fake-session-0001'

const emit = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

emit({
  type: 'system',
  subtype: 'init',
  uuid: sessionId,
  session_id: sessionId,
  apiKeySource: 'fake',
  cwd: process.cwd(),
  tools: ['Read'],
  mcp_servers: [],
  model: 'auto',
  permissionMode: 'default',
})
emit({ type: 'system', subtype: 'status', status: null, session_id: sessionId })
emit({
  type: 'file-history-snapshot',
  id: 'snap-1',
  timestamp: Date.now(),
  isSnapshotUpdate: false,
  snapshot: { messageId: 'msg-1', trackedFileBackups: {} },
})
emit({
  type: 'assistant',
  session_id: sessionId,
  message: {
    id: 'asst-1',
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content: [{ type: 'thinking', thinking: 'pondering the request' }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
})
emit({
  type: 'assistant',
  session_id: sessionId,
  message: {
    id: 'asst-2',
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content: [{ type: 'text', text: 'PONG' }],
    usage: {
      input_tokens: 22408,
      output_tokens: 100,
      cache_creation_input_tokens: 11144,
      cache_read_input_tokens: 11264,
    },
  },
})
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'PONG',
  session_id: sessionId,
  duration_ms: 35,
  num_turns: 3,
  total_cost_usd: 0,
  usage: {
    input_tokens: 22408,
    output_tokens: 100,
    cache_creation_input_tokens: 11144,
    cache_read_input_tokens: 11264,
  },
})
