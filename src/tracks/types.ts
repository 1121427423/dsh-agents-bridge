/**
 * dsh-agents-bridge / tracks — the seam between the two integration tracks.
 *
 * The kernel knows how to run a *protocol*; a track knows how to *establish*
 * an engine on this host. The two tracks are deliberately separate modules
 * with separate policies (decision D21): the CLI track may search PATH and may
 * repair a `#!/usr/bin/env node` shebang, the desktop track may do neither and
 * never guesses. Neither imports the other.
 *
 * A policy is pure with respect to the host: it receives the already-resolved
 * absolute paths and returns a `CommandSpec` (or a refusal), so both tracks are
 * unit-testable without spawning anything.
 *
 * @module dsh-agents-bridge/tracks/types
 */

import type { AgentDescriptor, AgentTrack, CommandSpec } from '../kernel/types.ts'

/** Everything a policy may look at. No policy reads `process.env` directly. */
export interface LaunchInput {
  readonly descriptor: AgentDescriptor
  /** Absolute path of `descriptor.command.executable`, when it was found. */
  readonly executablePath?: string
  /** Absolute path of `descriptor.command.interpreter`, when it was found. */
  readonly interpreterPath?: string
  /** Host environment (already filtered by the caller). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** `<PREFIX>_MODEL` / `<PREFIX>_PATH` style overrides already applied. */
  readonly rawExecutable: string
  readonly rawInterpreter?: string
}

/**
 * How a track answers "is this identity launchable, and with what argv".
 * `launch` is the only required member: `credentialPath` and `modelCatalog`
 * are optional capabilities a track may or may not have at all.
 */
export interface TrackPolicy {
  readonly track: AgentTrack
  /** Human-readable name used in probe output and errors. */
  readonly label: string
  /** Extra directories searched for a bare executable, before the inherited PATH. */
  readonly searchPath: readonly string[]
  /**
   * Turn the resolved identity into the exact `CommandSpec` to launch.
   * Returns `{ reason }` instead of throwing when the track refuses the launch
   * (a refusal is a normal probe outcome, not an exception).
   */
  launch(input: LaunchInput): { readonly command: CommandSpec } | { readonly reason: string }
}

/** A file a track reads to report credential status, without touching the secret. */
export interface CredentialSource {
  /** Absolute path of the config/credential file. */
  readonly path: string
  /**
   * Does the file hold a credential? Never returns the credential itself, and
   * never performs a network call — `agents_probe` must stay cheap and silent.
   */
  readonly hasCredential: (contents: string) => boolean
  /** What the engine calls this credential, for the probe line. */
  readonly label: string
}

/**
 * The one wording both tracks use for "I could not find it". Shared on purpose:
 * the model-facing probe output must not change shape depending on which half
 * of the bridge produced the line, and `<PREFIX>_PATH` is the documented way
 * out for either track.
 */
export function notFoundReason(
  what: 'executable' | 'interpreter',
  raw: string,
  envPrefix: string | undefined,
): string {
  const hint = envPrefix
    ? ` (set ${envPrefix.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PATH to override)`
    : ''
  return `${what} not found or not executable: ${raw}${hint}`
}

/** Optional per-identity model catalog reader (decision D20). */
export interface ModelCatalogSource {
  readonly path: string
  readonly read: (contents: string) => readonly string[]
}
