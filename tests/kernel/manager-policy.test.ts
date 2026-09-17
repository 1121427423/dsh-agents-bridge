/**
 * Host policy: which agent, which cwd, how many at once.
 *
 * Scope (docs/design.md §10.4): this is "stop the model from pointing `cwd` at
 * `/` by accident", not a sandbox. An agent handed file-write tools can still
 * reach outside its cwd — only the OS approval/sandbox layer stops that. So the
 * tests below care about *accidents and aliases*, not about defeating an
 * adversarial model.
 *
 * The symlink case is the one that actually matters here: on macOS `/tmp` is a
 * symlink to `/private/tmp`, so a raw string prefix check silently accepts
 * `cwd: /tmp/x` against `allowedCwd: ["/private/var"]`-style rules. Every check
 * resolves BOTH sides first.
 *
 * @module tests/kernel/manager-policy
 */

import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { AgentRunRejectedError } from '../../src/kernel/types.ts'
import { DEFAULT_MAX_CONCURRENT } from '../../src/kernel/policy.ts'
import { ManagerPool, sleep } from '../helpers/manager-harness.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SLOW_CLI = path.join(here, '..', 'fixtures', 'fake-slow-cli.mjs')

const pool = new ManagerPool()
afterEach(async () => {
  await pool.disposeAll()
})

/** A real directory that is safe to use as a run cwd. */
function workDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'bridge-cwd-'))
}

function slow(overrides: Parameters<ManagerPool['create']>[1] = {}) {
  return pool.create(SLOW_CLI, overrides, {}, 100)
}

describe('cwd allow-list', () => {
  it('accepts a cwd inside an allowed root', async () => {
    const root = workDir()
    const inner = path.join(root, 'project')
    mkdirSync(inner)
    const manager = slow({ allowedCwd: [root] })

    const started = await manager.run({ agent: 'claude', prompt: 'x', cwd: inner, timeoutMs: 0 })
    expect(started.status).toBe('running')
  })

  it('accepts the allowed root itself', async () => {
    const root = workDir()
    const manager = slow({ allowedCwd: [root] })
    const started = await manager.run({ agent: 'claude', prompt: 'x', cwd: root, timeoutMs: 0 })
    expect(started.status).toBe('running')
  })

  it('rejects a cwd outside every allowed root, naming both', async () => {
    const root = workDir()
    const outside = workDir()
    const manager = slow({ allowedCwd: [root] })

    const error = await manager
      .run({ agent: 'claude', prompt: 'x', cwd: outside, timeoutMs: 0 })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(AgentRunRejectedError)
    const rejection = error as AgentRunRejectedError
    expect(rejection.code).toBe('cwd-not-allowed')
    // The model must be able to see WHICH value was refused and what was allowed.
    expect(rejection.message).toContain(outside)
    expect(rejection.message).toContain(root)
    expect(rejection.value).toBe(outside)
    expect(rejection.allowed).toEqual([expect.stringContaining(root)])
  })

  it('does not restrict anything when allowedCwd is unset (backward compatible)', async () => {
    const anywhere = workDir()
    const manager = slow()
    const started = await manager.run({ agent: 'claude', prompt: 'x', cwd: anywhere, timeoutMs: 0 })
    expect(started.status).toBe('running')
  })

  it('resolves symlinks before comparing, so /tmp cannot alias past the rule', async () => {
    const root = workDir()
    const real = path.join(root, 'real')
    mkdirSync(real)
    const link = path.join(root, 'link')
    symlinkSync(real, link)

    // The policy is configured with the SYMLINK, the run asks for the TARGET.
    // A raw string comparison would reject this; a `realpath`-based one accepts
    // it, which is the correct behaviour (they are the same directory).
    const manager = slow({ allowedCwd: [link] })
    const started = await manager.run({ agent: 'claude', prompt: 'x', cwd: real, timeoutMs: 0 })
    expect(started.status).toBe('running')
  })

  it('cannot be bypassed by reaching a denied tree through a symlink', async () => {
    const root = workDir()
    const secret = mkdtempSync(path.join(tmpdir(), 'bridge-secret-'))
    const alias = path.join(root, 'shortcut')
    symlinkSync(secret, alias)

    // `alias` is textually under `allowedCwd`, but it RESOLVES into the denied
    // tree. Checking the raw string would let it through.
    const manager = slow({ allowedCwd: [root], deniedCwd: [secret] })
    const error = await manager
      .run({ agent: 'claude', prompt: 'x', cwd: alias, timeoutMs: 0 })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(AgentRunRejectedError)
    expect((error as AgentRunRejectedError).code).toBe('cwd-denied')
    expect((error as AgentRunRejectedError).message).toContain('denied')
  })

  it('rejects a non-existent cwd with a diagnosable message', async () => {
    const manager = slow()
    const missing = path.join(workDir(), 'definitely-not-here')
    const error = await manager
      .run({ agent: 'claude', prompt: 'x', cwd: missing, timeoutMs: 0 })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(AgentRunRejectedError)
    expect((error as AgentRunRejectedError).code).toBe('cwd-unresolvable')
    expect((error as AgentRunRejectedError).message).toContain('definitely-not-here')
  })

  it('applies the allow-list even when the run omits cwd (MI-2)', async () => {
    // The bypass: with NO default cwd configured, `run({})` used to fall
    // through `checkCwd(undefined)` — which is "unrestricted" — and the child
    // then inherited the bridge's own cwd, which may be outside the allow-list.
    const allowed = workDir()
    const manager = slow({ allowedCwd: [allowed], defaultCwd: undefined })

    const error = await manager
      .run({ agent: 'claude', prompt: 'x', timeoutMs: 0 })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(AgentRunRejectedError)
    expect((error as AgentRunRejectedError).code).toBe('cwd-not-allowed')
  })

  it('accepts an omitted cwd that resolves inside the allow-list', async () => {
    // Same shape, but the resolved default cwd IS allowed, so the run proceeds —
    // the rule rejects by location, not by "did you pass cwd".
    const manager = slow({ allowedCwd: [process.cwd()], defaultCwd: undefined })
    await expect(manager.run({ agent: 'claude', prompt: 'x', timeoutMs: 0 })).resolves.toBeDefined()
  })
})

describe('cwd deny-list', () => {
  it('rejects a cwd under a denied root even with no allow-list', async () => {
    const denied = workDir()
    const manager = slow({ deniedCwd: [denied] })

    const error = await manager
      .run({ agent: 'claude', prompt: 'x', cwd: denied, timeoutMs: 0 })
      .catch((err: unknown) => err)
    expect((error as AgentRunRejectedError).code).toBe('cwd-denied')
  })

  it('wins over allowedCwd when the two overlap', async () => {
    const root = workDir()
    const inner = path.join(root, 'blocked')
    mkdirSync(inner)
    const manager = slow({ allowedCwd: [root], deniedCwd: [inner] })

    const error = await manager
      .run({ agent: 'claude', prompt: 'x', cwd: inner, timeoutMs: 0 })
      .catch((err: unknown) => err)
    expect((error as AgentRunRejectedError).code).toBe('cwd-denied')
  })

  it('is not fooled by a prefix that is merely textually similar', async () => {
    // `/tmp/x-private` must NOT be treated as under `/tmp/x`.
    const base = mkdtempSync(path.join(tmpdir(), 'bridge-prefix-'))
    const denied = path.join(base, 'x')
    const sibling = path.join(base, 'x-private')
    mkdirSync(denied)
    mkdirSync(sibling)

    const manager = slow({ deniedCwd: [denied] })
    const started = await manager.run({ agent: 'claude', prompt: 'x', cwd: sibling, timeoutMs: 0 })
    expect(started.status).toBe('running')
  })
})

describe('agent allow-list', () => {
  it('rejects an agent that is not enabled, naming it and the permitted set', async () => {
    const manager = slow({ allowedAgents: ['claude'] })
    const error = await manager
      .run({ agent: 'codex', prompt: 'x', timeoutMs: 0 })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(AgentRunRejectedError)
    const rejection = error as AgentRunRejectedError
    expect(rejection.code).toBe('agent-not-allowed')
    expect(rejection.message).toContain('codex')
    expect(rejection.message).toContain('claude')
    expect(rejection.value).toBe('codex')
    expect(rejection.allowed).toEqual(['claude'])
  })

  it('permits every identity when the allow-list is unset', async () => {
    const manager = slow()
    for (const agent of ['claude', 'codex', 'openclaw']) {
      await expect(manager.run({ agent, prompt: 'x', timeoutMs: 0 })).resolves.toBeDefined()
    }
  })

  it('rejects an unknown agent with the unknown-agent code, not the policy code', async () => {
    // Order matters: "no such identity" is a different, more useful message than
    // "not in your allow-list", so the registry check runs first.
    const manager = slow({ allowedAgents: ['claude'] })
    const error = await manager
      .run({ agent: 'nope', prompt: 'x', timeoutMs: 0 })
      .catch((err: unknown) => err)
    expect((error as AgentRunRejectedError).code).toBe('unknown-agent')
  })
})

describe('concurrency cap', () => {
  it('defaults to DEFAULT_MAX_CONCURRENT when unset', async () => {
    const manager = slow()
    // One fewer than the cap must all succeed.
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT; i += 1) {
      await expect(manager.run({ agent: 'claude', prompt: `run ${i}`, timeoutMs: 0 })).resolves.toBeDefined()
    }
    // The next one is over the cap and must fail immediately.
    await expect(manager.run({ agent: 'claude', prompt: 'over', timeoutMs: 0 })).rejects.toThrow(
      /already running/,
    )
  })

  it('rejects immediately with the count, the cap and a way out — it never queues', async () => {
    const manager = slow({ maxConcurrent: 2 })
    await manager.run({ agent: 'claude', prompt: 'one', timeoutMs: 0 })
    await manager.run({ agent: 'claude', prompt: 'two', timeoutMs: 0 })

    const startedAt = Date.now()
    const error = await manager
      .run({ agent: 'claude', prompt: 'three', timeoutMs: 0 })
      .catch((err: unknown) => err)
    const elapsed = Date.now() - startedAt

    expect(error).toBeInstanceOf(AgentRunRejectedError)
    const rejection = error as AgentRunRejectedError
    expect(rejection.code).toBe('max-concurrent')
    expect(rejection.running).toBe(2)
    expect(rejection.maxConcurrent).toBe(2)
    // The model is told how many are running, what the cap is, and its options.
    expect(rejection.message).toContain('2')
    expect(rejection.message).toMatch(/agents_status|agents_cancel|maxConcurrent/)

    // Synchronous refusal: a queueing implementation would block here (and then
    // blow the tool call's own timeout budget).
    expect(elapsed).toBeLessThan(500)
  })

  it('frees a slot once a session reaches a terminal state', async () => {
    const manager = slow({ maxConcurrent: 1 })
    const first = await manager.run({ agent: 'claude', prompt: 'one', timeoutMs: 0 })
    await expect(manager.run({ agent: 'claude', prompt: 'two', timeoutMs: 0 })).rejects.toThrow(
      /already running/,
    )

    await manager.cancel(first.sessionId, 'free the slot')
    // Wait for the terminal state; the cap counts live sessions, not history.
    for (let i = 0; i < 100 && !manager.status(first.sessionId)?.terminal; i += 1) {
      await sleep(25)
    }
    expect(manager.status(first.sessionId)?.terminal).toBe(true)
    await expect(manager.run({ agent: 'claude', prompt: 'three', timeoutMs: 0 })).resolves.toBeDefined()
  })

  it('clamps a nonsense cap to the default instead of rejecting everything', async () => {
    // 0 or NaN would otherwise make every run fail with a confusing message.
    const manager = slow({ maxConcurrent: 0 })
    await expect(manager.run({ agent: 'claude', prompt: 'x', timeoutMs: 0 })).resolves.toBeDefined()
  })
})
