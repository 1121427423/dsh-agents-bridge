/**
 * `src/client/styles.ts` — the panel stylesheet.
 *
 * The stylesheet is a string, so it is asserted as one. Two rules decide whether
 * the panel is usable in whatever theme the human runs:
 *
 *  1. every colour resolves through a `--dsw-*` host token (the real names,
 *     extracted from `dsh-better-sidebar`'s compiled CSS) and carries a
 *     fallback, so a renamed token degrades to a readable default;
 *  2. nothing hardcodes a light background. A `#fff` panel in dark mode is the
 *     exact failure this rule exists to prevent.
 *
 * @module tests/client/styles
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ROOT_CLASS, STYLE_TAG_ID, injectStyles } from '../../src/client/styles.ts'

/* -------------------------------------------------------------------------- */
/* DOM stub — the stylesheet injector is the one place the client half         */
/* touches `document`, and it is worth asserting that it cleans up after itself.*/
/* -------------------------------------------------------------------------- */

interface FakeStyle {
  readonly dataset: Record<string, string>
  textContent: string
  removed: boolean
  remove(): void
}

/** Install a minimal `document` over `globalThis`; returns the teardown. */
function withDocument() {
  const created: FakeStyle[] = []
  const head: unknown[] = []
  const previous = (globalThis as { document?: unknown }).document
  ;(globalThis as { document: unknown }).document = {
    querySelector(selector: string) {
      // The injector dedupes on `style[data-plugin-css="<id>"]`.
      const match = /data-plugin-css="([^"]+)"/.exec(selector)
      const wanted = match?.[1]
      return head.find(node => (node as FakeStyle).dataset['pluginCss'] === wanted) ?? null
    },
    createElement() {
      const style: FakeStyle = {
        dataset: {},
        textContent: '',
        removed: false,
        remove() {
          style.removed = true
          const index = head.indexOf(style)
          if (index >= 0) head.splice(index, 1)
        },
      }
      created.push(style)
      return style
    },
    head: {
      appendChild(node: unknown) {
        head.push(node)
        return node
      },
    },
  }
  return {
    created,
    head,
    teardown() {
      ;(globalThis as { document?: unknown }).document = previous
    },
  }
}

const installed = withDocument()
afterEach(() => {
  // One document per test file keeps the assertions independent of order.
  for (const style of installed.created.splice(0)) style.remove()
  installed.head.splice(0)
})

/* -------------------------------------------------------------------------- */
/* Injection                                                                  */
/* -------------------------------------------------------------------------- */

describe('injectStyles', () => {
  it('inserts exactly one tagged <style> and tags it with this plugin', () => {
    const dispose = injectStyles()
    expect(installed.created).toHaveLength(1)
    expect(installed.created[0]?.dataset['plugin']).toBe('dsh-agents-bridge')
    expect(installed.created[0]?.dataset['pluginCss']).toBe(STYLE_TAG_ID)
    dispose()
  })

  it('is idempotent — an HMR reload must not stack copies', () => {
    const first = injectStyles()
    const second = injectStyles()
    expect(installed.created).toHaveLength(1)
    // The second call owns no tag, so its disposer must not remove the first one.
    second()
    expect(installed.created[0]?.removed).toBe(false)
    first()
    expect(installed.created[0]?.removed).toBe(true)
  })

  it('removes its own tag on disposal', () => {
    const dispose = injectStyles()
    expect(installed.head).toHaveLength(1)
    dispose()
    expect(installed.head).toHaveLength(0)
  })

  it('is a no-op without a document (a non-DOM renderer)', () => {
    const stub = withDocument()
    const documentRef = (globalThis as { document?: unknown }).document
    delete (globalThis as { document?: unknown }).document
    try {
      const dispose = injectStyles()
      expect(stub.created).toHaveLength(0)
      expect(() => dispose()).not.toThrow()
    } finally {
      ;(globalThis as { document?: unknown }).document = documentRef
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The stylesheet itself                                                      */
/* -------------------------------------------------------------------------- */

describe('stylesheet', () => {
  const css = (() => {
    injectStyles()
    return installed.created[0]?.textContent ?? ''
  })()

  it('namespaces every rule under the plugin root (no bare element selectors)', () => {
    expect(css).toContain(`.${ROOT_CLASS}`)
    // A rule that styles a bare `div`/`button` would leak into the host UI.
    expect(/^\s*(div|button|span|a|input)\s*\{/m.test(css)).toBe(false)
  })

  it('uses host theme tokens for every colour', () => {
    expect(css).toContain('var(--dsw-alias-label-primary')
    expect(css).toContain('var(--dsw-alias-label-secondary')
    expect(css).toContain('var(--dsw-alias-bg-layer-1')
    expect(css).toContain('var(--dsw-alias-border-l1')
    expect(css).toContain('var(--dsw-alias-state-success-primary')
    expect(css).toContain('var(--dsw-alias-state-error-primary')
    expect(css).toContain('var(--dsw-alias-state-warn-primary')
    expect(css).toContain('var(--dsw-alias-interactive-bg-hover')
  })

  it('hardcodes NO background colour (the dark-mode trap)', () => {
    // Every `background`/`background-color` declaration must resolve through a
    // token, a mask, or `transparent` — never a literal light colour.
    const declarations = css.match(/background(-color)?\s*:[^;}]+/g) ?? []
    expect(declarations.length).toBeGreaterThan(0)
    for (const declaration of declarations) {
      expect(declaration).toMatch(/var\(--dsw-[\w-]+|transparent|currentColor|none/)
    }
    // A literal colour in a background is the exact failure. `white-space` is a
    // layout property, not a colour, so the pattern is colour-shaped on purpose.
    expect(/#fff\b|#ffffff\b|\bwhite\b|rgb\(\s*255/i.test(css.replace(/white-space/g, ''))).toBe(false)
    expect(/\bcolor\s*:\s*(#|rgb|hsl|white|black)/i.test(css)).toBe(false)
  })

  it('gives every token a fallback so a renamed token still renders', () => {
    // `var(--x)` with no fallback renders as the invalid-value default, which
    // for `color` is inherited but for `background` is transparent — a silent
    // regression. Every non-`currentColor` token therefore carries a fallback.
    const tokens = css.match(/var\(--dsw-[a-z0-9-]+([^)]*)\)/g) ?? []
    expect(tokens.length).toBeGreaterThan(10)
    const withoutFallback = tokens.filter(token => !/var\(--dsw-[a-z0-9-]+\s*,/.test(token))
    // A short allowlist: tokens whose absence is benign because the property
    // falls back to a sane CSS default anyway.
    const allowed = withoutFallback.filter(token => /emoji|shorthand/.test(token))
    expect(withoutFallback.length).toBe(allowed.length)
  })

  it('honours prefers-reduced-motion for the one animation it adds', () => {
    expect(css).toContain('@keyframes abg-pulse')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('styles the status badge differently per status', () => {
    for (const status of ['running', 'completed', 'failed', 'cancelled', 'timeout']) {
      expect(css).toContain(`data-status='${status}'`)
    }
  })

  it('keeps the panel scrollable rather than letting the list grow unbounded', () => {
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('min-height: 0')
  })
})
