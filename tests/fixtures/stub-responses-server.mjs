#!/usr/bin/env node
/**
 * dsh-agents-bridge / test fixture — a tiny OpenAI **Responses API** stub.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tests/fixtures/codex-success.ndjson` is a *real* `codex exec --json` capture,
 * produced by pointing the real codex-cli at this server. Guessing the success
 * envelope from documentation is exactly the failure this repo exists to avoid:
 * the captured *failure* stream already contained an event (`turn.failed`) that
 * is not in any public summary of the dialect, so the success envelope had to be
 * measured, not derived.
 *
 * On this host the stored codex credential is rejected by the gateway at
 * http://127.0.0.1:8080, so codex cannot reach a real upstream. This stub
 * answers instead, which is enough for codex to complete a genuine turn and
 * print its genuine stdout JSONL.
 *
 * USAGE (see the header of tests/drivers/codex.test.ts for the exact command):
 *
 *   node tests/fixtures/stub-responses-server.mjs --port 8799 --log /tmp/req.ndjson
 *
 * WHAT IT SPEAKS
 * --------------
 *   POST /responses      → SSE stream: response.created, response.output_item.added,
 *                          response.output_text.delta, response.output_item.done,
 *                          response.completed (with usage). `stream: false` bodies get a
 *                          plain JSON response instead.
 *   GET  /healthz        → {"ok":true}, used to wait for readiness before launching codex.
 *   anything else        → 404 JSON.
 *
 * It performs NO authentication check on purpose: the request carries whatever
 * credential codex already has in its own `$CODEX_HOME/auth.json`, and this file
 * neither reads nor logs the `Authorization` header (only the JSON body).
 */

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

function parseArgs(argv) {
  const out = { port: 8799, log: '', text: 'OK', model: 'gpt-5-codex' }
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

function completedResponse(id, text, model) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [messageItem(`${id}_msg`, text, 'completed')],
    usage: {
      input_tokens: 812,
      input_tokens_details: { cached_tokens: 640 },
      output_tokens: 24,
      output_tokens_details: { reasoning_tokens: 8 },
      total_tokens: 836,
    },
  }
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

    if (parsed.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(completedResponse('resp_stub_1', opts.text, model)))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const id = 'resp_stub_1'
    sse(res, {
      type: 'response.created',
      response: {
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model,
        output: [],
      },
    })
    sse(res, {
      type: 'response.output_item.added',
      output_index: 0,
      item: messageItem(`${id}_msg`, '', 'in_progress'),
    })
    for (const piece of opts.text.match(/.{1,8}/gs) ?? [opts.text]) {
      sse(res, {
        type: 'response.output_text.delta',
        item_id: `${id}_msg`,
        output_index: 0,
        content_index: 0,
        delta: piece,
      })
    }
    sse(res, {
      type: 'response.output_item.done',
      output_index: 0,
      item: messageItem(`${id}_msg`, opts.text, 'completed'),
    })
    sse(res, { type: 'response.completed', response: completedResponse(id, opts.text, model) })
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
