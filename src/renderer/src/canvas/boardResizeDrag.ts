/**
 * Board-resize drag registry (resize-storm fix, T1a′) — lets a board's content hook know a
 * NodeResizer handle-drag is IN PROGRESS so it can defer expensive/externally-visible reactions
 * until the pointer is released.
 *
 * Why the terminal needs this: a handle-drag fires the board's ResizeObserver every frame, and
 * each changed grid would reach the PTY as a ConPTY resize + SIGWINCH. The 50 ms trailing
 * settler only PACES that stream (~20 resizes/sec on a slow drag) — a streaming TUI still
 * repaints per SIGWINCH and litters scrollback under claude-code#51828. During a drag the xterm
 * grid keeps refitting visually, but the PTY should see exactly ONE resize: the released size.
 *
 * Plain module registry (registerTerminalInput precedent), not a zustand store: the state is
 * ephemeral interaction state with exactly one producer (BoardNode's NodeResizer callbacks) and
 * per-board subscribers — no React render should ever depend on it.
 */

const dragging = new Set<string>()
const listeners = new Map<string, Set<(dragging: boolean) => void>>()

function notify(boardId: string, isDragging: boolean): void {
  const subs = listeners.get(boardId)
  if (!subs) return
  for (const cb of subs) cb(isDragging)
}

/** NodeResizer onResizeStart — the user grabbed a handle on this board. */
export function beginBoardResizeDrag(boardId: string): void {
  if (dragging.has(boardId)) return
  dragging.add(boardId)
  notify(boardId, true)
}

/** NodeResizer onResizeEnd — pointer released (also safe to call redundantly: unmount guard). */
export function endBoardResizeDrag(boardId: string): void {
  if (!dragging.delete(boardId)) return
  notify(boardId, false)
}

/** Snapshot read for late subscribers (a terminal that mounts mid-drag must start held). */
export function isBoardResizeDragging(boardId: string): boolean {
  return dragging.has(boardId)
}

/** Subscribe to this board's drag state; returns the unsubscribe. */
export function onBoardResizeDrag(boardId: string, cb: (dragging: boolean) => void): () => void {
  let subs = listeners.get(boardId)
  if (!subs) {
    subs = new Set()
    listeners.set(boardId, subs)
  }
  subs.add(cb)
  return () => {
    subs.delete(cb)
    if (subs.size === 0) listeners.delete(boardId)
  }
}
