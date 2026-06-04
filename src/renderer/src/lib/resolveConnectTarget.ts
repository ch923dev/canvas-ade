/**
 * Resolve the drop target of a connector drag from STORE GEOMETRY (M2 T2.2) — pure,
 * DOM-free, so it's unit-testable AND sidesteps the synthetic-event CSS-transform
 * hit-test problem the e2e harness hits (memory `e2e-sendinputevent-vs-dispatchevent`).
 *
 * Given the boards, the source board id, and a point in FLOW (world) coordinates
 * (`rf.screenToFlowPosition(pointer)`), return the id of the board the point lands on —
 * never the source (no self-link), null over empty canvas. When rects overlap, the
 * TOPMOST board wins: higher `z` first, ties broken by later array order (= rendered on
 * top), mirroring how the canvas stacks boards.
 */
import type { Board } from './boardSchema'

export function resolveConnectTarget(
  boards: Board[],
  fromId: string,
  flowPoint: { x: number; y: number }
): string | null {
  let best: Board | null = null
  let bestIndex = -1
  boards.forEach((b, i) => {
    if (b.id === fromId) return
    const inside =
      flowPoint.x >= b.x &&
      flowPoint.x <= b.x + b.w &&
      flowPoint.y >= b.y &&
      flowPoint.y <= b.y + b.h
    if (!inside) return
    // Topmost wins: higher z, then later array index on a tie.
    if (
      best === null ||
      (b.z ?? 0) > (best.z ?? 0) ||
      ((b.z ?? 0) === (best.z ?? 0) && i > bestIndex)
    ) {
      best = b
      bestIndex = i
    }
  })
  return best ? (best as Board).id : null
}
