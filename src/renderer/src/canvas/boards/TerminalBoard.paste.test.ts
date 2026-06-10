// @vitest-environment jsdom
// src/renderer/src/canvas/boards/TerminalBoard.paste.test.ts
// BUG-025 regression: pasteIntoTerminal must fall through to the text-paste branch
// (and not throw / silently drop the paste) when stageClipboardImage rejects.
//
// This drives the REAL exported `pasteIntoTerminal` from terminal/pasteIntoTerminal.ts
// (no hand-kept replica): the function reads the GLOBAL `window.api` seam (we stub it
// per-test) and takes a `Terminal` (we hand it a minimal fake whose `paste` is the
// spy we assert on). jsdom is required because importing TerminalBoard.tsx runs
// top-level browser code (navigator.platform, xterm/React module init).
//
// The BUG (before fix): if stageClipboardImage() rejected, the rejection propagated
// out of the async function and was silently dropped by the `void` call site —
// neither a fallback to text paste nor any user-visible error occurred.
//
// The FIX: wrap the stageClipboardImage call in try/catch; on error, fall through
// to the text-paste branch (same as "no image in clipboard").

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pasteIntoTerminal } from './terminal/pasteIntoTerminal'

// ── Test doubles ─────────────────────────────────────────────────────────────
// Build a minimal fake Terminal: `paste` is the spy we assert on.
// NOTE: `element` is intentionally NOT defined here — the old disposal guard
// (`if (term.element === undefined) return`) was dead code because xterm keeps
// `element` defined after dispose(). The replacement guard uses the `isLive`
// predicate, so `element` is irrelevant to the tests below.
function makeTerm(): import('@xterm/xterm').Terminal {
  return { paste: vi.fn() } as unknown as import('@xterm/xterm').Terminal
}

// Install the GLOBAL `window.api` seam pasteIntoTerminal reads, shaped per scenario.
// (The real fn calls `window.api.stageClipboardImage` + `window.api.clipboard.readText`.)
function apiWith({
  stageBehavior,
  clipboardText = 'clipboard text'
}: {
  stageBehavior: 'throw-enospc' | 'throw-eperm' | 'return-null' | 'return-path'
  clipboardText?: string
}): void {
  ;(window as unknown as { api: unknown }).api = {
    stageClipboardImage: vi.fn(async () => {
      if (stageBehavior === 'throw-enospc') {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      if (stageBehavior === 'throw-eperm') {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      if (stageBehavior === 'return-null') return null
      return '/proj/.canvas/tmp/paste-b-1.png'
    }),
    clipboard: {
      readText: vi.fn(async () => clipboardText)
    }
  }
}

// Read back the stubbed clipboard.readText spy for "not called" assertions.
function readTextSpy(): ReturnType<typeof vi.fn> {
  return (window as unknown as { api: { clipboard: { readText: ReturnType<typeof vi.fn> } } }).api
    .clipboard.readText
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('BUG-025: pasteIntoTerminal — stageClipboardImage failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { api?: unknown }).api
  })

  it('stageClipboardImage ENOSPC → falls through to text paste', async () => {
    const term = makeTerm()
    apiWith({ stageBehavior: 'throw-enospc', clipboardText: 'clipboard text' })
    await pasteIntoTerminal(term, 'board-1')
    // Must NOT throw, must fall back to text paste
    expect(term.paste).toHaveBeenCalledWith('clipboard text')
  })

  it('stageClipboardImage EPERM → falls through to text paste', async () => {
    const term = makeTerm()
    apiWith({ stageBehavior: 'throw-eperm', clipboardText: 'fallback text' })
    await pasteIntoTerminal(term, 'board-1')
    expect(term.paste).toHaveBeenCalledWith('fallback text')
  })

  it('stageClipboardImage ENOSPC with empty clipboard → no paste call (no crash)', async () => {
    const term = makeTerm()
    apiWith({ stageBehavior: 'throw-enospc', clipboardText: '' })
    await pasteIntoTerminal(term, 'board-1')
    // Empty clipboard text → paste not called (matches the null-image path behavior)
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('successful stage → image path pasted (happy path unchanged)', async () => {
    const term = makeTerm()
    apiWith({ stageBehavior: 'return-path' })
    await pasteIntoTerminal(term, 'board-1')
    expect(term.paste).toHaveBeenCalledWith('"/proj/.canvas/tmp/paste-b-1.png" ')
    // readText must NOT be called when image staging succeeds
    expect(readTextSpy()).not.toHaveBeenCalled()
  })

  it('no image in clipboard → text pasted (happy path unchanged)', async () => {
    const term = makeTerm()
    apiWith({ stageBehavior: 'return-null', clipboardText: 'text content' })
    await pasteIntoTerminal(term, 'board-1')
    expect(term.paste).toHaveBeenCalledWith('text content')
  })
})

// ── BUG-056 regression: isLive predicate replaces the dead term.element guard ──
// The old guard (`if (term.element === undefined) return`) was ineffective because
// xterm does NOT clear `element` on dispose — verified in the bundled lib. The
// replacement uses an `isLive` callback (defaults to always-true for call sites
// that already guard before calling) so callers can pass `() => termRef.current === term`
// to catch disposal / respawn during the stageClipboardImage / readText awaits.
describe('BUG-056: pasteIntoTerminal — isLive predicate prevents paste on disposed terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { api?: unknown }).api
  })

  it('isLive returns false before image-paste → paste is NOT called', async () => {
    const term = makeTerm()
    // Image is staged successfully, but the terminal was replaced before the await resolved.
    apiWith({ stageBehavior: 'return-path' })
    await pasteIntoTerminal(term, 'board-1', () => false)
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('isLive returns false before text-paste → paste is NOT called', async () => {
    const term = makeTerm()
    // No image; the terminal was replaced during the readText await.
    apiWith({ stageBehavior: 'return-null', clipboardText: 'hello' })
    await pasteIntoTerminal(term, 'board-1', () => false)
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('isLive returns true → paste proceeds normally (sanity check)', async () => {
    const term = makeTerm()
    apiWith({ stageBehavior: 'return-null', clipboardText: 'hello' })
    await pasteIntoTerminal(term, 'board-1', () => true)
    expect(term.paste).toHaveBeenCalledWith('hello')
  })

  it('isLive defaults to always-true when omitted → existing behavior preserved', async () => {
    const term = makeTerm()
    apiWith({ stageBehavior: 'return-null', clipboardText: 'text' })
    await pasteIntoTerminal(term, 'board-1') // no third arg
    expect(term.paste).toHaveBeenCalledWith('text')
  })
})
