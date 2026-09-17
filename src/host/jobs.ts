/**
 * Session completion notices — the DSH background-job seam (`ctx.jobs`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `agents_run` returns as soon as the child is spawned, and the model then has
 * to POLL: `agents_wait` blocks, `agents_status` asks. A delegation that takes
 * four minutes is invisible until the caller comes back to look for it, which
 * is exactly the difference between this bridge and a subagent — a subagent
 * opens a model turn when it finishes.
 *
 * DSH already owns that machinery: the background-job registry
 * (`@deepseek-ai/dsh-jobs`) is what delivers the "job N finished" notice for a
 * background bash command, and its contract says so —
 *
 *   > Settlement is first-wins: one terminal record, released waiters, and one
 *   > round of contained listener notification … Completion is announced last,
 *   > after the record is committed and every other observer of the settlement
 *   > has seen it, **because a reporter may open a model turn synchronously**.
 *
 * So this module does not invent a notification. It registers each started
 * session as ONE job owned by the calling agent, and lets the host announce the
 * settlement in the caller's own session.
 *
 * WHY A STRUCTURAL FACE
 * ---------------------
 * `inject` must NOT list `jobs`: cordis marks a plugin INACTIVE while an
 * inject-listed service is unmounted, so declaring an optional service costs
 * the nine tools on every host that lacks it (this plugin already learned that
 * with `webServer` and `commands` — design doc D16). The service is reached
 * through scope injection instead, and read through a structural subset
 * (`JobsFace`) exactly like `WebServerFace`, so the plugin keeps NO build-time
 * dependency on a second DSH package.
 *
 * FAILURE POSTURE
 * ---------------
 * A job registration is an OPTIMISATION, never a precondition: if the registry
 * is absent, refuses the job, or throws, `agents_run` must still start the run
 * and return its sessionId. Every call here is therefore wrapped, and a failure
 * is logged once and dropped.
 *
 * @module dsh-agents-bridge/host/jobs
 */

import type { BridgeLogger, SessionSnapshot } from '../kernel/types.ts'

/**
 * Producer kind registered with the host. Also the job id prefix (`agents-N`).
 *
 * Job ids live in their own namespace, so this cannot collide with the bridge's
 * `sess_…` session ids; the two are deliberately shown together in the tool
 * result so a model never has to guess which id belongs to which tool.
 */
export const JOB_KIND = 'agents'

/** Bound on one completion notice, in UTF-8 bytes (the host truncates to it). */
export const JOB_OUTPUT_LIMIT_BYTES = 4_096

/** Longest delegation label rendered into the notice. */
const MAX_LABEL_CHARS = 120

/** How much of the final message is quoted into the notice. */
const MAX_TAIL_CHARS = 400

/** Terminal job statuses, as `@deepseek-ai/dsh-jobs` names them. */
export type JobStatus = 'completed' | 'killed' | 'failed'

/** What a producer hands back through {@link JobHooksFace.done}. */
export interface JobOutcomeFace {
  readonly status: JobStatus
  readonly output?: string
}

/** Hooks the job runtime controls a producer through (structural subset). */
export interface JobHooksFace {
  /** Must be synchronous, idempotent, and eventually settle `done`. */
  cancel(reason?: string): void
  /** Resolves after the producer RELEASES ITS RESOURCES, not merely at end of work. */
  done: Promise<JobOutcomeFace>
}

/** One job start request (structural subset of `JobStart`). */
export interface JobStartFace {
  readonly kind: string
  readonly label: string
  readonly owner?: unknown
  readonly outputLimitBytes?: number
  readonly run: () => JobHooksFace
}

/**
 * The `ctx.jobs` face this module uses. Deliberately structural: the plugin
 * must typecheck without the jobs package's types on its dependency list.
 */
export interface JobsFace {
  start(spec: JobStartFace): string
  attachController(name: string): () => void
}

/** Everything the registrar needs to place ONE bridge session under the runtime. */
export interface SessionJobInput {
  /** Bridge session id (`sess_…`) — what `agents_output` takes. */
  readonly sessionId: string
  /** Agent identity, for the label and the notice. */
  readonly agentId: string
  /** The delegation itself, one-lined and bounded, for the notice. */
  readonly label: string
  /**
   * The calling agent, from `ToolExecution.agent`. `undefined` means the call
   * has no agent behind it (a direct dispatch, a test); see {@link register}.
   */
  readonly owner: unknown
  /** Resolve when the session reaches a terminal state. Never rejects. */
  readonly waitTerminal: () => Promise<SessionSnapshot | undefined>
  /** Ask the bridge to stop the session. Called at most once by the runtime. */
  readonly cancel: (reason: string) => void
  /** Short tail of the transcript for the notice; bounded by the caller. */
  readonly tail: () => string | undefined
}

/** The seam the tool layer holds and the jobs scope fills in. */
export interface JobSeat {
  registrar?: JobRegistrar
}

/** A live registration seam. */
export interface JobRegistrar {
  /** Register a started session; returns the job id, or `undefined` if refused. */
  register(input: SessionJobInput): string | undefined
  /** Release the controller. Idempotent. */
  dispose(): void
}

/** Collapse to one line and bound the length, so a label stays a label. */
function oneLine(raw: string, max: number): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** The status vocabulary of the job registry, from the bridge's own. */
function jobStatusOf(snapshot: SessionSnapshot | undefined): JobStatus {
  switch (snapshot?.status) {
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'killed'
    default:
      // `failed`, `timeout`, and "no snapshot at all" are all a job that did not
      // succeed. Reporting `completed` for a vanished session would be a lie the
      // model acts on.
      return 'failed'
  }
}

/** Human-readable duration for the notice. */
function durationText(snapshot: SessionSnapshot): string {
  const ended = snapshot.endedAt ?? Date.now()
  const ms = Math.max(0, ended - snapshot.startedAt)
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`
}

/**
 * The notice body: what finished, how it ended, and how to read it.
 *
 * Kept to a few lines on purpose. The transcript itself is NOT copied here —
 * `agents_output` already serves it incrementally, and a notice that dumped a
 * long transcript would burn the caller's context on every completion.
 */
function noticeText(input: SessionJobInput, snapshot: SessionSnapshot | undefined): string {
  const lines: string[] = []
  if (snapshot === undefined) {
    lines.push(`agents session ${input.sessionId} (${input.agentId}) is no longer known to the bridge`)
  } else {
    const exit = snapshot.result?.exitCode === null || snapshot.result?.exitCode === undefined
      ? ''
      : `, exit ${snapshot.result.exitCode}`
    lines.push(
      `agents session ${input.sessionId} (${input.agentId}) ${snapshot.status} after ${durationText(snapshot)}${exit}`,
    )
  }
  const tail = input.tail()
  if (tail !== undefined && tail !== '') lines.push('', oneLine(tail, MAX_TAIL_CHARS))
  lines.push(
    '',
    `Read it with agents_output { "sessionId": "${input.sessionId}", "sinceIndex": 0 }`
    + ' (keep the returned nextIndex and pass it back for later reads).',
  )
  return lines.join('\n')
}

/**
 * Build the registration seam over a live job registry.
 *
 * `attachController` is called HERE, once per registration lifetime: the job
 * runtime refuses `start()` while no attached controller serves the owner, and
 * this controller is registered from the plugin's own (unscoped) context, which
 * the contract defines as serving every owner.
 *
 * @param jobs - the host's job registry.
 * @param logger - plugin logger; the seam logs its first registration and every
 *   refusal, because "why did I never get a notice" is otherwise unanswerable.
 * @returns the seam plus its disposer.
 */
export function createJobRegistrar(jobs: JobsFace, logger: BridgeLogger): JobRegistrar {
  let disposeController: (() => void) | undefined
  try {
    disposeController = jobs.attachController('agents-bridge')
  } catch (err) {
    // No controller ⇒ every `start` would be refused; report once and stay a
    // no-op rather than turning a missing notice into a broken tool call.
    logger.warn('job controller could not be attached; session completion notices are off', {
      error: String(err),
    })
  }
  let announced = false
  let disposed = false

  return {
    register(input) {
      if (disposeController === undefined || disposed) return undefined
      // An UNOWNED job has no session to announce into, and would show up in
      // every caller's job list. Skip instead of creating that noise.
      if (input.owner === undefined) return undefined
      try {
        const jobId = jobs.start({
          kind: JOB_KIND,
          label: oneLine(`${input.agentId}: ${input.label}`, MAX_LABEL_CHARS),
          owner: input.owner,
          outputLimitBytes: JOB_OUTPUT_LIMIT_BYTES,
          run: () => {
            let cancelled = false
            return {
              cancel(reason) {
                // Synchronous and idempotent by contract: the runtime may call
                // this from teardown, where a second cancel must not throw or
                // start a second stop.
                if (cancelled) return
                cancelled = true
                try {
                  input.cancel(reason === undefined || reason === '' ? 'cancelled via the job registry' : reason)
                } catch (err) {
                  logger.warn('job cancellation threw; the session keeps running', {
                    sessionId: input.sessionId,
                    error: String(err),
                  })
                }
              },
              done: input.waitTerminal().then(
                snapshot => ({ status: jobStatusOf(snapshot), output: noticeText(input, snapshot) }),
                err => ({
                  status: 'failed' as const,
                  output: noticeText(input, undefined) + `\n\n(wait failed: ${String(err)})`,
                }),
              ),
            }
          },
        })
        if (!announced) {
          announced = true
          logger.info('session completion notices are on', { kind: JOB_KIND, firstJobId: jobId })
        }
        return jobId
      } catch (err) {
        logger.warn('session could not be registered as a job; this run gets no completion notice', {
          sessionId: input.sessionId,
          error: String(err),
        })
        return undefined
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        disposeController?.()
      } catch (err) {
        logger.warn('job controller disposer threw', { error: String(err) })
      }
      disposeController = undefined
    },
  }
}
