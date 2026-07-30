/**
 * The P4 feed's CLOSED status vocabulary — exhaustive, including the off-vocabulary case.
 *
 * The precedent this follows: `SWARM_BLOCKED_TAGS` / `SWARM_TRIAGE_ACTIONS` /
 * `SWARM_WORKTREE_DISPOSITIONS` each carry a test that walks every member AND proves the fallback
 * for a value outside the set is the SAFE one. The fallback is the point: a worker is untrusted
 * text on a wire, and the whole feature is worthless if an unreadable status is quietly rendered
 * as success.
 */
import { describe, expect, it } from 'vitest'
import {
  COMMAND_FEED_STATES,
  MAX_FEED_REFS,
  classifyFeedStatus,
  clampLine,
  flattenLine,
  isCommandFeedState,
  sanitizeFeedResult
} from './commandFeedTypes'

describe('classifyFeedStatus', () => {
  it.each(['done', 'ok', 'okay', 'success', 'succeeded', 'complete', 'completed'])(
    'reads %s as done with no disclosure noise',
    (raw) => {
      expect(classifyFeedStatus(raw)).toEqual({ state: 'done' })
    }
  )

  it.each(['failed', 'failure', 'fail', 'error', 'errored', 'cancelled', 'canceled'])(
    'reads %s as failed',
    (raw) => {
      expect(classifyFeedStatus(raw)).toEqual({ state: 'failed' })
    }
  )

  it.each(['blocked', 'needs-input', 'needs_input', 'needsinput', 'waiting', 'stuck', 'partial'])(
    'reads %s as blocked and keeps the reason as the tag',
    (raw) => {
      expect(classifyFeedStatus(raw)).toEqual({ state: 'blocked', blockedTag: raw.toLowerCase() })
    }
  )

  it('is case- and whitespace-insensitive', () => {
    expect(classifyFeedStatus('  DONE  ').state).toBe('done')
    expect(classifyFeedStatus('Failed').state).toBe('failed')
  })

  it('treats an ABSENT status as reporting, with no disclosure', () => {
    // A worker legitimately writes `{summary}` alone — that is not off-vocabulary, so it must not
    // produce a scary "unrecognized" line on the card.
    for (const raw of [undefined, null, '', '   ']) {
      expect(classifyFeedStatus(raw)).toEqual({ state: 'reporting' })
    }
  })

  it('🔒 falls back to the NON-TERMINAL `reporting` for an off-vocabulary status', () => {
    const c = classifyFeedStatus('partial-ok')
    // Not `done`: that would launder an unknown state into a success.
    // Not `failed`: that would claim a failure nobody reported.
    // `reporting` keeps the card in the recap's NOW zone, so the human keeps watching.
    expect(c.state).toBe('reporting')
    expect(c.blockedTag).toBeUndefined()
    expect(c.disclose).toBe('unrecognized status "partial-ok" — treated as unsettled')
  })

  it('puts the RAW value in the disclosure, flattened and clamped', () => {
    const c = classifyFeedStatus(`weird\n\tstatus  ${'x'.repeat(400)}`)
    expect(c.disclose).toMatch(/^unrecognized status "weird status x+…" — treated as unsettled$/)
    expect(c.disclose!.length).toBeLessThan(280)
  })
})

describe('isCommandFeedState', () => {
  it('accepts every member of the closed vocabulary', () => {
    for (const s of COMMAND_FEED_STATES) expect(isCommandFeedState(s)).toBe(true)
  })

  it('rejects anything else — the applier re-validates the wire', () => {
    for (const v of ['queued', 'DONE', '', null, undefined, 7, {}]) {
      expect(isCommandFeedState(v)).toBe(false)
    }
  })

  it('excludes `queued` deliberately — a fed worker already exists', () => {
    expect(COMMAND_FEED_STATES).not.toContain('queued')
  })
})

describe('flattenLine / clampLine', () => {
  it('strips control bytes so a worker cannot smuggle escapes into a label', () => {
    expect(flattenLine('a[31mred b')).toBe('a [31mred b')
    expect(flattenLine('one\r\ntwo\tthree')).toBe('one two three')
  })

  it('clamps with an ellipsis and never exceeds the max', () => {
    const out = clampLine('y'.repeat(500), 20)
    expect(out).toHaveLength(20)
    expect(out.endsWith('…')).toBe(true)
  })

  it('leaves short text untouched', () => {
    expect(clampLine('short', 20)).toBe('short')
  })
})

describe('sanitizeFeedResult', () => {
  it('returns undefined for junk, so a garbage report becomes a status-only push', () => {
    for (const v of [undefined, null, 'string', 42, {}, { status: '' }]) {
      expect(sanitizeFeedResult(v as never)).toBeUndefined()
    }
  })

  it('keeps the fields that survive and drops the ones that do not', () => {
    expect(
      sanitizeFeedResult({ status: 'done', summary: '  3 findings ', refs: ['a.ts:1', '', 7] })
    ).toEqual({ status: 'done', summary: '3 findings', refs: ['a.ts:1'] })
  })

  it('caps the ref list', () => {
    const refs = Array.from({ length: MAX_FEED_REFS + 20 }, (_, i) => `f${i}.ts:1`)
    expect(sanitizeFeedResult({ refs })!.refs).toHaveLength(MAX_FEED_REFS)
  })

  it('flattens a multi-line ref (a worker may paste a whole block)', () => {
    expect(sanitizeFeedResult({ refs: ['a.ts:1\n  note here'] })!.refs).toEqual([
      'a.ts:1 note here'
    ])
  })
})
