/**
 * CLI-track acceptance: drive a REAL, user-installed agent CLI through the whole
 * stack (registry → manager → driver → child process) and print what happened.
 *
 * This is deliberately not a unit test. Unit tests inject a fake spawn; this
 * script proves the parts that only a real machine can prove: that the engine is
 * found despite a truncated GUI PATH, that the process really starts, that the
 * dialect parses, and that a terminal result lands in the session store.
 *
 * Usage:
 *   export PATH=/opt/homebrew/bin:$PATH
 *   node --experimental-strip-types scripts/acceptance.ts <agent> [prompt] [--model=<id>] [--effort=<level>]
 *
 * Examples:
 *   node --experimental-strip-types scripts/acceptance.ts claude
 *   node --experimental-strip-types scripts/acceptance.ts codex "Reply with exactly: OK"
 *   node --experimental-strip-types scripts/acceptance.ts workbuddy "..." --model=deepseek-v4.1-flash
 *   node --experimental-strip-types scripts/acceptance.ts qoderclicn "..." --model=qmodel --effort=none
 *
 * `--effort` exists to exercise the model→effort ORDERING on a real engine: the
 * level set is a function of the selected model, so passing both is the only way
 * to see the driver validate effort against the POST-selection set rather than
 * the handshake's copy. Pair it with `DSH_AGENTS_BRIDGE_DEBUG=1`, because a
 * successful dial emits no frame of its own.
 *
 * A NON-ZERO upstream credential is a normal outcome, not a script bug: the
 * engine's own auth is out of scope for the bridge. What matters is that the
 * failure arrives as a parsed terminal result with the engine's own message.
 */

import os from 'node:os'
import path from 'node:path'

import { createBackend } from '../src/drivers/index.ts'
import { installDriverRuntime } from '../src/integrate.ts'
import { createLogger } from '../src/kernel/logger.ts'
import { createAgentManager } from '../src/kernel/manager.ts'

const [agent = 'claude', prompt = 'Reply with exactly: OK', ...rest] = process.argv.slice(2)
const modelFlag = rest.find((arg) => arg.startsWith('--model='))
const model = modelFlag?.slice('--model='.length)
const effortFlag = rest.find((arg) => arg.startsWith('--effort='))
const effort = effortFlag?.slice('--effort='.length)

installDriverRuntime()

const logger = createLogger('acceptance')
const manager = createAgentManager({
  logger,
  createBackend,
  // Never the user's real store: an acceptance run must not leave sessions behind.
  storeDir: path.join(os.tmpdir(), 'dsh-agents-bridge-acceptance'),
  defaultCwd: process.cwd(),
})

const probed = await manager.probe()
const target = probed.find((entry) => entry.id === agent)
console.log(`probe  ${agent}: track=${target?.track} available=${target?.available}`)
console.log(`       executable=${target?.executable} version=${target?.version} reason=${target?.reason ?? '-'}`)

const snapshot = await manager.run({
  agent,
  prompt,
  timeoutMs: 180_000,
  ...(model ? { model } : {}),
  ...(effort ? { effort } : {}),
})
console.log(`run    session=${snapshot.sessionId} status=${snapshot.status}`)
if (model || effort) console.log(`       requested model=${model ?? '-'} effort=${effort ?? '-'}`)

const deadline = Date.now() + 180_000
let current = snapshot
while (!current.terminal && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  current = manager.status(snapshot.sessionId) ?? current
}

const output = manager.output(snapshot.sessionId)
console.log(`\nevents (${output?.messages.length ?? 0}):`)
for (const message of output?.messages ?? []) {
  const body = message.content ?? message.output ?? ''
  console.log(`  [${message.type}${message.tool ? `:${message.tool}` : ''}] ${body.slice(0, 240).replace(/\n/g, ' ')}`)
}

const result = current.result
console.log(`\nresult status=${result?.status} exit=${String(result?.exitCode)} durationMs=${String(result?.durationMs)}`)
console.log(`text: ${(result?.text ?? '').slice(0, 400).replace(/\n/g, ' ')}`)
if (result?.usage) console.log(`usage: ${JSON.stringify(result.usage)}`)
if (result?.backendSessionId) console.log(`backendSessionId: ${result.backendSessionId}`)
if (result?.error) console.log(`error: ${result.error.slice(0, 400)}`)

await manager.dispose()
process.exit(current.terminal ? 0 : 1)
