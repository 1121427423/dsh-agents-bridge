#!/usr/bin/env node
/**
 * Fake CLI that emits one init event and then stays alive.
 *
 * Used to prove cancellation reaches a real, running child process — the
 * `agents_cancel` path must not be tested against an already-exited process,
 * or it proves nothing.
 *
 * A `SIGTERM`/`SIGKILL` handler is deliberately NOT installed: the point is to
 * verify the kernel's three-stage escalation (SIGTERM → grace → process-group
 * SIGKILL), so the child must die by signal.
 */
const sessionId = 'fake-slow-session'

process.stdout.write(
  `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    uuid: sessionId,
    session_id: sessionId,
    model: 'auto',
  })}\n`,
)

// Keep the event loop busy without exiting; stdout stays open.
setInterval(() => {}, 1000)
