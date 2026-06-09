import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ExportPopover } from './ExportPopover'
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
  })
})
