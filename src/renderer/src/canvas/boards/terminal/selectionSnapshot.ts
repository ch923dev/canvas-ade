// src/renderer/src/canvas/boards/terminal/selectionSnapshot.ts
/**
 * Last-known-selection snapshot for the terminal copy path (terminal-copy fix,
 * docs/reviews/2026-07-11-terminal-copy-paste-research).
 *
 * xterm stores a selection as buffer COORDINATES, never text, and several actors clear it
 * out from under the user while a CLI agent is streaming — all verified at our exact
 * xterm 5.5.0: the child TUI toggling DECSET mouse-tracking (`SelectionService.disable()`
 * → `clearSelection()`), any mouse report under DECSET 1003 (the `onUserInput` listener),
 * alt-screen entry/exit, and scrollback trim. So `getSelection()` at Ctrl+C time is often
 * empty even though the user just dragged a highlight — and worse, our keymap then falls
 * through to xterm's default Ctrl+C, SIGINT-ing the running agent.
 *
 * The fix (VS Code's pattern — copy state is captured at `onSelectionChange` time): cache
 * the selection TEXT the moment it exists, and let the copy paths fall back to the cache
 * when the live read comes up empty. The cache is invalidated by the gestures that signal
 * "I no longer mean that selection":
 *  - a fresh left-button mousedown in the well (plain click deselects; a new drag will
 *    re-cache on its own onSelectionChange),
 *  - the user TYPING into the PTY (interacting with the agent again — a later Ctrl+C
 *    almost certainly means interrupt, not copy),
 *  - a successful copy (one-shot: the next Ctrl+C is SIGINT again, matching today's
 *    copy-then-clear behavior),
 *  - the TTL below (backstop for clears we can't attribute to a user gesture).
 *
 * Pure data + functions over a caller-owned mutable cell so the policy is unit-testable
 * without xterm; useTerminalSpawn owns one cell per terminal via a ref.
 */

export interface SelectionSnapshot {
  text: string
  /** performance.now() timestamp of the caching onSelectionChange; 0 = empty. */
  at: number
}

/**
 * How long a cached selection stays copyable after the highlight itself was wiped.
 * Long enough to cover the real gesture gap (drag → agent redraw wipes it → user reaches
 * for Ctrl+C, seconds not milliseconds); short enough that a selection the user abandoned
 * without any invalidating gesture doesn't shadow SIGINT minutes later.
 */
export const SELECTION_SNAPSHOT_TTL_MS = 15_000

export function emptySnapshot(): SelectionSnapshot {
  return { text: '', at: 0 }
}

/** Cache `text` (ignore empty — clears are handled by the invalidation gestures, not here). */
export function cacheSnapshot(cell: SelectionSnapshot, text: string, now: number): void {
  if (!text) return
  cell.text = text
  cell.at = now
}

/** The cached text, or '' when nothing is cached or the TTL has lapsed. Non-consuming. */
export function readSnapshot(cell: SelectionSnapshot, now: number): string {
  if (!cell.text || now - cell.at > SELECTION_SNAPSHOT_TTL_MS) return ''
  return cell.text
}

/** Drop the cache (invalidation gestures + the one-shot consume after a copy). */
export function clearSnapshot(cell: SelectionSnapshot): void {
  cell.text = ''
  cell.at = 0
}
