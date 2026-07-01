import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import { makeNote, nextNoteIndex } from './elements'
import type { PlanningBoard as PlanningBoardData, PlanningElement } from '../../../lib/boardSchema'

// jsdom lacks Pointer Capture (PlanningBoard captures on every gesture). Shim it so a
// synthetic event never throws — DOM-API-only, no production behavior changes.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.hasPointerCapture = (): boolean => false
}

// NoteCard (BUG-050 fix) observes its rendered size via ResizeObserver; jsdom has no
// ResizeObserver — stub a no-op so cards mount without throwing (same pattern as
// PlanningBoard.interaction.test.tsx / PlanningBoard.stale-closure.test.tsx).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// jsdom has no createImageBitmap; addImageFromBlob calls it (in a try/catch) to size the
// image. Resolve a tiny stub so the post-await commit runs — the catch fallback would also
// work, but a clean resolve keeps the two-await window (asset.write + this) realistic.
if (typeof globalThis.createImageBitmap !== 'function') {
  ;(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(
    async () => ({ width: 100, height: 80, close: (): void => {} })
  )
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

// Real PlanningBoard, store-subscribed so a commit re-passes a fresh board prop (mirrors
// BoardNode). ReactFlowProvider supplies the transform store (defaults to zoom 1).
function Harness({ id }: { id: string }): ReactElement | null {
  const board = useCanvasStore((s) => s.boards.find((b) => b.id === id))
  if (!board || board.type !== 'planning') return null
  return (
    <ReactFlowProvider>
      <PlanningBoard board={board as PlanningBoardData} selected hovered={false} dimmed={false} />
    </ReactFlowProvider>
  )
}

/** Seed an empty planning board; returns its id. Resets the store. */
function seedPlanning(): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  return useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
}

function els(id: string): readonly PlanningElement[] {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'planning' ? b.elements : []
}

const well = (): HTMLElement => document.querySelector('.pl-well') as HTMLElement

/** A 1x1 PNG-typed blob (type drives imageExt; bytes are arbitrary for the test). */
function pngBlob(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
}

/** A controllable promise so a test can resolve asset.write at a chosen moment. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Add a note straight through the store (a concurrent edit during the async paste window). */
function addNoteViaStore(id: string): void {
  const cur = els(id)
  useCanvasStore.getState().updateBoard(id, {
    elements: [...cur, makeNote('concurrent-note', { x: 10, y: 10 }, nextNoteIndex([...cur]))]
  } as never)
}

/** Dispatch a Ctrl+V `paste` at the document with an image file in the clipboard. The well
 *  must own focus (onWellPaste gates on it) and must contain the active element. */
function pasteImage(blob: Blob): void {
  const file = new File([blob], 'x.png', { type: blob.type })
  const dt = {
    items: [{ kind: 'file', type: blob.type, getAsFile: () => file }],
    files: [file]
  }
  const e = new Event('paste', { bubbles: true, cancelable: true })
  ;(e as unknown as { clipboardData: unknown }).clipboardData = dt
  act(() => {
    well().focus()
    document.dispatchEvent(e)
  })
}

describe('PlanningBoard image paste — live-elements commit (race) [Fix 1]', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  })

  it('keeps a concurrent edit that lands during the async write window (no lost update)', async () => {
    const id = seedPlanning()
    const d = deferred<{ assetId: string }>()
    ;(window as unknown as { api: unknown }).api = {
      // `read` is invoked by ImageCard's mount effect once the image element renders.
      asset: { write: vi.fn(() => d.promise), read: vi.fn(async () => null) }
    }
    render(<Harness id={id} />)
    expect(els(id).length).toBe(0)

    // Start the paste — addImageFromBlob captures `elements` (empty) then awaits asset.write.
    pasteImage(pngBlob())

    // While the write is pending, a concurrent edit lands a note through the store.
    act(() => addNoteViaStore(id))
    expect(els(id).length).toBe(1)

    // Resolve the write → addImageFromBlob proceeds to createImageBitmap + commit.
    await act(async () => {
      d.resolve({ assetId: 'sha-1' })
      await Promise.resolve()
      await Promise.resolve()
    })

    // BOTH must survive: the stale-closure bug would commit [...capturedEmpty, image] and
    // silently drop the concurrent note. The fix re-reads live elements at commit time.
    const kinds = els(id).map((e) => e.kind)
    expect(els(id).length).toBe(2)
    expect(kinds).toContain('note')
    expect(kinds).toContain('image')
  })
})

describe('PlanningBoard image write failure — surfaced, not swallowed [Fix 2]', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  })

  it('logs the error and adds no image when asset.write returns { error }', async () => {
    const id = seedPlanning()
    ;(window as unknown as { api: unknown }).api = {
      asset: { write: vi.fn(async () => ({ error: 'disk full' })) }
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Harness id={id} />)

    await act(async () => {
      pasteImage(pngBlob())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(els(id).length).toBe(0) // no broken image element added
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls.flat().join(' ')).toContain('disk full')
  })
})

// NOTE: the Planning export UI MOVED off the board into the Inspector (P3) — it is now the
// extracted ExportPopover. Its returned-error / cancel console.error surfacing (formerly the
// on-board "[Fix 3]" cases here) lives in ExportPopover.test.tsx, rendering ExportPopover
// directly; a bare PlanningBoard no longer owns an export trigger.
