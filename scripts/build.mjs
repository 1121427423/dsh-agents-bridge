/**
 * Bundle the Node half of dsh-agents-bridge.
 *
 * Everything published by `@deepseek-ai/*` MUST stay external: the DSH profile
 * already provides those packages at runtime, and bundling a second copy of
 * `@deepseek-ai/dsh-tools` would produce two registries (silent tool loss).
 *
 * THIS FILE IS ALSO WHERE "WHAT THE HOST PROVIDES" IS DECLARED FOR BOTH HALVES
 * ---------------------------------------------------------------------------
 * `CLIENT_EXTERNALS` (below) is the single source of truth for the modules the
 * client bundle must never inline, and `scripts/build-client.mjs` imports it
 * rather than restating it. The reason is the same one that makes the Node
 * half's list live here: "the host already has this module" is one fact about
 * the deployment, not two facts about two bundles — and a second copy of React
 * inside `lib/client.js` is not a size problem, it is a correctness problem
 * (its own hooks dispatcher: "invalid hook call" at best, a silently
 * desynchronized tree at worst).
 *
 * When run directly this file builds the Node bundle only; the client bundle is
 * `scripts/build-client.mjs`, and `pnpm run build` runs both.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Node-half externals: the DSH profile provides every `@deepseek-ai/*` package. */
export const HOST_EXTERNALS = ['@deepseek-ai/*']

/**
 * Client-half externals — everything the DSH web client's module table hands
 * the factory's `require`.
 *
 * `react-dom` / `react-dom/client` are listed even though the current client
 * half does not import them: they are the two entry points a React panel
 * reaches for the moment it wants a portal, and an unlisted React-family
 * module is exactly how a second React gets inlined. `csstype` is
 * types-only today but is listed for the same reason (`react`'s types resolve
 * through it).
 */
export const CLIENT_EXTERNALS = [
  '@deepseek-ai/*',
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'csstype',
]

/** Build the Node half into `lib/index.js`. */
export async function buildHost() {
  await build({
    entryPoints: [path.join(root, 'src/index.ts')],
    outfile: path.join(root, 'lib/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'info',
    external: HOST_EXTERNALS,
  })
}

// Only build when this file is the entry point — `scripts/build-client.mjs`
// imports `CLIENT_EXTERNALS` from here and must not trigger a host build.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildHost()
}
