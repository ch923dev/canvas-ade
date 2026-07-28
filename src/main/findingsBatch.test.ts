/**
 * The P4 findings composer — the mechanical half of end-of-run aggregation.
 *
 * Two rules are pinned hard here because both are the difference between a useful batch and a
 * quietly-wrong one:
 *  1 · a ref that cannot be parsed is NEVER dropped — it becomes a finding whose note is the raw
 *      string, and the batch says so. Losing real findings silently is the failure this lane exists
 *      to prevent;
 *  2 · `unknown` severity routes to `backlog`, not `review` — unreadable text must not outrank a
 *      worker's explicit `low`.
 */
import { describe, expect, it } from 'vitest'
import {
  FINDING_SEVERITIES,
  MAX_FINDINGS,
  composeFindings,
  findingLabel,
  findingRef,
  isFindingSeverity,
  laneForSeverity,
  parseRef,
  type WorkerReport
} from './findingsBatch'

describe('parseRef', () => {
  it('reads a bare path:line locator', () => {
    expect(parseRef('src/main/pty.ts:774')).toMatchObject({
      path: 'src/main/pty.ts',
      line: 774,
      severity: 'unknown',
      parsed: true
    })
  })

  it('reads a path with no line, and a path:line-endLine range', () => {
    expect(parseRef('src/main/pty.ts')).toMatchObject({ path: 'src/main/pty.ts', parsed: true })
    expect(parseRef('src/main/pty.ts:12-40')).toMatchObject({ path: 'src/main/pty.ts', line: 12 })
  })

  it('reads `path:line severity — note`, the shape the code-reviewer pack asks for', () => {
    expect(parseRef('src/main/pty.ts:774 high — killTree reuses a stale pid')).toMatchObject({
      path: 'src/main/pty.ts',
      line: 774,
      severity: 'high',
      note: 'killTree reuses a stale pid'
    })
  })

  it('reads the severity FIRST too, bracketed or bare', () => {
    expect(parseRef('[crit] src/a.ts:3 boom')).toMatchObject({
      severity: 'crit',
      path: 'src/a.ts',
      line: 3,
      note: 'boom'
    })
    expect(parseRef('minor src/a.ts:3 nit')).toMatchObject({ severity: 'low', note: 'nit' })
  })

  it('reads a stringified JSON object (a worker taking the schema literally)', () => {
    const raw = JSON.stringify({
      path: 'src/main/pty.ts',
      line: 774,
      severity: 'critical',
      note: 'pid reuse'
    })
    expect(parseRef(raw)).toMatchObject({
      path: 'src/main/pty.ts',
      line: 774,
      severity: 'crit',
      note: 'pid reuse',
      parsed: true
    })
  })

  it('🔒 NEVER discards an unparseable ref — it becomes an unlocated finding', () => {
    const p = parseRef('the whole thing feels off, honestly')
    expect(p.path).toBeUndefined()
    expect(p.note).toBe('the whole thing feels off, honestly')
    // `parsed:false` is what the batch counts to disclose "N refs had no readable location".
    expect(p.parsed).toBe(false)
  })

  it('does not invent a path out of a stray word', () => {
    // "high" and "TODO" are not files. A locator needs a separator or an extension.
    expect(parseRef('TODO look at this').path).toBeUndefined()
    expect(parseRef('high something broke').path).toBeUndefined()
  })

  it('falls the note back to the locator when there is no prose', () => {
    expect(parseRef('src/a.ts:3').note).toBe('src/a.ts:3')
  })

  it('flattens control bytes and multi-line refs', () => {
    expect(parseRef('src/a.ts:3\n\thigh — broke').note).toBe('broke')
  })
})

describe('severity vocabulary', () => {
  it('is closed and runtime-checkable', () => {
    for (const s of FINDING_SEVERITIES) expect(isFindingSeverity(s)).toBe(true)
    for (const v of ['HIGH', 'urgent', '', null, 3]) expect(isFindingSeverity(v)).toBe(false)
  })

  it('routes crit/high/med to review and low to backlog', () => {
    expect(laneForSeverity('crit')).toBe('review')
    expect(laneForSeverity('high')).toBe('review')
    expect(laneForSeverity('med')).toBe('review')
    expect(laneForSeverity('low')).toBe('backlog')
  })

  it('🔒 routes `unknown` to BACKLOG — unreadable is not evidence of urgent', () => {
    // Sending it to `review` would let text we could not parse quietly outrank an explicit `low`.
    expect(laneForSeverity('unknown')).toBe('backlog')
  })
})

describe('composeFindings', () => {
  const r = (over: Partial<WorkerReport> & { boardId: string }): WorkerReport => ({ ...over })

  it('turns each ref into a finding attributed to its worker', () => {
    const b = composeFindings([
      r({ boardId: 'w1', refs: ['src/a.ts:1 high — one', 'src/b.ts:2 low — two'] })
    ])
    expect(b.findings).toHaveLength(2)
    expect(b.findings[0]).toMatchObject({ severity: 'high', note: 'one', boardIds: ['w1'] })
  })

  it('keeps a summary-only report as ONE unlocated finding', () => {
    // Dropping it would lose the entire output of any worker that summarizes rather than enumerates.
    const b = composeFindings([r({ boardId: 'w1', summary: 'looks clean overall' })])
    expect(b.findings).toEqual([
      expect.objectContaining({
        note: 'looks clean overall',
        severity: 'unknown',
        boardIds: ['w1']
      })
    ])
  })

  it('counts a report with nothing at all as a SILENT worker and says so', () => {
    const b = composeFindings([r({ boardId: 'w1', status: 'done' })])
    expect(b.findings).toHaveLength(0)
    expect(b.silentWorkers).toBe(1)
    expect(b.disclose).toContain('1 worker reported nothing and is not represented')
  })

  it('merges the same claim from two workers into ONE corroborated finding', () => {
    const b = composeFindings([
      r({ boardId: 'w1', refs: ['src/a.ts:1 low — pid reuse'] }),
      r({ boardId: 'w2', refs: ['src/a.ts:1 high — PID  reuse!'] })
    ])
    expect(b.findings).toHaveLength(1)
    expect(b.findings[0].boardIds).toEqual(['w1', 'w2'])
    // Worst severity wins: one reviewer calling it high is not cancelled by another calling it low.
    expect(b.findings[0].severity).toBe('high')
    expect(b.disclose).toContain('1 merged by (path, line, note)')
  })

  it('does NOT merge different lines of the same file', () => {
    const b = composeFindings([
      r({ boardId: 'w1', refs: ['src/a.ts:1 high — x', 'src/a.ts:2 high — x'] })
    ])
    expect(b.findings).toHaveLength(2)
  })

  it('keeps contradicting findings as separate rows — adjudication is not mechanical', () => {
    const b = composeFindings([
      r({ boardId: 'w1', refs: ['src/a.ts:1 high — this is a real bug'] }),
      r({ boardId: 'w2', refs: ['src/a.ts:1 low — this is not a bug'] })
    ])
    expect(b.findings).toHaveLength(2)
  })

  it('marks a finding synthesized only when EVERY contributor was', () => {
    const solo = composeFindings([r({ boardId: 'w1', refs: ['a/x.ts:1 — n'], synthesized: true })])
    expect(solo.findings[0].synthesized).toBe(true)
    const mixed = composeFindings([
      r({ boardId: 'w1', refs: ['a/x.ts:1 — n'], synthesized: true }),
      r({ boardId: 'w2', refs: ['a/x.ts:1 — n'] })
    ])
    expect(mixed.findings[0].synthesized).toBe(false)
  })

  it('orders worst-first, then located before unlocated', () => {
    const b = composeFindings([
      r({ boardId: 'w1', refs: ['just prose', 'src/z.ts:1 low — l', 'src/a.ts:1 crit — c'] })
    ])
    expect(b.findings.map((f) => f.severity)).toEqual(['crit', 'low', 'unknown'])
  })

  it('caps the batch and DISCLOSES the drop', () => {
    const refs = Array.from({ length: MAX_FINDINGS + 7 }, (_, i) => `src/f${i}.ts:1 high — n${i}`)
    const b = composeFindings([r({ boardId: 'w1', refs })])
    expect(b.findings).toHaveLength(MAX_FINDINGS)
    expect(b.dropped).toBe(7)
    expect(b.disclose).toContain(`capped at ${MAX_FINDINGS} — 7 dropped`)
  })

  it('always states that severities are claims, never verifications', () => {
    const b = composeFindings([r({ boardId: 'w1', refs: ['src/a.ts:1 high — n'] })])
    expect(b.disclose).toContain("severities are the workers' own claims, not verified")
  })

  it('counts refs with no readable location in the disclosure', () => {
    const b = composeFindings([r({ boardId: 'w1', refs: ['no location here', 'src/a.ts:1 — ok'] })])
    expect(b.disclose).toContain('1 ref had no readable location')
  })

  it('handles an empty run without pretending anything happened', () => {
    const b = composeFindings([])
    expect(b.findings).toHaveLength(0)
    expect(b.disclose).toContain('0 findings from 0 workers')
  })
})

describe('findingRef / findingLabel', () => {
  it('formats a location, or nothing when there is none', () => {
    expect(findingRef({ path: 'a.ts', line: 3 } as never)).toBe('a.ts:3')
    expect(findingRef({ path: 'a.ts' } as never)).toBe('a.ts')
    expect(findingRef({} as never)).toBe('')
  })

  it('names every reporter, the location, the severity and the destination lane', () => {
    const label = findingLabel(
      {
        severity: 'high',
        note: 'n',
        path: 'a.ts',
        line: 3,
        boardIds: ['w1', 'w2'],
        roles: [],
        synthesized: false
      },
      (id) => (id === 'w1' ? 'reviewer-1' : 'reviewer-4')
    )
    expect(label).toBe('reviewer-1 + reviewer-4 · a.ts:3 · high → lane "review"')
  })

  it('says so out loud when a finding has no file reference', () => {
    const label = findingLabel(
      { severity: 'unknown', note: 'n', boardIds: ['w1'], roles: [], synthesized: false },
      () => 'reviewer-1'
    )
    expect(label).toContain('no file reference')
  })
})
