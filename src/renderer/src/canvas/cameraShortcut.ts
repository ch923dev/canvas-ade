/**
 * Pure guard for the bare 1/0 camera shortcuts.
 *
 * A bare 1/0 keydown may only trigger a fit/reset when the user is not typing
 * AND the key event did not originate inside a board node.  Extracted so both
 * Canvas.tsx and the unit-test suite import the same implementation.
 */

/**
 * Returns true when the 1/0 camera shortcut is allowed to fire.
 *
 * @param target  The event target (e.target cast to HTMLElement | null).
 * @param typing  True when the target is an INPUT, TEXTAREA, or contenteditable.
 */
export function shouldFireCameraShortcut(target: HTMLElement | null, typing: boolean): boolean {
  return !typing && !target?.closest('.react-flow__node')
}

/**
 * Returns true when the board-nav keys (Tab cycle · arrow move/resize · Enter focus,
 * D4-B) are allowed to fire. Stricter than the bare-key guard: a WHITELIST — the keys
 * act only when nothing else owns focus (body / document root / the React Flow pane
 * surface). That structurally excludes every focus trap at once: a focused xterm
 * (helper textarea), the planning well (D3-C owns element-level arrows there),
 * INPUT/TEXTAREA/contenteditable, Modal/Menu focus traps (D1-B/C own Tab there), and
 * app-chrome or in-board buttons (native Tab order keeps working between them).
 * Our own Tab handler preventDefaults, so focus stays on body and the model
 * self-sustains.
 */
export function shouldFireBoardNavKey(target: HTMLElement | null, typing: boolean): boolean {
  if (typing) return false
  if (!target || target === document.body || target === document.documentElement) return true
  return target.matches('.react-flow, .react-flow__pane')
}
