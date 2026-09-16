/**
 * End-to-end against a REAL ACP engine.
 *
 * Opt-in through `DSH_ACP_E2E=1`, because it needs a real `codebuddy-code` on
 * the machine and a signed-in account to produce a completed turn. It is kept
 * in the suite rather than deleted so the integration is a one-command
 * verification for whoever next has credentials, rather than a rewrite.
 *
 * Honest about what it can assert: on a host with no credential the engine
 * answers `stopReason: "refusal"` with exit code 0 and puts the 401 only in
 * `_meta`. That path IS the assertion here — a driver that reported it as
 * `completed` would be reporting a dead credential as a successful turn. See
 * `tests/fixtures/ACP-PROVENANCE.md` for the raw capture.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DriverRuntime, SpawnSpec, SpawnedProcess } from '../../src/drivers/argv.ts'
import { createBackendWithRuntime } from '../../src/drivers/index.ts'

const ENABLED = process.env['DSH_ACP_E2E'] === '1'
const BINARY = process.env['DSH_ACP_BIN'] ?? 'codebuddy-code'

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

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

describe.runIf(ENABLED)('acp driver against a real engine', () => {
  it(
    'completes the handshake and reports the turn outcome the engine actually gives',
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'acp-e2e-'))
      try {
        const deps = {
          command: {
            executable: BINARY,
            protocolArgs: ['--acp'],
          },
          // `codebuddy-code` is an `#!/usr/bin/env node` shim, so a PATH without
          // node fails as `env: node: No such file or directory` before the
          // engine ever starts. The real path goes through the CLI track, whose
          // shebang repair handles this; a test that builds `deps.command` by
          // hand must do it itself.
          env: { PATH: `${path.dirname(process.execPath)}:${process.env['PATH'] ?? ''}` },
          logger: silentLogger,
        }
        const backend = createBackendWithRuntime('acp', deps, realRuntime)
        const handle = await backend.run(
          { agent: 'codebuddy-code-acp', prompt: 'reply with the single word PONG', cwd },
          deps,
          new AbortController().signal,
        )
        const result = await handle.done

        // The handshake must have produced a backend session id — that is the
        // proof the real NDJSON exchange worked, independent of auth state.
        expect(result.backendSessionId).toBeTruthy()
        expect(result.sessionId).toBeTruthy()

        // Two legitimate outcomes, and NOTHING in between:
        //  - completed: this host is signed in and produced an answer;
        //  - failed with the upstream message: not signed in (the measured
        //    default here — exit code 0, stopReason "refusal", 401 in _meta).
        expect(['completed', 'failed']).toContain(result.status)
        if (result.status === 'failed') {
          expect(result.error ?? '').toMatch(/[Aa]uthentication|refusal/)
        } else {
          expect(result.text.length).toBeGreaterThan(0)
        }

        // The transcript must at least carry the status lines for the handshake.
        const statuses = handle.messages.filter((m) => m.type === 'status')
        expect(statuses.length).toBeGreaterThan(0)

        console.log(
          '[acp-e2e] status=%s backendSessionId=%s text=%j error=%j',
          result.status,
          result.backendSessionId,
          result.text.slice(0, 200),
          result.error,
        )
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
