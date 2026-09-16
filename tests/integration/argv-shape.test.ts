/**
 * The SHAPE of the final argv, for every built-in identity.
 *
 * Why this file exists (and why a per-field assertion is not enough): the
 * `autoclaw` / `openclaw` identities shipped for weeks with a *duplicated*
 * `agent` subcommand. The descriptor's `argsPrefix` said `['agent']` while the
 * openclaw driver's `buildOpenclawArgs()` ALSO emits `agent` as its first arg,
 * and `spawn.ts` simply concatenates `[...head, ...argsPrefix, ...args]`. Every
 * existing test asserted a field in isolation — `argsPrefix === ['agent']` — so
 * each one passed while the concatenation the OS actually received was
 * `openclaw agent agent --local …`, which the CLI rejects with
 * "Too many arguments for this command."
 *
 * So this test asserts the one thing nobody was asserting: the assembled
 * argument vector. It is deliberately STRUCTURAL rather than a list of
 * hard-coded expected strings — a new identity, or a new prefix, is checked by
 * the same invariants instead of needing a new expectation to be remembered.
 *
 * It is host-independent by construction: the registry is given an injected
 * executable resolver and `scan: false`, so no real AutoClaw/WorkBuddy install
 * is required (or consulted).
 */

import { describe, expect, it } from 'vitest'

import { BUILTIN_DESCRIPTORS, createRegistry } from '../../src/kernel/registry.ts'
import { buildArgv } from '../../src/kernel/spawn.ts'
import type { AgentDescriptor, CommandSpec, ProtocolFamily } from '../../src/kernel/types.ts'

import { buildAcpArgs } from '../../src/drivers/acp.ts'
import { buildClaudeArgs } from '../../src/drivers/claude.ts'
import { buildCodebuddyArgs } from '../../src/drivers/codebuddy.ts'
import { buildCodexArgs } from '../../src/drivers/codex.ts'
import { buildGenericArgs } from '../../src/drivers/generic-argv.ts'
import { buildOpenclawArgs } from '../../src/drivers/openclaw.ts'

/** The argv the driver contributes for one family (everything after the prefix). */
function driverArgs(family: ProtocolFamily, command: CommandSpec): string[] {
  switch (family) {
    case 'openclaw':
      // `agent` is emitted HERE. A descriptor must therefore never put it in
      // `argsPrefix` — that is the whole point of this file.
      return buildOpenclawArgs({ prompt: 'PROMPT', sessionId: 'SESSION', mode: 'spawn' })
    case 'codex':
      return buildCodexArgs({ prompt: 'PROMPT' })
    case 'claude':
      return buildClaudeArgs({})
    case 'codebuddy':
      return buildCodebuddyArgs({})
    case 'acp':
      // ACP carries the turn over the pipe; argv is only the protocol selector.
      return buildAcpArgs({ protocolArgs: command.protocolArgs })
    case 'generic':
      // The generic driver moves `argsPrefix` into its own arg list rather than
      // leaving it in the command (`buildCommandLine({...command, argsPrefix: []}, …)`).
      // The assembled vector is identical, so `buildArgv` above supplies it.
      return buildGenericArgs({})
    default: {
      // A new family must be given an argv producer here rather than silently
      // skipped — an unchecked identity is exactly how the duplicated `agent`
      // survived.
      const exhaustive: never = family
      throw new Error(`no argv producer for family ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * A registry that resolves every executable to a deterministic fake path.
 *
 * `scan: false` + `env: { PATH: '' }` + `searchPath: []` keep the host's
 * installed apps out of the table; the injected resolver keeps the host's
 * FILESYSTEM out of the decision. Nothing here reads the machine.
 */
function fakeRegistry() {
  return createRegistry({
    env: { PATH: '' },
    scan: false,
    trackPolicyOptions: { searchPath: [] },
    resolveExecutable: (raw) => `/fake/bin/${raw.split('/').at(-1) ?? raw}`,
  })
}

/** `true` when this command launches the openclaw engine (by family or by binary name). */
function isOpenclawEngine(descriptor: AgentDescriptor, command: CommandSpec): boolean {
  if (descriptor.family === 'openclaw') return true
  return /(^|[/\\])openclaw(\.mjs)?$/.test(command.executable)
}

/** Every launchable built-in identity, with its resolved command and final argv. */
function launchedIdentities(): readonly {
  readonly descriptor: AgentDescriptor
  readonly command: CommandSpec
  readonly argv: readonly string[]
}[] {
  const registry = fakeRegistry()
  return BUILTIN_DESCRIPTORS.filter((descriptor) => descriptor.unsupported === undefined).map(
    (descriptor) => {
      const resolved = registry.resolve(descriptor.id)
      // A fake resolver means every identity must be launchable: a `reason`
      // here would mean the argv below is not the one a run would use.
      expect(resolved.reason, `${descriptor.id} must resolve with an injected resolver`).toBeUndefined()
      const command = resolved.command
      return {
        descriptor,
        command,
        argv: buildArgv(command, driverArgs(descriptor.family, command)),
      }
    },
  )
}

describe('assembled argv for every built-in identity', () => {
  it('has no two adjacent identical tokens (the whole class of concatenation bugs)', () => {
    const identities = launchedIdentities()
    // Guard against a vacuous pass: the table must really have been walked.
    expect(identities.length).toBeGreaterThanOrEqual(5)
    for (const { descriptor, argv } of identities) {
      for (let i = 1; i < argv.length; i++) {
        expect(
          argv[i],
          `${descriptor.id}: argv repeats "${String(argv[i])}" at positions ${i - 1} and ${i}: ${argv.join(' ')}`,
        ).not.toBe(argv[i - 1])
      }
    }
  })

  it('emits the `agent` subcommand exactly once for every openclaw engine', () => {
    const identities = launchedIdentities().filter((entry) => isOpenclawEngine(entry.descriptor, entry.command))
    // Guard against a vacuous pass: both openclaw identities must be covered.
    expect(identities.map((entry) => entry.descriptor.id).sort()).toEqual(['autoclaw', 'openclaw'])
    for (const { descriptor, argv } of identities) {
      const agentPositions = argv.flatMap((token, index) => (token === 'agent' ? [index] : []))
      expect(
        agentPositions,
        `${descriptor.id}: \`agent\` must appear exactly once: ${argv.join(' ')}`,
      ).toHaveLength(1)
    }
  })

  it('gives autoclaw its `--profile autoclaw` BEFORE the `agent` subcommand', () => {
    const entry = launchedIdentities().find((candidate) => candidate.descriptor.id === 'autoclaw')
    expect(entry).toBeDefined()
    const argv = entry?.argv ?? []

    const profileIndex = argv.indexOf('--profile')
    expect(profileIndex, `autoclaw must pass --profile: ${argv.join(' ')}`).toBeGreaterThanOrEqual(0)
    // Both spellings are acceptable to the CLI; the descriptor uses the split
    // form, and `openclawProfileFromArgsPrefix` understands both.
    const profileValue = argv[profileIndex + 1]
    expect(profileValue, `autoclaw profile value: ${argv.join(' ')}`).toBe('autoclaw')

    const agentIndex = argv.indexOf('agent')
    expect(agentIndex, `autoclaw must pass the agent subcommand: ${argv.join(' ')}`).toBeGreaterThanOrEqual(0)
    expect(
      profileIndex,
      `--profile must precede agent: ${argv.join(' ')}`,
    ).toBeLessThan(agentIndex)
  })

  it('never puts a driver-owned subcommand in an identity argsPrefix', () => {
    // The openclaw driver owns `agent`; the codex driver owns `exec`. A prefix
    // that repeats either one produces the duplicated-token bug above, so the
    // descriptors are also checked field-by-field for a readable failure.
    for (const descriptor of BUILTIN_DESCRIPTORS) {
      const prefix = descriptor.command.argsPrefix ?? []
      if (descriptor.family === 'openclaw') {
        expect(prefix, `${descriptor.id}: \`agent\` belongs to the driver, not the prefix`).not.toContain('agent')
      }
      if (descriptor.family === 'codex') {
        expect(prefix, `${descriptor.id}: \`exec\` belongs to the driver, not the prefix`).not.toContain('exec')
      }
    }
  })

  it('still puts the openclaw profile in front of the executable-adjacent prefix', () => {
    // The complement of the bug: fixing the duplicate must not have dropped the
    // profile. `--profile autoclaw` has to survive the driver's launch-prefix
    // filter (it does: only protocol flags are blocked) and land before `agent`.
    const entry = launchedIdentities().find((candidate) => candidate.descriptor.id === 'autoclaw')
    const argv = entry?.argv ?? []
    const [interpreter, executable] = argv
    expect(interpreter).toBe('/fake/bin/node')
    expect(executable).toBe('/fake/bin/openclaw.mjs')
    expect(argv.slice(2, 5)).toEqual(['--profile', 'autoclaw', 'agent'])
  })
})
