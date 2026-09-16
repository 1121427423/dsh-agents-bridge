/**
 * Pre-flight policy for `run()`: who may run, where, and how many at once.
 *
 * Everything here is SYNCHRONOUS on purpose. `agents_run.execute()` must return
 * a `running` snapshot without awaiting anything (design doc D5) — a policy
 * check that awaited a `realpath` or a semaphore would put a filesystem round
 * trip (or worse, a queue wait) inside the tool call's own timeout budget.
 *
 * The comparison is done on `realpath`-resolved paths, not on the strings the
 * model passed. On macOS `/tmp` is a symlink to `/private/tmp`, so a naive
 * prefix check on the raw string lets `cwd: /tmp/x` through an
 * `allowedCwd: ["/private/var"]` style rule and vice versa. Resolving first
 * makes the comparison mean what the config author intended.
 *
 * Scope note (docs/design.md §10.4): this is "stop the model from pointing cwd
 * at `/` by accident", not a sandbox. An agent with file-write tools can still
 * reach outside its cwd; only the OS-level sandbox/approval layer stops that.
 *
 * @module dsh-agents-bridge/kernel/policy
 */

import { realpathSync } from 'node:fs'
import path from 'node:path'

import { AgentRunRejectedError } from './types.ts'

/**
 * Default concurrent-session cap.
 *
 * Why 4: an agent run is not one process, it is a tree (the CLI plus its MCP
 * servers and tool subprocesses), each holding a model connection. Four is the
 * most a person can supervise and still notice one that has gone wrong, and it
 * is large enough that a normal "ask two engines the same question" workflow is
 * unaffected. It is deliberately a *small* number because the failure mode of a
 * too-large cap (a machine thrashing under N agent trees) is far worse than the
 * failure mode of a too-small one (an immediate, readable "try again later").
 */
export const DEFAULT_MAX_CONCURRENT = 4

/** Resolved policy, built once from `ManagerOptions` at manager construction. */
export interface RunPolicy {
  readonly allowedCwd: readonly string[]
  readonly deniedCwd: readonly string[]
  readonly allowedAgents: readonly string[]
  readonly maxConcurrent: number
}

/** Directory prefixes are compared after `realpath`, so `/` is normalized too. */
function normalizeRoots(roots: readonly string[] | undefined): string[] {
  if (roots === undefined || roots.length === 0) return []
  const out: string[] = []
  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const resolved = resolveExisting(raw.trim())
    if (resolved !== undefined && !out.includes(resolved)) out.push(resolved)
  }
  return out
}

/**
 * `realpath` that never throws.
 *
 * A configured root that does not exist on this host is skipped rather than
 * making every run fail: the config may be shared across machines (the README
 * ships `/Users/king/...`), and a missing *allowed* root is a configuration
 * mistake worth surfacing through the rejection message, not a crash.
 */
function resolveExisting(target: string): string | undefined {
  try {
    return realpathSync(target)
  } catch {
    return undefined
  }
}

export function createRunPolicy(options: {
  readonly allowedCwd?: readonly string[]
  readonly deniedCwd?: readonly string[]
  readonly allowedAgents?: readonly string[]
  readonly maxConcurrent?: number
}): RunPolicy {
  const rawMax = options.maxConcurrent
  const maxConcurrent =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.floor(rawMax)
      : DEFAULT_MAX_CONCURRENT

  return Object.freeze({
    allowedCwd: normalizeRoots(options.allowedCwd),
    deniedCwd: normalizeRoots(options.deniedCwd),
    allowedAgents: (options.allowedAgents ?? []).filter(
      (id): id is string => typeof id === 'string' && id.trim() !== '',
    ),
    maxConcurrent,
  })
}

/** True when `target` IS `root` or lives under it (both already resolved). */
function isUnder(target: string, root: string): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * Resolve a run's cwd and check it against the policy.
 *
 * Returns the RESOLVED path — the caller should spawn with that, so the cwd
 * check and the actual process cwd cannot disagree.
 *
 * @throws AgentRunRejectedError when the value is denied, outside every allowed
 *   root, or cannot be resolved at all.
 */
export function checkCwd(cwd: string | undefined, policy: RunPolicy): string | undefined {
  if (cwd === undefined || cwd.trim() === '') return undefined

  const requested = cwd.trim()
  const resolved = resolveExisting(requested)
  if (resolved === undefined) {
    // A cwd that does not exist is not a policy question, but reporting it here
    // is strictly better than the ENOENT the child would produce later: the
    // model gets told which value was wrong while it still has the context.
    throw new AgentRunRejectedError(
      'cwd-unresolvable',
      `cwd "${requested}" does not exist or cannot be resolved; ` +
        'pass an absolute path to an existing directory',
      { value: requested },
    )
  }

  const denied = policy.deniedCwd.find((root) => isUnder(resolved, root))
  if (denied !== undefined) {
    throw new AgentRunRejectedError(
      'cwd-denied',
      `cwd "${requested}" resolves to "${resolved}", which is under the denied path "${denied}". ` +
        'Pick a working directory inside the project instead.',
      { value: requested, allowed: policy.deniedCwd },
    )
  }

  if (policy.allowedCwd.length > 0 && !policy.allowedCwd.some((root) => isUnder(resolved, root))) {
    throw new AgentRunRejectedError(
      'cwd-not-allowed',
      `cwd "${requested}" resolves to "${resolved}", which is outside every allowed path. ` +
        `Allowed: ${policy.allowedCwd.join(', ')}.`,
      { value: requested, allowed: policy.allowedCwd },
    )
  }

  return resolved
}

/**
 * Check the agent id against the allow-list.
 *
 * @throws AgentRunRejectedError naming the id and the permitted set.
 */
export function checkAgent(agentId: string, policy: RunPolicy): void {
  if (policy.allowedAgents.length === 0) return
  if (policy.allowedAgents.includes(agentId)) return
  throw new AgentRunRejectedError(
    'agent-not-allowed',
    `agent "${agentId}" is not enabled for this bridge. Allowed: ${policy.allowedAgents.join(', ')}. ` +
      'Run agents_probe to see the identities that are available.',
    { value: agentId, allowed: policy.allowedAgents },
  )
}

/**
 * Check the concurrent-session cap.
 *
 * Never waits. A run that would exceed the cap is refused immediately with the
 * current count and the cap, because blocking would burn the caller's tool
 * budget and then fail anyway once that budget expired.
 *
 * @throws AgentRunRejectedError with the running count and the cap.
 */
export function checkConcurrency(running: number, policy: RunPolicy): void {
  if (running < policy.maxConcurrent) return
  throw new AgentRunRejectedError(
    'max-concurrent',
    `cannot start a new run: ${running} session(s) are already running and the limit is ` +
      `${policy.maxConcurrent}. Wait for one to finish (agents_status), cancel one you no longer ` +
      'need (agents_cancel), or raise maxConcurrent in the agents-bridge config.',
    { maxConcurrent: policy.maxConcurrent, running },
  )
}
