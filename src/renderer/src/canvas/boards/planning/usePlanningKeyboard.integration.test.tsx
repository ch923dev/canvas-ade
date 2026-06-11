/**
 * D3-C planning keyboard (audit A4 partial): arrow-key nudge, Ctrl+G/Ctrl+Shift+G
 * group/ungroup, Shift+F10/ContextMenu menu-open — exercised through the REAL
 * PlanningBoard (same harness as PlanningBoard.interaction.test.tsx: real store,
 * synthetic DOM events on the well). The undo-coalescing and checkpoint-discipline
 * assertions read the store's `past` rail directly.
 *
 * What jsdom CANNOT see here — real-OS key delivery, focus routing, the canvas
 * window-handler interplay — is pinned by e2e/planningKeyboard.e2e.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import type { PlanningBoard as PlanningBoardData, NoteElement } from '../../../lib/boardSchema'

// jsdom shims (same rationale as PlanningBoard.interaction.test.tsx): no Pointer
// Capture API, no ResizeObserver.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => false
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
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

function seedPlanning(elements: NoteElement[]): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(id, { elements } as never)
  // The seed itself must not count as an undoable user edit in these tests — the
  // checkpoint-discipline assertions read `past.length` deltas from a clean rail.
  useCanvasStore.setState({ past: [], future: [] })
  return id
}

function els(id: string): readonly (NoteElement & { groupId?: string })[] {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'planning' ? (b.elements as never) : []
}
function elById(id: string, nid: string): (NoteElement & { groupId?: string }) | undefined {
  return els(id).find((e) => e.id === nid)
}
function pastLen(): number {
  return useCanvasStore.getState().past.length
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
    text: 'A',
    rotation: 0,
    ...over
  } as NoteElement
}

const well = (): HTMLElement => document.querySelector('.pl-well') as HTMLElement
const grip = (i: number): HTMLElement =>
  document.querySelectorAll('.pl-note-grip')[i] as HTMLElement

interface KeyMods {
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
}
function key(type: 'keydown' | 'keyup', k: string, mods?: KeyMods): void {
  act(() => {
    well().focus()
    well().dispatchEvent(
      new KeyboardEvent(type, {
        key: k,
        bubbles: true,
        cancelable: true,
        shiftKey: !!mods?.shift,
        ctrlKey: !!mods?.ctrl,
        metaKey: !!mods?.meta
      })
    )
  })
}
const down = (k: string, mods?: KeyMods): void => key('keydown', k, mods)
const up = (k: string, mods?: KeyMods): void => key('keyup', k, mods)

function pev(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  mods?: { shift?: boolean }
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
      shiftKey: !!mods?.shift
    })
  )
}

/** Select the i-th note via a zero-movement grip click (no drag, no commit). */
function selectNote(i: number, at: { x: number; y: number }, mods?: { shift?: boolean }): void {
  act(() => {
    pev(grip(i), 'pointerdown', at.x, at.y, mods)
    pev(well(), 'pointerup', at.x, at.y, mods)
  })
}

const seedTwo = (): string =>
  seedPlanning([
    note('ka', { x: 40, y: 40, text: 'A' }),
    note('kb', { x: 260, y: 40, text: 'B', tint: 'blue' })
  ])

beforeEach(() => {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
})

describe('planning keyboard — arrow-key nudge (A4)', () => {
  it('ArrowRight moves the selected note 1px; Shift+ArrowDown moves 10px', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    down('ArrowRight')
    expect(elById(id, 'ka')!.x).toBe(41)
    expect(elById(id, 'ka')!.y).toBe(40)
    up('ArrowRight')
    down('ArrowDown', { shift: true })
    expect(elById(id, 'ka')!.y).toBe(50)
    // the unselected sibling never moved
    expect(elById(id, 'kb')!.x).toBe(260)
  })

  it('a contiguous keydown burst coalesces into ONE undo step; keyup splits bursts', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    const p0 = pastLen()
    down('ArrowRight')
    down('ArrowRight')
    down('ArrowRight') // key-repeat: no keyup between
    expect(elById(id, 'ka')!.x).toBe(43)
    expect(pastLen()).toBe(p0 + 1) // one checkpoint for the whole burst
    up('ArrowRight')
    down('ArrowRight') // a NEW burst
    expect(elById(id, 'ka')!.x).toBe(44)
    expect(pastLen()).toBe(p0 + 2)
    act(() => useCanvasStore.getState().undo())
    expect(elById(id, 'ka')!.x).toBe(43) // second burst undone
    act(() => useCanvasStore.getState().undo())
    expect(elById(id, 'ka')!.x).toBe(40) // first burst undone in ONE step
  })

  it('nudging a grouped member moves the whole group; a locked member stays put', () => {
    const id = seedPlanning([
      note('ga', { x: 40, y: 40, text: 'A' }),
      note('gb', { x: 260, y: 40, text: 'B' })
    ])
    useCanvasStore.getState().updateBoard(id, {
      elements: [
        { ...elById(id, 'ga')!, groupId: 'g1' },
        { ...elById(id, 'gb')!, groupId: 'g1', locked: true }
      ]
    } as never)
    useCanvasStore.setState({ past: [], future: [] })
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    down('ArrowRight')
    expect(elById(id, 'ga')!.x).toBe(41) // group expanded → selected member moved
    expect(elById(id, 'gb')!.x).toBe(260) // lock wins over group
  })

  it('an all-locked selection neither moves nor records a checkpoint', () => {
    const id = seedPlanning([note('lk', { x: 40, y: 40, text: 'L' })])
    useCanvasStore.getState().updateBoard(id, {
      elements: [{ ...elById(id, 'lk')!, locked: true }]
    } as never)
    useCanvasStore.setState({ past: [], future: [] })
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    const p0 = pastLen()
    down('ArrowRight')
    expect(elById(id, 'lk')!.x).toBe(40)
    expect(pastLen()).toBe(p0)
  })

  it('arrows while typing in a child input move the caret, never the element (#119 review)', () => {
    // The NoteCard/ChecklistCard stopPropagation guards are the load-bearing mechanism
    // for "arrows move the caret while editing" — pin them against the nudge handler.
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 }) // selection non-empty: the nudge WOULD fire if keys leaked
    const ta = document.querySelector('.pl-note textarea') as HTMLTextAreaElement
    expect(ta).not.toBeNull()
    const p0 = pastLen()
    act(() => {
      ta.focus()
      const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      ta.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false) // caret movement stays native
    })
    expect(elById(id, 'ka')!.x).toBe(40)
    expect(pastLen()).toBe(p0)
  })

  it('arrows on a focused checklist checkbox do not nudge the card (#119 review)', () => {
    const id = seedPlanning([])
    useCanvasStore.getState().updateBoard(id, {
      elements: [
        {
          id: 'cl',
          kind: 'checklist',
          x: 40,
          y: 40,
          w: 240,
          h: 0,
          title: 'T',
          items: [{ id: 'i1', label: 'one', done: false }]
        }
      ]
    } as never)
    useCanvasStore.setState({ past: [], future: [] })
    render(<Harness id={id} />)
    // Select the card via its body press, then move focus to the checkbox (AT-style).
    act(() => {
      pev(document.querySelector('.pl-check') as HTMLElement, 'pointerdown', 60, 60)
      pev(well(), 'pointerup', 60, 60)
    })
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement
    expect(box).not.toBeNull()
    act(() => {
      box.focus()
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      )
    })
    const cl = els(id).find((e) => e.id === 'cl') as unknown as { x: number }
    expect(cl.x).toBe(40)
  })

  it('arrows without a selection fall through (no move, no checkpoint, no preventDefault)', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    const p0 = pastLen()
    act(() => {
      well().focus()
      const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      well().dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    })
    expect(elById(id, 'ka')!.x).toBe(40)
    expect(pastLen()).toBe(p0)
  })
})

describe('planning keyboard — Ctrl+G / Ctrl+Shift+G (D3-C)', () => {
  it('Ctrl+G groups the two selected notes as one undo step; Ctrl+Shift+G ungroups', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    selectNote(1, { x: 280, y: 60 }, { shift: true })
    const p0 = pastLen()
    down('g', { ctrl: true })
    const a = elById(id, 'ka')!
    const b = elById(id, 'kb')!
    expect(a.groupId && a.groupId === b.groupId).toBeTruthy()
    expect(pastLen()).toBe(p0 + 1)
    down('g', { ctrl: true, shift: true })
    expect(elById(id, 'ka')!.groupId).toBeUndefined()
    expect(elById(id, 'kb')!.groupId).toBeUndefined()
    expect(pastLen()).toBe(p0 + 2)
    act(() => useCanvasStore.getState().undo())
    expect(elById(id, 'ka')!.groupId).toBeDefined() // back to grouped
  })

  it('Ctrl+G expands a partial group selection first — no stranded sibling (#119 review)', () => {
    // G1 = {ka, kc}; user selects only ka + the ungrouped kb. Grouping must produce
    // ONE group {ka, kb, kc} (right-click parity), not a new {ka, kb} stranding kc.
    const id = seedPlanning([
      note('ka', { x: 40, y: 40, text: 'A' }),
      note('kb', { x: 260, y: 40, text: 'B' }),
      note('kc', { x: 40, y: 160, text: 'C' })
    ])
    useCanvasStore.getState().updateBoard(id, {
      elements: [
        { ...elById(id, 'ka')!, groupId: 'g1' },
        elById(id, 'kb')!,
        { ...elById(id, 'kc')!, groupId: 'g1' }
      ]
    } as never)
    useCanvasStore.setState({ past: [], future: [] })
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    selectNote(1, { x: 280, y: 60 }, { shift: true })
    down('g', { ctrl: true })
    const a = elById(id, 'ka')!
    const b = elById(id, 'kb')!
    const c = elById(id, 'kc')!
    expect(a.groupId).toBeDefined()
    expect(a.groupId).not.toBe('g1') // a fresh group id
    expect(b.groupId).toBe(a.groupId)
    expect(c.groupId).toBe(a.groupId) // the sibling rode along, not stranded
    // The selection ring must expand with it (openMenuAtSelection parity): kc's
    // card shows the accent outline, not just a silent store-side membership.
    const cCard = screen.getByDisplayValue('C').closest<HTMLElement>('.pl-note')
    expect(cCard?.style.outline).toContain('var(--accent)')
  })

  it('meta (⌘) works like ctrl for the chord', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    selectNote(1, { x: 280, y: 60 }, { shift: true })
    down('g', { meta: true })
    const a = elById(id, 'ka')!
    expect(a.groupId && a.groupId === elById(id, 'kb')!.groupId).toBeTruthy()
  })

  it('Ctrl+G with fewer than 2 selected is a no-op with NO phantom checkpoint', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    const p0 = pastLen()
    down('g', { ctrl: true })
    expect(elById(id, 'ka')!.groupId).toBeUndefined()
    expect(pastLen()).toBe(p0)
  })

  it('Ctrl+Shift+G on an ungrouped selection is a no-op with NO phantom checkpoint', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    selectNote(1, { x: 280, y: 60 }, { shift: true })
    const p0 = pastLen()
    down('g', { ctrl: true, shift: true })
    expect(pastLen()).toBe(p0)
  })

  it('the chord never escapes the well — a window keydown listener does not see Ctrl+G', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 }) // single selection: the chord NO-OPS but is still swallowed
    const seen: string[] = []
    const spy = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'g') seen.push(e.key)
    }
    window.addEventListener('keydown', spy)
    try {
      down('g', { ctrl: true })
      down('g', { ctrl: true, shift: true })
    } finally {
      window.removeEventListener('keydown', spy)
    }
    // The canvas-level Ctrl+G (BOARD groups) lives on window — it must never fire
    // while the whiteboard well is focused, even when the planning chord no-ops.
    expect(seen).toEqual([])
  })
})

describe('planning keyboard — Shift+F10 / ContextMenu key (A4)', () => {
  it('Shift+F10 opens the element context menu for the selection', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    down('F10', { shift: true })
    expect(document.querySelector('[data-testid="w3-menu-group"]')).not.toBeNull()
  })

  it('the ContextMenu key opens it too, and a menu action applies to the selection', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    selectNote(0, { x: 60, y: 60 })
    selectNote(1, { x: 280, y: 60 }, { shift: true })
    down('ContextMenu')
    const groupItem = document.querySelector('[data-testid="w3-menu-group"]') as HTMLElement
    expect(groupItem).not.toBeNull()
    act(() => groupItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    const a = elById(id, 'ka')!
    expect(a.groupId && a.groupId === elById(id, 'kb')!.groupId).toBeTruthy()
  })

  it('keyboard menu-open expands a partial group selection to the whole group (right-click parity)', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    useCanvasStore.getState().updateBoard(id, {
      elements: [
        { ...elById(id, 'ka')!, groupId: 'g1' },
        { ...elById(id, 'kb')!, groupId: 'g1' }
      ]
    } as never)
    useCanvasStore.setState({ past: [], future: [] })
    selectNote(0, { x: 60, y: 60 })
    down('F10', { shift: true })
    // Align-left through the menu must move BOTH group members (effective selection
    // was expanded), exactly like the pointer path.
    const alignLeft = document.querySelector('[data-testid="w3-menu-align-left"]') as HTMLElement
    expect(alignLeft).not.toBeNull()
    act(() => alignLeft.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(elById(id, 'ka')!.x).toBe(elById(id, 'kb')!.x)
  })

  it('Shift+F10 with no selection opens nothing but is still consumed (#119 review)', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    act(() => {
      well().focus()
      const e = new KeyboardEvent('keydown', {
        key: 'F10',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
      well().dispatchEvent(e)
      // Consumed even as a no-op: Chromium's synthesized contextmenu event must never
      // reach onWellContextMenu's hit-test at bogus coordinates.
      expect(e.defaultPrevented).toBe(true)
    })
    expect(document.querySelector('[data-testid="w3-menu-group"]')).toBeNull()
  })
})
