// src/renderer/src/canvas/boards/terminal/terminalSelection.ts
/**
 * xterm computes a selection cell as (clientX − rect.left) / cellWidth, but the
 * Terminal board renders inside React Flow's `transform: scale(z)` viewport: the offset
 * is in scaled screen px while cellWidth is unscaled, so the cell is off by a factor z
 * at any zoom ≠ 1. We feed xterm a corrected coordinate so its native selection lands
 * on the cell under the cursor.
 *
 * Derivation: a point at true CSS offset u renders at z·u from the visual left, and
 * rect.left IS the visual left, so clientX − rect.left = z·u. Dividing by z recovers u.
 */
export function correctClientPoint(
  client: { x: number; y: number },
  rect: { left: number; top: number },
  z: number
): { x: number; y: number } {
  if (!Number.isFinite(z) || z <= 0) return { x: client.x, y: client.y }
  return {
    x: rect.left + (client.x - rect.left) / z,
    y: rect.top + (client.y - rect.top) / z
  }
}

const SENTINEL = '__caScaledMouse'

/**
 * Install a capture-phase mouse shim that makes xterm's NATIVE text selection land on
 * the right cell while the board is scaled by the React Flow camera.
 *
 * xterm 5.5's selection event model (verified against its source):
 *  - `mousedown` → a BUBBLE-phase listener on the `.xterm` root element (the element
 *    passed to `term.open(el)`) calls `SelectionService.handleMouseDown(event)`.
 *  - During a drag, `mousemove`/`mouseup` → BUBBLE-phase listeners on `document`.
 *  - The buffer cell is `(clientX − rect.left − padding) / cellWidth`, where `rect` is
 *    the `.xterm-screen` rect (already scaled) but `cellWidth` is NOT — hence the off-by-z
 *    bug. `handleMouseDown` also branches on `event.detail` (1/2/3 → single/double/triple
 *    click), so the re-dispatched clone MUST carry `detail` or no selection starts.
 *
 * The shim intercepts each selection mouse event in the CAPTURE phase (so it runs before
 * xterm's bubble listeners), rewrites its coordinate by the live zoom, and re-dispatches a
 * sentinel-tagged clone to the element xterm listens on (mousedown → the screen element,
 * which bubbles to `.xterm`; move/up → `document`). The original is
 * `stopImmediatePropagation`'d so xterm never sees the uncorrected coordinate; the clone
 * carries the sentinel so this same shim skips it (no re-capture / loop). No-op at z = 1
 * (and for non-finite/≤0 zoom), so the unscaled copy/paste/focus paths are untouched.
 *
 * The shim only acts during an active LEFT-BUTTON selection drag (button 0). Right-click
 * and middle-click pass through untouched so xterm's context-menu and paste-on-middle-click
 * (DECSET 1003 / OSC-8 link hover) are not disrupted. Idle mousemove events — xterm link
 * hover, DECSET 1003 mouse-motion reporting — are never intercepted; only moves/ups that
 * belong to an in-progress left-button drag are corrected.
 *
 * Note: move/up listeners are bound to `window` (not `screenWrap`) deliberately, to keep
 * correcting a drag that leaves the terminal well — matching xterm's own `document`-bound
 * drag listeners.
 *
 * Note: pointer/touch selection is out of scope — xterm 5.5 selection is mouse-event based.
 *
 * Returns a disposer that removes every listener.
 */
export function installSelectionShim(
  wrap: HTMLElement,
  screenEl: HTMLElement,
  getZoom: () => number
): () => void {
  let dragging = false

  const clone = (e: MouseEvent): MouseEvent | null => {
    if ((e as unknown as Record<string, unknown>)[SENTINEL]) return null // our own re-dispatch
    const z = getZoom()
    if (!Number.isFinite(z) || z === 1 || z <= 0) return null // no correction needed
    const rect = screenEl.getBoundingClientRect()
    const p = correctClientPoint(
      { x: e.clientX, y: e.clientY },
      { left: rect.left, top: rect.top },
      z
    )
    const ev = new MouseEvent(e.type, {
      bubbles: true,
      cancelable: true,
      view: window,
      // `detail` is the click count — xterm's handleMouseDown branches on detail === 1/2/3
      // to pick single/double/triple-click selection; a clone without it (detail 0) starts
      // no selection at all.
      detail: e.detail,
      button: e.button,
      buttons: e.buttons,
      clientX: p.x,
      clientY: p.y,
      screenX: e.screenX,
      screenY: e.screenY,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    })
    ;(ev as unknown as Record<string, unknown>)[SENTINEL] = true
    return ev
  }

  // Selection is left-button only. Start correcting on a button-0 mousedown (when the
  // zoom actually needs correction); set `dragging` so we only rewrite the moves/ups that
  // belong to THIS drag — leaving idle/button-less motion (xterm link hover, DECSET 1003
  // mouse reporting) untouched at z≠1.
  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return // right/middle: let xterm + the React onContextMenu handle it
    const ev = clone(e)
    if (!ev) return // z===1 or invalid → native flow (focus + native selection)
    dragging = true
    e.stopImmediatePropagation()
    e.preventDefault()
    // Dispatch to the screen element; the clone bubbles up to `.xterm` where xterm's
    // mousedown selection listener lives (and on to the React `screenWrap` handler, so
    // click-to-focus still fires via the clone).
    screenEl.dispatchEvent(ev)
  }

  const onMove = (e: MouseEvent): void => {
    if (!dragging) return
    const ev = clone(e)
    if (!ev) return // zoom flipped to 1 mid-drag → let native moves through
    e.stopImmediatePropagation()
    document.dispatchEvent(ev)
  }

  const onUp = (e: MouseEvent): void => {
    if (!dragging) return
    dragging = false
    const ev = clone(e)
    if (!ev) return
    e.stopImmediatePropagation()
    document.dispatchEvent(ev)
  }

  wrap.addEventListener('mousedown', onDown, true)
  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('mouseup', onUp, true)
  return () => {
    wrap.removeEventListener('mousedown', onDown, true)
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('mouseup', onUp, true)
  }
}
