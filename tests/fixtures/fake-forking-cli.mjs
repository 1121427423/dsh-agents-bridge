#!/usr/bin/env node
/**
 * Fake CLI that forks a long-lived GRANDCHILD, so a cancellation test can prove
 * the whole process tree dies and not just the direct child.
 *
 * Why this exists: killing only the direct child is the classic way to leak
 * runaway agent helpers (node workers, MCP servers, shell tool calls). The
 * kernel relies on `detached: true` making the child a process-group leader, so
 * `process.kill(-pid, SIGKILL)` reaches descendants. That claim is only worth
 * anything if a test actually observes a descendant dying.
 *
 * Contract with the test:
 *   env BRIDGE_FORK_REPORT = path to a JSON report file the fixture writes.
 *
 * The path travels through the environment, not argv: each driver appends its
 * own dialect flags in its own order, so a positional argument is not
 * addressable from a fake CLI that has to work under every dialect.
 *
 * The report is updated at each stage so the test never has to guess:
 *   `{ childPid, grandchildPid, ready: true }` once both are alive, then
 *   `{ ..., childSignal }` / `{ ..., grandchildSignal }` when a signal lands.
 *
 * Signal handlers are installed ON PURPOSE. A handler that records the signal
 * and then hangs is the worst case for the kernel: SIGTERM does NOT kill the
 * process, so the grace window must actually expire and the escalation to
 * SIGKILL must actually be what ends the tree. A fixture without handlers would
 * let a single-SIGTERM implementation pass.
 *
 * The grandchild is spawned with `detached: false` so it stays inside the
 * child's process group — that is the exact shape of a real agent CLI forking a
 * helper, and it is what group-kill must reach.
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const reportPath = process.env.BRIDGE_FORK_REPORT
if (!reportPath) {
  process.stderr.write('fake-forking-cli: BRIDGE_FORK_REPORT is not set\n')
  process.exit(2)
}

const report = {
  childPid: process.pid,
  childPpid: process.ppid,
  grandchildPid: null,
  childSignal: null,
  grandchildSignal: null,
  ready: false,
}

function flush() {
  // Written with an explicit newline so a reader can tell a half-written file
  // (empty / truncated JSON) from a complete one.
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`)
}

flush()

// The grandchild: alive, no signal handlers, and it reports its own death is
// NOT needed — the test asserts on the pid directly, which is stronger.
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  detached: false,
})

grandchild.on('spawn', () => {
  report.grandchildPid = grandchild.pid ?? null
  report.ready = true
  flush()
})

// Record the signal, then refuse to exit — forces the kernel past the grace
// window and onto SIGKILL.
//
// SIGKILL is deliberately NOT in this list: it cannot be trapped, and asking
// Node to listen for it throws `uv_signal_start EINVAL`, which would kill the
// fixture before it ever forks the grandchild.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    report.childSignal = signal
    flush()
  })
}

const sessionId = 'fake-forking-session'
process.stdout.write(
  `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    uuid: sessionId,
    session_id: sessionId,
    model: 'auto',
  })}\n`,
)

setInterval(() => {}, 1000)
