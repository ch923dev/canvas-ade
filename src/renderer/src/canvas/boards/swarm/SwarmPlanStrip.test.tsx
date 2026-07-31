import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SwarmPlanStrip } from './SwarmPlanStrip'
import { useCanvasStore } from '../../../store/canvasStore'
import type { Board, PlanningBoard } from '../../../lib/boardSchema'

const PLAN_ID = 'plan-1'

/** A Planning board carrying one checklist — the plan of record the strip projects. */
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

const seed = (items: Array<{ id: string; label: string; done: boolean }>): void => {
  useCanvasStore.setState({ boards: [planBoard(items) as Board] })
}

/** The checklist as the STORE holds it after an edit — the plan board is the source of truth. */
const stored = (): Array<{ id: string; label: string; done: boolean }> => {
  const b = useCanvasStore.getState().boards.find((x) => x.id === PLAN_ID)
  const el = b?.type === 'planning' ? b.elements.find((e) => e.kind === 'checklist') : undefined
  return el && el.kind === 'checklist' ? el.items : []
}

beforeEach(() => {
  cleanup()
  useCanvasStore.setState({ boards: [] })
})

describe('SwarmPlanStrip — projection', () => {
  it('renders one chip per checklist item, numbered, with done state', () => {
    seed([
      { id: 'i1', label: 'recon', done: true },
      { id: 'i2', label: 'migrate readers', done: false }
    ])
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />)
    expect(all('swarm-plan-chip')).toHaveLength(2)
    expect(screen.getByText('migrate readers')).toBeTruthy()
    expect(screen.getByLabelText('Untick recon')).toBeTruthy() // done ⇒ the verb inverts
  })

  it('says so plainly when there is no plan yet, and offers no add chip', () => {
    render(<SwarmPlanStrip planBoardId={null} owners={{}} onOpen={vi.fn()} />)
    expect(screen.getByText(/no plan yet/)).toBeTruthy()
    expect(all('swarm-plan-add')[0] ?? null).toBeNull()
  })

  it('the label still jumps to the Planning board (S1 behaviour, unchanged)', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    const onOpen = vi.fn()
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('recon'))
    expect(onOpen).toHaveBeenCalledWith(PLAN_ID)
  })

  it('renders the owner dot only for items the ledger says a worker holds', () => {
    seed([
      { id: 'i1', label: 'a', done: false },
      { id: 'i2', label: 'b', done: false }
    ])
    const { container } = render(
      <SwarmPlanStrip planBoardId={PLAN_ID} owners={{ i2: 'stalled' }} onOpen={vi.fn()} />
    )
    expect(container.querySelectorAll('.sw-task-own')).toHaveLength(1)
    expect(container.querySelector('.sw-task-own.stalled')).toBeTruthy()
  })
})

describe('SwarmPlanStrip — editing writes through to the plan board (D2 always-live)', () => {
  it('the checkbox toggles done on the BOARD, not in local state', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />)
    fireEvent.click(one('swarm-plan-tick'))
    expect(stored()[0].done).toBe(true)
  })

  it('rename commits on Enter and reverts on Escape', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />)

    fireEvent.click(one('swarm-plan-rename'))
    fireEvent.change(one('swarm-plan-edit'), { target: { value: 'recon + notes' } })
    fireEvent.keyDown(one('swarm-plan-edit'), { key: 'Enter' })
    expect(stored()[0].label).toBe('recon + notes')

    fireEvent.click(one('swarm-plan-rename'))
    fireEvent.change(one('swarm-plan-edit'), { target: { value: 'discarded' } })
    fireEvent.keyDown(one('swarm-plan-edit'), { key: 'Escape' })
    expect(stored()[0].label).toBe('recon + notes')
  })

  it('emptying an existing label removes the item (the ⌫ affordance)', () => {
    seed([
      { id: 'i1', label: 'recon', done: false },
      { id: 'i2', label: 'migrate', done: false }
    ])
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />)
    fireEvent.click(all('swarm-plan-rename')[0])
    fireEvent.change(one('swarm-plan-edit'), { target: { value: '   ' } })
    fireEvent.keyDown(one('swarm-plan-edit'), { key: 'Enter' })
    expect(stored().map((i) => i.id)).toEqual(['i2'])
  })

  it('the add chip appends a labelled item — and an EMPTY one adds nothing', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />)

    fireEvent.click(one('swarm-plan-add'))
    fireEvent.keyDown(one('swarm-plan-edit'), { key: 'Enter' })
    expect(stored()).toHaveLength(1) // a blank row is never what the human meant

    fireEvent.click(one('swarm-plan-add'))
    fireEvent.change(one('swarm-plan-edit'), { target: { value: 'ship it' } })
    fireEvent.keyDown(one('swarm-plan-edit'), { key: 'Enter' })
    expect(stored().map((i) => i.label)).toEqual(['recon', 'ship it'])
  })

  it('a blur commits the open rename (the design says blur commits, like the board)', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />)
    fireEvent.click(one('swarm-plan-rename'))
    fireEvent.change(one('swarm-plan-edit'), { target: { value: 'blurred' } })
    fireEvent.blur(one('swarm-plan-edit'))
    expect(stored()[0].label).toBe('blurred')
  })

  it('🔒 a keystroke in the rename never reaches the canvas hotkeys', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    const onKey = vi.fn()
    render(
      <div onKeyDown={onKey}>
        <SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />
      </div>
    )
    fireEvent.click(one('swarm-plan-rename'))
    fireEvent.keyDown(one('swarm-plan-edit'), { key: 'Backspace' })
    expect(onKey).not.toHaveBeenCalled()
  })
})

describe('SwarmPlanStrip — the kanban flip affordance (task #12)', () => {
  it('renders the ⊞ button only when a flip handler is wired, and it fires', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    const onFlip = vi.fn()
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} onFlip={onFlip} />)
    fireEvent.click(one('swarm-plan-flip'))
    expect(onFlip).toHaveBeenCalledTimes(1)
  })

  it('no handler ⇒ no button (test/legacy renders stay byte-identical)', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} />)
    expect(all('swarm-plan-flip')[0] ?? null).toBeNull()
  })

  it('double-click on the strip SURFACE flips — but never through a control', () => {
    seed([{ id: 'i1', label: 'recon', done: false }])
    const onFlip = vi.fn()
    render(<SwarmPlanStrip planBoardId={PLAN_ID} owners={{}} onOpen={vi.fn()} onFlip={onFlip} />)
    fireEvent.doubleClick(one('swarm-plan-strip'))
    expect(onFlip).toHaveBeenCalledTimes(1)
    // A double-click landing on a chip's checkbox must act as two ticks, not a flip.
    fireEvent.doubleClick(one('swarm-plan-tick'))
    expect(onFlip).toHaveBeenCalledTimes(1)
  })
})
