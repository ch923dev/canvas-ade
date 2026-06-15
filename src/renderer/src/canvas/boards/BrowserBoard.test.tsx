// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import { BrowserBoard } from './BrowserBoard'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore } from '../../store/previewStore'
import { useOsrLivenessStore } from '../../store/osrLivenessStore'
import { useToastStore } from '../../store/toastStore'
import type { BrowserBoard as BrowserBoardData } from '../../lib/boardSchema'

// OS-3 Phase 5: OSR is the default engine, so BrowserBoard now mounts the offscreen-preview hooks.
// These tests assert the board CHROME (URL draft, crashed CTA, status word, screenshot toasts) —
// all engine-agnostic — so stub the OSR engine hooks to no-ops; otherwise they'd call unmocked
// window.api OSR methods on mount. The liveness/widget STORES are left real (they default sensibly:
// osrAlive ?? true, no dialog/popup), which is what the chrome reads.
vi.mock('./useOffscreenPreview', () => ({ useOffscreenPreview: () => {} }))
vi.mock('./useOffscreenInput', () => ({ useOffscreenInput: () => {} }))
vi.mock('./useOffscreenSizing', () => ({ useOffscreenSizing: () => {} }))
vi.mock('./osr/useOsrWidgetEvents', () => ({ useOsrWidgetEvents: () => {} }))
vi.mock('./osr/OsrWidgetLayer', () => ({ OsrWidgetLayer: () => null }))

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
  usePreviewStore.setState({ byId: {} })
  useOsrLivenessStore.setState({ alive: {} })
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
    // The nav buttons + crashed Reload CTA route to the offscreen-preview IPC.
    reloadOsrPreview: vi.fn(async () => true),
    goBackOsrPreview: vi.fn(async () => true),
    goForwardOsrPreview: vi.fn(async () => true)
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

describe('BrowserBoard — crashed preview state (D2-C)', () => {
  it('shows "Preview crashed" with the reason and a Reload CTA wired to reloadOsrPreview', () => {
    const id = seedBrowser()
    act(() => {
      usePreviewStore.getState().patch(id, { status: 'crashed', error: 'oom' })
    })
    render(<Harness id={id} />)
    expect(document.body.textContent).toContain('Preview crashed')
    expect(document.body.textContent).toContain('oom')
    const cta = document.querySelector<HTMLButtonElement>('.bb-reload-btn')
    if (!cta) throw new Error('Reload CTA not found')
    fireEvent.click(cta)
    // OSR is the default engine — the crashed Reload CTA routes to reloadOsrPreview.
    expect(
      (window.api as unknown as { reloadOsrPreview: ReturnType<typeof vi.fn> }).reloadOsrPreview
    ).toHaveBeenCalledWith(id)
  })

  it('names the crashed state beside the connection dot', () => {
    const id = seedBrowser()
    act(() => {
      usePreviewStore.getState().patch(id, { status: 'crashed' })
    })
    render(<Harness id={id} />)
    expect(document.querySelector('.bb-conn-word')?.textContent).toBe('crashed')
  })
})

describe('BrowserBoard — status word beside the dot (D2-C, audit §3.4)', () => {
  it('shows the colourblind-safe status word for the current preview state', () => {
    const id = seedBrowser()
    act(() => {
      usePreviewStore.getState().patch(id, { status: 'connected' })
    })
    render(<Harness id={id} />)
    expect(document.querySelector('.bb-conn-word')?.textContent).toBe('connected')
  })

  it('overrides the word with "paused" for an evicted (renderer-freed) board', () => {
    const id = seedBrowser()
    act(() => {
      usePreviewStore.getState().patch(id, { status: 'connected' })
      // Evicted over the MAX_LIVE cap → the liveness store marks it not-alive → "paused".
      useOsrLivenessStore.getState().setAlive({ [id]: false })
    })
    render(<Harness id={id} />)
    expect(document.querySelector('.bb-conn-word')?.textContent).toBe('paused')
  })
})

describe('BrowserBoard — evicted "paused" badge (D2-C)', () => {
  it('shows the badge when the renderer was freed and hides it while live', () => {
    const id = seedBrowser()
    act(() => {
      usePreviewStore.getState().patch(id, { status: 'connected' })
      useOsrLivenessStore.getState().setAlive({ [id]: false })
    })
    render(<Harness id={id} />)
    expect(document.querySelector('.bb-paused-badge')?.textContent).toBe('paused')
    act(() => {
      useOsrLivenessStore.getState().setAlive({ [id]: true })
    })
    expect(document.querySelector('.bb-paused-badge')).toBeNull()
  })
})

describe('BrowserBoard — URL sanity check (D2-C inline error)', () => {
  it('rejects a non-http(s) commit: inline error, red field, NO board write', () => {
    const id = seedBrowser()
    const original = boardUrl(id)
    render(<Harness id={id} />)
    const input = urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'not a url' } })
    fireEvent.blur(input)
    expect(boardUrl(id)).toBe(original)
    expect(document.querySelector('.bb-url-field')?.classList.contains('bb-url-invalid')).toBe(true)
    expect(document.querySelector('.bb-url-error')?.textContent).toBeTruthy()
    // The rejected draft stays visible so the user can fix it in place.
    expect(urlInput().value).toBe('not a url')
  })

  it('clears the error and commits once the URL is corrected', () => {
    const id = seedBrowser()
    render(<Harness id={id} />)
    const input = urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.blur(input)
    expect(document.querySelector('.bb-url-error')).not.toBeNull()
    fireEvent.focus(urlInput())
    fireEvent.change(urlInput(), { target: { value: 'http://localhost:5173' } })
    fireEvent.blur(urlInput())
    expect(boardUrl(id)).toBe('http://localhost:5173')
    expect(document.querySelector('.bb-url-error')).toBeNull()
    expect(document.querySelector('.bb-url-field')?.classList.contains('bb-url-invalid')).toBe(
      false
    )
  })

  it('Escape discards an errored draft and clears the error', () => {
    const id = seedBrowser()
    const original = boardUrl(id)
    render(<Harness id={id} />)
    const input = urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'garbage' } })
    fireEvent.blur(input)
    expect(document.querySelector('.bb-url-error')).not.toBeNull()
    fireEvent.focus(urlInput())
    fireEvent.keyDown(urlInput(), { key: 'Escape' })
    fireEvent.blur(urlInput())
    expect(document.querySelector('.bb-url-error')).toBeNull()
    expect(urlInput().value).toBe(original)
  })
})

describe('BrowserBoard — auto-push URL accent flash (D2-C)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flashes the URL field when an external writer pushes a new url, then settles', () => {
    const id = seedBrowser()
    render(<Harness id={id} />)
    act(() => {
      useCanvasStore.getState().updateBoard(id, { url: 'http://localhost:4321' })
    })
    expect(document.querySelector('.bb-url-field')?.classList.contains('bb-url-flash')).toBe(true)
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(document.querySelector('.bb-url-field')?.classList.contains('bb-url-flash')).toBe(false)
  })

  it("does NOT flash on the user's own committed edit", () => {
    const id = seedBrowser()
    render(<Harness id={id} />)
    const input = urlInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'http://localhost:8080' } })
    fireEvent.blur(input)
    expect(boardUrl(id)).toBe('http://localhost:8080')
    expect(document.querySelector('.bb-url-field')?.classList.contains('bb-url-flash')).toBe(false)
  })
})

describe('BrowserBoard — screenshot toast honesty (BUG-028, toast channel since D1-A)', () => {
  // The board no longer renders its own note — feedback goes to the app toast store.
  async function shoot(id: string): Promise<{ message: string; kind: string }> {
    // OSR is the default engine: the camera button enables on status 'connected' + alive (osrAlive
    // defaults true with the liveness store unseeded), not the native `live` flag.
    act(() => {
      usePreviewStore.getState().patch(id, { status: 'connected' })
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
