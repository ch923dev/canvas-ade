/**
 * Eraser hit-testing for the Planning whiteboard — now a thin re-export of the unified
 * element-geometry rail (S3). The per-kind hit-test logic (`eraseHitTest` + its `inRect` /
 * bezier / polyline primitives, plus `ERASE_TOL` / `TEXT_HIT` / `HitPoint`) moved into
 * `./elementRegistry`, co-located with `elementBBox` so a card-layout change updates BOTH in
 * one place (the R4 drift class). This file preserves the `./erase` import path for its
 * existing consumers (`usePlanningPointer`, `erase.test.ts`).
 *
 * Atomic only: a hit removes the WHOLE element — partial stroke/arrow erasing
 * (Excalidraw #4904) is out of scope.
 */
export { eraseHitTest, ERASE_TOL, TEXT_HIT, type HitPoint } from './elementRegistry'
