/**
 * dsh-agents-bridge / tracks — assembly point for the two tracks.
 *
 * ONE mechanism, TWO implementations (decision D21):
 *   - `src/tracks/cli`     — standalone user-installed binaries.
 *   - `src/tracks/desktop` — app-bundled engines driven through the app's login.
 *
 * The kernel imports only this module; it never learns which track a descriptor
 * belongs to beyond passing `descriptor.track` back to `policyFor`.
 *
 * @module dsh-agents-bridge/tracks
 */

import type { AgentDescriptor, AgentTrack } from '../kernel/types.ts'
import { CLI_TRACK_DESCRIPTORS } from './cli/catalog.ts'
import { createCliPolicy, type CliPolicyDeps } from './cli/index.ts'
import { DESKTOP_TRACK_DESCRIPTORS } from './desktop/catalog.ts'
import { createDesktopPolicy } from './desktop/index.ts'
import type { TrackPolicy } from './types.ts'

export { CLI_SEARCH_PATH, createCliPolicy, expandSearchPath, findNode, readShebang, wantsNode } from './cli/index.ts'
export { createDesktopPolicy } from './desktop/index.ts'
export { CLI_TRACK_DESCRIPTORS } from './cli/catalog.ts'
export { DESKTOP_TRACK_DESCRIPTORS } from './desktop/catalog.ts'
export type { CredentialSource, LaunchInput, ModelCatalogSource, TrackPolicy } from './types.ts'
// Health + model discovery (D20). Both are pure readers over local config files:
// no network call, and no credential VALUE ever leaves them.
export { credentialStatusFor, healthFor, looksLikePlaceholder } from './health.ts'
export type { CredentialHealth, CredentialReaderOptions } from './health.ts'
export { creditSummary, modelFieldsFor, modelsFor, stripContextMarker } from './models.ts'
export type { ModelDiscovery, ModelFound, ModelNotDiscovered, ModelReaderOptions } from './models.ts'

/** Every built-in identity, CLI track first (probe order). */
export const BUILTIN_DESCRIPTORS: readonly AgentDescriptor[] = [
  ...CLI_TRACK_DESCRIPTORS,
  ...DESKTOP_TRACK_DESCRIPTORS,
]

export interface TrackPolicyOptions extends CliPolicyDeps {}

/**
 * The policy for one track. Built lazily and memoised: the CLI policy may look
 * at the filesystem, and a caller that only probes desktop engines should not
 * pay for it.
 */
export function policyFor(track: AgentTrack, options: TrackPolicyOptions = {}): TrackPolicy {
  switch (track) {
    case 'cli':
      return createCliPolicy(options)
    case 'desktop':
      return createDesktopPolicy()
    default: {
      const exhaustive: never = track
      throw new Error(`dsh-agents-bridge: unknown track ${JSON.stringify(exhaustive)}`)
    }
  }
}
