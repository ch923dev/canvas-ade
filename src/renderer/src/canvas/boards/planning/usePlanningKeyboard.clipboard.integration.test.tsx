/**
 * Phase 3 — in-app element clipboard (Ctrl+C / Ctrl+X / Ctrl+V), exercised through TWO real
 * PlanningBoards (same harness shape as usePlanningKeyboard.integration.test.tsx, extended to
 * a pair so cross-board copy/move/paste is real). Real store, synthetic DOM key + pointer
 * events on each board's well; the undo/checkpoint-discipline assertions read the store's
 * `past` rail directly.
 *
 * The clipboard is a module singleton, so each test resets it (clearClipboard) to stop state
 * leaking. What jsdom CANNOT see — real-OS key delivery + focus routing through the
 * camera-transformed canvas — is pinned by e2e/planningClipboard.e2e.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import { clearClipboard, getClipboard, hasClipboard } from './elementClipboard'
import type { PlanningBoard as PlanningBoardData, NoteElement } from '../../../lib/boardSchema'

// jsdom shims (same rationale as the sibling integration test): no Pointer Capture, no
// ResizeObserver.
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

afterEach(() => {
  cleanup()
  clearClipboard()
})

/** Renders every planning board in the store (in store order) under one RF provider. */
function TwoBoardHarness(): ReactElement {
  const boards = useCanvasStore((s) => s.boards)
  return (
    <ReactFlowProvider>
      {boards
        .filter((b): b is PlanningBoardData => b.type === 'planning')
        .map((b) => (
          <PlanningBoard key={b.id} board={b} selected hovered={false} dimmed={false} />
        ))}
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
    text: 'A',
    rotation: 0,
    ...over
  } as NoteElement
}

/** Seed board A with the given notes + an empty board B. Returns both ids; clears the rail. */
function seedPair(aElements: NoteElement[]): { a: string; b: string } {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  const a = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(a, { elements: aElements } as never)
  const b = useCanvasStore.getState().addBoard('planning', { x: 800, y: 0 })
  // The seed must not count as undoable user edits — the discipline assertions read deltas.
  useCanvasStore.setState({ past: [], future: [] })
  return { a, b }
}

function planning(id: string): PlanningBoardData | null {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'planning' ? b : null
}
const countOf = (id: string): number => planning(id)?.elements.length ?? -1
const idsOf = (id: string): string[] => (planning(id)?.elements ?? []).map((e) => e.id)
const pastLen = (): number => useCanvasStore.getState().past.length
const undo = (): void => act(() => useCanvasStore.getState().undo())

const wellAt = (i: number): HTMLElement => document.querySelectorAll('.pl-well')[i] as HTMLElement

function pev(target: EventTarget, type: string, mods?: { shift?: boolean }): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      clientX: 0,
      clientY: 0,
      shiftKey: !!mods?.shift
    })
  )
}

/** Select the i-th note of `well` via a zero-movement grip press (no drag → no commit). */
function selectNoteIn(well: HTMLElement, i: number, mods?: { shift?: boolean }): void {
  const grip = well.querySelectorAll('.pl-note-grip')[i] as HTMLElement
  act(() => {
    pev(grip, 'pointerdown', mods)
    pev(well, 'pointerup', mods)
  })
}

interface KeyMods {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}
/** Dispatch a real keydown on (a focused) `well`. */
function keyOn(well: HTMLElement, k: string, mods?: KeyMods): void {
  act(() => {
    well.focus()
    well.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ctrlKey: !!mods?.ctrl,
        metaKey: !!mods?.meta,
        shiftKey: !!mods?.shift
      })
    )
  })
}

beforeEach(() => {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  clearClipboard()
})

describe('planning clipboard — copy (Ctrl+C)', () => {
  it('copies the selection onto the clipboard, leaving the source + undo rail untouched', () => {
    const { a } = seedPair([note('na', { text: 'A' }), note('nb', { x: 260, text: 'B' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    selectNoteIn(wellA, 0)
    selectNoteIn(wellA, 1, { shift: true })
    const p0 = pastLen()

    keyOn(wellA, 'c', { ctrl: true })

    expect(hasClipboard()).toBe(true)
    expect(getClipboard()).toHaveLength(2) // group-expanded selection captured
    expect(countOf(a)).toBe(2) // source untouched
    expect(pastLen()).toBe(p0) // no checkpoint for a copy
  })

  it('Ctrl+C with an empty selection is a no-op (no clipboard, no checkpoint)', () => {
    seedPair([note('na', { text: 'A' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    const p0 = pastLen()

    keyOn(wellA, 'c', { ctrl: true }) // nothing selected

    expect(hasClipboard()).toBe(false)
    expect(pastLen()).toBe(p0)
  })
})

describe('planning clipboard — paste (Ctrl+V)', () => {
  it('pastes fresh-id copies into the FOCUSED (other) board, source intact, ONE undo step', () => {
    const { a, b } = seedPair([note('na', { text: 'A' }), note('nb', { x: 260, text: 'B' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    const wellB = wellAt(1)
    selectNoteIn(wellA, 0)
    selectNoteIn(wellA, 1, { shift: true })
    keyOn(wellA, 'c', { ctrl: true })
    const p0 = pastLen()

    keyOn(wellB, 'v', { ctrl: true })

    expect(countOf(b)).toBe(2) // B gained the two copies
    expect(countOf(a)).toBe(2) // A untouched (copy, not move)
    expect(pastLen()).toBe(p0 + 1) // exactly one checkpoint for the paste
    // Fresh ids — none of B's ids collide with A's.
    const aIds = idsOf(a)
    expect(idsOf(b).every((id) => !aIds.includes(id))).toBe(true)
    // Reselected in the target: a pasted card shows the accent selection outline.
    const pasted = wellB.querySelector('.pl-note') as HTMLElement
    expect(pasted?.style.outline).toContain('var(--accent)')

    undo() // one Ctrl+Z removes the whole paste
    expect(countOf(b)).toBe(0)
    expect(countOf(a)).toBe(2)
  })

  it('paste twice yields two distinct sets; one undo per paste', () => {
    const { b } = seedPair([note('na', { text: 'A' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    const wellB = wellAt(1)
    selectNoteIn(wellA, 0)
    keyOn(wellA, 'c', { ctrl: true })

    keyOn(wellB, 'v', { ctrl: true })
    keyOn(wellB, 'v', { ctrl: true })

    expect(countOf(b)).toBe(2)
    expect(new Set(idsOf(b)).size).toBe(2) // all distinct ids (paste re-clones per insert)

    undo()
    expect(countOf(b)).toBe(1)
    undo()
    expect(countOf(b)).toBe(0)
  })

  it('within-board paste duplicates into the SOURCE board (Ctrl+C then Ctrl+V in A)', () => {
    const { a } = seedPair([note('na', { text: 'A' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    selectNoteIn(wellA, 0)
    keyOn(wellA, 'c', { ctrl: true })

    keyOn(wellA, 'v', { ctrl: true })

    expect(countOf(a)).toBe(2) // original + the within-board duplicate
  })

  it('Ctrl+V with an empty clipboard is a no-op (nothing pasted, no checkpoint)', () => {
    const { b } = seedPair([note('na', { text: 'A' })])
    render(<TwoBoardHarness />)
    const wellB = wellAt(1)
    const p0 = pastLen()

    keyOn(wellB, 'v', { ctrl: true }) // clipboard empty

    expect(countOf(b)).toBe(0)
    expect(pastLen()).toBe(p0)
  })
})

describe('planning clipboard — cut (Ctrl+X)', () => {
  it('cut removes the selection (ONE undo step) and arms the clipboard for paste', () => {
    const { a, b } = seedPair([note('na', { text: 'A' }), note('nb', { x: 260, text: 'B' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    const wellB = wellAt(1)
    selectNoteIn(wellA, 0)
    selectNoteIn(wellA, 1, { shift: true })
    const p0 = pastLen()

    keyOn(wellA, 'x', { ctrl: true })

    expect(countOf(a)).toBe(0) // both removed from the source
    expect(hasClipboard()).toBe(true)
    expect(pastLen()).toBe(p0 + 1) // the cut is one undo step

    keyOn(wellB, 'v', { ctrl: true })
    expect(countOf(b)).toBe(2) // pasted into B
    expect(pastLen()).toBe(p0 + 2) // cut + paste = TWO separate undo steps

    // One Ctrl+Z per step: undo the paste, then the cut.
    undo()
    expect(countOf(b)).toBe(0)
    undo()
    expect(countOf(a)).toBe(2) // cut restored both notes
  })

  it('lock-precedence: a locked member stays in source and is NOT on the clipboard', () => {
    const { a, b } = seedPair([
      note('na', { text: 'A' }),
      note('nb', { x: 260, text: 'B', locked: true })
    ])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    const wellB = wellAt(1)
    selectNoteIn(wellA, 0)
    selectNoteIn(wellA, 1, { shift: true }) // selects the locked note too

    keyOn(wellA, 'x', { ctrl: true })

    expect(idsOf(a)).toEqual(['nb']) // the locked note stayed; the unlocked one was cut
    expect(getClipboard()).toHaveLength(1) // only the unlocked note rode onto the clipboard

    keyOn(wellB, 'v', { ctrl: true })
    expect(countOf(b)).toBe(1) // only the unlocked one pasted
  })

  it('Ctrl+X with an all-locked selection is a no-op (no checkpoint, no clipboard)', () => {
    const { a } = seedPair([note('na', { text: 'A', locked: true })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    selectNoteIn(wellA, 0)
    const p0 = pastLen()

    keyOn(wellA, 'x', { ctrl: true })

    expect(countOf(a)).toBe(1) // nothing removed
    expect(hasClipboard()).toBe(false) // nothing armed
    expect(pastLen()).toBe(p0) // no phantom checkpoint
  })

  it('Ctrl+X with an empty selection is a no-op (no checkpoint, no clipboard)', () => {
    const { a } = seedPair([note('na', { text: 'A' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    const p0 = pastLen()

    keyOn(wellA, 'x', { ctrl: true })

    expect(countOf(a)).toBe(1)
    expect(hasClipboard()).toBe(false)
    expect(pastLen()).toBe(p0)
  })
})

describe('planning clipboard — ⌘ parity + paste-into-self', () => {
  it('Meta (⌘) drives copy/paste like Ctrl', () => {
    const { a, b } = seedPair([note('na', { text: 'A' })])
    render(<TwoBoardHarness />)
    const wellA = wellAt(0)
    const wellB = wellAt(1)
    selectNoteIn(wellA, 0)

    keyOn(wellA, 'c', { meta: true })
    expect(hasClipboard()).toBe(true)

    keyOn(wellB, 'v', { meta: true })
    expect(countOf(b)).toBe(1)
    expect(countOf(a)).toBe(1)
  })
})
