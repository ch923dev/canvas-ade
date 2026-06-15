import { useEffect } from 'react'
import type { RefObject } from 'react'
import { VIEWPORT_PRESETS } from '../../lib/browserLayout'
import type { BrowserViewport } from '../../lib/boardSchema'
import { classifyKeydown } from '../../lib/osrKeyInput'
import { mapOsrWheel } from '../../lib/osrWheel'

/**
 * OS-3 Phase 3 — input forwarding for the offscreen (OSR) Browser preview.
 *
 * The offscreen `<canvas>` (useOffscreenPreview) is just a picture: the page renders in a hidden
 * window in MAIN, so the canvas receives no native OS input the way a live WebContentsView does.
 * This hook makes it interactive by forwarding real DOM events to MAIN. Two surfaces:
 *
 *   - **`<canvas>`** = pointer / wheel / cursor-mirror. Coordinates map screen → page-logical px via
 *     the canvas's live `getBoundingClientRect` (already reflects the RF camera + device-frame
 *     letterbox, so no camera math here); logical space is the active preset's CSS box (M4) — DPR-
 *     and supersample-independent, so it stays correct as Phase 1 bumps the render buffer.
 *   - **hidden `<textarea class="bb-ime-proxy">`** = keyboard / IME / clipboard target (Phase 3).
 *     A bare focused `<canvas>` has no *editing host*, so it can't fire `composition*` (no IME) and
 *     mis-handles AltGr (Windows reports it as Ctrl+Alt). The proxy is the industry-standard remote-
 *     rendering pattern (xterm/noVNC): we `proxy.focus()` on canvas pointerdown, then route:
 *       · **text** (printable, AltGr-composed `€`, dead-key `é`, IME commit) → the proxy's native
 *         `input`/`composition` events → `osrIme(commit/compose)` → CDP `Input.insertText` /
 *         `Input.imeSetComposition` (MAIN). The browser composes the grapheme for us.
 *       · **command keys** (Enter/Tab/Esc/arrows/Backspace/…, Ctrl/Cmd shortcuts) → `sendOsrInput`
 *         keyDown/keyUp so the page's key handlers + shortcuts fire.
 *       · **clipboard** (Ctrl/Cmd+C/X/V/A) → `osrEditCommand` → `wc.copy/cut/paste/selectAll` (the
 *         trusted bridge over the page's denied `navigator.clipboard`), NOT a synthetic chord.
 *     Key classification is the pure, unit-tested `classifyKeydown` (`lib/osrKeyInput.ts`).
 *
 * Late-mount note: the boards mount content into a deferred "stable content host", so the canvas /
 * proxy can be absent on the effect's first tick. We rAF-wait for both before attaching.
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

/** Wire all input listeners onto a present canvas + proxy textarea; returns a detach fn. `pageW/pageH`
 *  is the active preset's logical size — the page-coordinate space the offscreen window lays out in. */
function attachInput(
  boardId: string,
  canvas: HTMLCanvasElement,
  proxy: HTMLTextAreaElement,
  pageW: number,
  pageH: number
): () => void {
  const send = (ev: OsrInput): void => void window.api.sendOsrInput(boardId, ev)

  // ── Pointer (on the canvas) ──────────────────────────────────────────────────────────────────
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
    // Route keyboard/IME/clipboard to the hidden proxy textarea (NOT the canvas — it has no
    // editing host, so it can't fire composition events). preventScroll: don't jump the page.
    proxy.focus({ preventScroll: true })
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
    // Phase 3 / 3D — precise delta mapping (pixel passes through + precise hint; line x40; page
    // xpageH) instead of the old crude x16. Pure + unit-tested in lib/osrWheel.ts.
    send({ type: 'mouseWheel', ...p, ...mapOsrWheel(e, pageH), modifiers: modifiersOf(e) })
  }
  const onContextMenu = (e: MouseEvent): void => e.preventDefault()

  // ── Keyboard / IME / clipboard (on the proxy textarea) ───────────────────────────────────────
  // Per-interaction focus emulation (P0): the proxy grabs focus on canvas pointerdown, so 'focus'
  // here = "this preview is active" → enable the caret/:focus ring; 'blur' (clicking another board
  // or app chrome) disables it so the page's blur/focusout fires (menus close, on-blur validation
  // runs). DOM focus is singular, so only the active board is ever emulated-focused.
  const onFocus = (): void => void window.api.setOsrFocus(boardId, true)
  const onBlur = (): void => void window.api.setOsrFocus(boardId, false)

  const clearProxy = (): void => {
    proxy.value = ''
  }
  let composing = false
  // After a composition commits, the browser fires a trailing `input` (insertCompositionText) we've
  // already handled on compositionend — skip exactly one to avoid a double-insert.
  let skipNextInput = false

  const onKeyDown = (e: KeyboardEvent): void => {
    const cls = classifyKeydown(e)
    switch (cls.kind) {
      case 'ignore':
        return // IME-in-progress / lone modifier — composition events (or nothing) drive it
      case 'clipboard':
        e.preventDefault()
        e.stopPropagation()
        void window.api.osrEditCommand(boardId, cls.action)
        return
      case 'command':
        // Real key event to the page (Enter/Tab/arrows + Ctrl/Cmd shortcuts). preventDefault stops
        // the proxy from editing + React Flow from acting; stopPropagation keeps app shortcuts from
        // double-firing (focus is "inside" the web content, like a real browser).
        e.preventDefault()
        e.stopPropagation()
        send({ type: 'keyDown', keyCode: cls.keyCode, modifiers: modifiersOf(e) })
        return
      case 'text':
        // Let the proxy receive the character (NO preventDefault) → its `input` event forwards the
        // composed text via insertText. stopPropagation (no preventDefault) keeps app single-key
        // shortcuts from firing while typing in the preview, exactly as the canvas path did.
        e.stopPropagation()
        return
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    const cls = classifyKeydown(e)
    if (cls.kind === 'command')
      send({ type: 'keyUp', keyCode: cls.keyCode, modifiers: modifiersOf(e) })
  }

  const onCompositionStart = (): void => {
    composing = true
  }
  const onCompositionUpdate = (e: CompositionEvent): void => {
    void window.api.osrIme(boardId, 'compose', e.data ?? '') // inline underlined preview (best-effort)
  }
  const onCompositionEnd = (e: CompositionEvent): void => {
    composing = false
    const text = e.data ?? ''
    if (text) void window.api.osrIme(boardId, 'commit', text) // commit replaces the composing range
    skipNextInput = true // the trailing `input` (insertCompositionText) is already committed
    clearProxy()
  }
  const onInput = (): void => {
    if (composing) return // mid-composition; the compose path drives the page
    if (skipNextInput) {
      skipNextInput = false
      clearProxy()
      return
    }
    const text = proxy.value
    if (text) void window.api.osrIme(boardId, 'commit', text)
    clearProxy()
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
  proxy.addEventListener('keydown', onKeyDown)
  proxy.addEventListener('keyup', onKeyUp)
  proxy.addEventListener('compositionstart', onCompositionStart)
  proxy.addEventListener('compositionupdate', onCompositionUpdate)
  proxy.addEventListener('compositionend', onCompositionEnd)
  proxy.addEventListener('input', onInput)
  proxy.addEventListener('focus', onFocus)
  proxy.addEventListener('blur', onBlur)
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
    proxy.removeEventListener('keydown', onKeyDown)
    proxy.removeEventListener('keyup', onKeyUp)
    proxy.removeEventListener('compositionstart', onCompositionStart)
    proxy.removeEventListener('compositionupdate', onCompositionUpdate)
    proxy.removeEventListener('compositionend', onCompositionEnd)
    proxy.removeEventListener('input', onInput)
    proxy.removeEventListener('focus', onFocus)
    proxy.removeEventListener('blur', onBlur)
  }
}

export function useOffscreenInput(
  boardId: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  proxyRef: RefObject<HTMLTextAreaElement | null>,
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
    // The canvas + proxy can be absent on the first tick (deferred content host) — rAF-wait for
    // BOTH rather than bail permanently (the bug that made the preview un-clickable). They render
    // together, so they appear on the same tick.
    const waitForEls = (): void => {
      const canvas = canvasRef.current
      const proxy = proxyRef.current
      if (canvas && proxy) {
        detach = attachInput(boardId, canvas, proxy, preset.w, preset.h)
        return
      }
      if (tries++ > 180) return // ~3s of frames; give up rather than spin forever
      raf = requestAnimationFrame(waitForEls)
    }
    waitForEls()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (detach) detach()
    }
  }, [boardId, enabled, canvasRef, proxyRef, viewport])
}
