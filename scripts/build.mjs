/**
 * Bundle the Node half of dsh-agents-bridge.
 *
 * Everything published by `@deepseek-ai/*` MUST stay external: the DSH profile
 * already provides those packages at runtime, and bundling a second copy of
 * `@deepseek-ai/dsh-tools` would produce two registries (silent tool loss).
 *
 * The CLIENT half is a separate bundle with its own rules (browser platform,
 * CommonJS for the host's module table) — see `scripts/build-client.mjs`. Both
 * are produced by `pnpm run build`; keeping them in two files rather than one
 * script with a branch means each bundle's externals/platform are stated once,
 * next to the half they belong to.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  // Keep every harness package external (types + singleton services).
  external: ['@deepseek-ai/*'],
})
