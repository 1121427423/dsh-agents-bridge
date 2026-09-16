#!/usr/bin/env node
/**
 * dsh-agents-bridge / test fixture — a minimal **MCP stdio** server.
 *
 * Used together with `stub-responses-server.mjs` to obtain genuine codex
 * `mcp_tool_call` exec events. A `command_execution` item can be scripted purely
 * from the Responses stub (codex runs the shell itself), but an MCP tool call
 * needs a real MCP peer for codex to dispatch to — hence this process.
 *
 * Wire format: newline-delimited JSON-RPC 2.0 on stdin/stdout, per
 * https://modelcontextprotocol.io (stdio transport). Method coverage is only
 * what codex exercises during startup plus one tool call:
 *
 *   initialize                → protocolVersion + tools capability + serverInfo
 *   notifications/initialized → (notification, no reply)
 *   tools/list                → one tool: `stub_echo`
 *   tools/call                → one text content block
 *   ping                      → {}
 *   anything else with an id  → JSON-RPC error -32601
 *
 * CAUTION: stdout is the protocol channel, so diagnostics must go to stderr —
 * one stray `console.log` corrupts the stream and codex reports a transport
 * failure instead of an MCP item.
 */

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'stub-mcp', version: '1.0.0' }

const TOOLS = [
  {
    name: 'stub_echo',
    description: 'Echo the supplied text back. Test fixture; performs no I/O.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(msg) {
  const id = msg.id
  const method = msg.method
  const params = msg.params ?? {}
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion:
            typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    case 'tools/call': {
      if (params.name !== 'stub_echo') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `unknown tool: ${String(params.name)}` },
        }
      }
      const text = params.arguments?.text ?? ''
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `stub-mcp-output:${String(text)}` }],
          isError: false,
        },
      }
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } }
    default:
      if (id === undefined) return undefined
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let idx = buffer.indexOf('\n')
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line !== '') {
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        process.stderr.write('stub-mcp: ignoring malformed line\n')
        parsed = undefined
      }
      if (parsed !== undefined) {
        const reply = handle(parsed)
        if (reply !== undefined && reply.id !== undefined && reply.id !== null) send(reply)
      }
    }
    idx = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
