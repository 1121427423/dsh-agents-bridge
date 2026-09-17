/**
 * Vitest configuration — one alias, and the reason for it.
 *
 * `react` is HOST-PROVIDED (the client half declares
 * `dsh.client.platform: 'web'`; the DSH web client's module table supplies
 * `require('react')` at runtime) and is deliberately not installed in this repo
 * (D10: the shared `node_modules` tree cannot be re-resolved, and `react` is not
 * in it). `tsc` resolves it through the vendored types in `tsconfig.json`; the
 * BUNDLE keeps it external (`scripts/build-client.mjs`).
 *
 * That leaves exactly one consumer — vitest — that has to resolve the module for
 * real when it loads `src/client/**`. It points at `tests/stubs/react.ts`, a
 * minimal `createElement`, so the client half's module graph can be imported and
 * its non-React logic exercised. Nothing here changes what ships.
 */
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

/**
 * `src/client/identity.ts` reads the package name from the bundler's `define`
 * (see its module note). The bundle gets it from `scripts/build-client.mjs`;
 * the tests get it from here, from the SAME `package.json#name`, so a test can
 * never disagree with what ships. No fallback value on purpose: a missing
 * define must throw, not quietly pick a name.
 */
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string }

export default defineConfig({
  define: {
    __PACKAGE_NAME__: JSON.stringify(pkg.name),
  },
  resolve: {
    alias: {
      react: path.join(root, 'tests', 'stubs', 'react.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // The kernel/driver suites spawn real child processes; running files in
    // parallel keeps the suite well under a second while `--maxWorkers` stays
    // the caller's business (better-sidebar uses the same escape hatch on
    // Windows).
    environment: 'node',
  },
})
