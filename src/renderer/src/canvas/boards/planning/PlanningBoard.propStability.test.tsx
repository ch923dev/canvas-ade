import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import type { PlanningBoard as PlanningBoardData, NoteElement } from '../../../lib/boardSchema'

/**
 * P0 perf — the precondition behind per-card render isolation. The 4 cards are memoized
 * (see cardMemo.test.tsx); React.memo only skips when the PROPS are referentially equal.
 * This test mounts the REAL PlanningBoard (the mock NoteCard below is un-memo'd so it
 * records every render's props) and proves that editing ONE note leaves every OTHER card's
 * element object AND callbacks referentially stable — so a memo'd card skips. It guards the
 * concrete fixes in this slice: the stale-`elements`-closure mutators (setNoteText/
 * setTitle/setItem/deleteEl) and the unstable inline onDragStart/onEditingChange handlers,
 * any of which would re-create on every keystroke and defeat the memo.
 */
const noteProps: Record<string, Record<string, unknown>[]> = {}
vi.mock('./NoteCard', () => ({
  NoteCard: (props: { note: { id: string } } & Record<string, unknown>): null => {
    ;(noteProps[props.note.id] ??= []).push(props)
    return null
  }
}))

// jsdom shims (mirror PlanningBoard.interaction.test.tsx) — no production behavior change.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => false
}

afterEach(cleanup)
beforeEach(() => {
  for (const k of Object.keys(noteProps)) delete noteProps[k]
})

function Harness({ id }: { id: string }): ReactElement | null {
  const board = useCanvasStore((s) => s.boards.find((b) => b.id === id))
  if (!board || board.type !== 'planning') return null
  return (
    <ReactFlowProvider>
      <PlanningBoard board={board as PlanningBoardData} selected hovered={false} dimmed={false} />
    </ReactFlowProvider>
  )
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

function boardElements(id: string): NoteElement[] {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'planning' ? (b.elements as NoteElement[]) : []
}

describe('PlanningBoard passes stable props to un-edited cards (memo precondition)', () => {
  it('editing one note keeps the other card element + callbacks referentially stable', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    act(() => {
      useCanvasStore.getState().updateBoard(id, {
        elements: [note('a', { text: 'a' }), note('b', { text: 'b' })]
      } as never)
    })
    render(<Harness id={id} />)

    const aBefore = noteProps['a']?.at(-1)
    const bBefore = noteProps['b']?.at(-1)
    expect(aBefore).toBeDefined()
    expect(bBefore).toBeDefined()
    const bRendersBefore = noteProps['b']?.length ?? 0

    // Edit note A only — the same shape a keystroke commit produces (A is a new object,
    // B is preserved by reference via the .map). Drives a board re-render through the store.
    act(() => {
      useCanvasStore.getState().updateBoard(id, {
        elements: boardElements(id).map((e) => (e.id === 'a' ? { ...e, text: 'a2' } : e))
      } as never)
    })

    expect(noteProps['b']?.length ?? 0).toBeGreaterThan(bRendersBefore) // board re-rendered
    const aAfter = noteProps['a']?.at(-1)
    const bAfter = noteProps['b']?.at(-1)
    expect(aAfter).toBeDefined()
    expect(bAfter).toBeDefined()

    // The edited card's element object changed (it re-renders); the other card's did not
    // (patchElement keeps unchanged refs → memo skips it).
    expect(aAfter!.note).not.toBe(aBefore!.note)
    expect(bAfter!.note).toBe(bBefore!.note)

    // Every callback the un-edited card holds is the SAME reference across the edit — the
    // stable-identity contract that lets React.memo actually skip the card.
    for (const key of [
      'onChangeText',
      'onDelete',
      'onDragStart',
      'onSelect',
      'onMeasure',
      'onSetTint',
      'onEditStart',
      'onResize'
    ] as const) {
      expect(bAfter![key]).toBe(bBefore![key])
    }
  })
})
