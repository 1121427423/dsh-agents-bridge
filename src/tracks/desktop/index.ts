/**
 * dsh-agents-bridge / desktop track policy.
 *
 * The desktop policy refuses anything it cannot verify statically, and it never
 * repairs, guesses or falls back — a desktop engine that moved is a finding for
 * the user, not something to paper over. Contrast with the CLI policy, which
 * searches and (narrowly) repairs: the two tracks exist because those two
 * answers must never bleed into each other.
 *
 * @module dsh-agents-bridge/tracks/desktop
 */

import type { CommandSpec } from '../../kernel/types.ts'
import { notFoundReason, type LaunchInput, type TrackPolicy } from '../types.ts'

/** Same shape as the CLI policy's return, kept local so neither imports the other. */
type LaunchOutcome = { readonly command: CommandSpec } | { readonly reason: string }

export function createDesktopPolicy(): TrackPolicy {
  return {
    track: 'desktop',
    label: 'Desktop track (app-bundled engine)',
    searchPath: [],
    launch(input: LaunchInput): LaunchOutcome {
      const { descriptor, executablePath, interpreterPath } = input
      if (executablePath === undefined) {
        // Names the bundle the descriptor expects, so a moved/renamed app is
        // diagnosable from the probe line alone.
        return {
          reason: `${notFoundReason('executable', input.rawExecutable, descriptor.envPrefix)} — ${descriptor.displayName} is expected at that bundle path`,
        }
      }
      if (input.rawInterpreter !== undefined && interpreterPath === undefined) {
        return { reason: notFoundReason('interpreter', input.rawInterpreter, descriptor.envPrefix) }
      }
      return {
        command: {
          executable: executablePath,
          ...(interpreterPath !== undefined ? { interpreter: interpreterPath } : {}),
          ...(descriptor.command.argsPrefix !== undefined ? { argsPrefix: descriptor.command.argsPrefix } : {}),
          ...(descriptor.command.env !== undefined ? { env: descriptor.command.env } : {}),
        },
      }
    },
  }
}
