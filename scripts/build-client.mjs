/**
 * Bundle the CLIENT half of dsh-agents-bridge (`src/client/index.ts` →
 * `lib/client.js`).
 *
 * WHAT MAKES THIS DIFFERENT FROM `build.mjs`
 * ------------------------------------------
 * The Node half is ESM for Node; this half is a browser module consumed by the
 * DSH web client's module table (`window.__ModuleLoader__.load({ id, factory })`
 * — see `dsh-history/lib/client-registry.js`), so it must be:
 *
 *   - `platform: 'browser'` — no `node:` builtins, no `process` shim;
 *   - `format: 'cjs'` — the module table calls a CommonJS-shaped `factory`,
 *     not an ES module `import()`;
 *   - `target: 'es2020'` — the widest engine set a desktop shell might embed,
 *     while still allowing `?.`/`??`.
 *
 * `react` AND every `@deepseek-ai/*` package stay EXTERNAL, for the same reason
 * the Node half keeps them external: the host provides exactly one copy of
 * each. Bundling a second `react` gives the panel its own hooks dispatcher
 * (React's "invalid hook call" at best, a silently desynchronized tree at
 * worst), and a bundled `@deepseek-ai/*` would duplicate a singleton service.
 * The host's module table resolves them through the `require` it hands the
 * factory.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

await build({
  entryPoints: [path.join(root, 'src/client/index.ts')],
  outfile: path.join(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  logLevel: 'info',
  // `react` is provided by the host (and `react/jsx-runtime` is not used — the
  // client half calls `createElement` directly, so a JSX runtime would be a
  // second React entry point for no benefit).
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'csstype'],
})
