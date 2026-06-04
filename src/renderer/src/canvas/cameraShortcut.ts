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
