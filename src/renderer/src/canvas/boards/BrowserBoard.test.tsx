// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import { BrowserBoard } from './BrowserBoard'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore } from '../../store/previewStore'
import { useToastStore } from '../../store/toastStore'
import type { BrowserBoard as BrowserBoardData } from '../../lib/boardSchema'

// jsdom has no ResizeObserver (BoardFrame/board chrome may observe size).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// Render the REAL BrowserBoard, subscribed to the store so an external updateBoard
// re-passes a fresh `board` prop (mirrors BoardNode in production).
function Harness({ id }: { id: string }): ReactElement | null {
  const board = useCanvasStore((s) => s.boards.find((b) => b.id === id))
  if (!board || board.type !== 'browser') return null
  return <BrowserBoard board={board as BrowserBoardData} selected hovered={false} dimmed={false} />
}

function seedBrowser(): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  usePreviewStore.setState({ byId: {}, nodeGesture: false, openMenus: new Set(), menuOpen: false })
  return useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 })
}

function boardUrl(id: string): string {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'browser' ? b.url : ''
}

let screenshotPreview: ReturnType<typeof vi.fn>

beforeEach(() => {
  useToastStore.getState().clearToasts()
  screenshotPreview = vi.fn(async () => ({ ok: true, assetId: null, clipboardOk: true }))
  ;(window as unknown as { api: unknown }).api = {
    screenshotPreview,
    openExternalPreview: vi.fn(async () => true),
    goBackPreview: vi.fn(async () => true),
    goForwardPreview: vi.fn(async () => true),
    reloadPreview: vi.fn(async () => true)
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

function urlInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.bb-url-input')
  if (!el) throw new Error('url input not found')
  return el
}

describe('BrowserBoard — URL draft vs external writers (BUG-059)', () => {
  it('does not clobber an in-progress draft when board.url changes while the input is focused', () => {
    const id = seedBrowser()
    render(<Harness id={id} />)
    const input = urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'http://loca' } })
    // External writer (auto-connect detect push / MCP / undo) lands mid-edit.
    act(() => {
      useCanvasStore.getState().updateBoard(id, { url: 'http://localhost:4321' })
    })
    // The bug: the render-time re-sync reset the draft under the caret.
    expect(urlInput().value).toBe('http://loca')
    // The user's edited blur still commits THEIR value (user intent wins).
    fireEvent.blur(urlInput())
    expect(boardUrl(id)).toBe('http://loca')
  })

  it('re-syncs the draft from an external board.url change when the input is NOT focused', () => {
    const id = seedBrowser()
    render(<Harness id={id} />)
    act(() => {
      useCanvasStore.getState().updateBoard(id, { url: 'http://localhost:9999' })
    })
    expect(urlInput().value).toBe('http://localhost:9999')
  })

  it('does not revert an external url change on a focus-without-edit blur', () => {
    const id = seedBrowser()
    render(<Harness id={id} />)
    const input = urlInput()
    fireEvent.focus(input) // focused, but the user types nothing
    act(() => {
      useCanvasStore.getState().updateBoard(id, { url: 'http://localhost:7777' })
    })
    fireEvent.blur(urlInput())
    // A non-dirty blur must not write the stale draft back over the external change.
    expect(boardUrl(id)).toBe('http://localhost:7777')
    expect(urlInput().value).toBe('http://localhost:7777')
  })

  it('Escape discards the draft instead of committing the typed text', () => {
    const id = seedBrowser()
    const original = boardUrl(id)
    render(<Harness id={id} />)
    const input = urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'http://typo' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(urlInput())
    expect(boardUrl(id)).toBe(original)
    expect(urlInput().value).toBe(original)
  })
})

describe('BrowserBoard — screenshot toast honesty (BUG-028, toast channel since D1-A)', () => {
  // The board no longer renders its own note — feedback goes to the app toast store.
  async function shoot(id: string): Promise<{ message: string; kind: string }> {
    // The camera button is enabled only while the native view is live.
    act(() => {
      usePreviewStore.getState().patch(id, { live: true })
    })
    const btn = document.querySelector<HTMLButtonElement>('button[title="Screenshot"]')
    if (!btn) throw new Error('screenshot button not found')
    await act(async () => {
      fireEvent.click(btn)
      await Promise.resolve()
    })
    const t = useToastStore.getState().toasts.at(-1)
    return { message: t?.message ?? '', kind: t?.kind ?? '' }
  }

  it('reports failure when the clipboard write failed and nothing was saved', async () => {
    const id = seedBrowser()
    screenshotPreview.mockResolvedValue({ ok: true, assetId: null, clipboardOk: false })
    render(<Harness id={id} />)
    const t = await shoot(id)
    expect(t.message).toContain('Screenshot failed')
    expect(t.message).not.toContain('copied to clipboard')
    expect(t.kind).toBe('error')
  })

  it('reports partial success when saved to assets but the clipboard failed', async () => {
    const id = seedBrowser()
    screenshotPreview.mockResolvedValue({
      ok: true,
      assetId: 'assets/abc.png',
      clipboardOk: false
    })
    render(<Harness id={id} />)
    const t = await shoot(id)
    expect(t.message).toContain('saved to assets/')
    expect(t.message).not.toContain('copied')
    expect(t.kind).toBe('ok')
  })

  it('still reports the clipboard success toast when the copy landed', async () => {
    const id = seedBrowser()
    screenshotPreview.mockResolvedValue({ ok: true, assetId: null, clipboardOk: true })
    render(<Harness id={id} />)
    const t = await shoot(id)
    expect(t.message).toContain('Screenshot copied to clipboard')
    expect(t.kind).toBe('ok')
  })

  it('routes the open-external failure to a board-keyed error toast (repeats collapse)', async () => {
    const id = seedBrowser()
    ;(window.api as unknown as { openExternalPreview: unknown }).openExternalPreview = vi.fn(
      async () => false
    )
    render(<Harness id={id} />)
    const btn = document.querySelector<HTMLButtonElement>('button[title="Open in browser"]')
    if (!btn) throw new Error('open-external button not found')
    // Rapid double-click on a broken URL must REPLACE the keyed toast, not stack two.
    await act(async () => {
      fireEvent.click(btn)
      fireEvent.click(btn)
      await Promise.resolve()
    })
    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].id).toBe(`browser-external-${id}`)
    expect(toasts[0].message).toBe('Cannot open that URL in a browser')
    expect(toasts[0].kind).toBe('error')
  })
})
