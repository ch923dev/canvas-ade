import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ExportPopover } from './ExportPopover'
import { useToastStore } from '../../../store/toastStore'
import type { PlanningBoard as PlanningBoardData } from '../../../lib/boardSchema'

// Mock the dynamic export module: SVG path only (PNG's offscreen rasterize needs the
// canvas/Image APIs jsdom lacks). buildExport resolves a tiny artifact; the component
// then hands those bytes to window.api.export.save.
vi.mock('./exportBoard', () => ({
  buildExport: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), ext: 'svg' }))
}))

// Minimal board — the component only reads board.title (defaultName) + passes `board`
// straight to the mocked buildExport (which ignores it). Cast through unknown since we
// don't need a fully-populated PlanningBoardData for this surface.
function board(): PlanningBoardData {
  return {
    id: 'b1',
    type: 'planning',
    title: 'wb',
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    elements: []
  } as unknown as PlanningBoardData
}

beforeEach(() => {
  useToastStore.getState().clearToasts()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

/** Open the popover (click [title="Export"]) then click the portaled "Export SVG" item. */
function clickExportSvg(): void {
  const trigger = document.querySelector('[title="Export"]') as HTMLElement
  act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  const items = Array.from(document.querySelectorAll('button.board-menu-item')) as HTMLElement[]
  const svg = items.find((b) => b.textContent?.includes('SVG'))
  if (!svg) throw new Error('Export SVG menu item not found')
  act(() => svg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
}

/** runExport dynamically imports exportBoard then awaits buildExport + export.save; flush
 *  the resulting microtasks (in act) until `save` has actually been called. */
async function settleExport(saveSpy: ReturnType<typeof vi.fn>): Promise<void> {
  for (let i = 0; i < 50 && saveSpy.mock.calls.length === 0; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('ExportPopover — SVG export wires buildExport → export.save', () => {
  it('calls export.save once with the built bytes, ext, and board title as defaultName', async () => {
    const save = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { api: unknown }).api = {
      export: { save }
    }
    render(<ExportPopover board={board()} />)

    clickExportSvg()
    await settleExport(save)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({
      bytes: new Uint8Array([1, 2, 3]),
      ext: 'svg',
      defaultName: 'wb'
    })
    // Success is silent — no toast.
    expect(useToastStore.getState().toasts).toEqual([])
  })
})

describe('ExportPopover — failure feedback routes to the toast channel (D1-A)', () => {
  it('a write failure raises an error toast (fixed copy, raw OS error kept off-screen)', async () => {
    const save = vi.fn(async () => ({ ok: false, canceled: false, error: 'EACCES: /tmp/x.svg' }))
    ;(window as unknown as { api: unknown }).api = { export: { save } }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ExportPopover board={board()} />)

    clickExportSvg()
    await settleExport(save)

    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].id).toBe('export-failed-b1') // board-keyed: repeats replace in place
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].message).toBe('Export failed — check file permissions and disk space')
    // The raw OS error also lands on the console side-channel (kept off the fixed-copy toast).
    expect(errSpy).toHaveBeenCalled()
    expect(errSpy.mock.calls.flat().join(' ')).toContain('EACCES')
  })

  it('a repeat failure replaces the keyed toast instead of stacking', async () => {
    const save = vi.fn(async () => ({ ok: false, canceled: false, error: 'EACCES' }))
    ;(window as unknown as { api: unknown }).api = { export: { save } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ExportPopover board={board()} />)

    clickExportSvg()
    await settleExport(save)
    clickExportSvg()
    for (let i = 0; i < 50 && save.mock.calls.length < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    }

    expect(save).toHaveBeenCalledTimes(2)
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('an explicit user cancel stays silent (no toast, no console.error)', async () => {
    const save = vi.fn(async () => ({ ok: false, canceled: true }))
    ;(window as unknown as { api: unknown }).api = { export: { save } }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ExportPopover board={board()} />)

    clickExportSvg()
    await settleExport(save)

    expect(useToastStore.getState().toasts).toEqual([])
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('a thrown export error raises the generic error toast', async () => {
    const save = vi.fn(async () => {
      throw new Error('ipc gone')
    })
    ;(window as unknown as { api: unknown }).api = { export: { save } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ExportPopover board={board()} />)

    clickExportSvg()
    await settleExport(save)

    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('error')
    expect(toasts[0].message).toBe('Export failed')
  })
})

describe('ExportPopover — inspector variant (P3, re-homed into the Board Inspector)', () => {
  it('renders a labelled Export action that opens the same PNG/SVG menu and wires save', async () => {
    const save = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { api: unknown }).api = { export: { save } }
    render(<ExportPopover board={board()} variant="inspector" />)

    // The inspector variant renders a labelled InspectorAction (data-test), NOT the toolbar IconBtn
    // (no title="Export"). Opening it portals the same PNG/SVG menu the toolbar variant does.
    const trigger = document.querySelector('[data-test="inspector-export"]') as HTMLElement
    expect(trigger, 'the inspector Export action renders').not.toBeNull()
    expect(trigger.textContent).toContain('Export')

    act(() => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    const items = Array.from(document.querySelectorAll('button.board-menu-item')) as HTMLElement[]
    const svg = items.find((b) => b.textContent?.includes('SVG'))
    expect(svg, 'the PNG/SVG menu opens from the inspector trigger').toBeTruthy()
    act(() => svg!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await settleExport(save)

    expect(save).toHaveBeenCalledTimes(1)
  })
})
