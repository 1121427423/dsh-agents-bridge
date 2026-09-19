/**
 * The Qoder CN CLI's headless stream-json dialect (D46).
 *
 * These assertions encode the MEASUREMENTS the dialect was built from, and the
 * two of them that make it a dialect rather than a reuse of `codebuddy` are the
 * flag-spelling ones: `--verbose` does not exist on this CLI, and the effort
 * dial is `--reasoning-effort`. Both are negative controls — a copy-paste of the
 * codebuddy dialect would pass every other assertion in this file.
 *
 * @module tests/drivers/qoderclicn
 */

import { describe, expect, it } from 'vitest'

import {
  buildQoderclicnArgs,
  QODERCLICN_BLOCKED_ARGS,
  QODERCLICN_DIALECT,
} from '../../src/drivers/qoderclicn.ts'

describe('the qoderclicn headless dialect (D46)', () => {
  it('pins the measured headless argv, and nothing claude-specific', () => {
    expect(QODERCLICN_DIALECT.fixedArgs).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-mode',
      'bypass_permissions',
    ])
    // Measured: `qoderclicn -p --verbose` answers `error: unknown option
    // '--verbose'`, and BOTH sibling dialects pass it. This is the difference
    // that makes a copy of codebuddy's dialect wrong rather than merely untidy.
    expect(QODERCLICN_DIALECT.fixedArgs).not.toContain('--verbose')
    // The mode is spelled with underscores on this CLI.
    expect(QODERCLICN_DIALECT.fixedArgs).not.toContain('bypassPermissions')
    // Nothing to deny: the real `system/init` tool list has no AskUserQuestion.
    expect(QODERCLICN_DIALECT.fixedArgs).not.toContain('--disallowedTools')
  })

  it('spells the effort dial the way THIS CLI does, and only that way', () => {
    const args = buildQoderclicnArgs({ effort: 'low' })
    expect(args).toContain('--reasoning-effort')
    // Measured: `--effort` is `error: unknown option` here, so emitting claude's
    // spelling would fail the launch outright.
    expect(args).not.toContain('--effort')
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('low')
  })

  it('reaches the model and resume flags this CLI really has', () => {
    expect(buildQoderclicnArgs({ model: 'qfmodel', resumeSessionId: 'sess-1' })).toEqual([
      ...QODERCLICN_DIALECT.fixedArgs,
      '--model',
      'qfmodel',
      '--resume',
      'sess-1',
    ])
  })

  it('drops caller-supplied flags the driver owns, without duplicating the fixed ones', () => {
    const args = buildQoderclicnArgs({
      extraArgs: [
        '-p',
        '--output-format',
        'text',
        '--permission-mode',
        'default',
        '--reasoning-effort',
        'high',
        '--keep',
      ],
    })
    const count = (flag: string): number => args.filter((token) => token === flag).length
    // The caller's own flag survives.
    expect(args).toContain('--keep')
    // …and every driver-owned one appears exactly ONCE — the fixed copy — with
    // the caller's VALUE dropped alongside it.
    expect(count('-p')).toBe(1)
    expect(count('--output-format')).toBe(1)
    expect(args).not.toContain('text')
    expect(count('--permission-mode')).toBe(1)
    expect(args).not.toContain('default')
    expect(count('--reasoning-effort')).toBe(0)
    expect(args).not.toContain('high')
  })

  it('claims only the knobs it measured, and leaves the unverified ones conservative', () => {
    // Each of these is a deliberate side of an unverified question; the test
    // exists so flipping one is a decision, not a drift.
    expect(QODERCLICN_DIALECT.strictMcpConfigWhenManaged).toBe(false)
    expect(QODERCLICN_DIALECT.forwardSystemPrompt).toBe(false)
    expect(QODERCLICN_DIALECT.readsTerminalReason).toBe(false)
    expect(QODERCLICN_DIALECT.controlResponseIncludesAllowed).toBe(true)
    expect(QODERCLICN_DIALECT.effortFlag).toBe('--reasoning-effort')
  })

  it('keeps the blocked map on this CLI\'s spellings', () => {
    expect(QODERCLICN_BLOCKED_ARGS['--reasoning-effort']).toBe('withValue')
    expect(QODERCLICN_BLOCKED_ARGS['--output-format']).toBe('withValue')
    expect(QODERCLICN_BLOCKED_ARGS['--input-format']).toBe('withValue')
    expect(QODERCLICN_BLOCKED_ARGS['--permission-mode']).toBe('withValue')
    // `-p` takes no value on this CLI, but a caller writing `-p "text"` must not
    // leave `text` behind as a positional prompt competing with the stdin frame.
    expect(QODERCLICN_BLOCKED_ARGS['-p']).toBe('optionalValue')
    // claude's spelling is not this CLI's flag; blocking it would be noise.
    expect(QODERCLICN_BLOCKED_ARGS['--effort']).toBeUndefined()
  })
})
