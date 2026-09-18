/**
 * `src/client/panel.ts` + `src/client/indicator.ts` — the rendered surfaces.
 *
 * The host's rendering environment is not worth simulating, but the components
 * are plain `createElement` calls, so calling them with a props object returns
 * an inspectable element tree. That is enough to assert the two rules that
 * matter most for a HUMAN surface and are easy to break silently:
 *
 *  - every non-happy state renders READABLE copy with a way out (never a blank
 *    panel, never a raw code, never an English stack);
 *  - the indicator appears only when there is something to say.
 *
 * @module tests/client/components
 */

import { describe, expect, it } from 'vitest'

import type { BridgeApi, ClientSettingsView } from '../../src/client/api.ts'
import { ApiError } from '../../src/client/api.ts'
import { SettingsCard, SettingsFields } from '../../src/client/settings.ts'
import { SETTINGS_NAMESPACE } from '../../src/namespace.ts'
import { createTranslator, DICTS } from '../../src/client/i18n.ts'
import { Indicator } from '../../src/client/indicator.ts'
import { SupervisorPanel, useSupervisor } from '../../src/client/panel.ts'
import { createSupervisorStore, type SupervisorStore } from '../../src/client/store.ts'
import { DEFAULT_POLL_POLICY, type ClientRunStatus, type ClientSession } from '../../src/client/util.ts'
import { ROOT_CLASS } from '../../src/client/styles.ts'
import { createElement, type StubElement } from '../stubs/react.ts'

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function session(sessionId: string, status: ClientRunStatus): ClientSession {
  return {
    sessionId,
    agentId: 'claude',
    status,
    startedAt: 0,
    messageCount: 3,
    terminal: status !== 'running',
    lastMessage: { index: 2, type: 'text', text: 'working on the build', at: 2 },
  }
}

/**
 * The settings trio `BridgeApi` requires (IM-14).
 *
 * `BridgeApi` grew `settings`/`settingsWrite`/`settingsReset` with the settings
 * card, and every fake in this file predates them — nothing typechecked tests
 * back then, so the drift went unseen. These stubs are deliberately LOUD rather
 * than silently returning a shape: a surface that starts calling them under this
 * fixture should fail, not read a plausible-looking empty value.
 */
const noSettings: Pick<BridgeApi, 'settings' | 'settingsWrite' | 'settingsReset'> = {
  async settings(): Promise<ClientSettingsView> {
    throw new Error('settings() is not part of this fixture')
  },
  async settingsWrite() {
    throw new Error('settingsWrite() is not part of this fixture')
  },
  async settingsReset() {
    throw new Error('settingsReset() is not part of this fixture')
  },
}

function makeStore(script: {
  readonly sessions?: () => readonly ClientSession[]
  readonly failStatus?: boolean
  readonly output?: (sessionId: string, sinceIndex: number) => { readonly nextIndex: number; readonly messages: readonly { readonly index: number; readonly type: string; readonly text?: string | undefined; readonly tool?: string | undefined; readonly at: number }[] }
} = {}): SupervisorStore {
  const api: BridgeApi = {
    async status() {
      if (script.failStatus === true) throw new ApiError('missing', 'not-found', 404, 'no route')
      const rows = script.sessions?.() ?? []
      return { sessions: rows, concurrency: { running: 0, limit: 200 }, now: 1_000 }
    },
    async output(sessionId, sinceIndex) {
      return {
        sessionId,
        status: 'running',
        terminal: false,
        ...(script.output?.(sessionId, sinceIndex) ?? { nextIndex: sinceIndex, messages: [] }),
      }
    },
    async cancel() {
      return { sessionId: 'x', cancelled: true, status: 'running', note: 'ok' }
    },
    async probe() {
      return {
        available: true,
        results: [{ id: 'claude', available: true, health: { credential: 'ok' }, models: ['a', 'b'] }],
        at: 1_000,
        cached: true,
      }
    },
    ...noSettings,
  }
  return createSupervisorStore(api, createTranslator('en'), { policy: DEFAULT_POLL_POLICY, autoRefresh: true }, {
    setTimeout: () => 1,
    clearTimeout: () => {},
    now: () => Date.now(),
    hidden: () => false,
    onVisibilityChange: () => () => {},
  })
}

/**
 * Deep-walk an element tree and collect every string it renders.
 *
 * A child whose `type` is a FUNCTION is a nested component (the panel composes
 * `SessionRow`, `EngineStrip`, …); the stub renderer does not invoke it, so this
 * walker does — with its own props — which is what makes an assertion about
 * rendered copy meaningful rather than vacuous.
 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  const element = node as StubElement
  if (typeof element.type === 'function') {
    const rendered = (element.type as (props: unknown) => unknown)(element.props)
    return textOf(rendered)
  }
  const children = Array.isArray(element.props?.children) ? element.props.children : []
  return children.map(textOf).join(' ')
}

/** Every element of a given `type` in the tree, descending into components. */
function findAll(node: unknown, type: unknown): StubElement[] {
  if (node === null || typeof node !== 'object') return []
  const element = node as StubElement
  if (typeof element.type === 'function') {
    return findAll((element.type as (props: unknown) => unknown)(element.props), type)
  }
  const children = Array.isArray(element.props?.children) ? element.props.children : []
  return [
    ...(element.type === type ? [element] : []),
    ...children.flatMap(child => findAll(child, type)),
  ]
}

/** Render the panel once and return the tree plus its flattened text. */
async function renderPanel(store: SupervisorStore): Promise<{ readonly tree: StubElement; readonly text: string }> {
  // `start()` is what kicks off the engine probe (the panel mounts through it,
  // not through a bare `refresh()`); awaiting both keeps the assertions about
  // the engine strip honest.
  store.start()
  await store.refresh()
  await store.refreshEngines()
  const tree = SupervisorPanel({ store, translator: createTranslator('en') }) as unknown as StubElement
  return { tree, text: textOf(tree) }
}

/* -------------------------------------------------------------------------- */
/* Panel states                                                               */
/* -------------------------------------------------------------------------- */

describe('SupervisorPanel — every state is readable', () => {
  it('shows an empty state that explains what will appear, not a blank panel', async () => {
    const store = makeStore({ sessions: () => [] })
    const { tree, text } = await renderPanel(store)
    expect(text).toContain(DICTS.en.emptyTitle)
    expect(text).toContain(DICTS.en.emptyBody)
    // Not blank: the panel root and its chrome are always rendered.
    expect(tree.props.className).toBe(ROOT_CLASS)
    expect(text).toContain(DICTS.en.panelTitle)
    store.stop()
  })

  it('shows an actionable error state when the host has no route', async () => {
    const store = makeStore({ failStatus: true })
    const { text } = await renderPanel(store)
    expect(text).toContain(DICTS.en.errorUnavailableTitle)
    expect(text).toContain(DICTS.en.errorMissing)
    expect(text).toContain(DICTS.en.retry)
    // Never the wire code or a stack.
    expect(text).not.toContain('not-found')
    expect(text).not.toContain('at ')
    store.stop()
  })

  it('renders one row per session with identity, status, elapsed and token figures', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running'), session('b', 'failed')] })
    const { text } = await renderPanel(store)
    expect(text).toContain('claude')
    expect(text).toContain(DICTS.en.running)
    expect(text).toContain(DICTS.en.failed)
    expect(text).toContain('working on the build')
    expect(text).toContain(DICTS.en.instantaneous)
    expect(text).toContain(DICTS.en.openOutput)
    store.stop()
  })

  it('does NOT render the cancel confirmation until the human asks for it', async () => {
    // Cancelling kills a process group and loses unfinished work, so it is
    // behind a two-step confirm. The dialog must not be in the DOM on mount.
    const store = makeStore({ sessions: () => [session('a', 'running'), session('b', 'completed')] })
    const { text } = await renderPanel(store)
    expect(text).not.toContain(DICTS.en.cancelConfirmTitle)
    expect(text).not.toContain(DICTS.en.cancelConfirmYes)
    // ...but the affordance itself is there for the running row.
    expect(text).toContain(DICTS.en.cancel)
    store.stop()
  })

  it('offers no cancel affordance on a terminal row', async () => {
    const store = makeStore({ sessions: () => [session('b', 'completed')] })
    const { tree } = await renderPanel(store)
    const labels = findAll(tree, 'button').flatMap(button => button.props.children.map(child => (typeof child === 'string' ? child : '')))
    expect(labels).not.toContain(DICTS.en.cancel)
    expect(labels).toContain(DICTS.en.openOutput)
    store.stop()
  })

  it('reads a finished row as a RECORD: its final elapsed time and its exit code', async () => {
    // Requirement: "已完成" must be a record, not a grey line. Two finished rows
    // with DIFFERENT exit codes and DIFFERENT durations, so neither assertion
    // can be satisfied by one hardcoded string.
    const store = makeStore({
      sessions: () => [
        {
          sessionId: 'ok', agentId: 'claude', status: 'completed', startedAt: 0, endedAt: 2_000,
          messageCount: 4, terminal: true, lastMessage: { index: 3, type: 'text', text: 'all done', at: 3 },
          result: { status: 'completed', text: 'all done', exitCode: 0 },
        },
        {
          sessionId: 'bad', agentId: 'codex', status: 'failed', startedAt: 0, endedAt: 65_000,
          messageCount: 2, terminal: true, result: { status: 'failed', text: '', error: 'engine exited 3', exitCode: 3 },
        },
      ],
    })
    const { text } = await renderPanel(store)
    expect(text).toContain(DICTS.en.exitCode.replace('{code}', '0'))
    expect(text).toContain(DICTS.en.exitCode.replace('{code}', '3'))
    // Elapsed is FROZEN at endedAt for a finished row (2s / 1m05s), never the
    // live ticker — a finished record that keeps counting is a lie.
    expect(text).toContain('2s')
    expect(text).toContain('1m05s')
    store.stop()
  })

  it('does not put an exit code on a row that has not finished', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running')] })
    const { text } = await renderPanel(store)
    expect(text).not.toMatch(/exit \d/)
    store.stop()
  })

  it('never tells the reader a FINISHED session is "still working"', async () => {
    // The exact shape the host produces for a session restored from disk (or one
    // whose transcript the finished-LRU spilled): a real terminal status, real
    // timings, no last message, no result text, no exit code. The row used to
    // render `noEventsYet` — "the agent is still working; output will arrive as
    // it goes" — which is simply false about a finished record.
    //
    // No `exitCode` key at all, not `exitCode: null`: on the wire the ABI sends
    // `null`, and `normalizeSession` collapses that to "absent" at the boundary
    // (see `tests/client/api.test.ts`).
    const store = makeStore({
      sessions: () => [
        {
          sessionId: 'r1', agentId: 'claude', status: 'completed', startedAt: 0, endedAt: 4_000,
          messageCount: 0, terminal: true, result: { status: 'completed', text: '' },
        },
      ],
    })
    const { text } = await renderPanel(store)
    expect(text).not.toContain(DICTS.en.noEventsYet)
    expect(text).not.toContain(DICTS.en.waitingForAgent)
    expect(text).toContain(DICTS.en.noOutputKept)
    // ...and it is still a RECORD: identity, status and frozen wall time.
    expect(text).toContain('claude')
    expect(text).toContain(DICTS.en.completed)
    expect(text).toContain('4s')
    store.stop()
  })

  it('shows the engine strip with availability and credential state', async () => {
    const store = makeStore({ sessions: () => [] })
    const { text } = await renderPanel(store)
    expect(text).toContain(DICTS.en.enginesTitle)
    expect(text).toContain(DICTS.en.enginesAvailable.replace('{n}', '1').replace('{total}', '1'))
    expect(text).toContain('claude')
    expect(text).toContain(DICTS.en.enginesCredentialOk)
    store.stop()
  })

  it('offers a re-scan that is DISTINCT from Refresh, and explains what it re-walks (RR-MI-1b)', async () => {
    // The operator's problem: "I installed the app while DSH was running and
    // the panel still cannot see it". Refresh only re-probes versions, so the
    // re-walk needs its own, explicitly-labelled entry point — one button that
    // silently did two jobs would leave the expensive one undiscoverable.
    const store = makeStore({ sessions: () => [] })
    const { tree } = await renderPanel(store)
    const buttons = findAll(tree, 'button').map(button => ({
      label: button.props.children.map(child => (typeof child === 'string' ? child : '')).join(''),
      title: button.props.title,
    }))
    expect(buttons.map(button => button.label)).toContain(DICTS.en.refresh)
    // The re-scan is its own button, and its consequence — a filesystem walk
    // that is slower than Refresh — is stated where the operator hovers.
    const rescan = buttons.find(button => button.label === DICTS.en.rescanInstalls)
    expect(rescan).toBeDefined()
    expect(rescan?.title).toBe(DICTS.en.rescanInstallsTitle)
    store.stop()
  })

  it('renders the incremental transcript view once a session is opened', async () => {
    const store = makeStore({
      sessions: () => [session('a', 'running')],
      output: (_id, since) => ({
        nextIndex: since + 2,
        messages: [
          { index: since, type: 'text', text: 'hello from the agent', at: 1 },
          // `tool` (not `text`) is how the host serializes a tool event — see
          // `OutputPayload` on the host side. The panel must read that field.
          { index: since + 1, type: 'tool_use', tool: 'Bash', at: 2 },
        ],
      }),
    })
    store.start()
    await store.refresh()
    await store.openSession('a')
    const tree = SupervisorPanel({ store, translator: createTranslator('en') }) as unknown as StubElement
    const text = textOf(tree)
    expect(text).toContain('hello from the agent')
    expect(text).toContain('[tool_use] Bash')
    expect(text).toContain(DICTS.en.back)
    store.stop()
  })

  it('shows a readable transcript empty state while the agent has produced nothing', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running')] })
    store.start()
    await store.refresh()
    await store.openSession('a')
    const text = textOf(SupervisorPanel({ store, translator: createTranslator('en') }))
    expect(text).toContain(DICTS.en.noEventsYet)
    expect(text).toContain(DICTS.en.waitingForAgent)
    store.stop()
  })

  it('says so when the transcript does not start at #0', async () => {
    // The panel used to open straight at `#200, #201, …` with no explanation,
    // which reads as an agent that skipped its own first events.
    const store = makeStore({
      sessions: () => [session('a', 'running')],
      output: () => ({
        nextIndex: 202,
        messages: [
          { index: 200, type: 'text', text: 'mid-run', at: 0 },
          { index: 201, type: 'text', text: 'later', at: 1 },
        ],
      }),
    })
    store.start()
    await store.refresh()
    await store.openSession('a')
    const text = textOf(SupervisorPanel({ store, translator: createTranslator('en') }))
    expect(text).toContain(createTranslator('en').t('transcriptDropped', { n: 200 }))
    // The rows are still rendered — the notice explains them, it does not hide them.
    expect(text).toContain('mid-run')
    store.stop()
  })

  it('does not claim events are missing when the transcript starts at #0', async () => {
    const store = makeStore({
      sessions: () => [session('a', 'running')],
      output: () => ({ nextIndex: 1, messages: [{ index: 0, type: 'text', text: 'first', at: 0 }] }),
    })
    store.start()
    await store.refresh()
    await store.openSession('a')
    const text = textOf(SupervisorPanel({ store, translator: createTranslator('en') }))
    expect(text).not.toContain(createTranslator('en').t('transcriptDropped', { n: 0 }))
    store.stop()
  })

  it('labels the poll state so "it stopped updating" is never a mystery', async () => {
    const idle = makeStore({ sessions: () => [session('a', 'completed')] })
    expect((await renderPanel(idle)).text).toContain(DICTS.en.pollIdle)
    idle.stop()

    const live = makeStore({ sessions: () => [session('a', 'running')] })
    expect((await renderPanel(live)).text).toContain(DICTS.en.pollLive)
    live.stop()
  })

  it('renders in Chinese when the host locale is Chinese', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running')] })
    await store.refresh()
    const text = textOf(SupervisorPanel({ store, translator: createTranslator('zh') }))
    expect(text).toContain(DICTS.zh.panelTitle)
    expect(text).toContain(DICTS.zh.running)
    expect(text).toContain(DICTS.zh.openOutput)
    store.stop()
  })

  it('renders a retry affordance on the stale-data strip after a mid-session failure', async () => {
    let failing = false
    const api: BridgeApi = {
      async status() {
        if (failing) throw new ApiError('network', 'network', 0, 'offline')
        return { sessions: [session('a', 'running')], concurrency: { running: 1, limit: 200 }, now: 1 }
      },
      async output() {
        return { sessionId: 'a', status: 'running', nextIndex: 0, terminal: false, messages: [] }
      },
      async cancel() {
        return { sessionId: 'a', cancelled: true, status: 'running', note: '' }
      },
      async probe() {
        return { available: true, results: [], at: 0, cached: false }
      },
      ...noSettings,
    }
    const store = createSupervisorStore(api, createTranslator('en'), { policy: DEFAULT_POLL_POLICY, autoRefresh: true }, {
      setTimeout: () => 1,
      clearTimeout: () => {},
      now: () => 1,
      hidden: () => false,
      onVisibilityChange: () => () => {},
    })
    await store.refresh()
    failing = true
    await store.refresh()
    const text = textOf(SupervisorPanel({ store, translator: createTranslator('en') }))
    // The row survives AND the unreachable state is stated in the host's own
    // words: the last known data is still the best information the human has,
    // and it must be labelled as stale rather than silently trusted.
    expect(text).toContain(DICTS.en.errorNetwork)
    expect(text).toContain(DICTS.en.retry)
    expect(text).toContain('claude')
    // Never the raw transport text.
    expect(text).not.toContain('offline')
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* Indicator                                                                  */
/* -------------------------------------------------------------------------- */

describe('Indicator — visible only when there is something to say', () => {
  it('renders nothing before the first read completes', () => {
    const store = makeStore({ sessions: () => [] })
    expect(Indicator({ store, translator: createTranslator('en') })).toBeNull()
    store.stop()
  })

  it('renders a running chip with the count', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running'), session('b', 'running')] })
    await store.refresh()
    const text = textOf(Indicator({ store, translator: createTranslator('en') }))
    expect(text).toContain(DICTS.en.indicatorRunning.replace('{n}', '2'))
    store.stop()
  })

  it('gives an UNSEEN failure priority over a running session', async () => {
    // A failure is the only state that needs a human; it must not be hidden
    // behind a green "still working" chip.
    const store = makeStore({ sessions: () => [session('a', 'running'), session('b', 'failed')] })
    await store.refresh()
    const element = Indicator({ store, translator: createTranslator('en') }) as StubElement
    expect(element.props['data-status']).toBe('failed')
    expect(textOf(element)).toContain(DICTS.en.indicatorFailed.replace('{n}', '1'))
    store.stop()
  })

  it('opens the first UNSEEN failure, not whichever failed row sorts first (MI-11)', async () => {
    // Terminal rows sort newest-first, so a failure the human has ALREADY
    // opened can sit ahead of one they have not. Clicking the badge must open
    // the unseen row (and so clear it), not the first `failed` row in the list.
    const newerSeen = { ...session('newer-seen', 'failed'), startedAt: 200 }
    const olderUnseen = { ...session('older-unseen', 'failed'), startedAt: 100 }
    const store = makeStore({
      sessions: () => [newerSeen, olderUnseen],
      output: (_id, since) => ({ nextIndex: since, messages: [] }),
    })
    store.start()
    await store.refresh()
    await store.openSession('newer-seen')
    store.closeSession()

    expect(store.getSnapshot().sessions.map(row => row.sessionId)).toEqual(['newer-seen', 'older-unseen'])
    expect(store.getSnapshot().counts.unseenFailures).toBe(1)

    const element = Indicator({ store, translator: createTranslator('en') }) as StubElement
    expect(element.props['data-status']).toBe('failed')
    ;(element.props.onClick as () => void)()

    expect(store.getSnapshot().selectedId).toBe('older-unseen')
    expect(store.getSnapshot().counts.unseenFailures).toBe(0)
    store.stop()
  })

  it('shows a quiet idle chip once loaded, and drops it when nothing is drivable', async () => {
    const store = makeStore({ sessions: () => [session('a', 'completed')] })
    await store.refresh()
    const idle = Indicator({ store, translator: createTranslator('en') }) as StubElement
    expect(idle.props['data-status']).toBe('idle')
    store.stop()

    const dead = createSupervisorStore(
      {
        async status() {
          return { sessions: [], concurrency: { running: 0, limit: 0 }, now: 1 }
        },
        async output() {
          return { sessionId: 'a', status: 'running', nextIndex: 0, terminal: false, messages: [] }
        },
        async cancel() {
          return { sessionId: 'a', cancelled: false, status: 'cancelled', note: '' }
        },
        async probe() {
          return { available: false, results: [], at: 0, cached: false }
        },
        ...noSettings,
      } satisfies BridgeApi,
      createTranslator('en'),
      { policy: DEFAULT_POLL_POLICY, autoRefresh: true },
      { setTimeout: () => 1, clearTimeout: () => {}, now: () => 1, hidden: () => false, onVisibilityChange: () => () => {} },
    )
    await dead.refresh()
    await dead.refreshEngines()
    // Nothing delegated, nothing drivable: stay out of the session header.
    expect(Indicator({ store: dead, translator: createTranslator('en') })).toBeNull()
    dead.stop()
  })

  it('renders in Chinese when the host locale is Chinese', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running')] })
    await store.refresh()
    expect(textOf(Indicator({ store, translator: createTranslator('zh') }))).toContain(DICTS.zh.indicatorRunning.replace('{n}', '1'))
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* The subscription hook                                                      */
/* -------------------------------------------------------------------------- */

describe('useSupervisor', () => {
  it('returns the store snapshot through the external-store contract', () => {
    const store = makeStore()
    const snapshot = useSupervisor(store)
    expect(snapshot).toBe(store.getSnapshot())
    store.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* createElement hygiene                                                      */
/* -------------------------------------------------------------------------- */

describe('component tree shape', () => {
  it('uses no JSX runtime and builds plain elements', async () => {
    // The bundle keeps `react/jsx-runtime` external for a reason: a second React
    // entry point. Every component here calls `createElement` directly, and this
    // asserts the stub (which mirrors the real one) sees a well-formed tree.
    const store = makeStore({ sessions: () => [session('a', 'running')] })
    const { tree } = await renderPanel(store)
    expect(findAll(tree, 'div').length).toBeGreaterThan(0)
    expect(tree.props.children).toBeInstanceOf(Array)
    store.stop()
  })

  it('gives every rendered child a position in the tree (no undefined holes)', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running')] })
    const { tree } = await renderPanel(store)
    const children = tree.props.children as unknown[]
    expect(children.some(child => child === undefined)).toBe(false)
    store.stop()
  })

  it('renders the panel without a sessionId (the slot may pass none)', async () => {
    const store = makeStore({ sessions: () => [session('a', 'running')] })
    await store.refresh()
    expect(() => SupervisorPanel({ store, translator: createTranslator('en'), sessionId: undefined })).not.toThrow()
    expect(() => createElement(SupervisorPanel, { store, translator: createTranslator('en') })).not.toThrow()
    store.stop()
  })
})

describe('SettingsCard — the card says which plugin it belongs to', () => {
  /**
   * The stub renderer has no effects, so this is the card's FIRST state — which
   * is the point: the identifier is rendered from the shared constant rather
   * than from data, so it is present before any fetch resolves, and it stays
   * present when the fetch fails.
   *
   * The regression it guards is real and came from the operator: opening
   * 设置 → 插件 on a real host, they found a card titled `监督桥设置` and had to
   * ASK whether it was this plugin's. A settings page lists every plugin's card
   * side by side, so a human name alone cannot answer that; the namespace can,
   * because the namespace IS the package name.
   */
  const cardApi = {
    async settings() {
      throw new ApiError('missing', 'not-found', 404, 'no route')
    },
  } as unknown as BridgeApi

  it('prints its namespace, so a reader never has to ask whose card this is', () => {
    const rendered = SettingsCard({ api: cardApi, translator: createTranslator('zh') })
    const text = textOf(rendered)
    expect(text).toContain(SETTINGS_NAMESPACE)
    expect(text).toContain('插件标识')
  })

  it('prints the same identifier in English, with the package name unchanged', () => {
    const text = textOf(SettingsCard({ api: cardApi, translator: createTranslator('en') }))
    expect(text).toContain('Plugin id')
    // The identifier is data, not copy: it must not be localized.
    expect(text).toContain(SETTINGS_NAMESPACE)
  })

  /**
   * The section renders a `<ul>`, and every other card in it is one `<li>` with a
   * header button that expands the body. The operator asked for exactly that
   * after finding this card laid out as a permanently-open form.
   */
  it('is one <li> card that starts COLLAPSED — no inputs until it is expanded', () => {
    const rendered = SettingsCard({ api: cardApi, translator: createTranslator('zh') })
    expect(rendered.type).toBe('li')
    expect(JSON.stringify(rendered)).toContain('"aria-expanded":false')
    // The header carries the title and the identity…
    const text = textOf(rendered)
    expect(text).toContain('监督桥设置')
    expect(text).toContain(SETTINGS_NAMESPACE)
    // …and the BODY is absent: not one field label is rendered while collapsed.
    expect(text).not.toContain('默认工作目录')
    expect(text).not.toContain('最大并发会话数')
  })
})

describe('SettingsFields — the expanded body keeps every field', () => {
  /** Two rows is enough: one scalar (live) and one list (reload + overridden). */
  const view: ClientSettingsView = {
    namespace: SETTINGS_NAMESPACE,
    writable: true,
    fields: [
      {
        key: 'defaultCwd',
        kind: 'string',
        effect: 'live',
        reason: 'read on every run',
        value: undefined,
        overridden: false,
      },
      {
        key: 'allowedCwd',
        kind: 'strings',
        effect: 'reload',
        reason: 'snapshotted when the manager is built',
        value: [],
        overridden: true,
      },
    ],
  }

  const fields = (overrides: Partial<Parameters<typeof SettingsFields>[0]> = {}) =>
    SettingsFields({
      view,
      drafts: {},
      busy: false,
      translator: createTranslator('zh'),
      onEdit: () => {},
      onReset: () => {},
      ...overrides,
    })

  it('labels each control and states when the change takes effect', () => {
    const text = textOf(fields())
    expect(text).toContain('默认工作目录')
    expect(text).toContain('立即生效')
    expect(text).toContain('跟随部署配置')
    expect(text).toContain('允许的工作目录白名单')
    expect(text).toContain('下次加载生效')
    // Only the overridden row offers a way back.
    expect(text).toContain('已被用户覆盖')
    expect(text).toContain('恢复默认')
  })

  it('renders an unknown field by its raw key rather than dropping it', () => {
    // The Node half can add a field before this half ships copy for it; losing
    // the row entirely would be the silent failure.
    const text = textOf(
      fields({
        view: {
          ...view,
          fields: [
            {
              key: 'brandNewKnob',
              kind: 'natural',
              effect: 'reload',
              reason: 'added by the Node half',
              value: undefined,
              overridden: false,
            },
          ],
        },
      }),
    )
    expect(text).toContain('brandNewKnob')
    expect(text).toContain('added by the Node half')
  })
})
