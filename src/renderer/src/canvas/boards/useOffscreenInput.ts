import { useEffect } from 'react'
import type { RefObject } from 'react'
import { VIEWPORT_PRESETS } from '../../lib/browserLayout'
import type { BrowserViewport } from '../../lib/boardSchema'

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
 *     the page's LOGICAL space = the active preset's CSS box (M4: Mobile 390 / Tablet 834 /
 *     Desktop 1280, mirroring previewOsr.ts). Logical space is DPR- and supersample-independent,
 *     so this stays correct as M1 bumps the render buffer for sharpness.
 *   - **Mouse** down/up/move(+wheel). Move is rAF-coalesced (one event/frame) to bound IPC — an
 *     M2 throughput factor. `setPointerCapture` keeps a drag (text-select / slider) alive past the
 *     canvas edge.
 *   - **Keyboard** is BEST-EFFORT for this slice: the canvas is focusable and grabs focus on
 *     pointerdown, then keyDown/keyUp (+ a `char` for printable keys) forward. Special keys map to
 *     Electron key-code names. Robust key-byte fidelity (à la the terminal) is a later increment.
 *
 * Late-mount note: the boards mount content into a deferred "stable content host", so the
 * canvas can be absent on the effect's first tick. We rAF-wait for `canvasRef.current` before
 * attaching (the sibling frame hook dodges this only because it reads the ref lazily per frame).
 *
 * No-op unless `enabled` (VITE_PREVIEW_OSR + not full view). Isolated from the native path.
 */

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

/** Map a DOM event's client coords to page-logical px (the active preset's CSS box), or null
 *  if the canvas has no size. `pageW/pageH` = the live preset logical size (M4 reflow). */
function toPage(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  pageW: number,
  pageH: number
): { x: number; y: number } | null {
  const r = canvas.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  const x = Math.round(((clientX - r.left) / r.width) * pageW)
  const y = Math.round(((clientY - r.top) / r.height) * pageH)
  return {
    x: Math.max(0, Math.min(pageW - 1, x)),
    y: Math.max(0, Math.min(pageH - 1, y))
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

/**
 * Electron cursor `type` → CSS `cursor`. Most types ARE valid CSS keywords and pass
 * through; the load-bearing translations are `hand`→`pointer` (the link cursor — CSS has
 * no `hand`) and `pointer`→`default` (Blink's `pointer` is the arrow, not the link). The
 * *-panning family → `all-scroll`; unknown/`null` → `default`. (`custom` is handled
 * separately via the image data URL.)
 */
const CURSOR_CSS: Record<string, string> = {
  default: 'default',
  pointer: 'default',
  hand: 'pointer',
  crosshair: 'crosshair',
  text: 'text',
  'vertical-text': 'vertical-text',
  wait: 'wait',
  help: 'help',
  progress: 'progress',
  'e-resize': 'e-resize',
  'n-resize': 'n-resize',
  'ne-resize': 'ne-resize',
  'nw-resize': 'nw-resize',
  's-resize': 's-resize',
  'se-resize': 'se-resize',
  'sw-resize': 'sw-resize',
  'w-resize': 'w-resize',
  'ns-resize': 'ns-resize',
  'ew-resize': 'ew-resize',
  'nesw-resize': 'nesw-resize',
  'nwse-resize': 'nwse-resize',
  'col-resize': 'col-resize',
  'row-resize': 'row-resize',
  'm-panning': 'all-scroll',
  'e-panning': 'all-scroll',
  'n-panning': 'all-scroll',
  'ne-panning': 'all-scroll',
  'nw-panning': 'all-scroll',
  's-panning': 'all-scroll',
  'se-panning': 'all-scroll',
  'sw-panning': 'all-scroll',
  'w-panning': 'all-scroll',
  move: 'move',
  cell: 'cell',
  'context-menu': 'context-menu',
  alias: 'alias',
  nodrop: 'no-drop',
  copy: 'copy',
  none: 'none',
  'not-allowed': 'not-allowed',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  grab: 'grab',
  grabbing: 'grabbing'
}

/** Wire all input listeners onto a present canvas; returns a detach fn. `pageW/pageH` is the
 *  active preset's logical size — the page-coordinate space the offscreen window lays out in. */
function attachInput(
  boardId: string,
  canvas: HTMLCanvasElement,
  pageW: number,
  pageH: number
): () => void {
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
  // Flush the coalesced move SYNCHRONOUSLY (used before mouseUp / on pointerleave) so the
  // page's hover/drag-select endpoint is exact and not raced by a pending rAF move.
  const flushPendingSync = (): void => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (pendingMove) {
      send({ type: 'mouseMove', ...pendingMove })
      pendingMove = null
    }
  }

  const onPointerDown = (e: PointerEvent): void => {
    const p = toPage(canvas, e.clientX, e.clientY, pageW, pageH)
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
    const p = toPage(canvas, e.clientX, e.clientY, pageW, pageH)
    if (!p) return
    pendingMove = { ...p, modifiers: modifiersOf(e) }
    if (!rafId) rafId = requestAnimationFrame(flushMove)
  }
  const onPointerUp = (e: PointerEvent): void => {
    const p = toPage(canvas, e.clientX, e.clientY, pageW, pageH)
    if (!p) return
    flushPendingSync() // exact endpoint: drain any pending move before the up
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
  const onPointerLeave = (e: PointerEvent): void => {
    // Send a definitive exit move so the page clears its last :hover / dismisses tooltips
    // (forwarded mouseMove drives element hover; viewport mouseLeave does not — Electron
    // #4912), and drop the mirrored cursor so a stale I-beam doesn't bleed onto app chrome.
    flushPendingSync()
    const p = toPage(canvas, e.clientX, e.clientY, pageW, pageH)
    if (p) send({ type: 'mouseMove', ...p, modifiers: modifiersOf(e) })
    canvas.style.cursor = 'default'
  }
  const onWheel = (e: WheelEvent): void => {
    // Non-passive: stop React Flow from zooming the canvas and scroll the page instead.
    e.preventDefault()
    e.stopPropagation()
    const p = toPage(canvas, e.clientX, e.clientY, pageW, pageH)
    if (!p) return
    // deltaMode: 0=pixel, 1=line, 2=page → approximate non-pixel modes to pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1
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
  // Per-interaction focus emulation (P0): the canvas grabs focus on pointerdown, so 'focus'
  // here = "this preview is active" → enable the caret/:focus ring; 'blur' (clicking another
  // board or app chrome) disables it so the page's blur/focusout fires (menus close, on-blur
  // validation runs). DOM focus is singular, so only the active board is ever emulated-focused.
  const onFocus = (): void => void window.api.setOsrFocus(boardId, true)
  const onBlur = (): void => void window.api.setOsrFocus(boardId, false)
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

  // Mirror the offscreen page's cursor onto the canvas (I-beam over inputs, pointer over
  // links). Start at 'default' (arrow) so the preview reads as a page, not the canvas-pan
  // grab cursor; cursor-changed refines it. A CSS url() MUST end in a fallback keyword.
  canvas.style.cursor = 'default'
  const offCursor = window.api.onPreviewOsrCursor((c) => {
    if (c.id !== boardId) return
    if (c.type === 'custom' && c.image) {
      const hx = c.hotspot?.x ?? 0
      const hy = c.hotspot?.y ?? 0
      canvas.style.cursor = `url(${c.image}) ${hx} ${hy}, auto`
    } else {
      canvas.style.cursor = CURSOR_CSS[c.type] ?? 'default'
    }
  })

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  canvas.addEventListener('keydown', onKeyDown)
  canvas.addEventListener('keyup', onKeyUp)
  canvas.addEventListener('focus', onFocus)
  canvas.addEventListener('blur', onBlur)
  return () => {
    if (rafId) cancelAnimationFrame(rafId)
    offCursor()
    canvas.style.cursor = ''
    void window.api.setOsrFocus(boardId, false) // drop emulation if torn down while focused
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointerleave', onPointerLeave)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('contextmenu', onContextMenu)
    canvas.removeEventListener('keydown', onKeyDown)
    canvas.removeEventListener('keyup', onKeyUp)
    canvas.removeEventListener('focus', onFocus)
    canvas.removeEventListener('blur', onBlur)
  }
}

export function useOffscreenInput(
  boardId: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  viewport: BrowserViewport,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled) return
    // M4: forward coordinates in the ACTIVE preset's logical space (the width the page lays
    // out at in MAIN). A preset switch re-attaches with the new size — infrequent (a control
    // click), so the listener churn is negligible.
    const preset = VIEWPORT_PRESETS[viewport]
    let raf = 0
    let tries = 0
    let detach: (() => void) | null = null
    // The canvas can be absent on the first tick (deferred content host) — rAF-wait for it
    // rather than bail permanently (the bug that made the preview un-clickable).
    const waitForCanvas = (): void => {
      const canvas = canvasRef.current
      if (canvas) {
        detach = attachInput(boardId, canvas, preset.w, preset.h)
        return
      }
      if (tries++ > 180) return // ~3s of frames; give up rather than spin forever
      raf = requestAnimationFrame(waitForCanvas)
    }
    waitForCanvas()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (detach) detach()
    }
  }, [boardId, enabled, canvasRef, viewport])
}
