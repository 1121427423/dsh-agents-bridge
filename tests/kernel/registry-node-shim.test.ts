/**
 * The `env: node: No such file or directory` regression, end to end.
 *
 * The reported symptom: in a GUI-launched host (PATH = `/usr/bin:/bin:/usr/sbin:/sbin`,
 * no `node` anywhere) the identity rows for `claude`, `codex` and
 * `codebuddy-code` each showed that string — and showed it as their VERSION,
 * while being marked `available: true`. Two defects stacked:
 *
 *  1. the version probe built its argv by hand out of
 *     `ResolvedIdentity.interpreterPath`, which is set ONLY when the DESCRIPTOR
 *     pins an `interpreter`. The CLI track's shim repair writes
 *     `command.interpreter` instead, so the probe spawned the bare shim and the
 *     child died before printing anything;
 *  2. `defaultVersionProbe` concatenated stdout AND stderr and parsed the
 *     result, so `parseVersion`'s "no semver → first non-empty line" fallback
 *     published the child's error text as a version.
 *
 * These tests use a FIXTURE shim (`tests/fixtures/node-shim-cli.mjs`) and the
 * REAL `defaultVersionProbe`, and they never touch this machine's installed
 * CLIs: the interpreter is the node running the suite, injected as the policy's
 * `resolveNode`. See `docs/findings-node-shim.md`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { createRegistry, defaultVersionProbe } from '../../src/kernel/registry.ts'
import type { AgentDescriptor } from '../../src/kernel/types.ts'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'node-shim-cli.mjs')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-node-shim-'))

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/**
 * A bin directory holding one copy of the fixture shim under `name`, plus an
 * EMPTY directory to use as the child's PATH.
 *
 * The empty dir is a real directory rather than a path that does not exist, so
 * "node is not on PATH" is a fact about the directory's contents and not about
 * a lookup error — the same distinction `lookupOnPath` makes.
 */
function shimBin(name: string): { readonly bin: string; readonly emptyPath: string; readonly shim: string } {
  const bin = path.join(tmpRoot, `${name}-bin`)
  const emptyPath = path.join(tmpRoot, `${name}-empty-path`)
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(emptyPath, { recursive: true })
  const shim = path.join(bin, name)
  fs.copyFileSync(FIXTURE, shim)
  fs.chmodSync(shim, 0o755)
  return { bin, emptyPath, shim }
}

function fixtureDescriptor(id: string, executable: string): AgentDescriptor {
  return {
    id,
    track: 'cli',
    family: 'claude',
    displayName: `fixture node shim (${id})`,
    command: { executable },
    envPrefix: 'FIXTURE',
  }
}

describe('a repaired node shim answers --version', () => {
  it('reads the version through the REPAIRED interpreter when node is not on the child PATH', async () => {
    const { bin, emptyPath, shim } = shimBin('repaired-cli')
    const registry = createRegistry({
      env: { PATH: emptyPath },
      scan: false,
      portProbe: false,
      trackPolicyOptions: {
        searchPath: [bin],
        // The `node` this host has OFF the child's PATH. Injected so the test is
        // independent of where node is installed; it is the same binary running
        // this suite, so it is guaranteed to exist.
        resolveNode: () => process.execPath,
      },
      extraDescriptors: [fixtureDescriptor('repaired-shim', 'repaired-cli')],
    })

    // The repair is the CLI policy's, NOT a descriptor pin — that difference is
    // the whole bug, so assert it explicitly.
    const resolved = registry.resolve('repaired-shim')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.command.executable).toBe(shim)
    expect(resolved.command.interpreter).toBe(process.execPath)
    expect(resolved.interpreterPath).toBeUndefined()

    const result = (await registry.probe({ refresh: true })).find((r) => r.id === 'repaired-shim')
    expect(result?.available).toBe(true)
    expect(result?.version).toBe('9.9.9')
    // The defect's fingerprint: the child's stderr published as a version.
    expect(result?.notes ?? '').not.toContain('No such file or directory')
  })

  it('reports an UNREPAIRABLE shim honestly instead of publishing its stderr as a version', async () => {
    const { bin, emptyPath } = shimBin('unrepairable-cli')
    const registry = createRegistry({
      env: { PATH: emptyPath },
      scan: false,
      portProbe: false,
      trackPolicyOptions: {
        searchPath: [bin],
        // No node anywhere: the repair cannot fire, so the probe really does
        // spawn the bare shim and the child really does die.
        resolveNode: () => undefined,
      },
      extraDescriptors: [fixtureDescriptor('unrepairable-shim', 'unrepairable-cli')],
    })

    const resolved = registry.resolve('unrepairable-shim')
    expect(resolved.reason).toBeUndefined()
    expect(resolved.command.interpreter).toBeUndefined()

    const result = (await registry.probe({ refresh: true })).find((r) => r.id === 'unrepairable-shim')
    // Still launchable as far as the filesystem can tell — the executable was
    // found. What must NOT happen is an error string in `version`.
    expect(result?.available).toBe(true)
    expect(result?.version).toBeUndefined()
    // An unknown version is not an error, but it is not silent either: the
    // reason now lives in a field that explains itself.
    expect(result?.notes).toContain('[probe] --version failed:')
    expect(result?.notes).toContain('No such file or directory')
  })
})

describe('defaultVersionProbe keeps stdout and stderr apart', () => {
  const env = { PATH: '/usr/bin:/bin' }

  it('reads a version from stdout only', async () => {
    const outcome = await defaultVersionProbe({
      argv: ['/bin/sh', '-c', 'echo 1.2.3; echo "a warning" >&2'],
      env,
      timeoutMs: 5_000,
    })
    expect(outcome).toEqual({ version: '1.2.3' })
  })

  it('never publishes a stderr line as a version', async () => {
    const outcome = await defaultVersionProbe({
      argv: ['/bin/sh', '-c', 'echo boom >&2; exit 1'],
      env,
      timeoutMs: 5_000,
    })
    expect(typeof outcome).toBe('object')
    expect(outcome).toMatchObject({ diagnostic: 'boom' })
    expect(outcome).not.toHaveProperty('version')
  })

  it('says nothing when the child fails without a diagnostic', async () => {
    const outcome = await defaultVersionProbe({
      argv: ['/bin/sh', '-c', 'exit 3'],
      env,
      timeoutMs: 5_000,
    })
    expect(outcome).toBeUndefined()
  })
})
