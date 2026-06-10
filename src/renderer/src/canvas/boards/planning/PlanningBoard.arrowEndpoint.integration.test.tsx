import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import type {
  ArrowElement,
  PlanningBoard as PlanningBoardData,
  PlanningElement
} from '../../../lib/boardSchema'

// jsdom does not implement the Pointer Capture API; the endpoint-drag gesture (like
// every well gesture) captures the pointer on the well. Stub the three methods so a
// synthetic PointerEvent does not throw inside the handler (mirrors
// PlanningBoard.interaction.test.tsx — shims a missing jsdom DOM API only).
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => false
}

afterEach(cleanup)

function Harness({ id }: { id: string }): ReactElement | null {
  const board = useCanvasStore((s) => s.boards.find((b) => b.id === id))
  if (!board || board.type !== 'planning') return null
  return (
    <ReactFlowProvider>
      <PlanningBoard board={board as PlanningBoardData} selected hovered={false} dimmed={false} />
    </ReactFlowProvider>
  )
}

/** Seed a planning board with the given elements; returns its id. Resets the store. */
function seedPlanning(elements: PlanningElement[]): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(id, { elements } as never)
  return id
}

/** The live arrow element from the store (the serialized truth). */
function storeArrow(boardId: string, elId: string): ArrowElement | undefined {
  const b = useCanvasStore.getState().boards.find((x) => x.id === boardId)
  const els = b && b.type === 'planning' ? b.elements : []
  return els.find((e): e is ArrowElement => e.id === elId && e.kind === 'arrow')
}

function arrow(id: string, over?: Partial<ArrowElement>): ArrowElement {
  return { id, kind: 'arrow', x: 20, y: 30, x2: 220, y2: 130, ...over }
}

const well = (): HTMLElement => document.querySelector('.pl-well') as HTMLElement

function pointer(type: string, x: number, y: number, init?: PointerEventInit): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: x,
    clientY: y,
    ...init
  })
}

/** Select a committed vector by pressing its <path> (press + settle on the well). */
function selectPath(el: Element, opts?: PointerEventInit): void {
  act(() => {
    el.dispatchEvent(pointer('pointerdown', 0, 0, opts))
    well().dispatchEvent(pointer('pointerup', 0, 0, opts))
  })
}

/** The committed arrow <path> elements (direct svg children; marker paths are nested). */
const arrowPaths = (): Element[] => Array.from(document.querySelectorAll('.pl-well svg > path'))

const handle = (end: 'start' | 'end'): Element | null =>
  document.querySelector(`[data-arrow-endpoint="${end}"]`)

describe('PlanningBoard — arrow endpoint editing (D3-B)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  })

  it('shows two endpoint handles for exactly one selected, unlocked arrow', () => {
    const id = seedPlanning([arrow('a1')])
    render(<Harness id={id} />)
    expect(handle('start')).toBeNull()

    selectPath(arrowPaths()[0])
    expect(handle('start')).not.toBeNull()
    expect(handle('end')).not.toBeNull()
  })

  it('hides handles for a locked arrow', () => {
    const id = seedPlanning([arrow('a1', { locked: true })])
    render(<Harness id={id} />)
    selectPath(arrowPaths()[0])
    expect(handle('start')).toBeNull()
    expect(handle('end')).toBeNull()
  })

  it('hides handles when more than one element is selected', () => {
    const id = seedPlanning([arrow('a1'), arrow('a2', { x: 40, y: 200, x2: 240, y2: 300 })])
    render(<Harness id={id} />)
    selectPath(arrowPaths()[0])
    expect(handle('start')).not.toBeNull()
    selectPath(arrowPaths()[1], { shiftKey: true })
    expect(handle('start')).toBeNull()
  })

  it('dragging the head handle moves only x2/y2 and commits ONE undo step', () => {
    const id = seedPlanning([arrow('a1')])
    render(<Harness id={id} />)
    selectPath(arrowPaths()[0])
    const pastBefore = useCanvasStore.getState().past.length

    act(() => {
      handle('end')!.dispatchEvent(pointer('pointerdown', 220, 130))
    })
    act(() => {
      well().dispatchEvent(pointer('pointermove', 300, 60))
    })
    // Mid-drag: live re-bow renders the draft endpoint; the store is untouched.
    expect(arrowPaths()[0].getAttribute('d')).toMatch(/300 60$/)
    expect(storeArrow(id, 'a1')).toMatchObject({ x2: 220, y2: 130 })
    act(() => {
      well().dispatchEvent(pointer('pointerup', 300, 60))
    })

    expect(storeArrow(id, 'a1')).toMatchObject({ x: 20, y: 30, x2: 300, y2: 60 })
    expect(useCanvasStore.getState().past.length).toBe(pastBefore + 1)
    act(() => useCanvasStore.getState().undo())
    expect(storeArrow(id, 'a1')).toMatchObject({ x2: 220, y2: 130 })
  })

  it('dragging the tail handle moves only x/y', () => {
    const id = seedPlanning([arrow('a1')])
    render(<Harness id={id} />)
    selectPath(arrowPaths()[0])

    act(() => {
      handle('start')!.dispatchEvent(pointer('pointerdown', 20, 30))
    })
    act(() => {
      well().dispatchEvent(pointer('pointermove', 90, 95))
    })
    act(() => {
      well().dispatchEvent(pointer('pointerup', 90, 95))
    })
    expect(storeArrow(id, 'a1')).toMatchObject({ x: 90, y: 95, x2: 220, y2: 130 })
  })

  it('a sub-4px tap on a handle commits nothing and pushes NO undo checkpoint', () => {
    const id = seedPlanning([arrow('a1')])
    render(<Harness id={id} />)
    selectPath(arrowPaths()[0])
    const pastBefore = useCanvasStore.getState().past.length

    act(() => {
      handle('end')!.dispatchEvent(pointer('pointerdown', 220, 130))
    })
    act(() => {
      well().dispatchEvent(pointer('pointermove', 222, 131))
    })
    act(() => {
      well().dispatchEvent(pointer('pointerup', 222, 131))
    })
    expect(storeArrow(id, 'a1')).toMatchObject({ x2: 220, y2: 130 })
    expect(useCanvasStore.getState().past.length).toBe(pastBefore)
  })

  it('pointer-cancel mid-drag discards the edit (no commit, no checkpoint)', () => {
    const id = seedPlanning([arrow('a1')])
    render(<Harness id={id} />)
    selectPath(arrowPaths()[0])
    const pastBefore = useCanvasStore.getState().past.length

    act(() => {
      handle('end')!.dispatchEvent(pointer('pointerdown', 220, 130))
    })
    act(() => {
      well().dispatchEvent(pointer('pointermove', 320, 80))
    })
    act(() => {
      well().dispatchEvent(pointer('pointercancel', 320, 80))
    })
    expect(storeArrow(id, 'a1')).toMatchObject({ x: 20, y: 30, x2: 220, y2: 130 })
    expect(useCanvasStore.getState().past.length).toBe(pastBefore)
  })

  it('a right-button press on a handle starts no drag', () => {
    const id = seedPlanning([arrow('a1')])
    render(<Harness id={id} />)
    selectPath(arrowPaths()[0])

    act(() => {
      handle('end')!.dispatchEvent(pointer('pointerdown', 220, 130, { button: 2 }))
    })
    act(() => {
      well().dispatchEvent(pointer('pointermove', 300, 60))
    })
    act(() => {
      well().dispatchEvent(pointer('pointerup', 300, 60))
    })
    expect(storeArrow(id, 'a1')).toMatchObject({ x2: 220, y2: 130 })
  })
})
