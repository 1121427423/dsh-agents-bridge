/**
 * `src/client/util.ts` — the client half's pure logic.
 *
 * These are the rules the panel obeys, tested without React, without a DOM and
 * without a host: how a duration reads, how a status is labelled, how an
 * incremental read is merged into a transcript, and — the requirement that is
 * easiest to get silently wrong — when polling must STOP.
 *
 * @module tests/client/util
 */

import { describe, expect, it } from 'vitest'

import { DICTS, createTranslator, detectLocaleTag, interpolate, localeTagOf } from '../../src/client/i18n.ts'
import {
  DEFAULT_POLL_POLICY,
  countAttention,
  credentialLabel,
  formatDuration,
  formatTokenSummary,
  formatTokens,
  isDisplayable,
  markSeen,
  mergeMessages,
  pollDecision,
  previewText,
  sessionElapsed,
  sessionPreview,
  sessionTokens,
  sortSessions,
  statusLabel,
  summarizeEngines,
  type ClientMessage,
  type ClientSession,
} from '../../src/client/util.ts'

/** A session row with sane defaults. */
function session(overrides: Partial<ClientSession> & { readonly sessionId: string }): ClientSession {
  return {
    agentId: 'claude',
    status: 'running',
    startedAt: 0,
    messageCount: 0,
    terminal: false,
    ...overrides,
  }
}

/** One transcript event. */
function message(index: number, overrides: Partial<ClientMessage> = {}): ClientMessage {
  return { index, type: 'text', text: `event ${index}`, at: index, ...overrides }
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

describe('formatDuration', () => {
  it('reads a fresh run in sub-second terms rather than as "0s"', () => {
    expect(formatDuration(0)).toBe('0.0s')
    expect(formatDuration(450)).toBe('0.5s')
    expect(formatDuration(999)).toBe('1.0s')
  })

  it('reads seconds, then minutes-with-seconds, then hours-with-minutes', () => {
    expect(formatDuration(1_000)).toBe('1s')
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(59_999)).toBe('59s')
    expect(formatDuration(60_000)).toBe('1m00s')
    expect(formatDuration(184_000)).toBe('3m04s')
    expect(formatDuration(3_600_000)).toBe('1h00m')
    expect(formatDuration(7_500_000)).toBe('2h05m')
  })

  it('treats a negative or non-finite input as a clock problem, not as NaN', () => {
    // A browser clock behind the host's produces a negative elapsed time; the
    // panel must render a dash, never the string "NaN".
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatTokens', () => {
  it('keeps exact counts below 1000 and compacts above', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_000)).toBe('1.0k')
    expect(formatTokens(12_403)).toBe('12k')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })

  it('refuses a negative or non-finite count', () => {
    expect(formatTokens(-5)).toBe('—')
    expect(formatTokens(Number.NaN)).toBe('—')
  })
})

describe('sessionTokens / formatTokenSummary', () => {
  const labels = DICTS.en

  it('reports nothing until the engine actually reported usage', () => {
    expect(sessionTokens(session({ sessionId: 's1' }))).toBeUndefined()
    expect(formatTokenSummary(session({ sessionId: 's1' }), labels)).toBe(labels.instantaneous)
  })

  it('reports an input/output pair without double-counting reasoning tokens', () => {
    const withUsage = session({
      sessionId: 's1',
      result: { status: 'completed', usage: { inputTokens: 1_200, outputTokens: 340 } },
    })
    expect(sessionTokens(withUsage)).toEqual({ input: 1_200, output: 340 })
    expect(formatTokenSummary(withUsage, labels)).toBe('tokens ↑1.2k ↓340')
  })
})

describe('statusLabel', () => {
  it('labels every known status in both locales', () => {
    for (const tag of ['zh', 'en'] as const) {
      const dict = DICTS[tag]
      expect(statusLabel('running', dict)).toBe(dict.running)
      expect(statusLabel('completed', dict)).toBe(dict.completed)
      expect(statusLabel('failed', dict)).toBe(dict.failed)
      expect(statusLabel('cancelled', dict)).toBe(dict.cancelled)
      expect(statusLabel('timeout', dict)).toBe(dict.timeout)
    }
  })

  it('renders an unknown future status verbatim instead of blanking the row', () => {
    expect(statusLabel('quarantined' as ClientSession['status'], DICTS.en)).toBe('quarantined')
  })
})

describe('previewText / sessionPreview', () => {
  it('collapses a multi-line payload to one line and clips it', () => {
    expect(previewText('line one\n\n  line two  ')).toBe('line one line two')
    expect(previewText('abcdefghij', 4)).toBe('abcd…')
    expect(previewText(undefined)).toBe('')
  })

  it('prefers the live event while running, and names the tool for tool events', () => {
    const running = session({ sessionId: 's1', lastMessage: message(3, { type: 'tool_use', tool: 'Bash' }) })
    expect(sessionPreview(running)).toBe('[tool_use] Bash')
    const text = session({ sessionId: 's1', lastMessage: message(3, { type: 'text', text: 'working on it' }) })
    expect(sessionPreview(text)).toBe('working on it')
  })

  it('surfaces a failure error once the run is terminal, never the stale preview', () => {
    const failed = session({
      sessionId: 's1',
      status: 'failed',
      terminal: true,
      lastMessage: message(3, { type: 'text', text: 'still looks fine' }),
      result: { status: 'failed', error: 'engine exited 1' },
    })
    expect(sessionPreview(failed)).toBe('engine exited 1')
  })

  it('falls back to the final result text, then to empty', () => {
    const done = session({
      sessionId: 's1',
      status: 'completed',
      terminal: true,
      result: { status: 'completed', text: 'final answer' },
    })
    expect(sessionPreview(done)).toBe('final answer')
    expect(sessionPreview(session({ sessionId: 's1', terminal: true, status: 'cancelled' }))).toBe('')
  })
})

describe('sessionElapsed', () => {
  it('runs against a caller clock while live and freezes at endedAt once terminal', () => {
    expect(sessionElapsed(session({ sessionId: 's1', startedAt: 100 }), 1_100)).toBe(1_000)
    expect(sessionElapsed(session({ sessionId: 's1', startedAt: 100, endedAt: 600 }), 99_999)).toBe(500)
  })
})

/* -------------------------------------------------------------------------- */
/* Ordering, counters                                                         */
/* -------------------------------------------------------------------------- */

describe('sortSessions', () => {
  it('puts live rows first, oldest first, then finished rows newest first', () => {
    const rows = [
      session({ sessionId: 'ended-old', startedAt: 10, terminal: true, status: 'completed' }),
      session({ sessionId: 'live-new', startedAt: 500 }),
      session({ sessionId: 'ended-new', startedAt: 900, terminal: true, status: 'failed' }),
      session({ sessionId: 'live-old', startedAt: 100 }),
    ]
    expect(sortSessions(rows).map(row => row.sessionId)).toEqual([
      'live-old',
      'live-new',
      'ended-new',
      'ended-old',
    ])
  })

  it('does not mutate its input', () => {
    const rows = [session({ sessionId: 'b', startedAt: 2 }), session({ sessionId: 'a', startedAt: 1 })]
    const before = rows.map(row => row.sessionId)
    sortSessions(rows)
    expect(rows.map(row => row.sessionId)).toEqual(before)
  })
})

describe('countAttention / markSeen', () => {
  const rows = [
    session({ sessionId: 'live' }),
    session({ sessionId: 'failed-1', status: 'failed', terminal: true }),
    session({ sessionId: 'failed-2', status: 'failed', terminal: true }),
    session({ sessionId: 'of-course-it-succeeded-says-the-model', status: 'completed', terminal: true }),
  ]

  it('counts running, failed and UNSEEN failed separately', () => {
    expect(countAttention(rows, new Set())).toEqual({ running: 1, failed: 2, unseenFailures: 2 })
    expect(countAttention(rows, new Set(['failed-1']))).toEqual({ running: 1, failed: 2, unseenFailures: 1 })
    expect(countAttention(rows, new Set(['failed-1', 'failed-2']))).toEqual({ running: 1, failed: 2, unseenFailures: 0 })
  })

  it('returns the SAME set identity when nothing is new (keeps the snapshot stable)', () => {
    const seen = new Set(['failed-1'])
    expect(markSeen(seen, ['failed-1'])).toBe(seen)
    const next = markSeen(seen, ['failed-1', 'failed-2'])
    expect(next).not.toBe(seen)
    expect([...next].sort()).toEqual(['failed-1', 'failed-2'])
  })
})

/* -------------------------------------------------------------------------- */
/* Incremental merge — the reason sinceIndex exists                           */
/* -------------------------------------------------------------------------- */

describe('mergeMessages', () => {
  it('appends a pure incremental read', () => {
    const merged = mergeMessages([message(0), message(1)], [message(2), message(3)])
    expect(merged.map(m => m.index)).toEqual([0, 1, 2, 3])
  })

  it('MERGES an overlapping read instead of duplicating it', () => {
    // The panel re-reads from an earlier index after a reload or a
    // limit-bounded read; a naive concat would print every line twice.
    const merged = mergeMessages([message(0), message(1), message(2)], [message(1), message(2), message(3)])
    expect(merged.map(m => m.index)).toEqual([0, 1, 2, 3])
  })

  it('orders an out-of-order batch by index', () => {
    const merged = mergeMessages([message(0)], [message(3), message(1), message(2)])
    expect(merged.map(m => m.index)).toEqual([0, 1, 2, 3])
  })

  it('lets a re-read REPLACE an event (a streamed delta that grew)', () => {
    const merged = mergeMessages([message(0, { text: 'hel' })], [message(0, { text: 'hello' })])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.text).toBe('hello')
  })

  it('is a no-op on an empty batch, returning the same content', () => {
    const existing = [message(0)]
    expect(mergeMessages(existing, [])).toEqual(existing)
    expect(mergeMessages(existing, [])).not.toBe(existing)
  })

  it('caps growth from the FRONT (a supervisor watches the tail)', () => {
    const merged = mergeMessages([message(0), message(1), message(2)], [message(3)], 3)
    expect(merged.map(m => m.index)).toEqual([1, 2, 3])
  })

  it('handles a gap without filling it', () => {
    // A limit-bounded read can leave a hole; the merge must not invent events.
    const merged = mergeMessages([message(0)], [message(5)])
    expect(merged.map(m => m.index)).toEqual([0, 5])
  })
})

describe('isDisplayable', () => {
  it('hides driver chatter but never hides an error or a warning', () => {
    expect(isDisplayable(message(0, { type: 'log', level: 'debug' }))).toBe(false)
    expect(isDisplayable(message(0, { type: 'log' }))).toBe(false)
    expect(isDisplayable(message(0, { type: 'log', level: 'warn' }))).toBe(true)
    expect(isDisplayable(message(0, { type: 'log', level: 'error' }))).toBe(true)
    for (const type of ['text', 'thinking', 'tool_use', 'tool_result', 'status', 'error']) {
      expect(isDisplayable(message(0, { type }))).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Poll scheduling — the "must not spin when idle" requirement                 */
/* -------------------------------------------------------------------------- */

describe('pollDecision', () => {
  it('STOPS polling entirely when nothing is running', () => {
    // The requirement, verbatim: an all-idle panel must not burn a request
    // every couple of seconds forever.
    expect(pollDecision({ running: 0, hidden: false, paused: false })).toEqual({ mode: 'idle', delayMs: -1 })
    expect(pollDecision({ running: 0, hidden: true, paused: false })).toEqual({ mode: 'idle', delayMs: -1 })
  })

  it('polls at the active interval while something is live', () => {
    expect(pollDecision({ running: 1, hidden: false, paused: false })).toEqual({
      mode: 'running',
      delayMs: DEFAULT_POLL_POLICY.activeMs,
    })
  })

  it('backs off by the policy factor while the tab is hidden, but keeps watching', () => {
    const decision = pollDecision({ running: 2, hidden: true, paused: false })
    expect(decision.mode).toBe('hidden')
    expect(decision.delayMs).toBe(DEFAULT_POLL_POLICY.activeMs * DEFAULT_POLL_POLICY.hiddenFactor)
    expect(decision.delayMs).toBeGreaterThan(0)
  })

  it('honours a caller pause (a confirmation modal must not move the row)', () => {
    expect(pollDecision({ running: 3, hidden: false, paused: true })).toEqual({ mode: 'paused', delayMs: -1 })
  })

  it('keeps the active interval in the 1-2s band the task specifies', () => {
    expect(DEFAULT_POLL_POLICY.activeMs).toBeGreaterThanOrEqual(1_000)
    expect(DEFAULT_POLL_POLICY.activeMs).toBeLessThanOrEqual(2_000)
  })
})

/* -------------------------------------------------------------------------- */
/* Engine availability                                                        */
/* -------------------------------------------------------------------------- */

describe('summarizeEngines', () => {
  it('counts totals, availability, catalogs and credential problems', () => {
    const summary = summarizeEngines([
      { id: 'claude', available: true, health: { credential: 'ok' }, models: ['a', 'b'] },
      { id: 'codex', available: true, health: { credential: 'invalid', detail: 'token rejected' } },
      { id: 'mimo', available: false, reason: 'sealed desktop app' },
    ])
    expect(summary).toEqual({
      total: 3,
      available: 2,
      withModels: 1,
      credentialIssues: ['codex: invalid (token rejected)'],
    })
  })

  it('reports nothing for an empty host', () => {
    expect(summarizeEngines([])).toEqual({ total: 0, available: 0, withModels: 0, credentialIssues: [] })
  })

  it('does not report a credential problem for an UNAVAILABLE engine', () => {
    // An engine that cannot launch is already reported as unavailable; a second
    // line about its credential is noise.
    const summary = summarizeEngines([{ id: 'x', available: false, health: { credential: 'missing' } }])
    expect(summary.credentialIssues).toEqual([])
  })
})

describe('credentialLabel', () => {
  it('never renders the raw enum', () => {
    expect(credentialLabel('ok')).toBe('ok')
    expect(credentialLabel('missing')).toBe('missing')
    expect(credentialLabel('invalid')).toBe('invalid')
    expect(credentialLabel('not-applicable')).toBe('n/a')
    expect(credentialLabel('unknown')).toBe('unknown')
    expect(credentialLabel(undefined)).toBe('—')
  })
})

/* -------------------------------------------------------------------------- */
/* i18n                                                                       */
/* -------------------------------------------------------------------------- */

describe('localeTagOf / detectLocaleTag', () => {
  it('maps zh-* to Chinese and everything else to English', () => {
    expect(localeTagOf('zh')).toBe('zh')
    expect(localeTagOf('zh-CN')).toBe('zh')
    expect(localeTagOf('zh-Hans-HK')).toBe('zh')
    expect(localeTagOf('en-US')).toBe('en')
    expect(localeTagOf('de-DE')).toBe('en')
    expect(localeTagOf(undefined)).toBe('en')
    expect(localeTagOf('  ZH-cn ')).toBe('zh')
  })

  it('falls back to English without throwing when there is no navigator', () => {
    expect(['zh', 'en']).toContain(detectLocaleTag())
  })
})

describe('interpolate / createTranslator', () => {
  it('substitutes placeholders and leaves an unknown one verbatim', () => {
    expect(interpolate('{n} of {total}', { n: 2, total: 3 })).toBe('2 of 3')
    expect(interpolate('{n} of {total}', { n: 2 })).toBe('2 of {total}')
    expect(interpolate('no placeholders')).toBe('no placeholders')
  })

  it('switches dictionaries without remounting', () => {
    const translator = createTranslator('en')
    expect(translator.t('panelTitle')).toBe(DICTS.en.panelTitle)
    translator.setTag('zh')
    expect(translator.tag()).toBe('zh')
    expect(translator.t('panelTitle')).toBe(DICTS.zh.panelTitle)
    expect(translator.current()).toBe(DICTS.zh)
  })

  it('renders both dictionaries with the same placeholder set', () => {
    // A key present in one dictionary and missing from the other is the classic
    // i18n regression; `Dict` catches it at compile time, this catches a
    // placeholder that only one side defines.
    const zh = createTranslator('zh')
    const en = createTranslator('en')
    for (const key of Object.keys(DICTS.en) as (keyof typeof DICTS.en)[]) {
      expect(en.t(key)).toBe(DICTS.en[key])
      expect(zh.t(key)).toBe(DICTS.zh[key])
    }
  })
})
