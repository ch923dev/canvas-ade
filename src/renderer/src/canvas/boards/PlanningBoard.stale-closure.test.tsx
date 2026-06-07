// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from './PlanningBoard'
import { useCanvasStore } from '../../store/canvasStore'
import type {
  PlanningBoard as PlanningBoardData,
  ChecklistElement,
  TextElement
} from '../../lib/boardSchema'

// jsdom does not implement the Pointer Capture API; PlanningBoard's well captures the
// pointer on every gesture. Stub the three methods so a synthetic PointerEvent does not
// throw inside the handler (mirrors PlanningBoard.interaction.test.tsx).
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => false
}

// ChecklistCard observes its size via ResizeObserver (auto-grow #12); jsdom has no
// such API. Stub a no-op so the card mounts without throwing — it changes no
// production behavior (the grow path is exercised by other suites).
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
// transform store PlanningBoard reads for the screen→board zoom.
function Harness({ id }: { id: string }): ReactElement | null {
  const board = useCanvasStore((s) => s.boards.find((b) => b.id === id))
  if (!board || board.type !== 'planning') return null
  return (
    <ReactFlowProvider>
      <PlanningBoard board={board as PlanningBoardData} selected hovered={false} dimmed={false} />
    </ReactFlowProvider>
  )
}

function checklist(items: { id: string; done: boolean }[]): ChecklistElement {
  return {
    id: 'cl',
    kind: 'checklist',
    x: 40,
    y: 40,
    w: 240,
    h: 160,
    title: 'List',
    items: items.map((i) => ({ id: i.id, label: i.id, done: i.done }))
  }
}

/** Seed a planning board carrying a single checklist; returns its id. Resets the store. */
function seedChecklist(items: { id: string; done: boolean }[]): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(id, { elements: [checklist(items)] } as never)
  return id
}

/** Read the live checklist element straight from the store (the serialized truth). */
function liveItems(id: string): { id: string; done: boolean }[] {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  if (!b || b.type !== 'planning') return []
  const cl = b.elements.find((e): e is ChecklistElement => e.kind === 'checklist')
  return cl ? cl.items.map((i) => ({ id: i.id, done: i.done })) : []
}

/** The two checkbox toggle buttons (one per item), in item order. */
function boxes(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.pl-check button[title]')).filter(
    (b) => /Mark (not )?done/.test(b.title)
  )
}

describe('PlanningBoard checklist — rapid ops do not clobber (BUG-023 stale closure)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  })

  it('two checkbox toggles in ONE scheduling window both persist (no lost update)', () => {
    const id = seedChecklist([
      { id: 'a', done: false },
      { id: 'b', done: false }
    ])
    render(<Harness id={id} />)
    const [boxA, boxB] = boxes()
    expect(boxA && boxB).toBeTruthy()

    // Fire BOTH toggles inside a single act() — no React re-render flushes between
    // them, so the second callback still closes over the elements snapshot from the
    // last render. With the stale-closure bug, the second commit fully replaces
    // `elements` from that stale array, discarding the first toggle (lost update).
    act(() => {
      boxA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      boxB.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const after = liveItems(id)
    expect(after.find((i) => i.id === 'a')?.done).toBe(true) // first toggle survives
    expect(after.find((i) => i.id === 'b')?.done).toBe(true) // second toggle applied
  })

  it('rapid appendItem ops in ONE window both land (no lost append)', () => {
    const id = seedChecklist([{ id: 'a', done: false }])
    render(<Harness id={id} />)
    // The visible "Add item" button calls onAddItem(element.id) on click; press it
    // twice in one act() so the second call runs against the stale closure.
    const addBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.pl-check button')
    ).find((b) => /Add item/.test(b.textContent ?? ''))
    expect(addBtn).toBeTruthy()
    act(() => {
      addBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      addBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    // Started with 1 item; two appends must yield 3 (the buggy path would clobber to 2).
    expect(liveItems(id).length).toBe(3)
  })
})

// ── Free-text toolbar interplay (setTextText live-read + onTextPatch guard) ────────
function seedTexts(els: TextElement[]): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(id, { elements: els } as never)
  return id
}

function liveText(id: string, elId: string): TextElement | undefined {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  if (!b || b.type !== 'planning') return undefined
  return b.elements.find((e): e is TextElement => e.kind === 'text' && e.id === elId)
}

/** Select an element via its drag grip. A MouseEvent of type 'pointerdown' carries
 *  shiftKey and is caught by React's onPointerDown (jsdom lacks PointerEvent). */
function pressGrip(grip: Element, shift = false): void {
  grip.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, shiftKey: shift })
  )
}
const grips = (): Element[] => Array.from(document.querySelectorAll('.pl-text-grip'))
const toolbar = (): Element | null => document.querySelector('.pl-text-toolbar')

/** Drive a controlled <textarea> the way the user would (native setter → React's onChange). */
function typeInto(ta: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )!.set!
  setter.call(ta, value)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PlanningBoard free-text — toolbar + text-edit interplay', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  })

  it('a typography patch + a text edit in ONE window both persist (setTextText live-read)', () => {
    const id = seedTexts([{ id: 'tx', kind: 'text', x: 60, y: 80, text: 'hi' }])
    render(<Harness id={id} />)
    act(() => pressGrip(grips()[0])) // select → the toolbar mounts
    const sizeL = document.querySelector('button[aria-label="size L"]') as HTMLButtonElement
    const ta = document.querySelector('.pl-text textarea') as HTMLTextAreaElement
    expect(sizeL && ta).toBeTruthy()
    // In one scheduling window: the toolbar commits fontSize (live-read transform), then a
    // text edit commits. If setTextText spread the STALE render closure, it would replace
    // `elements` from the pre-fontSize snapshot and discard the typography change.
    act(() => {
      sizeL.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      typeInto(ta, 'hello')
    })
    const el = liveText(id, 'tx')!
    expect(el.text).toBe('hello') // the text edit landed
    expect(el.fontSize).toBe('L') // …without clobbering the typography patch
  })

  it('a typography click on an already-removed element pushes NO undo step (no phantom)', () => {
    const id = seedTexts([{ id: 'tx', kind: 'text', x: 60, y: 80, text: 'hi' }])
    render(<Harness id={id} />)
    act(() => pressGrip(grips()[0]))
    const sizeL = document.querySelector('button[aria-label="size L"]') as HTMLButtonElement
    expect(sizeL).toBeTruthy()
    const pastBefore = useCanvasStore.getState().past.length
    act(() => {
      // The element is removed, then the now-stale toolbar button is clicked in the same
      // window. onTextPatch must bail BEFORE beginChange() so no empty checkpoint is pushed.
      useCanvasStore.getState().updateBoard(id, { elements: [] } as never)
      sizeL.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(useCanvasStore.getState().past.length).toBe(pastBefore)
  })

  it('the toolbar shows for one selected text but NOT for a multi-selection', () => {
    const id = seedTexts([
      { id: 'a', kind: 'text', x: 40, y: 80, text: 'aa' },
      { id: 'b', kind: 'text', x: 220, y: 80, text: 'bb' }
    ])
    render(<Harness id={id} />)
    act(() => pressGrip(grips()[0]))
    expect(toolbar()).toBeTruthy()
    act(() => pressGrip(grips()[1], true)) // shift-add the second → size 2
    expect(toolbar()).toBeNull()
  })
})
