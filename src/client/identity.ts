/**
 * dsh-agents-bridge client half — the plugin's own name, injected at BUILD time.
 *
 * WHY THIS IS NOT A STRING LITERAL
 * --------------------------------
 * Three separate host-side contracts are keyed on the exact package name:
 *
 *   1. `window.__ModuleLoader__.load({ id })` — the module table's key for this
 *      bundle (see `scripts/build-client.mjs`);
 *   2. the slot registration `id` (`PANEL_ID` / `INDICATOR_ID`) — the host
 *      dedupes registrations on it;
 *   3. the slot registration `registrant` — how the host attributes a slot to
 *      the plugin that owns it.
 *
 * A literal in any of those three places disagrees with `package.json#name` the
 * moment the package is renamed, and it disagrees SILENTLY: the bundle still
 * loads, the registrations still happen, and the UI simply never appears
 * (nothing errors, because nothing looks for the old name). So the name is
 * declared exactly once — in `package.json` — and reaches this module through
 * the bundler's `define`, which `scripts/build-client.mjs` populates from that
 * file. `vitest.config.ts` sets the same define so the unit tests exercise the
 * real value rather than a fallback.
 *
 * There is deliberately NO runtime fallback: if the define is missing, this
 * module throws a `ReferenceError` at import time, which is the loudest
 * possible failure and exactly what a mis-wired build deserves.
 *
 * @module dsh-agents-bridge/client/identity
 */

/** Replaced by esbuild/vite `define` with `JSON.stringify(package.json#name)`. */
declare const __PACKAGE_NAME__: string

/** `package.json#name` — ModuleLoader id, slot registrant, slot id prefix. */
export const PACKAGE_NAME: string = __PACKAGE_NAME__
