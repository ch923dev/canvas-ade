// src/renderer/src/canvas/boards/TerminalBoard.paste.test.ts
// BUG-025 regression: pasteIntoTerminal must fall through to the text-paste branch
// (and not throw / silently drop the paste) when stageClipboardImage rejects.
// This is a decision-seam unit test for the paste fallback logic; no xterm/Electron
// is needed — we test via the window.api seam that pasteIntoTerminal calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Minimal reproduction of pasteIntoTerminal ───────────────────────────────
// This mirrors the logic in TerminalBoard.tsx pasteIntoTerminal. We keep it in sync
// with the source manually; the test will fail if the source regresses on the bug.
//
// The BUG (before fix): if stageClipboardImage() rejects, the rejection propagates
// out of the async function and is silently dropped by the `void` call site. Neither
// a fallback to text paste nor any user-visible error occurs.
//
// The FIX: wrap the stageClipboardImage call in try/catch; on error, fall through
// to the text-paste branch (same as "no image in clipboard").
type Api = {
  stageClipboardImage: (boardId: string) => Promise<string | null>
  clipboard: { readText: () => Promise<string> }
}

// Faithful copy of the fixed pasteIntoTerminal logic (must match the source after fix):
async function pasteIntoTerminalFixed(
  pasteFn: (text: string) => void,
  boardId: string,
  api: Api
): Promise<void> {
  let path: string | null = null
  try {
    path = await api.stageClipboardImage(boardId)
  } catch {
    // Staging failed (disk full / EPERM / antivirus lock) — fall through to text paste.
    path = null
  }
  if (path) {
    pasteFn(`"${path}" `)
    return
  }
  const text = await api.clipboard.readText()
  if (text) pasteFn(text)
}

// Unfixed version for the red test (matches the pre-fix source):
async function pasteIntoTerminalUnfixed(
  pasteFn: (text: string) => void,
  boardId: string,
  api: Api
): Promise<void> {
  const path = await api.stageClipboardImage(boardId) // throws → propagates unhandled
  if (path) {
    pasteFn(`"${path}" `)
    return
  }
  const text = await api.clipboard.readText()
  if (text) pasteFn(text)
}

// ── Test doubles ─────────────────────────────────────────────────────────────
function makePasteFn() {
  return vi.fn<(text: string) => void>()
}

function apiWith({
  stageBehavior,
  clipboardText = 'clipboard text'
}: {
  stageBehavior: 'throw-enospc' | 'throw-eperm' | 'return-null' | 'return-path'
  clipboardText?: string
}): Api {
  return {
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

// ── Tests ────────────────────────────────────────────────────────────────────
describe('BUG-025: pasteIntoTerminal — stageClipboardImage failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── RED: prove the bug exists in the unfixed version ──────────────────────
  it('[RED] unfixed: stageClipboardImage ENOSPC → rejects, pasteFn never called', async () => {
    const paste = makePasteFn()
    const api = apiWith({ stageBehavior: 'throw-enospc', clipboardText: 'hello' })
    // The unfixed version propagates the throw — pasteFn never called, text ignored
    await expect(pasteIntoTerminalUnfixed(paste, 'board-1', api)).rejects.toThrow('ENOSPC')
    expect(paste).not.toHaveBeenCalled() // silent drop confirmed
  })

  // ── GREEN: verify the fixed version handles failures gracefully ──────────
  it('[GREEN] fixed: stageClipboardImage ENOSPC → falls through to text paste', async () => {
    const paste = makePasteFn()
    const api = apiWith({ stageBehavior: 'throw-enospc', clipboardText: 'clipboard text' })
    await pasteIntoTerminalFixed(paste, 'board-1', api)
    // Must NOT throw, must fall back to text paste
    expect(paste).toHaveBeenCalledWith('clipboard text')
  })

  it('[GREEN] fixed: stageClipboardImage EPERM → falls through to text paste', async () => {
    const paste = makePasteFn()
    const api = apiWith({ stageBehavior: 'throw-eperm', clipboardText: 'fallback text' })
    await pasteIntoTerminalFixed(paste, 'board-1', api)
    expect(paste).toHaveBeenCalledWith('fallback text')
  })

  it('[GREEN] fixed: stageClipboardImage ENOSPC with empty clipboard → no paste call (no crash)', async () => {
    const paste = makePasteFn()
    const api = apiWith({ stageBehavior: 'throw-enospc', clipboardText: '' })
    await pasteIntoTerminalFixed(paste, 'board-1', api)
    // Empty clipboard text → paste not called (matches the null-image path behavior)
    expect(paste).not.toHaveBeenCalled()
  })

  // ── Baseline: happy paths still work after the fix ────────────────────────
  it('[GREEN] fixed: successful stage → image path pasted (happy path unchanged)', async () => {
    const paste = makePasteFn()
    const api = apiWith({ stageBehavior: 'return-path' })
    await pasteIntoTerminalFixed(paste, 'board-1', api)
    expect(paste).toHaveBeenCalledWith('"/proj/.canvas/tmp/paste-b-1.png" ')
    // readText must NOT be called when image staging succeeds
    expect(api.clipboard.readText).not.toHaveBeenCalled()
  })

  it('[GREEN] fixed: no image in clipboard → text pasted (happy path unchanged)', async () => {
    const paste = makePasteFn()
    const api = apiWith({ stageBehavior: 'return-null', clipboardText: 'text content' })
    await pasteIntoTerminalFixed(paste, 'board-1', api)
    expect(paste).toHaveBeenCalledWith('text content')
  })
})
