/**
 * Bundle the Node half of dsh-agents-bridge.
 *
 * Everything published by `@deepseek-ai/*` MUST stay external: the DSH profile
 * already provides those packages at runtime, and bundling a second copy of
 * `@deepseek-ai/dsh-tools` would produce two registries (silent tool loss).
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
