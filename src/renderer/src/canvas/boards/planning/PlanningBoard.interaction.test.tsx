import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import type { PlanningBoard as PlanningBoardData, NoteElement } from '../../../lib/boardSchema'

// jsdom does not implement the Pointer Capture API; PlanningBoard's well captures the
// pointer on every gesture (`setPointerCapture` in onWellPointerDown / startElementDrag).
// Stub the three methods so a synthetic PointerEvent does not throw inside the handler.
// This shims a missing jsdom DOM API only — it changes no production behavior.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => false
}

afterEach(cleanup)

// Render the REAL PlanningBoard, subscribed to the store so a commit re-passes a fresh
// `board` prop (mirrors BoardNode in production). ReactFlowProvider supplies the
// transform store PlanningBoard reads for the screen→board zoom (defaults to zoom 1).
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
function seedPlanning(elements: NoteElement[]): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(id, { elements } as never)
  return id
}

/** Current planning-board elements from the store (the serialized truth). */
function els(id: string): readonly { id: string; kind: string; x: number; y: number }[] {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'planning' ? (b.elements as never) : []
}

function note(id: string, over: Partial<NoteElement>): NoteElement {
  return {
    id,
    kind: 'note',
    x: 40,
    y: 40,
    w: 156,
    h: 96,
    tint: 'yellow',
    text: '',
    rotation: 0,
    ...over
  } as NoteElement
}

const well = (): HTMLElement => document.querySelector('.pl-well') as HTMLElement
// Each interaction is wrapped in act() so the resulting setState (e.g. setTool) commits
// before the next event reads it — a tool shortcut must be applied before the tap that
// relies on it, and dispatchEvent outside act does not flush React's re-render.
function press(k: string): void {
  act(() => {
    well().focus()
    well().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}
/** Tap = pointerdown+pointerup at board-local (bx,by) (== client coords in jsdom). */
function tap(bx: number, by: number): void {
  act(() => {
    for (const t of ['pointerdown', 'pointerup']) {
      well().dispatchEvent(
        new PointerEvent(t, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          clientX: bx,
          clientY: by
        })
      )
    }
  })
}

describe('PlanningBoard interaction — erase + shortcut (migrated from e2e whiteboard-erase)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  })

  // Notes carry text so the empty-note auto-prune (NoteCard focuses a text-empty note
  // on mount and deletes it on blur) never fires when `press()` moves focus to the well
  // — the same discipline the W2 selection probe used. An empty seed note would blur-prune
  // on the first keypress and confound the erase/create assertion.
  it("'e' erases the tapped note; undo restores it in one step", () => {
    const id = seedPlanning([note('n1', { x: 40, y: 40, w: 156, h: 96, text: 'A' })])
    render(<Harness id={id} />)
    expect(els(id).length).toBe(1)

    press('e') // eraser tool (shortcutTool)
    tap(118, 88) // board-local centre of the note → erase swipe removes it on pointer-up
    expect(els(id).length).toBe(0)

    useCanvasStore.getState().undo()
    expect(els(id).length).toBe(1)
  })

  it("'n' selects the note tool → a tap on empty space creates a note", () => {
    const id = seedPlanning([note('n1', { x: 40, y: 40, text: 'A' })])
    render(<Harness id={id} />)

    press('n')
    tap(230, 210) // empty spot → note tool creates a fresh note
    expect(els(id).length).toBe(2)
  })
})
