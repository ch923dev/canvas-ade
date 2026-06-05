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
