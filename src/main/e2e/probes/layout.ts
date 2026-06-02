/**
 * Layout-preset probes (deterministic store paths — immune to the capturePage flake):
 * Smart tidy repacks into a tighter, non-overlapping, type-grouped block; Tile resizes
 * boards to fill an area's zones edge-to-edge.
 */
import type { E2EProbe } from '../types'

// ── Auto-tidy (Smart preset): repack the scattered boards into a clean, non-overlapping
// block. After Smart tidy the boards must (a) keep their count, (b) NOT overlap, (c)
// occupy a TIGHTER horizontal span than the spread, and (d) GROUP by type — all browser
// boards on a single row (same y), proving the link/type-aware grouping runs. ──
export const tidy: E2EProbe = {
  name: 'tidy',
  async run(ctx) {
    const tidyProbe = await ctx.evalIn<{
      before: number
      after: number
      overlap: boolean
      count: number
      browserRows: number
    }>(
      `(() => {
         const rect = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });
         const span = (bs) => Math.max(...bs.map((b) => b.x + b.w)) - Math.min(...bs.map((b) => b.x));
         const overlapAny = (bs) => {
           for (let i = 0; i < bs.length; i++)
             for (let j = i + 1; j < bs.length; j++) {
               const a = bs[i], c = bs[j];
               if (a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) return true;
             }
           return false;
         };
         const pre = window.__canvasE2E.getBoards().map(rect);
         window.__canvasE2E.tidy('smart');
         const after = window.__canvasE2E.getBoards();
         const post = after.map(rect);
         const browserYs = new Set(after.filter((b) => b.type === 'browser').map((b) => Math.round(b.y)));
         return { before: span(pre), after: span(post), overlap: overlapAny(post), count: post.length, browserRows: browserYs.size };
       })()`
    )
    const tidyOk =
      tidyProbe.count >= 2 &&
      !tidyProbe.overlap &&
      tidyProbe.after < tidyProbe.before &&
      tidyProbe.browserRows === 1
    return {
      name: 'tidy',
      ok: tidyOk,
      detail: tidyOk
        ? `smart packed: span ${Math.round(tidyProbe.before)}→${Math.round(tidyProbe.after)}px, browsers grouped on 1 row, no overlaps`
        : JSON.stringify(tidyProbe)
    }
  }
}

// ── Tile (resize-to-fill preset): the window-manager templates RESIZE boards to fill an
// area's zones. Tile into a fixed 1600×1000 area with cols-2 and assert the union of the
// boards fills that area edge-to-edge (each axis within tolerance) AND no overlaps. ──
export const tile: E2EProbe = {
  name: 'tile',
  async run(ctx) {
    const tileProbe = await ctx.evalIn<{
      fills: boolean
      overlap: boolean
      resized: boolean
      count: number
    }>(
      `(() => {
         const area = { x: 0, y: 0, w: 1600, h: 1000 };
         const before = window.__canvasE2E.getBoards().map((b) => b.w + 'x' + b.h).join(',');
         window.__canvasE2E.tile('cols-2', area);
         const bs = window.__canvasE2E.getBoards();
         const r = bs.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
         const minX = Math.min(...r.map((b) => b.x)), minY = Math.min(...r.map((b) => b.y));
         const maxX = Math.max(...r.map((b) => b.x + b.w)), maxY = Math.max(...r.map((b) => b.y + b.h));
         let overlap = false;
         for (let i = 0; i < r.length; i++)
           for (let j = i + 1; j < r.length; j++) {
             const a = r[i], c = r[j];
             if (a.x < c.x + c.w - 0.5 && c.x < a.x + a.w - 0.5 && a.y < c.y + c.h - 0.5 && c.y < a.y + a.h - 0.5) overlap = true;
           }
         const fills = Math.abs(minX) < 1 && Math.abs(minY) < 1 && Math.abs(maxX - 1600) < 2 && Math.abs(maxY - 1000) < 2;
         return { fills, overlap, resized: bs.map((b) => b.w + 'x' + b.h).join(',') !== before, count: bs.length };
       })()`
    )
    const tileOk =
      tileProbe.count >= 2 && tileProbe.fills && !tileProbe.overlap && tileProbe.resized
    return {
      name: 'tile',
      ok: tileOk,
      detail: tileOk
        ? 'cols-2 tiling resized boards to fill the 1600×1000 area, no overlaps'
        : JSON.stringify(tileProbe)
    }
  }
}
