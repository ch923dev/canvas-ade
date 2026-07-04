/**
 * PTY dimension bounds — the resize-clamp helpers shared by the spawn-time and adopt-time
 * MessagePort listeners in `pty.ts`. Extracted (2026-07-04, max-lines doctrine) so pty.ts keeps
 * its headroom under the 700 global cap; pure + runtime-free, unit-tested in `pty.test.ts`.
 */

/**
 * Validate terminal resize dimensions before forwarding to ConPTY. Both cols
 * and rows must be positive integers in the range [1, 1000]. This guards both
 * MessagePort listener sites (spawn-time and adopt-time) — a non-integer
 * (80.5), zero, negative, or absurd value must never reach proc.resize().
 * Exported so the unit test targets the real code path used by both listeners.
 */
export function isValidResize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols <= 1000 &&
    rows <= 1000
  )
}

/**
 * BUG-023: clamp a single spawn dimension (cols or rows) to the [1, 1000] range
 * that isValidResize enforces on the resize path. Truncates fractional values
 * before clamping so the result is always an integer in [1, 1000].
 * Exported for unit testing — both spawn-time uses call this helper.
 */
export function clampSpawnDim(value: number, fallback: number): number {
  const v = Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(1, v), 1000)
}
