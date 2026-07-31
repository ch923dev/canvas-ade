import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SwarmPlanKanban } from './SwarmPlanKanban'
import { useCanvasStore } from '../../../store/canvasStore'
import type { Board, PlanningBoard } from '../../../lib/boardSchema'
import type { SwarmWorkerLedgerState } from '../../../../../shared/swarmLedgerTypes'

const PLAN_ID = 'plan-1'

/** A Planning board carrying one checklist — the plan of record the kanban projects. */
function planBoard(items: Array<{ id: string; label: string; done: boolean }>): PlanningBoard {
  return {
    id: PLAN_ID,
    type: 'planning',
    title: 'Run plan',
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    elements: [{ id: 'cl-1', kind: 'checklist', x: 0, y: 0, w: 260, title: 'Plan', items }]
  } as PlanningBoard
}

/** The repo tags DOM hooks `data-test`, not testing-library's default `data-testid`. */
const all = (t: string): HTMLElement[] =>
  Array.from(document.querySelectorAll(`[data-test="${t}"]`)) as HTMLElement[]
const one = (t: string): HTMLElement => {
  const el = all(t)[0]
  if (!el) throw new Error(`no element with data-test="${t}"`)
  return el
}
/** Cards inside the column keyed `data-col=<key>` (queue · a worker boardId · done). */
const colCards = (key: string): HTMLElement[] =>
  Array.from(
    document.querySelectorAll(`[data-col="${key}"] [data-test="swarm-kb-card"]`)
  ) as HTMLElement[]

const seed = (items: Array<{ id: string; label: string; done: boolean }>): void => {
  useCanvasStore.setState({ boards: [planBoard(items) as Board] })
}

/** The checklist as the STORE holds it after an edit — the plan board is the source of truth. */
const stored = (): Array<{ id: string; label: string; done: boolean }> => {
  const b = useCanvasStore.getState().boards.find((x) => x.id === PLAN_ID)
  const el = b?.type === 'planning' ? b.elements.find((e) => e.kind === 'checklist') : undefined
  return el && el.kind === 'checklist' ? el.items : []
}

const worker = (over: Partial<SwarmWorkerLedgerState> = {}): SwarmWorkerLedgerState => ({
  boardId: 'w1',
  taskId: 't1',
  role: 'builder',
  activity: 'Wiring the flip…',
  ...over
})

const renderKanban = (
  over: Partial<Parameters<typeof SwarmPlanKanban>[0]> = {}
): ReturnType<typeof render> =>
  render(
    <SwarmPlanKanban
      planBoardId={PLAN_ID}
      workers={[]}
      holders={{}}
      owners={{}}
      titleOf={(id) => `title:${id}`}
      onOpenPlan={vi.fn()}
      onOpenWorker={vi.fn()}
      onBack={vi.fn()}
      {...over}
    />
  )

beforeEach(() => {
  cleanup()
  useCanvasStore.setState({ boards: [] })
})

describe('SwarmPlanKanban — derivation (a lens, not a second kanban)', () => {
  it('routes each item: done → Done, held → its worker column, else Queue', () => {
    seed([
      { id: 'i1', label: 'shipped', done: true },
      { id: 'i2', label: 'held by w1', done: false },
      { id: 'i3', label: 'free', done: false }
    ])
    renderKanban({ workers: [worker()], holders: { i2: 'w1' } })
    expect(colCards('done').map((c) => c.dataset.item)).toEqual(['i1'])
    expect(colCards('w1').map((c) => c.dataset.item)).toEqual(['i2'])
    expect(colCards('queue').map((c) => c.dataset.item)).toEqual(['i3'])
  })

  it('a DONE item leaves its worker column even while the ledger still holds it', () => {
    // done wins over held: the tick is the human's fact, the hold is the run's.
    seed([{ id: 'i1', label: 'ticked mid-hold', done: true }])
    renderKanban({ workers: [worker()], holders: { i1: 'w1' } })
    expect(colCards('done')).toHaveLength(1)
    expect(colCards('w1')).toHaveLength(0)
  })

  it('worker columns render in ledger order — a HOLDING worker shows its activity, an idle one says so', () => {
    seed([{ id: 'i1', label: 'a', done: false }])
    renderKanban({
      workers: [worker(), worker({ boardId: 'w2', role: 'tester', activity: 'Running e2e…' })],
      holders: { i1: 'w2' }
    })
    const cols = all('swarm-kb-col').map((c) => c.dataset.col)
    expect(cols).toEqual(['queue', 'w1', 'w2', 'done'])
    expect(screen.getByText('title:w2')).toBeTruthy()
    expect(screen.getByText('tester')).toBeTruthy()
    expect(screen.getByText('Running e2e…')).toBeTruthy() // w2 holds i1 → live activity verb
    expect(screen.getByText('idle — awaiting dispatch')).toBeTruthy() // w1 holds nothing
  })

  it('a stalled hold marks the card and the column tone amber', () => {
    seed([{ id: 'i1', label: 'stuck', done: false }])
    const { container } = renderKanban({
      workers: [worker({ state: 'stalled' })],
      holders: { i1: 'w1' },
      owners: { i1: 'stalled' }
    })
    expect(container.querySelector('.sw-kb-card.stalled')).toBeTruthy()
    expect(screen.getByText('stalled')).toBeTruthy() // the card's tag
    expect(container.querySelector('.sw-kb-dot.stalled')).toBeTruthy()
  })

  it('says so plainly when there is no plan yet', () => {
    renderKanban({ planBoardId: null })
    expect(one('swarm-kb-empty').textContent).toMatch(/no plan yet/)
  })
})

describe('SwarmPlanKanban — edits write through to the plan board (the strip’s three)', () => {
  it('the tick toggles done on the BOARD, not in local state', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    renderKanban()
    fireEvent.click(one('swarm-kb-tick'))
    expect(stored()[0].done).toBe(true)
  })

  it('add lands a labelled item (in Queue), and an EMPTY one adds nothing', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    renderKanban()

    fireEvent.click(one('swarm-kb-add'))
    fireEvent.keyDown(one('swarm-kb-edit'), { key: 'Enter' })
    expect(stored()).toHaveLength(1)

    fireEvent.click(one('swarm-kb-add'))
    fireEvent.change(one('swarm-kb-edit'), { target: { value: 'ship it' } })
    fireEvent.keyDown(one('swarm-kb-edit'), { key: 'Enter' })
    expect(stored().map((i) => i.label)).toEqual(['recon', 'ship it'])
  })

  it('rename commits on Enter, reverts on Escape, and an emptied label removes the item', () => {
    seed([
      { id: 'i1', label: 'recon', done: false },
      { id: 'i2', label: 'keep', done: false }
    ])
    renderKanban()

    fireEvent.click(all('swarm-kb-rename')[0])
    fireEvent.change(one('swarm-kb-edit'), { target: { value: 'recon + notes' } })
    fireEvent.keyDown(one('swarm-kb-edit'), { key: 'Enter' })
    expect(stored()[0].label).toBe('recon + notes')

    fireEvent.click(all('swarm-kb-rename')[0])
    fireEvent.change(one('swarm-kb-edit'), { target: { value: 'discarded' } })
    fireEvent.keyDown(one('swarm-kb-edit'), { key: 'Escape' })
    expect(stored()[0].label).toBe('recon + notes')

    fireEvent.click(all('swarm-kb-rename')[0])
    fireEvent.change(one('swarm-kb-edit'), { target: { value: '   ' } })
    fireEvent.keyDown(one('swarm-kb-edit'), { key: 'Enter' })
    expect(stored().map((i) => i.id)).toEqual(['i2'])
  })

  it('🔒 a keystroke in the rename never reaches the canvas hotkeys', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    const onKey = vi.fn()
    render(
      <div onKeyDown={onKey}>
        <SwarmPlanKanban
          planBoardId={PLAN_ID}
          workers={[]}
          holders={{}}
          owners={{}}
          titleOf={(id) => id}
          onOpenPlan={vi.fn()}
          onOpenWorker={vi.fn()}
          onBack={vi.fn()}
        />
      </div>
    )
    fireEvent.click(one('swarm-kb-rename'))
    fireEvent.keyDown(one('swarm-kb-edit'), { key: 'Backspace' })
    expect(onKey).not.toHaveBeenCalled()
  })
})

describe('SwarmPlanKanban — navigation + the way back', () => {
  it('the card label opens the Planning board; the worker name opens that worker', () => {
    seed([{ id: 'i1', label: 'held', done: false }])
    const onOpenPlan = vi.fn()
    const onOpenWorker = vi.fn()
    renderKanban({ workers: [worker()], holders: { i1: 'w1' }, onOpenPlan, onOpenWorker })
    fireEvent.click(screen.getByText('held'))
    expect(onOpenPlan).toHaveBeenCalledWith(PLAN_ID)
    fireEvent.click(screen.getByText('title:w1'))
    expect(onOpenWorker).toHaveBeenCalledWith('w1')
  })

  it('⟲ strip flips back', () => {
    seed([{ id: 'i1', label: 'a', done: false }])
    const onBack = vi.fn()
    renderKanban({ onBack })
    fireEvent.click(one('swarm-kb-back'))
    expect(onBack).toHaveBeenCalled()
  })
})
