import { describe, it, expect } from 'vitest'
import {
  boardFingerprint,
  createMemoryEngine,
  type Scheduler,
  type SummarizeIntent
} from './memoryEngine'

const terminal = (over: Record<string, unknown> = {}): unknown => ({
  id: 't1',
  type: 'terminal',
  x: 0,
  y: 0,
  w: 420,
  h: 340,
  title: 'Terminal',
  launchCommand: 'pnpm dev',
  cwd: '/repo',
  port: 5173,
  ...over
})
const browser = (over: Record<string, unknown> = {}): unknown => ({
  id: 'b1',
  type: 'browser',
  x: 0,
  y: 0,
  w: 700,
  h: 500,
  title: 'Browser',
  url: 'http://localhost:5173',
  viewport: 'desktop',
  previewSourceId: 't1',
  ...over
})
const planning = (elements: unknown[]): unknown => ({
  id: 'p1',
  type: 'planning',
  x: 0,
  y: 0,
  w: 516,
  h: 366,
  title: 'Planning',
  elements
})
const note = (text: string, over: Record<string, unknown> = {}): unknown => ({
  id: 'n1',
  kind: 'note',
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  tint: 'yellow',
  text,
  ...over
})
const checklist = (items: { label: string; done: boolean }[]): unknown => ({
  id: 'c1',
  kind: 'checklist',
  x: 0,
  y: 0,
  w: 200,
  h: 0,
  title: 'Tasks',
  items: items.map((i, idx) => ({ id: `i${idx}`, ...i }))
})

describe('boardFingerprint — move-invariant', () => {
  it('terminal: pure move/resize does not change the fingerprint', () => {
    // title is now PART of the fingerprint (BUG-018), so hold it fixed and vary only geometry.
    expect(boardFingerprint(terminal())).toBe(
      boardFingerprint(terminal({ x: 999, y: 888, w: 1000, h: 900, z: 5 }))
    )
  })
  it('browser: pure move does not change the fingerprint', () => {
    expect(boardFingerprint(browser())).toBe(boardFingerprint(browser({ x: 50, y: 60, w: 720 })))
  })
  it('planning: moving a note does not change the fingerprint', () => {
    expect(boardFingerprint(planning([note('hi')]))).toBe(
      boardFingerprint(planning([note('hi', { x: 300, y: 400, rotation: 45, tint: 'blue' })]))
    )
  })
})

describe('boardFingerprint — content-sensitive', () => {
  it('terminal: launchCommand / cwd / port changes are detected', () => {
    const base = boardFingerprint(terminal())
    expect(boardFingerprint(terminal({ launchCommand: 'pnpm build' }))).not.toBe(base)
    expect(boardFingerprint(terminal({ cwd: '/other' }))).not.toBe(base)
    expect(boardFingerprint(terminal({ port: 3000 }))).not.toBe(base)
  })
  it('browser: url / viewport changes are detected', () => {
    const base = boardFingerprint(browser())
    expect(boardFingerprint(browser({ url: 'http://localhost:3000' }))).not.toBe(base)
    expect(boardFingerprint(browser({ viewport: 'mobile' }))).not.toBe(base)
  })
  it('terminal: a title-only rename IS detected (title opens the LLM prompt — BUG-018)', () => {
    // boardContent emits `Terminal board "${title}".`, so a rename changes the summary input
    // → the fingerprint MUST change or the cached prose stays stale with the old name.
    expect(boardFingerprint(terminal({ title: 'Renamed' }))).not.toBe(boardFingerprint(terminal()))
  })
  it('browser: a title-only rename IS detected (title opens the LLM prompt — BUG-018)', () => {
    expect(boardFingerprint(browser({ title: 'Renamed' }))).not.toBe(boardFingerprint(browser()))
  })
  it('browser: a previewSourceId-only change is NOT detected (excluded — never in the summary)', () => {
    // The Tier-2 summary omits the preview link, so a link-only change must not arm a
    // re-summarize (it would burn a budgeted call for identical prose).
    const base = boardFingerprint(browser())
    expect(boardFingerprint(browser({ previewSourceId: 't2' }))).toBe(base)
  })
  it('planning: note text + checklist item label/done changes are detected', () => {
    expect(boardFingerprint(planning([note('hi')]))).not.toBe(
      boardFingerprint(planning([note('hi there')]))
    )
    const c = boardFingerprint(planning([checklist([{ label: 'a', done: false }])]))
    expect(boardFingerprint(planning([checklist([{ label: 'a', done: true }])]))).not.toBe(c)
    expect(boardFingerprint(planning([checklist([{ label: 'b', done: false }])]))).not.toBe(c)
  })
})

describe('boardFingerprint — robustness', () => {
  it('malformed / null / unknown-type input never throws and is stable', () => {
    expect(() => boardFingerprint(null)).not.toThrow()
    expect(() => boardFingerprint({})).not.toThrow()
    expect(() => boardFingerprint({ type: 'planning', elements: 'nope' })).not.toThrow()
    expect(boardFingerprint({ id: 'x', type: 'mystery' })).toBe(
      boardFingerprint({ id: 'x', type: 'mystery' })
    )
  })
})

/** A manual scheduler: jobs run only when flush() is called (simulates the debounce firing). */
function fakeScheduler() {
  const jobs: { fn: () => void; cancelled: boolean }[] = []
  const schedule: Scheduler = (fn) => {
    const job = { fn, cancelled: false }
    jobs.push(job)
    return () => {
      job.cancelled = true
    }
  }
  const flush = (): void => {
    // snapshot so jobs scheduled during flush don't run in this pass
    for (const job of [...jobs]) {
      if (!job.cancelled) {
        job.cancelled = true
        job.fn()
      }
    }
  }
  return { schedule, flush }
}

const docOf = (boards: unknown[]): unknown => ({ schemaVersion: 4, viewport: null, boards })
const term = (id: string, launchCommand: string, x = 0): unknown => ({
  id,
  type: 'terminal',
  x,
  y: 0,
  w: 420,
  h: 340,
  title: 'T',
  launchCommand
})

describe('createMemoryEngine — baseline + diff', () => {
  it('first observe sets baseline and emits nothing', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev')]))
    flush()
    expect(intents).toEqual([])
  })

  it('a content change after baseline emits exactly one intent for that board', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev')])) // baseline
    engine.observe(docOf([term('t1', 'pnpm build')])) // content changed
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })

  it('a pure move (x only) after baseline emits nothing', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev', 0)])) // baseline
    engine.observe(docOf([term('t1', 'pnpm dev', 999)])) // moved only
    flush()
    expect(intents).toEqual([])
  })

  it('a burst of content changes to one board collapses to a single intent', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([term('t1', 'ab')]))
    engine.observe(docOf([term('t1', 'abc')]))
    engine.observe(docOf([term('t1', 'abcd')]))
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })

  it('a brand-new board added after baseline emits an intent for it', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([term('t1', 'a'), term('t2', 'b')])) // t2 is new
    flush()
    expect(intents).toEqual([{ boardId: 't2' }])
  })

  it('a board removed before its debounce fires cancels its pending intent', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a'), term('t2', 'b')])) // baseline
    engine.observe(docOf([term('t1', 'a'), term('t2', 'bb')])) // t2 changed → timer armed
    engine.observe(docOf([term('t1', 'a')])) // t2 removed → cancel
    flush()
    expect(intents).toEqual([])
  })

  it('a board removed then re-added emits an intent again', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([])) // t1 removed → state dropped
    engine.observe(docOf([term('t1', 'a')])) // t1 re-added → treated as new
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })

  it('two independent boards changing both emit intents', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a'), term('t2', 'b')])) // baseline
    engine.observe(docOf([term('t1', 'aa'), term('t2', 'bb')])) // both changed
    flush()
    expect(intents.map((i) => i.boardId).sort()).toEqual(['t1', 't2'])
  })

  it('a board changing again after its intent fired emits a second intent', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([term('t1', 'b')])) // change → arm
    flush() // fires intent #1
    engine.observe(docOf([term('t1', 'c')])) // change again → arm a fresh timer
    flush() // fires intent #2
    expect(intents).toEqual([{ boardId: 't1' }, { boardId: 't1' }])
  })
})

describe('createMemoryEngine — reset', () => {
  it('reset cancels pending timers and clears baselines', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'a')])) // baseline
    engine.observe(docOf([term('t1', 'b')])) // armed
    engine.reset()
    flush()
    expect(intents).toEqual([]) // armed timer was cancelled

    // after reset, the next observe re-baselines (no spurious emit)
    engine.observe(docOf([term('t1', 'c')]))
    flush()
    expect(intents).toEqual([])
  })

  it('observe is best-effort: a malformed doc never throws and arms nothing', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    expect(() => engine.observe(undefined)).not.toThrow()
    expect(() => engine.observe({ boards: 'nope' })).not.toThrow()
    flush()
    expect(intents).toEqual([])
  })
})

describe('createMemoryEngine — title rename arms an intent (BUG-018)', () => {
  const titled = (id: string, title: string): unknown => ({
    id,
    type: 'terminal',
    x: 0,
    y: 0,
    w: 420,
    h: 340,
    title,
    launchCommand: 'pnpm dev'
  })

  it('a title-only rename after baseline emits a re-summarize intent', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([titled('t1', 'Build')])) // baseline
    engine.observe(docOf([titled('t1', 'Renamed')])) // title-only rename
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })
})

describe('createMemoryEngine — rehydrate (BUG-018 #2: missing summary recovery)', () => {
  it('arms an intent for a KNOWN board even with no content change (bypasses primed guard)', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev')])) // baseline (primed, no emit)
    // Simulate a re-open with identical content + an externally-deleted board-t1.md:
    // observe() alone would never emit, but rehydrate force-arms the listed board.
    engine.rehydrate(['t1'])
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })

  it('ignores ids the engine has not baselined (no stale/unknown summarize)', () => {
    const { schedule, flush } = fakeScheduler()
    const intents: SummarizeIntent[] = []
    const engine = createMemoryEngine({ onIntent: (i) => intents.push(i), schedule })
    engine.observe(docOf([term('t1', 'pnpm dev')])) // only t1 is known
    engine.rehydrate(['t1', 'ghost', '']) // ghost + empty must be ignored
    flush()
    expect(intents).toEqual([{ boardId: 't1' }])
  })
})
