/**
 * Phase 5 · S4 — jump-to-bottom badge: pure, side-effect-free helpers.
 *
 * The live scroll subscription lives in TerminalJumpButton (it reads xterm's buffer in
 * onScroll/onWriteParsed callbacks). These are the decisions it makes, isolated here so
 * they're unit-testable without a real Terminal.
 *
 * xterm buffer geometry: `viewportY` is the buffer line at the TOP of the viewport;
 * `baseY` is that same line when scrolled fully to the tail (the max viewportY). So the
 * user is reading above the live tail iff `viewportY < baseY`, and the number of lines
 * appended below the fold since an anchor tail position is `baseY - anchorY`.
 */

/** True when the viewport's top line sits above the live tail (i.e. scrolled up). */
export function isScrolledUp(viewportY: number, baseY: number): boolean {
  return viewportY < baseY
}

/** Lines appended to the buffer since the anchored tail position, floored at zero. */
export function unreadSince(baseY: number, anchorY: number): number {
  return Math.max(0, baseY - anchorY)
}

/** Compact unread-chip label: empty for ≤0, plain under the cap, `<cap>+` above it. */
export function formatUnread(n: number, cap = 99): string {
  if (n <= 0) return ''
  return n > cap ? `${cap}+` : String(n)
}
