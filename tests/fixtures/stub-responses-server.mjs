#!/usr/bin/env node
/**
 * dsh-agents-bridge / test fixture — a tiny OpenAI **Responses API** stub.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tests/fixtures/codex-success.ndjson` and `codex-tools.ndjson` are *real*
 * `codex exec --json` captures, produced by pointing the real codex-cli at this
 * server. Guessing the success envelope from documentation is exactly the
 * failure this repo exists to avoid: the captured *failure* stream already
 * carried an event (`turn.failed`) that appears in no public summary of the
 * dialect, so the success envelope had to be measured, not derived.
 *
 * On this host the stored codex credential is rejected by the gateway at
 * http://127.0.0.1:8080, so codex cannot reach a real upstream. This stub
 * answers instead, which is enough for codex to complete genuine turns — tool
 * execution included — and print its genuine stdout JSONL.
 *
 * USAGE (see the header of tests/drivers/codex.test.ts for the exact commands):
 *
 *   node tests/fixtures/stub-responses-server.mjs --port 8799 --log /tmp/req.ndjson
 *   node tests/fixtures/stub-responses-server.mjs --port 8799 --scenario tools
 *
 * SCENARIOS
 * ---------
 *   plain   (default) request 1 → one assistant message with `--text`
 *   tools   request 1 → reasoning + an `exec_command` function call
 *           request 2 → one assistant message with `--text`
 *   patch   request 1 → an `apply_patch` custom call (writes a file)
 *           request 2 → one assistant message with `--text`
 *   mcp     request 1 → a `tool_search` call (codex 0.154 defers MCP tools
 *                       behind the tool-search mechanism, so they are NOT in
 *                       `tools[]` until searched)
 *           request 2 → a function call to whichever tool name in `tools[]`
 *                       matches `stub_echo` (discovered from codex's own
 *                       request rather than hardcoded — the qualification
 *                       scheme is version-specific)
 *           request 3 → one assistant message with `--text`
 *
 * WHAT IT SPEAKS
 * --------------
 *   POST /responses      → SSE stream: response.created, response.output_item.added,
 *                          response.output_text.delta, response.output_item.done,
 *                          response.completed (with usage). A `stream: false` body gets
 *                          a plain JSON response instead.
 *   GET  /healthz        → {"ok":true}, used to wait for readiness before launching codex.
 *   anything else        → 404 JSON.
 *
 * It performs NO authentication check on purpose: the request carries whatever
 * credential codex already has in its own `$CODEX_HOME/auth.json`, and this file
 * neither reads nor logs the `Authorization` header (only the JSON body).
 *
 * NOTE for future maintenance: codex 0.154.0's own tool set here is
 * `exec_command` / `write_stdin` / `apply_patch` / `view_image` / … — a plain
 * `shell` tool no longer exists, so a scenario that calls `shell` is ignored by
 * the model loop and the turn ends with no tool item. Check
 * `tools[].name` in the `--log` capture before authoring a new scenario.
 */

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

function parseArgs(argv) {
  const out = { port: 8799, log: '', text: 'OK', model: 'gpt-5-codex', scenario: 'plain' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--port' && next !== undefined) {
      out.port = Number(next)
      i++
    } else if (arg === '--log' && next !== undefined) {
      out.log = next
      i++
    } else if (arg === '--text' && next !== undefined) {
      out.text = next
      i++
    } else if (arg === '--model' && next !== undefined) {
      out.model = next
      i++
    } else if (arg === '--scenario' && next !== undefined) {
      out.scenario = next
      i++
    }
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))

/** One SSE frame. Both the `event:` and `data:` lines, as the real API sends. */
function sse(res, payload) {
  res.write(`event: ${payload.type}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function messageItem(id, text, status) {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: status === 'completed' ? [{ type: 'output_text', text, annotations: [] }] : [],
  }
}

function reasoningItem(id, text, status) {
  return {
    id,
    type: 'reasoning',
    status,
    summary: status === 'completed' ? [{ type: 'summary_text', text }] : [],
    // codex requests `include: ["reasoning.encrypted_content"]` and replays it on
    // the next request, so the stub supplies an opaque placeholder.
    encrypted_content: 'stub-encrypted-reasoning',
  }
}

function functionCallItem(id, callId, name, args, status) {
  return {
    id,
    type: 'function_call',
    call_id: callId,
    name,
    arguments: args,
    status,
  }
}

/** A `custom` tool call (how apply_patch travels in the Responses dialect). */
function customCallItem(id, callId, name, input, status) {
  return { id, type: 'custom_tool_call', call_id: callId, name, input, status }
}

function completedResponse(id, model, output) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    usage: {
      input_tokens: 812,
      input_tokens_details: { cached_tokens: 640 },
      output_tokens: 24,
      output_tokens_details: { reasoning_tokens: 8 },
      total_tokens: 836,
    },
  }
}

/**
 * Every function-shaped tool name codex advertised on this request, including
 * tools nested inside a `namespace` tool. Used by the `mcp` scenario to learn
 * how this CLI version qualifies an MCP tool (`mcp__server__tool`,
 * `server.tool`, …) instead of hardcoding a scheme that may not exist.
 */
function advertisedToolNames(tools) {
  const names = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (typeof tool?.name === 'string') names.push(tool.name)
    if (Array.isArray(tool?.tools)) {
      for (const nested of tool.tools) {
        if (typeof nested?.name === 'string') names.push(nested.name)
      }
    }
  }
  return names
}

/**
 * The output items for one turn. `index` is 1-based: the first request codex
 * makes for a turn is request 1.
 */
function turnItems(scenario, index, text, tools) {
  const last = index > 1
  if (scenario === 'tools' && !last) {
    return [
      { item: reasoningItem('rs_stub_1', 'I should run a command to check.', 'completed'), deltas: true },
      {
        item: functionCallItem(
          'fc_stub_1',
          'call_stub_1',
          'exec_command',
          JSON.stringify({ cmd: 'echo stub-tool-output' }),
          'completed',
        ),
        argumentDeltas: JSON.stringify({ cmd: 'echo stub-tool-output' }),
      },
    ]
  }
  if (scenario === 'patch' && !last) {
    const patch = '*** Begin Patch\n*** Add File: stub-patched.txt\n+stub patch body\n*** End Patch\n'
    return [
      { item: customCallItem('ct_stub_1', 'call_stub_patch', 'apply_patch', patch, 'completed') },
    ]
  }
  if (scenario === 'mcp' && index === 1) {
    return [
      {
        item: functionCallItem(
          'fc_search_1',
          'call_search_1',
          'tool_search',
          JSON.stringify({ query: 'stub_echo echo text', limit: 5 }),
          'completed',
        ),
        argumentDeltas: JSON.stringify({ query: 'stub_echo echo text', limit: 5 }),
      },
    ]
  }
  if (scenario === 'mcp' && index === 2) {
    const mcpName = advertisedToolNames(tools).find((n) => n.includes('stub_echo'))
    if (mcpName !== undefined) {
      const args = JSON.stringify({ text: 'hello from stub' })
      return [
        {
          item: functionCallItem('fc_mcp_1', 'call_mcp_1', mcpName, args, 'completed'),
          argumentDeltas: args,
        },
      ]
    }
  }
  return [{ item: messageItem('msg_stub_out', text, 'completed'), textDeltas: text }]
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => resolve(body))
  })
}

let requestCount = 0

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  if (!(req.method === 'POST' && (req.url === '/responses' || req.url === '/v1/responses'))) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"stub-responses-server: not found"}}')
    return
  }

  void readBody(req).then((body) => {
    requestCount++
    // Log the request BODY only. Never the Authorization header, never a key.
    if (opts.log !== '') {
      try {
        appendFileSync(opts.log, `${JSON.stringify({ url: req.url, body })}\n`)
      } catch {
        /* logging is diagnostics only */
      }
    }

    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* tolerate a non-JSON body */
    }
    // Echo the model the caller asked for so codex's own state stays coherent.
    const model = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : opts.model
    const responseId = `resp_stub_${requestCount}`
    const items = turnItems(opts.scenario, requestCount, opts.text, parsed.tools)

    if (parsed.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(completedResponse(responseId, model, items.map((i) => i.item))))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    sse(res, {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model,
        output: [],
      },
    })
    items.forEach((entry, outputIndex) => {
      const inProgress = { ...entry.item, status: 'in_progress' }
      if (entry.item.type === 'message') inProgress.content = []
      if (entry.item.type === 'reasoning') inProgress.summary = []
      if (entry.item.type === 'function_call') inProgress.arguments = ''
      if (entry.item.type === 'custom_tool_call') inProgress.input = ''
      sse(res, { type: 'response.output_item.added', output_index: outputIndex, item: inProgress })

      if (entry.textDeltas !== undefined) {
        for (const piece of entry.textDeltas.match(/.{1,12}/gs) ?? [entry.textDeltas]) {
          sse(res, {
            type: 'response.output_text.delta',
            item_id: entry.item.id,
            output_index: outputIndex,
            content_index: 0,
            delta: piece,
          })
        }
      }
      if (entry.item.type === 'reasoning') {
        sse(res, {
          type: 'response.reasoning_summary_part.added',
          item_id: entry.item.id,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        })
        sse(res, {
          type: 'response.reasoning_summary_text.delta',
          item_id: entry.item.id,
          output_index: outputIndex,
          summary_index: 0,
          delta: entry.item.summary[0].text,
        })
      }
      if (entry.argumentDeltas !== undefined) {
        sse(res, {
          type: 'response.function_call_arguments.delta',
          item_id: entry.item.id,
          output_index: outputIndex,
          delta: entry.argumentDeltas,
        })
      }
      if (entry.item.type === 'custom_tool_call') {
        sse(res, {
          type: 'response.custom_tool_call_input.delta',
          item_id: entry.item.id,
          output_index: outputIndex,
          delta: entry.item.input,
        })
      }
      sse(res, { type: 'response.output_item.done', output_index: outputIndex, item: entry.item })
    })
    sse(res, {
      type: 'response.completed',
      response: completedResponse(responseId, model, items.map((i) => i.item)),
    })
    res.end()
  })
})

server.listen(opts.port, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : opts.port
  process.stdout.write(`stub-responses-server listening on http://127.0.0.1:${port}\n`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    process.exit(0)
  })
}
