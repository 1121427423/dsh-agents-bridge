/**
 * A minimal stand-in for the HOST-PROVIDED `react` module.
 *
 * The client half targets `dsh.client.platform: 'web'`, where the DSH web
 * client's module table supplies `react` (`dsh-history/lib/client-registry.js`
 * does exactly this: `require("react")`). This repo therefore never installs it
 * (D10 — the shared `node_modules` tree cannot be re-resolved), and esbuild
 * keeps it external.
 *
 * Vitest, however, loads `src/client/**` as ordinary modules and needs SOMETHING
 * to resolve `react` to. This file exists only for that: it re-exports the few
 * primitives the client half calls, with the real `createElement` semantics
 * (children flattened into a props array) so a test can inspect a rendered tree
 * without a DOM. It is never bundled into `lib/client.js`.
 *
 * @module tests/stubs/react
 */

/** One element produced by {@link createElement}. */
export interface StubElement {
  readonly type: unknown
  readonly props: Record<string, unknown> & { readonly children: unknown[] }
  readonly key: string | number | null
}

/** Flatten arbitrary children into a single array, dropping null/undefined. */
function flatten(children: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child))
    else if (child !== null && child !== undefined && child !== false) out.push(child)
  }
  return out
}

/** The real `createElement` shape, trimmed to what the client half uses. */
export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): StubElement {
  const { children: declared, key, ...rest } = props ?? {}
  const merged = declared !== undefined ? flatten([declared, ...children]) : flatten(children)
  return {
    type,
    props: { ...rest, children: merged },
    key: typeof key === 'string' || typeof key === 'number' ? key : null,
  }
}

/**
 * A no-op hook surface.
 *
 * `useState`/`useEffect`/`useMemo`/`useCallback` are only meaningful inside a
 * real render; the client half's LOGIC is tested without React (see
 * `tests/client/util.test.ts` and `store.test.ts`), so these exist to keep a
 * module import from throwing, not to emulate a renderer.
 */
export function useState<T>(initial: T | (() => T)): [T, (next: T) => void] {
  const value = typeof initial === 'function' ? (initial as () => T)() : initial
  return [value, () => {}]
}

export function useEffect(): void {}
export function useMemo<T>(factory: () => T): T {
  return factory()
}
export function useCallback<T>(callback: T): T {
  return callback
}
export function useSyncExternalStore<T>(_subscribe: () => () => void, getSnapshot: () => T): T {
  return getSnapshot()
}

export default { createElement, useState, useEffect, useMemo, useCallback, useSyncExternalStore }
