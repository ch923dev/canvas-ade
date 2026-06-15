/**
 * Tear down all live preview resources before a project switch: close every preview
 * (native WebContentsView AND offscreen OSR window) and kill every Terminal PTY tree.
 * Without this, switching projects leaks renderers + orphans node-pty child trees.
 * Idempotent / best-effort.
 */

export async function disposeLiveResources(): Promise<void> {
  // Close all preview views in one shot (cheaper than per-id). Both engines: the native
  // closeAll empties the WebContentsView map, the OSR closeAll destroys every offscreen
  // window + removes its per-board session listener (the session outlives the window).
  await window.api.closeAllPreviews().catch(() => false)
  await window.api.closeAllOsr().catch(() => false)
  // PTY-1: reap EVERY PTY — live AND parked — in one main-side call. Iterating the
  // board list (terminal boards) and killing per-id missed PARKED sessions: a
  // terminal deleted within PARK_TTL (120s) awaiting undo is no longer in the board
  // list, and its proc lives in main's `parked` map, so its child tree leaked until
  // the TTL fired. disposeAllTerminals drains both maps.
  await window.api.disposeAllTerminals().catch(() => false)
}
