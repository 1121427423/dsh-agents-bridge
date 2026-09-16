/**
 * Loopback port fingerprint tests (P3).
 *
 * No test here opens a socket: every one injects a `connect` implementation, so
 * the suite is hermetic and instant. The one host-touching assertion (that a
 * CLOSED loopback port really is refused immediately, which is the assumption
 * the whole design rests on) is host-guarded at the bottom.
 *
 * The load-bearing property under test is the NEGATIVE one: a failed or
 * unexpected fingerprint may never change what a probe reports as `available`.
 */

import net from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  LOOPBACK_HOSTS,
  defaultPortExpectations,
  hasConfirmed,
  portNote,
  probePorts,
  resolveLoopbackHost,
  type ConnectInput,
  type Connector,
  type PortExpectation,
  type PortFinding,
} from '../../src/tracks/desktop/port-probe.ts'

/** A connector that answers exactly what the test tells it to, per port. */
function fakeConnector(answers: Record<number, string | undefined>): Connector {
  return async ({ port }: ConnectInput) => answers[port]
}

/** A connector that records every call, so "did it even try" is assertable. */
function recordingConnector(answers: Record<number, string | undefined>, seen: ConnectInput[]): Connector {
  return async (input: ConnectInput) => {
    seen.push(input)
    return answers[input.port]
  }
}

const GATEWAY: PortExpectation = {
  agentId: 'autoclaw',
  port: 18789,
  label: 'openclaw gateway',
  request: 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
  signature: /openclaw/i,
}

describe('resolveLoopbackHost', () => {
  it('accepts only 127.0.0.1 and ::1', () => {
    expect(resolveLoopbackHost('127.0.0.1')).toBe('127.0.0.1')
    expect(resolveLoopbackHost('::1')).toBe('::1')
    expect(resolveLoopbackHost(' 127.0.0.1 ')).toBe('127.0.0.1')
    // `localhost` goes through a resolver and /etc/hosts, which is the
    // indirection this module exists to avoid.
    expect(resolveLoopbackHost('localhost')).toBeUndefined()
    expect(resolveLoopbackHost('0.0.0.0')).toBeUndefined()
    expect(resolveLoopbackHost('192.168.1.10')).toBeUndefined()
    expect(resolveLoopbackHost('example.com')).toBeUndefined()
    expect(resolveLoopbackHost('::')).toBeUndefined()
    expect(resolveLoopbackHost('')).toBeUndefined()
    expect(LOOPBACK_HOSTS).toEqual(['127.0.0.1', '::1'])
  })
})

describe('probePorts', () => {
  it('confirms a fingerprint only when BOTH the port and the signature match', async () => {
    const sweep = await probePorts({
      expectations: [GATEWAY],
      connect: fakeConnector({ 18789: 'HTTP/1.1 200 OK\r\n\r\n{"service":"openclaw"}' }),
    })
    expect(sweep.findings).toHaveLength(1)
    expect(sweep.findings[0]?.verdict).toBe('confirmed')
    expect(sweep.findings[0]?.detail).toContain('matched the expected signature')
  })

  it('reports `unexpected` when the port answers but not like the expected engine', async () => {
    const sweep = await probePorts({
      expectations: [GATEWAY],
      // Something is on that port, but it is not the engine: the fingerprint
      // must NOT be promoted to confirmed.
      connect: fakeConnector({ 18789: 'HTTP/1.1 200 OK\r\n\r\n{"service":"something-else"}' }),
    })
    expect(sweep.findings[0]?.verdict).toBe('unexpected')
    expect(sweep.findings[0]?.detail).toContain('did not answer like openclaw gateway')
  })

  it('degrades silently when nothing is listening', async () => {
    const sweep = await probePorts({
      expectations: [GATEWAY],
      connect: fakeConnector({}), // every port refused
    })
    expect(sweep.findings[0]?.verdict).toBe('absent')
    expect(sweep.findings[0]?.detail).toContain('nothing listening')
    // And the whole call resolved rather than rejecting.
    expect(sweep.budgetExhausted).toBe(false)
  })

  it('never rejects, even when the connector itself throws', async () => {
    const sweep = await probePorts({
      expectations: [GATEWAY],
      connect: async () => {
        throw new Error('socket exploded')
      },
    })
    expect(sweep.findings[0]?.verdict).toBe('absent')
  })

  it('refuses a non-loopback host instead of connecting to it', async () => {
    const seen: ConnectInput[] = []
    const sweep = await probePorts({
      expectations: [{ ...GATEWAY, host: '10.0.0.5' }],
      connect: recordingConnector({ 18789: 'openclaw' }, seen),
    })
    // Not one socket was opened.
    expect(seen).toEqual([])
    expect(sweep.findings[0]?.verdict).toBe('unchecked')
    expect(sweep.findings[0]?.detail).toContain('non-loopback host')
  })

  it('checks ::1 as well as 127.0.0.1, and reports which one answered', async () => {
    const seen: ConnectInput[] = []
    const sweep = await probePorts({
      expectations: [
        { ...GATEWAY, host: '127.0.0.1' },
        { ...GATEWAY, host: '::1' },
      ],
      connect: recordingConnector({ 18789: 'openclaw' }, seen),
    })
    expect(seen.map((input) => input.host).sort()).toEqual(['127.0.0.1', '::1'])
    expect(sweep.findings.map((finding) => finding.host).sort()).toEqual(['127.0.0.1', '::1'])
  })

  it('keeps the caller\'s declared order regardless of completion order', async () => {
    const slow: PortExpectation = { agentId: 'slow', port: 1111, label: 'slow engine' }
    const fast: PortExpectation = { agentId: 'fast', port: 2222, label: 'fast engine' }
    const sweep = await probePorts({
      expectations: [slow, fast],
      connect: async ({ port }) => {
        // The FIRST expectation is the slow one, so a naive implementation would
        // report `fast` first.
        await new Promise((resolve) => setTimeout(resolve, port === 1111 ? 20 : 1))
        return undefined
      },
    })
    expect(sweep.findings.map((finding) => finding.agentId)).toEqual(['slow', 'fast'])
  })

  it('caps concurrency so a large port list is not a burst of sockets', async () => {
    const expectations: PortExpectation[] = Array.from({ length: 20 }, (_unused, index) => ({
      agentId: `agent-${index}`,
      port: 30_000 + index,
      label: `engine-${index}`,
    }))
    let inFlight = 0
    let peak = 0
    const sweep = await probePorts({
      expectations,
      concurrency: 3,
      connect: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlight -= 1
        return undefined
      },
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(sweep.findings).toHaveLength(20)
  })

  it('clamps the per-connect timeout to the remaining sweep budget', async () => {
    const seen: ConnectInput[] = []
    await probePorts({
      expectations: [GATEWAY],
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      budgetMs: 250,
      startedAt: 0,
      now: () => 0,
      connect: recordingConnector({}, seen),
    })
    // Never more than the declared connect timeout, and never more than the
    // sweep has left.
    expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(DEFAULT_CONNECT_TIMEOUT_MS)
    expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(250)
    expect(seen[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it('reports the budget as exhausted when the clock leaves no room', async () => {
    const sweep = await probePorts({
      expectations: [GATEWAY],
      startedAt: 0,
      now: () => 10_000,
      budgetMs: 1,
      connect: fakeConnector({ 18789: 'openclaw' }),
    })
    expect(sweep.budgetExhausted).toBe(true)
    // It stopped early rather than connecting.
    expect(sweep.findings).toEqual([])
  })

  it('sends the declared request, and caps how much it reads', async () => {
    const seen: ConnectInput[] = []
    await probePorts({
      expectations: [GATEWAY],
      connect: recordingConnector({ 18789: 'openclaw' }, seen),
    })
    expect(seen[0]?.request).toContain('GET /health')
    expect(seen[0]?.maxBytes).toBeGreaterThan(0)
    expect(seen[0]?.maxBytes).toBeLessThanOrEqual(4_096)
  })

  it('returns an empty result for no expectations, without touching a socket', async () => {
    const seen: ConnectInput[] = []
    const sweep = await probePorts({ expectations: [], connect: recordingConnector({}, seen) })
    expect(sweep.findings).toEqual([])
    expect(seen).toEqual([])
  })
})

describe('portNote', () => {
  it('stays quiet when nothing was found, so a probe is not noisy', () => {
    const absent: PortFinding = {
      agentId: 'autoclaw',
      host: '127.0.0.1',
      port: 18789,
      label: 'openclaw gateway',
      verdict: 'absent',
      detail: 'nothing listening',
    }
    // A desktop app that is simply not running is the NORMAL state.
    expect(portNote([absent])).toBeUndefined()
    expect(portNote([])).toBeUndefined()
    expect(portNote([{ ...absent, verdict: 'unchecked' }])).toBeUndefined()
  })

  it('says SUSPECTED unless the signature was confirmed, and never touches availability', () => {
    const unexpected: PortFinding = {
      agentId: 'autoclaw',
      host: '127.0.0.1',
      port: 18789,
      label: 'openclaw gateway',
      verdict: 'unexpected',
      detail: '127.0.0.1:18789 is listening but did not answer like openclaw gateway',
    }
    const note = portNote([unexpected])
    expect(note).toContain('suspected')
    expect(note).toContain('openclaw gateway')

    const confirmed: PortFinding = { ...unexpected, verdict: 'confirmed' }
    const confirmedNote = portNote([confirmed])
    expect(confirmedNote).toContain('confirmed')
    // The one sentence that must always be there: this did not decide
    // `available`.
    expect(confirmedNote).toContain('availability is decided by whether the engine can be launched')
  })

  it('reports whether anything was confirmed, as information only', () => {
    const base: PortFinding = {
      agentId: 'a',
      host: '127.0.0.1',
      port: 1,
      label: 'x',
      verdict: 'absent',
    }
    expect(hasConfirmed([base])).toBe(false)
    expect(hasConfirmed([{ ...base, verdict: 'confirmed' }])).toBe(true)
    expect(hasConfirmed([])).toBe(false)
  })
})

describe('defaultPortExpectations', () => {
  it('asserts no port, because no fingerprint is host-verified yet', () => {
    // Guessing a port would put a fabricated fact into probe output; the
    // function is the single place to add a VERIFIED one.
    expect(defaultPortExpectations()).toEqual([])
  })
})

/* -------------------------------------------------------- host-guarded */

/**
 * The design assumes a closed loopback port refuses IMMEDIATELY, which is what
 * makes a sweep of several ports cost well under a millisecond rather than one
 * timeout each. Probe an ephemeral port that nothing can be listening on.
 */
describe('real loopback socket (host-dependent)', () => {
  it('refuses a closed port immediately rather than waiting for the timeout', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const assigned = typeof address === 'object' && address !== null ? address.port : 0
        server.close(() => resolve(assigned))
      })
    })
    expect(port).toBeGreaterThan(0)

    const started = Date.now()
    const sweep = await probePorts({
      expectations: [{ agentId: 'nothing', port, label: 'closed port' }],
      // deliberately a generous timeout: the refusal must not need it
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    })
    const elapsed = Date.now() - started
    expect(sweep.findings[0]?.verdict).toBe('absent')
    expect(elapsed).toBeLessThan(1_000)
  })

  it('connects to a real listening loopback server and reads its answer', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\n\r\n{"service":"openclaw"}\n'))
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    try {
      const sweep = await probePorts({
        expectations: [{ ...GATEWAY, port }],
      })
      expect(sweep.findings[0]?.verdict).toBe('confirmed')
      expect(sweep.findings[0]?.detail).toContain('is listening')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
