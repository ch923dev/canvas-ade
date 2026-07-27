import { describe, expect, it } from 'vitest'
import {
  buildMergeSequence,
  describeOverlapFiles,
  detectOverlaps,
  normalizeRef,
  overlapKey,
  type MergeCandidate,
  type OverlapInput
} from './swarmOverlap'

/**
 * The whole point of S3's integration half: worktree isolation makes the WRITES correct, and this
 * is what catches the collision it cannot remove. A wrong answer here is silently wrong on screen
 * and ends with somebody's work reverted by a blind merge — so it is tested directly, at the
 * function, rather than inferred from a rendered row.
 */
describe('normalizeRef — the step that makes two worktrees comparable', () => {
  it('relativises an absolute ref against its OWN worktree (the load-bearing step)', () => {
    // Without this the two spellings below never compare equal and the overlap is invisible.
    expect(
      normalizeRef(
        'M:\\proj\\.canvas\\worktrees\\b2\\src\\main\\load.ts',
        'M:\\proj\\.canvas\\worktrees\\b2'
      )
    ).toBe('src/main/load.ts')
    expect(normalizeRef('./src/main/load.ts', 'M:\\proj\\.canvas\\worktrees\\b4')).toBe(
      'src/main/load.ts'
    )
  })

  it('strips a trailing :line and :line:col but never a Windows drive letter', () => {
    expect(normalizeRef('src/a.ts:42', null)).toBe('src/a.ts')
    expect(normalizeRef('src/a.ts:42:7', null)).toBe('src/a.ts')
    // `C:` is not a location suffix — the anchor requires digits to the very end.
    expect(normalizeRef('C:/proj/src/a.ts', null)).toBe('C:/proj/src/a.ts')
  })

  it('normalises separators and drops a leading ./ or /', () => {
    expect(normalizeRef('src\\main\\a.ts', null)).toBe('src/main/a.ts')
    expect(normalizeRef('./src/a.ts', null)).toBe('src/a.ts')
    expect(normalizeRef('/src/a.ts', null)).toBe('src/a.ts')
  })

  it('matches the worktree prefix case-insensitively and tolerates a trailing slash', () => {
    expect(normalizeRef('M:/Proj/WT/b2/src/a.ts', 'm:/proj/wt/b2/')).toBe('src/a.ts')
  })

  it('leaves a ref that is NOT under its worktree alone (an escape is not silently relativised)', () => {
    expect(normalizeRef('M:/elsewhere/src/a.ts', 'M:/proj/wt/b2')).toBe('M:/elsewhere/src/a.ts')
  })

  it('returns null for anything that normalises to nothing, so "" can never match ""', () => {
    expect(normalizeRef('', null)).toBeNull()
    expect(normalizeRef('   ', null)).toBeNull()
    expect(normalizeRef('./', null)).toBeNull()
    expect(normalizeRef(undefined as unknown as string, null)).toBeNull()
  })
})

describe('overlapKey — deliberately over-detecting', () => {
  it('case-folds, so Foo.ts and foo.ts collide', () => {
    // A false positive costs a human one glance; a false negative silently reverts their work.
    // Branching on process.platform instead would make this untestable as a pure function.
    expect(overlapKey('src/Foo.ts')).toBe(overlapKey('src/foo.ts'))
  })
})

describe('detectOverlaps', () => {
  const w = (taskId: string, worktree: string | null, refs: string[]): OverlapInput => ({
    taskId,
    boardId: `b-${taskId}`,
    worktree,
    refs
  })

  it('finds the intersection across two different worktrees, in different spellings', () => {
    const pairs = detectOverlaps([
      w('t1', '/wt/b2', ['/wt/b2/src/main/load.ts:42', '/wt/b2/src/a.ts']),
      w('t2', '/wt/b4', ['./src/main/LOAD.ts', 'src/b.ts'])
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ a: 't1', b: 't2' })
    // Display keeps the EARLIER worker's spelling — the row reads in the same spelling as the
    // branch listed first in the sequence.
    expect(pairs[0].files).toEqual(['src/main/load.ts'])
  })

  it('produces nothing for genuinely disjoint writers — the happy path stays quiet', () => {
    expect(
      detectOverlaps([w('t1', '/wt/a', ['src/a.ts']), w('t2', '/wt/b', ['src/b.ts'])])
    ).toEqual([])
  })

  it('treats a worker with no usable refs as UNKNOWN, not disjoint — it simply pairs with nobody', () => {
    const pairs = detectOverlaps([
      w('t1', '/wt/a', []),
      w('t2', '/wt/b', ['src/x.ts']),
      w('t3', '/wt/c', ['src/x.ts'])
    ])
    // t1 raises no pair (nothing to compare), but t2/t3 still collide.
    expect(pairs).toEqual([{ a: 't2', b: 't3', files: ['src/x.ts'] }])
  })

  it('de-duplicates one worker reporting the same file twice (path and path:line)', () => {
    const pairs = detectOverlaps([
      w('t1', null, ['src/x.ts', 'src/x.ts:9', 'src/x.ts:40']),
      w('t2', null, ['src/x.ts'])
    ])
    expect(pairs[0].files).toEqual(['src/x.ts'])
  })

  it('reports every colliding pair among three writers, in input order', () => {
    const pairs = detectOverlaps([
      w('t1', null, ['a.ts', 'b.ts']),
      w('t2', null, ['b.ts']),
      w('t3', null, ['a.ts'])
    ])
    expect(pairs.map((p) => [p.a, p.b])).toEqual([
      ['t1', 't2'],
      ['t1', 't3']
    ])
  })

  it('sorts the file list so a row is stable across renders', () => {
    const pairs = detectOverlaps([w('t1', null, ['z.ts', 'a.ts']), w('t2', null, ['a.ts', 'z.ts'])])
    expect(pairs[0].files).toEqual(['a.ts', 'z.ts'])
  })
})

describe('describeOverlapFiles — honest about its own cap', () => {
  it('names up to the cap and counts the rest (never silently truncates)', () => {
    expect(describeOverlapFiles(['a', 'b'])).toBe('a, b')
    expect(describeOverlapFiles(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c (+2 more)')
  })
})

describe('buildMergeSequence', () => {
  const c = (taskId: string, over: Partial<MergeCandidate> = {}): MergeCandidate => ({
    taskId,
    boardId: `b-${taskId}`,
    branch: `swarm/r/${taskId}`,
    label: taskId,
    files: 1,
    ...over
  })

  it('keeps the caller order and marks the LATER step — the one that has to rebase', () => {
    const steps = buildMergeSequence(
      [c('t1'), c('t2')],
      [{ a: 't1', b: 't2', files: ['src/x.ts'] }]
    )
    expect(steps.map((s) => s.taskId)).toEqual(['t1', 't2'])
    expect(steps[0].overlapsWith).toEqual([])
    expect(steps[1].overlapsWith).toEqual([1])
  })

  it('normalises a pair given in reverse order onto the later position', () => {
    const steps = buildMergeSequence(
      [c('t1'), c('t2')],
      [{ a: 't2', b: 't1', files: ['src/x.ts'] }]
    )
    expect(steps[1].overlapsWith).toEqual([1])
  })

  it('accumulates several earlier overlaps, sorted, without duplicates', () => {
    const steps = buildMergeSequence(
      [c('t1'), c('t2'), c('t3')],
      [
        { a: 't3', b: 't1', files: ['x'] },
        { a: 't2', b: 't3', files: ['y'] },
        { a: 't1', b: 't3', files: ['z'] }
      ]
    )
    expect(steps[2].overlapsWith).toEqual([1, 2])
  })

  it('drops a pair naming a task that is not in the sequence rather than pointing at a bad position', () => {
    const steps = buildMergeSequence([c('t1')], [{ a: 't1', b: 'ghost', files: ['x'] }])
    expect(steps[0].overlapsWith).toEqual([])
  })

  it('carries the dirty flag through — a tree with uncommitted work is listed, not merge-ready', () => {
    const steps = buildMergeSequence([c('t1', { dirty: true })], [])
    expect(steps[0].dirty).toBe(true)
    expect(buildMergeSequence([c('t2')], [])[0].dirty).toBeUndefined()
  })
})
