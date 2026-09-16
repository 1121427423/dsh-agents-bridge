/**
 * dsh-agents-bridge / desktop track — loopback port fingerprinting (P3).
 *
 * A desktop engine sometimes exposes a local endpoint (the OpenClaw gateway
 * that AutoClaw bundles is the live example: it serves an HTTP API on a
 * loopback port). When it does, "is this identity usable?" has a second,
 * stronger answer available than "the file exists": *the engine is running and
 * answering*.
 *
 * Three rules make that safe to do from a probe, which is called from a
 * model-facing tool and must stay cheap and silent:
 *
 *  1. LOOPBACK ONLY. `127.0.0.1` and `::1`, never a hostname that could resolve
 *     elsewhere, never a LAN or public address. `resolveLoopbackHost` refuses
 *     anything else, so "scan the network" is not a thing this module can be
 *     made to do even by a bad caller.
 *
 *  2. A TIGHT DEADLINE. The connect budget is 300 ms by default and the whole
 *     sweep has its own wall-clock budget. A CLOSED LOOPBACK PORT REFUSES
 *     IMMEDIATELY on macOS (ECONNREFUSED, sub-millisecond), so a healthy sweep
 *     of a few ports costs well under a millisecond — the timeout only matters
 *     for a port that is filtered or wedged, and then it is bounded.
 *
 *  3. FAILURE IS SILENT DEGRADATION. A refused connection, a timeout, a reset,
 *     a socket error — every one of them is reported as "not listening", never
 *     thrown, never logged as an error. A probe must not be noisier because
 *     something is not running.
 *
 * ── THE `available` RULE ───────────────────────────────────────────────────
 *
 * A port fingerprint can only ever CONFIRM, never deny:
 *
 *   | expected port answers with the expected signature | `confirmed`  |
 *   | expected port answers, but the signature differs  | `unexpected` |
 *   | nothing is listening                              | `absent`     |
 *
 * `absent` and `unexpected` both mean "not confirmed", and NOTHING here may
 * change `ProbeResult.available`. `available` answers exactly one question —
 * "can this identity be launched?" — and a gateway that is merely not running
 * yet is still launchable. So a fingerprint is reported as "suspected" in
 * `notes` and is never allowed to promote or demote an identity's availability.
 *
 * @module dsh-agents-bridge/tracks/desktop/port-probe
 */

import net from 'node:net'

/* ------------------------------------------------------------- constants */

/** Connect budget for one port. Short on purpose: loopback refuses instantly. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 300
/** Wall-clock budget for a whole sweep, so `N` ports cannot add up unbounded. */
export const DEFAULT_SWEEP_BUDGET_MS = 1_200
/** Concurrent connects, so a large port list cannot open sockets in a burst. */
export const DEFAULT_CONCURRENCY = 4
/** Bytes of a response read to match a signature. Never a whole body. */
const MAX_RESPONSE_BYTES = 4_096

/** The only two hosts this module will ever connect to. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1']

/* ---------------------------------------------------------------- shapes */

/** One endpoint worth checking for an identity. */
export interface PortExpectation {
  /** Agent id this endpoint would confirm. */
  readonly agentId: string
  /**
   * Loopback host: `127.0.0.1` (default) or `::1`. Anything else is refused
   * and reported `unchecked` — see `resolveLoopbackHost`.
   */
  readonly host?: string
  /** TCP port on loopback. */
  readonly port: number
  /** When set, sent immediately after connect (an HTTP request line, say). */
  readonly request?: string
  /**
   * A pattern the response must match for the fingerprint to be CONFIRMED.
   * Without one, "something is listening" is the whole claim.
   */
  readonly signature?: RegExp
  /** Short label for the note line, e.g. `openclaw gateway`. */
  readonly label: string
}

export type PortVerdict =
  /** The port answered AND the response matched the expected signature. */
  | 'confirmed'
  /** The port answered but the response did not look like the expected engine. */
  | 'unexpected'
  /** Nothing was listening (refused, timed out, or unreachable). */
  | 'absent'
  /** Not checked: the budget ran out or the caller asked for no probing. */
  | 'unchecked'

export interface PortFinding {
  readonly agentId: string
  readonly host: string
  readonly port: number
  readonly label: string
  readonly verdict: PortVerdict
  /** One line of evidence. Present for every verdict except `unchecked`. */
  readonly detail?: string
}

export interface PortProbeResult {
  readonly findings: readonly PortFinding[]
  readonly elapsedMs: number
  /** True when the sweep budget ran out before every expectation was checked. */
  readonly budgetExhausted: boolean
}

/** Injectable connection seam — the tests never open a socket. */
export interface ConnectInput {
  readonly host: string
  readonly port: number
  readonly timeoutMs: number
  /** Sent after connect, when the expectation carries one. */
  readonly request?: string
  /** Close as soon as this much has been received (bounded read). */
  readonly maxBytes: number
}

/**
 * Resolve to the bytes the endpoint sent (possibly empty), or `undefined` when
 * nothing answered. Implementations must never reject on a refused connection.
 */
export type Connector = (input: ConnectInput) => Promise<string | undefined>

export interface PortProbeOptions {
  readonly expectations: readonly PortExpectation[]
  readonly connect?: Connector
  readonly now?: () => number
  /**
   * Epoch ms the sweep budget is measured from. Defaults to `Date.now()`; a test
   * that injects `now` should pin this too, otherwise the deadline would follow
   * the injected clock and could never expire.
   */
  readonly startedAt?: number
  readonly connectTimeoutMs?: number
  readonly budgetMs?: number
  readonly concurrency?: number
}

/* -------------------------------------------------------------- host rule */

/**
 * Accept a host only when it is loopback, returning the exact string to use.
 *
 * Anything else returns `undefined` — a misconfigured expectation is DROPPED
 * with an `unchecked` finding, not silently redirected to a different address.
 */
export function resolveLoopbackHost(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '127.0.0.1' || value === '::1') return value
  // `localhost` is deliberately NOT accepted: it resolves through the host's
  // resolver and `/etc/hosts`, which is exactly the indirection this module
  // exists to avoid.
  return undefined
}

/* ---------------------------------------------------------- the connector */

/**
 * The real connector: `net.connect` to loopback with a hard deadline.
 *
 * Resolves `''` (connected, nothing said), the received text (connected and
 * answered), or `undefined` (did not connect). It never rejects and it always
 * destroys the socket, so a probe cannot leak a descriptor.
 */
export const defaultConnector: Connector = ({ host, port, timeoutMs, request, maxBytes }) =>
  new Promise<string | undefined>((resolve) => {
    let settled = false
    let socket: net.Socket | undefined
    let timer: NodeJS.Timeout | undefined

    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (socket !== undefined) {
        // `destroy` rather than `end`: the peer may be mid-write and waiting on
        // us, and a half-closed socket would keep the event loop alive.
        socket.removeAllListeners()
        try {
          socket.destroy()
        } catch {
          /* already gone */
        }
      }
      resolve(value)
    }

    try {
      socket = net.connect({ host, port, family: host === '::1' ? 6 : 4 })
    } catch {
      finish(undefined)
      return
    }

    let received = ''
    socket.setNoDelay(true)
    socket.on('connect', () => {
      if (request !== undefined && request !== '') {
        try {
          socket?.write(request)
        } catch {
          finish(undefined)
        }
      }
    })
    socket.on('data', (chunk: Buffer) => {
      if (received.length < maxBytes) received += chunk.toString('utf8')
      // An endpoint that says nothing and does not close is still evidence of
      // *something* listening; the timeout below settles that case.
    })
    socket.on('end', () => finish(received))
    socket.on('close', () => finish(received))
    // A refused port lands here (ECONNREFUSED) and is reported as "absent".
    socket.on('error', () => finish(undefined))
    // `timeout` is set after connect too: an accepted socket that then stalls
    // must not hold the sweep open.
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => finish(received))

    timer = setTimeout(() => finish(received), timeoutMs)
  })

/* ------------------------------------------------------------- the sweep */

function matches(finding: { readonly response: string }, signature: RegExp | undefined): boolean {
  if (signature === undefined) return true
  return signature.test(finding.response)
}

/** One expectation, checked and turned into a finding. Never throws. */
async function probeOne(
  expectation: PortExpectation,
  connector: Connector,
  host: string,
  timeoutMs: number,
): Promise<PortFinding> {
  const base = { agentId: expectation.agentId, host, port: expectation.port, label: expectation.label }
  let response: string | undefined
  try {
    response = await connector({
      host,
      port: expectation.port,
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      ...(expectation.request !== undefined ? { request: expectation.request } : {}),
    })
  } catch {
    // A connector that throws is a connector that found nothing. The probe's
    // contract ("silent degradation") outranks any implementation's error.
    response = undefined
  }
  if (response === undefined) {
    return { ...base, verdict: 'absent', detail: `${expectation.label}: nothing listening on ${host}:${expectation.port}` }
  }
  if (matches({ response }, expectation.signature)) {
    const evidence = expectation.signature !== undefined ? ' (response matched the expected signature)' : ''
    return { ...base, verdict: 'confirmed', detail: `${expectation.label}: ${host}:${expectation.port} is listening${evidence}` }
  }
  return {
    ...base,
    verdict: 'unexpected',
    detail: `${expectation.label}: ${host}:${expectation.port} is listening but did not answer like ${expectation.label}`,
  }
}

/**
 * Check a list of loopback expectations, bounded in concurrency and wall clock.
 *
 * Never rejects. Expectations on a non-loopback host are reported `unchecked`
 * rather than connected to.
 */
export async function probePorts(options: PortProbeOptions): Promise<PortProbeResult> {
  const now = options.now ?? (() => Date.now())
  // Fixed origin, for the same reason as the scanner: a budget measured from a
  // fresh `now()` reading could never expire under an injected clock.
  const startedAt = options.startedAt ?? Date.now()
  const deadline = startedAt + (options.budgetMs ?? DEFAULT_SWEEP_BUDGET_MS)
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const connector = options.connect ?? defaultConnector
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)

  const findings: PortFinding[] = []
  /** Expectations that are worth connecting to, each tagged with its position. */
  const queue: { readonly expectation: PortExpectation; readonly order: number }[] = []

  for (const [index, expectation] of options.expectations.entries()) {
    const host = resolveLoopbackHost(expectation.host ?? '127.0.0.1')
    if (host === undefined) {
      findings.push({
        agentId: expectation.agentId,
        host: String(expectation.host),
        port: expectation.port,
        label: expectation.label,
        verdict: 'unchecked',
        detail: `${expectation.label}: refused to probe a non-loopback host (only ${LOOPBACK_HOSTS.join(' / ')} is allowed)`,
      })
      continue
    }
    queue.push({ expectation, order: index })
  }

  let cursor = 0
  let budgetExhausted = false
  /** Findings produced by the workers, tagged with the caller's order. */
  const produced: { readonly finding: PortFinding; readonly order: number }[] = []

  async function worker(): Promise<void> {
    for (;;) {
      if (now() > deadline) {
        budgetExhausted = true
        return
      }
      const item = queue[cursor]
      cursor += 1
      if (item === undefined) return
      const host = resolveLoopbackHost(item.expectation.host ?? '127.0.0.1') ?? '127.0.0.1'
      // The per-connect deadline is additionally clamped by the sweep budget,
      // so the LAST connect cannot outlive the sweep's own wall clock.
      const remaining = Math.max(1, Math.min(connectTimeoutMs, deadline - now()))
      produced.push({ finding: await probeOne(item.expectation, connector, host, remaining), order: item.order })
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, Math.max(1, queue.length)); i += 1) workers.push(worker())
  await Promise.all(workers)

  // Findings are reported in the caller's declared order regardless of the
  // order the workers completed in, so probe output is deterministic.
  for (const { finding, order } of produced.sort((a, b) => a.order - b.order)) {
    findings.splice(findInsertionIndex(findings, options.expectations, order), 0, finding)
  }

  return { findings, elapsedMs: Math.max(0, now() - startedAt), budgetExhausted }
}

/** Index in `findings` at which an expectation of `order` belongs. */
function findInsertionIndex(
  findings: readonly PortFinding[],
  expectations: readonly PortExpectation[],
  order: number,
): number {
  const later = new Set(
    expectations.slice(order + 1).map((expectation) => `${expectation.agentId}\u0000${expectation.port}`),
  )
  const index = findings.findIndex((finding) => later.has(`${finding.agentId}\u0000${finding.port}`))
  return index === -1 ? findings.length : index
}

/* -------------------------------------------------------------- reporting */

/**
 * One line for `ProbeResult.notes`, or `undefined` when there is nothing worth
 * saying.
 *
 * Only `confirmed` and `unexpected` produce a note: an `absent` port is the
 * normal state of a desktop app that is simply not running, and reporting it
 * would add noise to every probe of every host.
 *
 * The wording is deliberate. A fingerprint is reported as **suspected** unless
 * it was confirmed, and a confirmed one says outright that it did not influence
 * `available` — because it must not.
 */
export function portNote(findings: readonly PortFinding[]): string | undefined {
  const relevant = findings.filter((finding) => finding.verdict === 'confirmed' || finding.verdict === 'unexpected')
  if (relevant.length === 0) return undefined
  const parts = relevant.map((finding) => {
    const confidence = finding.verdict === 'confirmed' ? 'confirmed' : 'suspected'
    return `${finding.label} ${confidence} running (${finding.detail ?? `${finding.host}:${finding.port}`})`
  })
  return `[port] ${parts.join('; ')}. This fingerprint is corroboration only: availability is decided by whether the engine can be launched, not by whether it is currently listening.`
}

/** True when any finding was confirmed. Never used to change `available`. */
export function hasConfirmed(findings: readonly PortFinding[]): boolean {
  return findings.some((finding) => finding.verdict === 'confirmed')
}

/**
 * Expectations for the desktop identities the bridge knows ship a gateway.
 *
 * Deliberately EMPTY by default. No port is asserted for AutoClaw/OpenClaw
 * because none is verified on this host (the gateway is not listening here),
 * and guessing one would put a fabricated fact into probe output. It is
 * exported as the single place to add a verified fingerprint, and it is a
 * function so a caller can supply its own table.
 */
export function defaultPortExpectations(): readonly PortExpectation[] {
  return []
}
