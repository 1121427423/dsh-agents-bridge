/**
 * `createRunPolicy` / `checkCwd` in isolation.
 *
 * The cwd allow-list is security-relevant data: a configured root that cannot be
 * resolved must not silently disappear, because an allow-list that becomes empty
 * looks exactly like "no allow-list configured" — which is UNRESTRICTED. That
 * fail-open was MI-3.
 *
 * @module tests/kernel/policy
 */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { checkCwd, createRunPolicy } from '../../src/kernel/policy.ts'
import { AgentRunRejectedError } from '../../src/kernel/types.ts'

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('createRunPolicy: an unresolvable allowed root fails CLOSED (MI-3)', () => {
  it('throws instead of letting every cwd through', () => {
    const log = logger()
    const policy = createRunPolicy({ allowedCwd: ['/no/such/root/at/all'], logger: log })

    // The behavioral claim first: before the fix this returned '/' (fail OPEN).
    expect(() => checkCwd('/', policy)).toThrow(AgentRunRejectedError)
    expect(() => checkCwd('/tmp', policy)).toThrow(/outside every allowed path/)
    // And the reason is visible to the policy layer.
    expect(policy.allowedCwdConfigured).toBe(true)
  })

  it('logs which roots could not be resolved', () => {
    const log = logger()
    createRunPolicy({ allowedCwd: ['/no/such/root/at/all', mkdtempSync(path.join(tmpdir(), 'ok-'))], logger: log })
    // The dropped root is named, not silently discarded.
    expect(log.error).toHaveBeenCalled()
    expect(JSON.stringify(log.error.mock.calls)).toContain('/no/such/root/at/all')
  })

  it('still accepts a cwd under a resolvable root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bridge-policy-'))
    const inner = path.join(root, 'project')
    mkdirSync(inner)

    const policy = createRunPolicy({ allowedCwd: [root] })
    expect(checkCwd(inner, policy)).toBe(realpathSync(inner))
    expect(policy.allowedCwdConfigured).toBe(true)
  })

  it('treats an UNSET allowedCwd as unrestricted (the documented default)', () => {
    const policy = createRunPolicy({})
    expect(policy.allowedCwdConfigured).toBe(false)
    expect(policy.allowedCwd).toEqual([])
    // Backward compatible: omitting the list must not start rejecting runs.
    expect(checkCwd('/', policy)).toBe('/')
    expect(checkCwd(tmpdir(), policy)).toBe(realpathSync(tmpdir()))
  })

  it('treats an empty allowedCwd array as unset, not as deny-all', () => {
    const policy = createRunPolicy({ allowedCwd: [] })
    expect(policy.allowedCwdConfigured).toBe(false)
    expect(checkCwd('/', policy)).toBe('/')
  })
})
