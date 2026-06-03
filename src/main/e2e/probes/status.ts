/**
 * T1.6 — the on-canvas board-chrome status pill is derived from the SAME coarse bucket
 * the MCP sees (`boardStatusBucket` → `canvas://boards`), so the human-visible dot and
 * the agent's view can never disagree. The browser pill is the one T1.6 rewired (it
 * used an ad-hoc connected→green / connecting→amber mapping that diverged from the
 * bucket); it is now `bucketToPill(boardStatusBucket('browser', …))`, the exact same
 * derivation `boardBucket(id)` reports. This probe asserts the rendered browser title-
 * bar dot colour equals `bucketPillDot(boardBucket(browserId))` for its live state —
 * proving the pill tracks the bucket, not a stale per-board mapping.
 *
 * (The terminal keeps its richer lifecycle pill in TerminalBoard — spawning/awaiting/
 * spawn-failed are sub-states the coarse bucket intentionally collapses — so it is not
 * asserted for exact dot-equality here; the browser is the surface T1.6 changed.)
 */
import type { E2EProbe } from '../types'

export const boardStatusPill: E2EProbe = {
  name: 'board-status-pill',
  async run(ctx) {
    const browserId = ctx.ids.browserId!
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(220)
    const r = await ctx.evalIn<{
      domColor: string | null
      bucket: string | null
      expected: string | null
    }>(
      `(async () => {
         const sel = (s, root) => (root || document).querySelector(s);
         const E = window.__canvasE2E;
         const id = ${JSON.stringify(browserId)};
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const glyph = node && sel('.board-titlebar > span', node);
         const bucket = E.boardBucket(id);
         return { domColor: glyph ? glyph.style.color || null : null, bucket, expected: E.bucketPillDot(bucket) };
       })()`
    )
    // The rendered dot equals the bucket-derived dot for the browser's live state, and a
    // browser always has a non-null pill (never the `static` no-pill case).
    const ok = r.domColor != null && r.expected != null && r.domColor === r.expected
    return {
      name: 'board-status-pill',
      ok,
      detail: ok ? `browser pill matches bucket (${r.bucket} → ${r.domColor})` : JSON.stringify(r)
    }
  }
}
