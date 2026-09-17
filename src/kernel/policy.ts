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

import { AgentRunRejectedError, type BridgeLogger } from './types.ts'

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
  /**
   * True when the host CONFIGURED an `allowedCwd` list, even if every entry was
   * unusable and `allowedCwd` ended up empty.
   *
   * This is the difference between "unset = unrestricted" (the documented
   * default) and "configured but nothing resolved" — the latter must FAIL
   * CLOSED, because an allow-list that silently becomes empty would let every
   * cwd through (the fail-open MI-3 fixed).
   */
  readonly allowedCwdConfigured: boolean
}

interface NormalizedRoots {
  readonly roots: readonly string[]
  /** True when the caller actually supplied a non-empty list. */
  readonly configured: boolean
  /** Configured entries that could not be `realpath`-resolved. */
  readonly unresolved: readonly string[]
}

/**
 * Resolve configured directory roots for prefix comparison.
 *
 * A root that cannot be `realpath`-resolved is KEPT in its lexical
 * (`path.resolve`) form rather than silently dropped: dropping it would make an
 * allow-list narrower than the operator wrote (and, when it was the only root,
 * empty = unrestricted = fail OPEN). Keeping it lexical still lets it match the
 * path the child would really be spawned with, while the unresolved entry is
 * reported to the caller so a shared config naming another machine's paths is
 * visible instead of silent.
 */
function normalizeRoots(
  roots: readonly string[] | undefined,
  label: string,
  logger: BridgeLogger | undefined,
): NormalizedRoots {
  const configured = roots !== undefined && roots.length > 0
  if (!configured) return { roots: [], configured: false, unresolved: [] }
  const out: string[] = []
  const unresolved: string[] = []
  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const trimmed = raw.trim()
    const resolved = resolveExisting(trimmed)
    if (resolved !== undefined) {
      if (!out.includes(resolved)) out.push(resolved)
      continue
    }
    const lexical = path.resolve(trimmed)
    if (!unresolved.includes(lexical)) unresolved.push(lexical)
    if (!out.includes(lexical)) out.push(lexical)
  }
  if (unresolved.length > 0) {
    logger?.error(`${label} root(s) do not exist on this host; kept in lexical form`, {
      [label]: unresolved,
    })
  }
  return { roots: out, configured: true, unresolved }
}

/**
 * `realpath` that never throws.
 *
 * Called only for a path that is about to be COMPARED, never for the value the
 * child is spawned with — so a missing root is a policy-data problem (reported
 * by {@link normalizeRoots}), not a run failure.
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
  /** Reports configured roots that could not be resolved (MI-3). */
  readonly logger?: BridgeLogger
}): RunPolicy {
  const rawMax = options.maxConcurrent
  const maxConcurrent =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.floor(rawMax)
      : DEFAULT_MAX_CONCURRENT

  const allowed = normalizeRoots(options.allowedCwd, 'allowedCwd', options.logger)
  const denied = normalizeRoots(options.deniedCwd, 'deniedCwd', options.logger)

  return Object.freeze({
    allowedCwd: allowed.roots,
    deniedCwd: denied.roots,
    allowedAgents: (options.allowedAgents ?? []).filter(
      (id): id is string => typeof id === 'string' && id.trim() !== '',
    ),
    maxConcurrent,
    allowedCwdConfigured: allowed.configured,
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

  // `allowedCwdConfigured` matters even when the ROOTS came out empty: a
  // configured allow-list whose entries were all unusable must deny, not become
  // "unrestricted". Only a genuinely-unset list (the documented default) lets
  // every cwd through.
  const allowListApplies = policy.allowedCwd.length > 0 || policy.allowedCwdConfigured
  if (allowListApplies && !policy.allowedCwd.some((root) => isUnder(resolved, root))) {
    const allowedText =
      policy.allowedCwd.length > 0
        ? policy.allowedCwd.join(', ')
        : '(configured, but no root could be resolved on this host)'
    throw new AgentRunRejectedError(
      'cwd-not-allowed',
      `cwd "${requested}" resolves to "${resolved}", which is outside every allowed path. ` +
        `Allowed: ${allowedText}.`,
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
