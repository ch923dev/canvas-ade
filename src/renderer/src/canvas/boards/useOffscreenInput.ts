import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * SPIKE (feat/preview-offscreen-spike) — M3 input forwarding for the offscreen preview.
 *
 * The offscreen `<canvas>` (useOffscreenPreview) is just a picture: the page renders in a
 * hidden window in MAIN, so the canvas receives no native OS input the way a live
 * WebContentsView does. This hook makes it interactive by forwarding real DOM events on
 * the canvas to MAIN's `preview:osrInput` → `webContents.sendInputEvent` on the offscreen
 * window:
 *
 *   - **Coordinates.** Screen → page-logical px via the canvas's live `getBoundingClientRect`.
 *     That rect already reflects the React Flow camera (`translate/scale`) AND the device-frame
 *     letterboxing, so no camera-transform math is needed here — the ratio maps straight onto
 *     the page's fixed 1280×800 logical space (OSR_PAGE_W/H, the MAIN render size; DPR-independent,
 *     so this stays correct when M1 bumps the buffer to 2× for sharpness).
 *   - **Mouse** down/up/move(+wheel). Move is rAF-coalesced (one event/frame) to bound IPC — an
 *     M2 throughput factor. `setPointerCapture` keeps a drag (text-select / slider) alive past the
 *     canvas edge.
 *   - **Keyboard** is BEST-EFFORT for this slice: the canvas is focusable and grabs focus on
 *     pointerdown, then keyDown/keyUp (+ a `char` for printable keys) forward. Special keys map to
 *     Electron key-code names. Robust key-byte fidelity (à la the terminal) is a later increment.
 *
 * No-op unless `enabled` (VITE_PREVIEW_OSR + not full view). Isolated from the native path.
 */

/** MAIN render size (mirror of previewOsr.ts OSR_WIDTH/OSR_HEIGHT) — the page's logical
 *  coordinate space that `sendInputEvent` expects, independent of frame-buffer DPR. */
const OSR_PAGE_W = 1280
const OSR_PAGE_H = 800

type OsrInput = Parameters<typeof window.api.sendOsrInput>[1]
type Modifier = 'shift' | 'control' | 'alt' | 'meta'

function modifiersOf(e: MouseEvent | WheelEvent | KeyboardEvent): Modifier[] {
  const m: Modifier[] = []
  if (e.shiftKey) m.push('shift')
  if (e.ctrlKey) m.push('control')
  if (e.altKey) m.push('alt')
  if (e.metaKey) m.push('meta')
  return m
}

const MOUSE_BUTTON = ['left', 'middle', 'right'] as const
function buttonOf(button: number): 'left' | 'middle' | 'right' {
  return MOUSE_BUTTON[button] ?? 'left'
}

/** Map a DOM event's client coords to page-logical px, or null if the canvas has no size. */
function toPage(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const r = canvas.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  const x = Math.round(((clientX - r.left) / r.width) * OSR_PAGE_W)
  const y = Math.round(((clientY - r.top) / r.height) * OSR_PAGE_H)
  return {
    x: Math.max(0, Math.min(OSR_PAGE_W - 1, x)),
    y: Math.max(0, Math.min(OSR_PAGE_H - 1, y))
  }
}

/** DOM KeyboardEvent.key → an Electron `keyCode`. Printable single chars pass through as-is. */
function keyCodeOf(e: KeyboardEvent): string | null {
  const named: Record<string, string> = {
    Enter: 'Return',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    Delete: 'Delete',
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }
  if (named[e.key]) return named[e.key]
  if (e.key.length === 1) return e.key // letters / digits / punctuation
  return null // ignore standalone modifier presses, F-keys, etc. for this slice
}

export function useOffscreenInput(
  boardId: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  enabled: boolean
): void {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!enabled || !canvas) return

    const send = (ev: OsrInput): void => void window.api.sendOsrInput(boardId, ev)

    // rAF-coalesced move: keep only the latest position, flush once per frame.
    let pendingMove: { x: number; y: number; modifiers: Modifier[] } | null = null
    let rafId = 0
    const flushMove = (): void => {
      rafId = 0
      if (!pendingMove) return
      send({ type: 'mouseMove', ...pendingMove })
      pendingMove = null
    }

    const onPointerDown = (e: PointerEvent): void => {
      const p = toPage(canvas, e.clientX, e.clientY)
      if (!p) return
      try {
        canvas.setPointerCapture(e.pointerId) // keep drag alive past the canvas edge
      } catch {
        /* capture unavailable */
      }
      canvas.focus({ preventScroll: true }) // route keyboard here
      send({
        type: 'mouseDown',
        ...p,
        button: buttonOf(e.button),
        clickCount: e.detail || 1,
        modifiers: modifiersOf(e)
      })
    }
    const onPointerMove = (e: PointerEvent): void => {
      const p = toPage(canvas, e.clientX, e.clientY)
      if (!p) return
      pendingMove = { ...p, modifiers: modifiersOf(e) }
      if (!rafId) rafId = requestAnimationFrame(flushMove)
    }
    const onPointerUp = (e: PointerEvent): void => {
      const p = toPage(canvas, e.clientX, e.clientY)
      if (!p) return
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* nothing captured */
      }
      send({
        type: 'mouseUp',
        ...p,
        button: buttonOf(e.button),
        clickCount: e.detail || 1,
        modifiers: modifiersOf(e)
      })
    }
    const onWheel = (e: WheelEvent): void => {
      // Non-passive: stop React Flow from zooming the canvas and scroll the page instead.
      e.preventDefault()
      e.stopPropagation()
      const p = toPage(canvas, e.clientX, e.clientY)
      if (!p) return
      // deltaMode: 0=pixel, 1=line, 2=page → approximate non-pixel modes to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? OSR_PAGE_H : 1
      // DOM wheel deltaY>0 scrolls down; Electron mouseWheel deltaY>0 scrolls up → negate.
      send({
        type: 'mouseWheel',
        ...p,
        deltaX: -e.deltaX * unit,
        deltaY: -e.deltaY * unit,
        canScroll: true,
        modifiers: modifiersOf(e)
      })
    }
    const onContextMenu = (e: MouseEvent): void => e.preventDefault()
    const onKeyDown = (e: KeyboardEvent): void => {
      const keyCode = keyCodeOf(e)
      if (!keyCode) return
      e.preventDefault()
      e.stopPropagation()
      const modifiers = modifiersOf(e)
      send({ type: 'keyDown', keyCode, modifiers })
      // Printable (no ctrl/meta) → also emit a char so text inputs receive the character.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        send({ type: 'char', keyCode: e.key, modifiers })
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      const keyCode = keyCodeOf(e)
      if (!keyCode) return
      send({ type: 'keyUp', keyCode, modifiers: modifiersOf(e) })
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('keyup', onKeyUp)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('keyup', onKeyUp)
    }
  }, [boardId, enabled, canvasRef])
}
