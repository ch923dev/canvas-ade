import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { useCameraRequestStore } from './cameraRequestStore'
import { useCanvasViewStore } from './canvasViewStore'
import { useRoleSignalsStore } from './roleSignalsStore'
import { useOrchestrationStore } from './orchestrationStore'
import { runTidy, type TidyRun } from './spatialTidy'
import { createBoard, type Board, type BoardType } from '../lib/boardSchema'

/**
 * The shared tidy engine (spatial I2) — every mode end to end against the REAL stores: the
 * routing (fit / roles / tile / legacy), the C9 live signals, scope + id re-validation, ONE undo
 * step, x/y always + w/h only where sized, and the camera framing.
 */

const WIDE = { w: 1920, h: 1080 }

function board(
  type: BoardType,
  id: string,
  x: number,
  y: number,
  extra: Partial<Board> = {}
): Board {
  return { ...createBoard(type, { id, x, y }), ...extra } as Board
}

function seed(
  boards: Board[],
  extra: Partial<ReturnType<typeof useCanvasStore.getState>> = {}
): void {
  useCanvasStore.setState({
    boards,
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: [],
    past: [],
    future: [],
    ...extra
  })
}

const byId = (id: string): Board => useCanvasStore.getState().boards.find((b) => b.id === id)!

function ok(run: ReturnType<typeof runTidy>): TidyRun {
  if (!run.ok) throw new Error(`expected ok, got: ${run.error}`)
  return run
}

function overlaps(boards: readonly Board[]): boolean {
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      const a = boards[i]
      const b = boards[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true
    }
  }
  return false
}

beforeEach(() => {
  seed([])
  useCameraRequestStore.setState({ seq: 0, target: null })
  useCanvasViewStore.setState({ pane: WIDE, camera: { x: 0, y: 0, zoom: 1 } })
  useRoleSignalsStore.getState().reset()
  useOrchestrationStore.setState({ leadBoardId: null })
})
afterEach(() => useCanvasViewStore.setState({ pane: null, camera: null }))

describe('runTidy — validation (defence in depth)', () => {
  it('rejects an off-enum mode, a template without tile, and overflow pages with a legacy packer', () => {
    seed([board('terminal', 'a', 0, 0), board('terminal', 'b', 0, 0)])
    expect(runTidy({ mode: 'diagonal' }).ok).toBe(false)
    expect(runTidy({ mode: 'fit', template: 'cols-2' }).ok).toBe(false)
    expect(runTidy({ mode: 'tile' }).ok).toBe(false)
    expect(runTidy({ mode: 'smart', overflow: 'pages' }).ok).toBe(false)
    expect(runTidy({ mode: 'fit', primary: 'a' }).ok).toBe(false)
    expect(useCanvasStore.getState().past).toHaveLength(0)
  })

  it('rejects unknown / docked / out-of-scope ids against the LIVE store, moving nothing', () => {
    seed([
      board('swarm', 'sw', 0, 0),
      board('terminal', 'w1', 0, 0, { dockedIn: 'sw' }),
      board('terminal', 't1', 0, 0),
      board('terminal', 't2', 0, 0)
    ])
    const before = useCanvasStore.getState().boards
    expect(runTidy({ scope: { boardIds: ['ghost'] } }).ok).toBe(false)
    expect(runTidy({ scope: { boardIds: ['w1', 't1'] } }).ok).toBe(false)
    expect(runTidy({ scope: { groupId: 'nope' } }).ok).toBe(false)
    expect(runTidy({ primary: 'ghost' }).ok).toBe(false)
    expect(runTidy({ primary: 'w1' }).ok).toBe(false)
    expect(runTidy({ primary: 't2', scope: { boardIds: ['t1', 'sw'] } }).ok).toBe(false)
    expect(useCanvasStore.getState().boards).toBe(before)
  })

  it('never moves a docked worker terminal', () => {
    seed([
      board('swarm', 'sw', 0, 0),
      board('terminal', 'w1', 5, 5, { dockedIn: 'sw' }),
      board('terminal', 't1', 0, 0),
      board('terminal', 't2', 0, 0)
    ])
    for (const mode of ['fit', 'roles', 'smart', 'grid'] as const) ok(runTidy({ mode }))
    ok(runTidy({ mode: 'tile', template: 'cols-3' }))
    expect(byId('w1')).toMatchObject({ x: 5, y: 5 })
  })
})

describe('runTidy — fit (C4)', () => {
  function seedGroups(): void {
    const boards = [
      board('terminal', 'a1', 0, 0),
      board('browser', 'a2', 0, 0),
      board('terminal', 'b1', 0, 0),
      board('planning', 'b2', 0, 0),
      board('terminal', 'loose', 0, 0)
    ]
    seed(boards, {
      groups: [
        { id: 'gA', name: 'App', boardIds: ['a1', 'a2'] },
        { id: 'gB', name: 'Docs', boardIds: ['b1', 'b2'] }
      ]
    })
  }

  it('packs Named Groups as contiguous units, no overlaps, sizes untouched, ONE undo step', () => {
    seedGroups()
    const sizes = useCanvasStore.getState().boards.map((b) => [b.id, b.w, b.h])
    const run = ok(runTidy({ mode: 'fit' }))
    const boards = useCanvasStore.getState().boards
    expect(overlaps(boards)).toBe(false)
    expect(boards.map((b) => [b.id, b.w, b.h])).toEqual(sizes)
    // Group A's bbox holds no board of group B and vice versa.
    const box = (ids: string[]): { x0: number; y0: number; x1: number; y1: number } => {
      const bs = boards.filter((b) => ids.includes(b.id))
      return {
        x0: Math.min(...bs.map((b) => b.x)),
        y0: Math.min(...bs.map((b) => b.y)),
        x1: Math.max(...bs.map((b) => b.x + b.w)),
        y1: Math.max(...bs.map((b) => b.y + b.h))
      }
    }
    const inside = (b: Board, r: ReturnType<typeof box>): boolean =>
      b.x < r.x1 && b.x + b.w > r.x0 && b.y < r.y1 && b.y + b.h > r.y0
    expect(
      boards.filter((b) => ['b1', 'b2'].includes(b.id)).some((b) => inside(b, box(['a1', 'a2'])))
    ).toBe(false)
    expect(
      boards.filter((b) => ['a1', 'a2'].includes(b.id)).some((b) => inside(b, box(['b1', 'b2'])))
    ).toBe(false)
    expect(run.moved).toBeGreaterThan(0)
    expect(run.fitZoom).toBeGreaterThan(0)
    expect(typeof run.readable).toBe('boolean')
    expect(useCanvasStore.getState().past).toHaveLength(1)
    // One undo restores every position.
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().boards.every((b) => b.x === 0 && b.y === 0)).toBe(true)
  })

  it('is screen-aware: a wide and a tall pane give different arrangements', () => {
    seedGroups()
    ok(runTidy({ mode: 'fit' }))
    const wide = useCanvasStore.getState().boards.map((b) => [b.id, b.x, b.y])
    seedGroups()
    useCanvasViewStore.setState({ pane: { w: 700, h: 1400 } })
    ok(runTidy({ mode: 'fit' }))
    const tall = useCanvasStore.getState().boards.map((b) => [b.id, b.x, b.y])
    expect(tall).not.toEqual(wide)
  })

  it('frames the camera on the arranged bbox (race-free rect), or not at all under fit:false', () => {
    seedGroups()
    ok(runTidy({ mode: 'fit' }))
    const target = useCameraRequestStore.getState().target
    expect(target?.kind).toBe('rect')
    const boards = useCanvasStore.getState().boards
    if (target?.kind !== 'rect') throw new Error('rect expected')
    expect(target.rect.x).toBe(Math.min(...boards.map((b) => b.x)))
    expect(target.rect.y).toBe(Math.min(...boards.map((b) => b.y)))

    seedGroups()
    useCameraRequestStore.setState({ seq: 0, target: null })
    ok(runTidy({ mode: 'fit', fit: false }))
    expect(useCameraRequestStore.getState().seq).toBe(0)
  })

  it("overflow 'shrink' resizes to readable; 'pages' pages a crowded canvas on a small pane", () => {
    const many = Array.from({ length: 16 }, (_, i) => board('terminal', `t${i}`, 0, 0))
    seed(many)
    useCanvasViewStore.setState({ pane: { w: 800, h: 500 } })
    const shrunk = ok(runTidy({ mode: 'fit', overflow: 'shrink' }))
    expect(useCanvasStore.getState().boards.some((b) => b.w < many[0].w)).toBe(true)
    expect(shrunk.readable).toBe(true)

    seed(many)
    const paged = ok(runTidy({ mode: 'fit', overflow: 'pages' }))
    expect(paged.pages).toBeGreaterThan(1)

    seed(many)
    const report = ok(runTidy({ mode: 'fit' }))
    expect(report.readable).toBe(false)
    expect(report.pages).toBeUndefined()
  })
})

describe('runTidy — roles (C9 / C10) with live signals', () => {
  it('a lead + cabled workers: lead is the hero (bigger), flexible boards resized, viewport camera', () => {
    seed(
      [
        board('terminal', 'lead', 0, 0),
        board('terminal', 'w1', 0, 0),
        board('terminal', 'w2', 0, 0)
      ],
      {
        connectors: [
          { id: 'c1', sourceId: 'lead', targetId: 'w1', kind: 'orchestration' },
          { id: 'c2', sourceId: 'lead', targetId: 'w2', kind: 'orchestration' }
        ]
      }
    )
    useOrchestrationStore.setState({ leadBoardId: 'lead' })
    const run = ok(runTidy({ mode: 'roles' }))
    expect(run.units?.[0]).toMatchObject({ scene: 'lead', heroIds: ['lead'] })
    const lead = byId('lead')
    expect(lead.w * lead.h).toBeGreaterThan(byId('w1').w * byId('w1').h)
    expect(overlaps(useCanvasStore.getState().boards)).toBe(false)
    expect(useCameraRequestStore.getState().target?.kind).toBe('viewport')
    expect(useCanvasStore.getState().past).toHaveLength(1)
  })

  it('reads the C9 signals live: an agent launch line + a browser make a pair; ports make a stack', () => {
    seed([
      board('terminal', 'agent', 0, 0, { launchCommand: 'claude' } as Partial<Board>),
      board('browser', 'web', 0, 0, { previewSourceId: 'agent' } as Partial<Board>)
    ])
    expect(ok(runTidy({ mode: 'roles' })).units?.[0].scene).toBe('pair')

    // Without signals: a plain shell + a browser share no unit (two singles), never a stack.
    seed([board('terminal', 'srv', 0, 0), board('browser', 'web', 0, 0)])
    expect(ok(runTidy({ mode: 'roles' })).units?.map((u) => u.scene)).toEqual(['single', 'single'])
    seed([board('terminal', 'srv', 0, 0), board('browser', 'web', 0, 0)])
    useRoleSignalsStore.getState().setPorts('srv', [3000])
    useRoleSignalsStore.getState().setCallsPorts('web', [3000])
    const run = ok(runTidy({ mode: 'roles' }))
    expect(run.units?.[0]).toMatchObject({ scene: 'stack', heroIds: ['web'] })
  })

  it('D8 (a): implicit roles keeps plain shells at their size; explicit roles resizes them', () => {
    const shells = (): Board[] => [
      board('terminal', 's1', 0, 0),
      board('terminal', 's2', 0, 0),
      board('terminal', 's3', 0, 0)
    ]
    const group = { groups: [{ id: 'g', name: 'Shells', boardIds: ['s1', 's2', 's3'] }] }
    seed(shells(), group)
    const size = [byId('s1').w, byId('s1').h]
    ok(runTidy({}))
    expect(useCanvasStore.getState().boards.every((b) => b.w === size[0] && b.h === size[1])).toBe(
      true
    )
    seed(shells(), group)
    ok(runTidy({ mode: 'roles' }))
    expect(useCanvasStore.getState().boards.some((b) => b.w !== size[0] || b.h !== size[1])).toBe(
      true
    )
  })

  it('primary forces the hero (S14) and a rigid hero keeps its exact size', () => {
    seed(
      [
        board('terminal', 'agent', 0, 0, { launchCommand: 'claude' } as Partial<Board>),
        board('browser', 'web', 0, 0),
        board('planning', 'plan', 0, 0)
      ],
      { groups: [{ id: 'g', name: 'Work', boardIds: ['agent', 'web', 'plan'] }] }
    )
    const planSize = [byId('plan').w, byId('plan').h]
    const run = ok(runTidy({ primary: 'plan' }))
    expect(run.units?.[0].heroIds).toEqual(['plan'])
    expect([byId('plan').w, byId('plan').h]).toEqual(planSize)
  })

  it('scope moves ONLY the scoped boards (S12); the rest stay put', () => {
    seed(
      [
        board('terminal', 'a', 0, 0),
        board('terminal', 'b', 0, 0),
        board('terminal', 'c', 900, 900)
      ],
      { groups: [{ id: 'g', name: 'Pair', boardIds: ['a', 'b'] }] }
    )
    ok(runTidy({ mode: 'roles', scope: { groupId: 'g' } }))
    expect(byId('c')).toMatchObject({ x: 900, y: 900 })
    expect(overlaps(useCanvasStore.getState().boards.filter((b) => b.id !== 'c'))).toBe(false)

    seed([board('terminal', 'a', 0, 0), board('terminal', 'b', 0, 0), board('terminal', 'c', 0, 0)])
    ok(runTidy({ mode: 'smart', scope: { boardIds: ['a', 'b'] } }))
    expect(byId('c')).toMatchObject({ x: 0, y: 0 })
  })

  it("scope 'visible' arranges only what is on screen", () => {
    seed([
      board('terminal', 'on1', 10, 10),
      board('terminal', 'on2', 10, 10),
      board('terminal', 'off', 50_000, 50_000)
    ])
    const run = ok(runTidy({ mode: 'smart', scope: 'visible' }))
    expect(run.count).toBe(2)
    expect(byId('off')).toMatchObject({ x: 50_000, y: 50_000 })
  })
})

describe('runTidy — tile + legacy packers', () => {
  it('tile sizes every board into the template (ONE step); smart repositions only', () => {
    seed([board('terminal', 'a', 0, 0), board('terminal', 'b', 0, 0)])
    const w0 = byId('a').w
    ok(runTidy({ mode: 'tile', template: 'cols-2' }))
    expect(byId('a').w).not.toBe(w0)
    expect(useCanvasStore.getState().past).toHaveLength(1)

    seed([board('terminal', 'a', 0, 0), board('terminal', 'b', 0, 0)])
    const run = ok(runTidy({ mode: 'smart' }))
    expect(run.moved).toBeGreaterThan(0)
    expect(byId('a').w).toBe(w0)
    expect(overlaps(useCanvasStore.getState().boards)).toBe(false)
  })

  it('an already-tidy canvas records NO undo step but still frames the camera', () => {
    seed([board('terminal', 'a', 0, 0), board('terminal', 'b', 0, 0)])
    ok(runTidy({ mode: 'smart' }))
    useCanvasStore.setState({ past: [] })
    const again = ok(runTidy({ mode: 'smart' }))
    expect(again.moved).toBe(0)
    expect(useCanvasStore.getState().past).toHaveLength(0)
    expect(useCameraRequestStore.getState().seq).toBe(2)
  })
})
