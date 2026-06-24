/**
 * Phase 3 / E7 — image-paste vs element-clipboard precedence (spec §3.B / §6). The
 * usePlanningImageIO document `paste` listener must DEFER (skip the bitmap paste) when the
 * in-app element clipboard is non-empty and this well owns focus, so a single Ctrl+V never
 * double-pastes (an element set AND a bitmap). When the element clipboard is EMPTY the
 * existing image-paste path is untouched — pinned here too so the guard can't silently break
 * normal image paste. Same harness/mock shape as PlanningBoard.images.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import { setClipboard, clearClipboard } from './elementClipboard'
import type {
  PlanningBoard as PlanningBoardData,
  PlanningElement,
  NoteElement
} from '../../../lib/boardSchema'

// jsdom shims — Pointer Capture + ResizeObserver + createImageBitmap (see PlanningBoard.images.test.tsx).
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
if (typeof globalThis.createImageBitmap !== 'function') {
  ;(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(
    async () => ({ width: 100, height: 80, close: (): void => {} })
  )
}

afterEach(() => {
  cleanup()
  clearClipboard()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
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

function seedPlanning(): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  return useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
}
const els = (id: string): readonly PlanningElement[] => {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'planning' ? b.elements : []
}
const well = (): HTMLElement => document.querySelector('.pl-well') as HTMLElement

const noteEl = (id: string): NoteElement =>
  ({
    id,
    kind: 'note',
    x: 0,
    y: 0,
    w: 156,
    h: 96,
    tint: 'yellow',
    text: 'A',
    rotation: 0
  }) as NoteElement

/** Dispatch a Ctrl+V `paste` at the document carrying an image file (well must own focus). */
function pasteImage(): void {
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'x.png', { type: 'image/png' })
  const dt = {
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    files: [file]
  }
  const e = new Event('paste', { bubbles: true, cancelable: true })
  ;(e as unknown as { clipboardData: unknown }).clipboardData = dt
  act(() => {
    well().focus()
    document.dispatchEvent(e)
  })
}

describe('image paste vs element clipboard (E7 precedence)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    clearClipboard()
  })

  it('DEFERS the image paste while the element clipboard is non-empty (no bitmap added)', async () => {
    const id = seedPlanning()
    const write = vi.fn(async () => ({ assetId: 'sha-1' }))
    ;(window as unknown as { api: unknown }).api = {
      asset: { write, read: vi.fn(async () => null) }
    }
    // A non-empty element clipboard → E7 says it wins over an OS bitmap while the well is focused.
    setClipboard([noteEl('clip-a')])
    render(<Harness id={id} />)

    await act(async () => {
      pasteImage()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(write).not.toHaveBeenCalled() // the image pipeline never ran
    expect(els(id).length).toBe(0) // nothing added
  })

  it('still pastes an image normally when the element clipboard is EMPTY', async () => {
    const id = seedPlanning()
    const write = vi.fn(async () => ({ assetId: 'sha-1' }))
    ;(window as unknown as { api: unknown }).api = {
      asset: { write, read: vi.fn(async () => null) }
    }
    // clipboard empty (cleared in beforeEach) → the existing image-paste path is untouched.
    render(<Harness id={id} />)

    await act(async () => {
      pasteImage()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(els(id).map((e) => e.kind)).toContain('image')
  })
})
