import { useMcpPublish } from './useMcpPublish'

/**
 * R5 (audit P-1) — the MCP board-snapshot publisher, as a RENDER-NOTHING LEAF.
 *
 * `useMcpPublish` subscribes six store slices (boards, connectors, groups, running, previewById,
 * attention). A board drag mutates `boards` ~60×/s, so wherever that hook is *called* re-renders at
 * ~60 Hz. It used to be called from `App`, which meant every root child re-rendered per drag frame
 * — including `JarvisPanel`, which owns a rAF canvas painter. `paint` (React mount + first painted
 * frame) is the steepest per-board cost in the switch pipeline, 11.1 → 46.5 ms across 0 → 24 boards
 * (`docs/reviews/2026-07-25-bench/BASELINE.md` §2), which is what makes this the load-bearing fix.
 *
 * The subscription itself is NOT the bug and is deliberately left coarse: `buildBoardSnapshot`
 * forwards world-space geometry (`x/y/w/h`), so a drag genuinely changes the published payload and
 * a narrower pick would publish stale rects. The fix is purely about WHERE the re-render lands —
 * this leaf renders `null`, so its 60 Hz render is a no-op instead of a subtree.
 *
 * Mounted once from `App`. Keep it a leaf: never give it children, or the whole problem returns.
 */
export function McpPublisher(): null {
  useMcpPublish()
  return null
}
