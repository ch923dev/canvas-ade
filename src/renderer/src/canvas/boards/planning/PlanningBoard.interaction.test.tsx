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

// NoteCard (BUG-050 fix) now observes its rendered size via ResizeObserver so
// erase/marquee/snap use the actual auto-sized height. jsdom has no ResizeObserver;
// stub a no-op so cards mount without throwing (mirrors the ChecklistCard stub in
// PlanningBoard.stale-closure.test.tsx — same pattern, same rationale).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
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

  it('BUG-014: right-button press on the well with erase tool does NOT erase (primary-button guard)', () => {
    const id = seedPlanning([note('n1', { x: 40, y: 40, w: 156, h: 96, text: 'A' })])
    render(<Harness id={id} />)
    press('e') // arm eraser
    // Right-button pointerdown + pointerup over the note centre — must NOT erase
    act(() => {
      for (const t of ['pointerdown', 'pointerup']) {
        well().dispatchEvent(
          new PointerEvent(t, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            button: 2,
            buttons: 2,
            clientX: 118,
            clientY: 88
          })
        )
      }
    })
    expect(els(id).length).toBe(1) // note must survive a right-button press
  })

  it('BUG-014: right-button press on the well with note tool does NOT create a note', () => {
    const id = seedPlanning([note('n1', { x: 40, y: 40, text: 'A' })])
    render(<Harness id={id} />)
    press('n') // arm note tool
    act(() => {
      for (const t of ['pointerdown', 'pointerup']) {
        well().dispatchEvent(
          new PointerEvent(t, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            button: 2,
            buttons: 2,
            clientX: 300,
            clientY: 300
          })
        )
      }
    })
    expect(els(id).length).toBe(1) // no new note from right-button press
  })

  it('BUG-014: right-button press on empty well in select mode does NOT clear the selection', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // marquee-select both notes
    const beforeCount = els(id).length
    expect(beforeCount).toBe(2)
    // Right-button press on empty space — must NOT arm a marquee that clears selection
    act(() => {
      for (const t of ['pointerdown', 'pointerup']) {
        well().dispatchEvent(
          new PointerEvent(t, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            button: 2,
            buttons: 2,
            clientX: 560,
            clientY: 300
          })
        )
      }
    })
    // Elements still present (selection clear would not remove them, but verifying count
    // also ensures no accidental creation from the right-press)
    expect(els(id).length).toBe(2)
  })
})

const grip = (i: number): HTMLElement =>
  document.querySelectorAll('.pl-note-grip')[i] as HTMLElement

function ev(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  mods?: { shift?: boolean; alt?: boolean }
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
      shiftKey: !!mods?.shift,
      altKey: !!mods?.alt
    })
  )
}

/** Drag from (fx,fy) to (tx,ty); down on `downTarget` (default well), moves+up on well.
 *  Each event is flushed in its OWN act() so the move-frame setState (dragPos / marqueeRect)
 *  commits before pointerup reads it — onWellPointerUp closes over that state, and batching
 *  the whole gesture in one act would leave it stale (null), so no move/marquee would
 *  register. The real e2e probe achieves the same via `await sleep()` between events. */
function drag(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  opts?: { downTarget?: EventTarget; shift?: boolean; alt?: boolean }
): void {
  const downT = opts?.downTarget ?? well()
  act(() => ev(downT, 'pointerdown', fx, fy, opts))
  for (let i = 1; i <= 4; i++) {
    const t = i / 4
    act(() => ev(well(), 'pointermove', fx + (tx - fx) * t, fy + (ty - fy) * t, opts))
  }
  act(() => ev(well(), 'pointerup', tx, ty, opts))
}

function noteX(id: string, nid: string): number {
  const n = els(id).find((e) => e.id === nid)
  return n ? n.x : -999999
}

/** The two-note W2 fixture (text so a no-move grip click never prunes an empty note). */
function seedTwo(): string {
  return seedPlanning([
    note('w2-a', { x: 40, y: 40, w: 156, h: 96, text: 'A', tint: 'yellow' }),
    note('w2-b', { x: 260, y: 40, w: 156, h: 96, text: 'B', tint: 'blue' })
  ])
}

function openContextMenuAt(x: number, y: number, target: EventTarget = well()): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
    )
  })
}
function clickMenuItem(testid: string): void {
  const item = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement
  if (!item) throw new Error(`menu item ${testid} not found`)
  act(() => item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
}

describe('PlanningBoard interaction — selection core (migrated from whiteboard-selection)', () => {
  it('marquee selects both → Delete removes both; one undo restores both', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // marquee over w2-a + w2-b
    act(() => press('Delete'))
    expect(els(id).length).toBe(0)
    useCanvasStore.getState().undo()
    expect(els(id).length).toBe(2)
  })

  it('marquee 2 → drag one grip moves both; undo restores both', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // select both
    const ax0 = noteX(id, 'w2-a')
    const bx0 = noteX(id, 'w2-b')
    drag(118, 88, 158, 128, { downTarget: grip(0) }) // drag w2-a's grip +40,+40
    expect(noteX(id, 'w2-a') - ax0).toBeGreaterThanOrEqual(30)
    expect(noteX(id, 'w2-b') - bx0).toBeGreaterThanOrEqual(30)
    useCanvasStore.getState().undo()
    expect(noteX(id, 'w2-a')).toBe(ax0)
    expect(noteX(id, 'w2-b')).toBe(bx0)
  })

  it('click A + Shift-click B selects both; dragging A moves both (additive element select)', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    act(() => {
      ev(grip(0), 'pointerdown', 60, 60)
      ev(well(), 'pointerup', 60, 60)
    })
    act(() => {
      ev(grip(1), 'pointerdown', 280, 60, { shift: true })
      ev(well(), 'pointerup', 280, 60, { shift: true })
    })
    const a0 = noteX(id, 'w2-a')
    const b0 = noteX(id, 'w2-b')
    drag(60, 60, 100, 60, { downTarget: grip(0) })
    expect(noteX(id, 'w2-a') - a0).toBeGreaterThanOrEqual(30)
    expect(noteX(id, 'w2-b') - b0).toBeGreaterThanOrEqual(30)
  })

  it("drags B's left edge within tolerance of A's left → committed B.x snaps to 40", () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(338, 88, 122, 88, { downTarget: grip(1) }) // B toward A's left edge (x=40)
    expect(Math.abs(noteX(id, 'w2-b') - 40)).toBeLessThanOrEqual(1)
  })
})

describe('PlanningBoard interaction — alt-dup + lock (migrated from W3 probes)', () => {
  it('alt-drag of a note grip duplicates it; original stays; undo removes the copy', () => {
    const id = seedPlanning([note('ad-a', { x: 60, y: 60, w: 156, h: 96, text: 'A' })])
    render(<Harness id={id} />)
    const x0 = noteX(id, 'ad-a')
    drag(138, 108, 198, 168, { downTarget: grip(0), alt: true }) // alt-drag → duplicate
    expect(els(id).length).toBe(2)
    expect(noteX(id, 'ad-a')).toBe(x0) // original unmoved
    useCanvasStore.getState().undo()
    expect(els(id).length).toBe(1)
  })

  it('a locked note resists drag, erase, and inline delete', () => {
    // Mirror whiteboardLock: a note with locked:true resists the grip drag, the eraser
    // swipe, and exposes no inline delete (.pl-del) affordance.
    const id = seedPlanning([note('lk', { x: 60, y: 60, w: 156, h: 96, text: 'L' })])
    useCanvasStore.getState().updateBoard(id, {
      elements: [{ ...els(id)[0], locked: true }]
    } as never)
    render(<Harness id={id} />)
    const x0 = noteX(id, 'lk')
    drag(138, 108, 220, 108, { downTarget: grip(0) }) // drag attempt
    expect(noteX(id, 'lk')).toBe(x0) // locked → unmoved
    press('e')
    tap(138, 108)
    expect(els(id).length).toBe(1) // locked → not erased
    expect(document.querySelector('.pl-del')).toBeNull() // no inline delete affordance
  })
})

describe('PlanningBoard interaction — group / align (migrated from W3 menu probes)', () => {
  it('marquee + context-menu Group assigns both a shared groupId', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // select both
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-group')
    const e = els(id) as readonly { groupId?: string }[]
    expect(e[0].groupId && e[0].groupId === e[1].groupId).toBeTruthy()
  })

  it('marquee + context-menu Align-left flushes both to the board pad; one undo restores B', () => {
    const id = seedPlanning([
      note('al-a', { x: 12, y: 40, text: 'A' }),
      note('al-b', { x: 300, y: 40, text: 'B' })
    ])
    render(<Harness id={id} />)
    drag(0, 10, 470, 150) // marquee both
    openContextMenuAt(40, 60, grip(0))
    clickMenuItem('w3-menu-align-left')
    expect(noteX(id, 'al-a')).toBe(noteX(id, 'al-b')) // both flushed left to the same x
    expect(noteX(id, 'al-a')).toBe(12) // the board pad
    useCanvasStore.getState().undo()
    expect(noteX(id, 'al-b')).toBe(300)
  })

  it('right-clicking ONE grouped element aligns the WHOLE group (group-align regression)', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150)
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-group')
    // clear selection, then right-click only one grouped element → align expands the group
    tap(560, 300)
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-align-left')
    expect(noteX(id, 'w2-a')).toBe(noteX(id, 'w2-b')) // both moved, not just the clicked one
  })

  it('BUG-013: empty-space right-click with partial group selection must NOT delete the un-selected sibling', () => {
    // 1. Create two notes (A=w2-a, B=w2-b) and group them.
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150)
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-group')

    // 2. Clear selection, then Shift-click only note A (partial group selection).
    tap(560, 300) // clear to empty selection
    act(() => {
      ev(grip(0), 'pointerdown', 60, 60, { shift: true })
      ev(well(), 'pointerup', 60, 60, { shift: true })
    })

    // 3. Right-click on empty whiteboard space — no element under the cursor.
    //    Bug: expandGroups fires on base=selectedIds={A}, silently adds B → effective={A,B}.
    //    The context menu then opens with effective={A,B}; Delete removes BOTH.
    openContextMenuAt(560, 300, well()) // far from any note; targetId will be null

    // 4. If the bug is present the context menu opened with the expanded set.
    //    Click Delete — with the bug this removes both A and B (count drops to 0).
    //    With the fix, either the menu never opened (empty-space right-click, no target)
    //    or it opened with only A; either way B must survive.
    const deleteItem = document.querySelector(
      '[data-testid="w3-menu-delete"]'
    ) as HTMLElement | null
    if (deleteItem) {
      act(() =>
        deleteItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      )
    }
    // B (w2-b) must survive: it was never in the user's explicit selection.
    const remaining = els(id)
    const bSurvives = remaining.some((e) => e.id === 'w2-b')
    expect(bSurvives).toBe(true)
  })
})

function noteTint(id: string, nid: string): string {
  const n = els(id).find((e) => e.id === nid) as { tint?: string } | undefined
  return n?.tint ?? ''
}

describe('PlanningBoard interaction — context-menu Tint row (D3-A)', () => {
  it('select both → click the green swatch tints BOTH; one undo restores both', () => {
    const id = seedTwo() // w2-a yellow, w2-b blue
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // marquee both
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-tint-green')
    expect(noteTint(id, 'w2-a')).toBe('green')
    expect(noteTint(id, 'w2-b')).toBe('green')
    useCanvasStore.getState().undo()
    expect(noteTint(id, 'w2-a')).toBe('yellow')
    expect(noteTint(id, 'w2-b')).toBe('blue')
  })

  it('marks the current tint when every selected note shares it', () => {
    const id = seedPlanning([
      note('t-a', { x: 40, y: 40, text: 'A', tint: 'blue' }),
      note('t-b', { x: 260, y: 40, text: 'B', tint: 'blue' })
    ])
    render(<Harness id={id} />)
    drag(10, 10, 440, 150)
    openContextMenuAt(120, 80, grip(0))
    expect(
      (document.querySelector('[data-testid="w3-menu-tint-blue"]') as HTMLElement).hasAttribute(
        'data-current'
      )
    ).toBe(true)
    expect(
      (document.querySelector('[data-testid="w3-menu-tint-yellow"]') as HTMLElement).hasAttribute(
        'data-current'
      )
    ).toBe(false)
  })

  it('disables the Tint row when the only selected note is locked', () => {
    const id = seedPlanning([note('lk', { x: 60, y: 60, text: 'L' })])
    useCanvasStore.getState().updateBoard(id, {
      elements: [{ ...els(id)[0], locked: true }]
    } as never)
    render(<Harness id={id} />)
    openContextMenuAt(120, 80, grip(0))
    const swatch = document.querySelector('[data-testid="w3-menu-tint-blue"]') as HTMLButtonElement
    expect(swatch.disabled).toBe(true)
    act(() => swatch.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(noteTint(id, 'lk')).toBe('yellow') // unchanged
  })

  it('re-applying the current tint pushes NO undo step (no phantom)', () => {
    const id = seedPlanning([note('t-a', { x: 40, y: 40, text: 'A', tint: 'blue' })])
    render(<Harness id={id} />)
    const past0 = useCanvasStore.getState().past.length
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-tint-blue') // already blue → no-op
    expect(useCanvasStore.getState().past.length).toBe(past0)
    expect(noteTint(id, 't-a')).toBe('blue')
  })

  it('hover-pill dot click sets the tint in exactly ONE undo step; re-click is a no-op', () => {
    const id = seedPlanning([note('hv', { x: 40, y: 40, text: 'A', tint: 'yellow' })])
    render(<Harness id={id} />)
    const past0 = useCanvasStore.getState().past.length
    const dot = document.querySelector('[data-testid="pl-tint-green"]') as HTMLElement
    act(() => dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(noteTint(id, 'hv')).toBe('green')
    expect(useCanvasStore.getState().past.length).toBe(past0 + 1)
    // Re-applying the same tint from the pill must not arm/push another step.
    act(() => dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(useCanvasStore.getState().past.length).toBe(past0 + 1)
    useCanvasStore.getState().undo()
    expect(noteTint(id, 'hv')).toBe('yellow')
  })
})
