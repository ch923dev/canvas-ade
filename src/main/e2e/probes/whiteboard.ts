/**
 * Whiteboard (Planning) native/real-instance SLIVERS (post-T3 push-down). The W1/W2/W3
 * interaction probes (erase/shortcut/marquee/multidrag/shift-add/snap/alt-dup/lock/group/
 * align) and the paste-reload/dedup/gc + svg/image-embed parts all migrated DOWN to Vitest
 * (PlanningBoard.interaction.test.tsx, projectStore.test.ts, whiteboardExport.test.ts) and
 * were deleted. What stays here needs a REAL instance: full-view add-note through the live
 * camera transform, a real Ctrl+V clipboard paste, and PNG raster.
 *
 * Order-bound: these read `ctx.ids.planId`. The `planning` probe that used to seed it was
 * migrated + deleted in T3, so the first consumer (`fullviewPreview`, then this file's
 * `whiteboardFullviewAdd`) seeds it via a `??` guard. They mutate only the planning board's
 * `elements`, never the board COUNT the final `seed` probe asserts.
 */
import { clipboard, nativeImage } from 'electron'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject, setCurrentDir } from '../../projectStore'
import type { E2EProbe, E2EPart } from '../types'

// ── Planning camera-full-view add-note (Option A regression guard). The bug this locks:
// full-view used to portal the board + apply a 2nd CSS transform, so a click mapped to a
// board-local point FAR outside board bounds (e.g. x=1469 on a 520-wide board) → the note
// was clipped/lost. Now full view is a CAMERA fit (one transform), so a click lands in
// bounds under the cursor. MUST use REAL OS input (win.webContents.sendInputEvent) — a
// synthetic dispatchEvent bypasses the transform hit-testing and false-greens this exact
// bug (memory e2e-sendinputevent-vs-dispatchevent).
export const whiteboardFullviewAdd: E2EProbe = {
  name: 'whiteboard-fullview-add',
  async run(ctx): Promise<E2EPart> {
    // The planning board used to be seeded by the `planning` probe, which T3 migrated to
    // Vitest (canvasStore.test.ts) and deleted. As the FIRST surviving whiteboard sliver,
    // this probe now seeds it (if absent) and publishes ctx.ids.planId so the W4 paste and
    // W5 export slivers that run after it in the PLAYLIST still find a planning board.
    const planId =
      ctx.ids.planId ??
      (ctx.ids.planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')"))

    // Deterministic board: known size + two notes (non-empty → not the empty-board path).
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 500, elements: [
         { id: 'fv-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'fv-b', kind: 'note', x: 300, y: 320, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] })`
    )
    // Let React Flow apply the new 520x500 node size before fitting the camera to it.
    await ctx.delay(180)
    // Enter camera full view (Option A) — the real path under test (sets the camera-
    // full-view MODE + does the animated fit).
    await ctx.evalIn(`window.__canvasE2E.enterCameraFullView(${JSON.stringify(planId)})`)
    // Poll until the board is fitted ON-SCREEN (so a real click at its centre lands).
    // GATE ON RENDER-PRESENCE, NOT A ZOOM THRESHOLD: a smaller CI window fits a 520x500
    // board at zoom ~1.0 (height-constrained), so the old `scale > 1.3` gate could never
    // pass on the GitHub runner even though the board was fully visible + clickable (the
    // deterministic CI flake — passes locally where the window is larger). Memory
    // e2e-modifier-keys-synthetic ("gate fit-polls on render-presence, not >1.0") +
    // e2e-rf-measurement-race. Re-fit instantly each tick too, in case RF measured the
    // freshly-resized node lazily and the single animated fit no-opped.
    const fitted = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `(() => {
             const id = ${JSON.stringify(planId)};
             window.__canvasE2E.fitCameraInstant(id);
             const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
             const well = node && node.querySelector('.pl-well');
             if (!well || !(well.offsetWidth > 0)) return false;
             const r = well.getBoundingClientRect();
             const scale = r.width / well.offsetWidth;
             // Fitted = the whole well sits within the window (2px tolerance for
             // sub-pixel rounding) so its centre is clickable. The pl-well node only
             // exists above LOD, so its presence already rules out an LOD-collapsed
             // card; the loose scale floor just rejects a mid-transition tiny frame
             // (a small CI pane fits 520x500 at ~0.9, so keep it well under 1.0).
             return (
               scale > 0.4 &&
               r.left >= -2 &&
               r.top >= -2 &&
               r.right <= window.innerWidth + 2 &&
               r.bottom <= window.innerHeight + 2
             );
           })()`
        ),
      4000
    )
    if (!fitted) {
      await ctx.evalIn(`window.__canvasE2E.exitCameraFullView()`)
      return {
        name: 'whiteboard-fullview-add',
        ok: false,
        detail: 'camera did not fit the board on-screen in full view'
      }
    }
    await ctx.delay(60) // settle the final fitted frame before reading the rect

    // Compute the well's on-screen rect → the screen point for board-local (260, 250).
    const t = await ctx.evalIn<{
      found: boolean
      sx: number
      sy: number
      scale: number
      bx: number
      by: number
    }>(
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well) return { found: false, sx: 0, sy: 0, scale: 0, bx: 0, by: 0 };
         const r = well.getBoundingClientRect();
         const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
         const bx = 260, by = 250;                    // board-local target (~center of 520x500)
         return { found: true, sx: r.left + bx * scale, sy: r.top + by * scale, scale, bx, by };
       })()`
    )
    if (!t.found) {
      await ctx.evalIn(`window.__canvasE2E.exitCameraFullView()`)
      return { name: 'whiteboard-fullview-add', ok: false, detail: 'no .pl-well in full view' }
    }

    // Select the note tool — synthetic key is fine (no coordinate mapping involved).
    await ctx.evalIn(
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (well) { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); }
       })()`
    )
    await ctx.delay(60)

    // REAL OS click — exercises toBoard under the live camera transform.
    const x = Math.round(t.sx)
    const y = Math.round(t.sy)
    ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await ctx.delay(140)

    // Read the freshly added note (the non-seed note) + board size.
    const res = await ctx.evalIn<{
      count: number
      nx: number
      ny: number
      nw: number
      bw: number
      bh: number
    }>(
      `(() => {
         const id = ${JSON.stringify(planId)};
         const b = window.__canvasE2E.getBoards().find((x) => x.id === id);
         const els = b && b.type === 'planning' ? b.elements : [];
         const added = els.filter((e) => e.kind === 'note' && e.id !== 'fv-a' && e.id !== 'fv-b').pop();
         return {
           count: els.length,
           nx: added ? added.x : -999999,
           ny: added ? added.y : -999999,
           nw: added ? added.w : 0,
           bw: b ? b.w : 0,
           bh: b ? b.h : 0
         };
       })()`
    )
    // Restore the viewport so later probes aren't disturbed.
    await ctx.evalIn(`window.__canvasE2E.exitCameraFullView()`)
    await ctx.delay(60)

    // makeNote centers x on the click and offsets y by 20 → reconstruct the click point.
    const clickX = res.nx + res.nw / 2
    const clickY = res.ny + 20
    const inBounds = res.nx >= 0 && res.nx <= res.bw && res.ny >= 0 && res.ny <= res.bh
    const nearClick = Math.abs(clickX - t.bx) <= 10 && Math.abs(clickY - t.by) <= 10
    const ok = res.count === 3 && inBounds && nearClick
    return {
      name: 'whiteboard-fullview-add',
      ok,
      detail: ok
        ? `real click lands in-bounds at board-local ~(${Math.round(clickX)},${Math.round(clickY)}) on ${res.bw}x${res.bh}`
        : JSON.stringify({ ...res, target: { bx: t.bx, by: t.by, scale: t.scale } })
    }
  }
}

// ── W4 image paste (SLIVER, T3): real clipboard paste persists a blob to assets/<sha1>
// and stores a RELATIVE path (not base64). This is the irreducible native bit — a REAL
// Ctrl+V keystroke via webContents.sendInputEvent (the same path a user hits), which a
// synthetic ClipboardEvent can't reproduce (it can't carry a file image item, and
// webContents.paste() is a no-op on the non-editable well). The reload / dedup / GC
// behaviors moved DOWN to projectStore.test.ts (round-trip / dedup / gc) — T3 push-down.
// MAIN-side: mints a temp project (e2e has no project dir), puts an image on the system
// clipboard, focuses the well, drives the keystroke. Memory e2e-sendinputevent-vs-dispatchevent.
export const whiteboardPasteImage: E2EProbe = {
  name: 'whiteboard-paste-image',
  async run(ctx): Promise<E2EPart[]> {
    const planId = ctx.ids.planId
    if (!planId) return [{ name: 'whiteboard-paste-image', ok: false, detail: 'planId not seeded' }]

    const tmp = mkdtempSync(join(tmpdir(), 'canvas-w4-'))
    const id = JSON.stringify(planId)
    const imageCount = async (): Promise<number> =>
      ctx.evalIn<number>(
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${id});
                  return b && b.type === 'planning' ? b.elements.filter(e => e.kind === 'image').length : -1; })()`
      )
    const firstAssetId = async (): Promise<string | null> =>
      ctx.evalIn<string | null>(
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${id});
                  const img = (b && b.type === 'planning' ? b.elements : []).find(e => e.kind === 'image');
                  return img ? img.assetId : null; })()`
      )
    // Focus the REAL well (the user surface) so a Ctrl+V keystroke targets the same
    // element a user pastes onto. The well is tabIndex=0 → focusable.
    const focusWell = async (): Promise<void> => {
      await ctx.evalIn(
        `(() => { const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(
          id
        )} + ']'); const w = n && n.querySelector('.pl-well'); if (w) w.focus(); })()`
      )
    }
    // Drive a REAL Ctrl+V keystroke (OS input). Chromium dispatches the `paste` DOM event
    // to the focused well even though it is not editable; React's onPaste catches the
    // bubbled event — the exact path a real user hits. (webContents.paste() is NOT used:
    // it invokes the Paste *editing command*, a no-op on a non-editable element, so it
    // never fires a paste event there — the trap the earlier proxy contingency hit.)
    const pasteKey = (): void => {
      const wc = ctx.win.webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'char', keyCode: 'V', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] })
    }
    const parts: E2EPart[] = []
    try {
      await createProject(tmp, 'w4', {})
      setCurrentDir(tmp)
      await ctx.evalIn(`window.__canvasE2E.patchBoard(${id}, { elements: [] })`)
      await ctx.delay(80)

      // (1) PASTE — put a 10×10 opaque-red bitmap on the system clipboard, focus the well,
      // and drive a real Ctrl+V. createFromBitmap takes raw RGBA (4 bytes/pixel, no encoding).
      const width = 10
      const height = 10
      const bitmapBuf = Buffer.alloc(width * height * 4)
      for (let i = 0; i < width * height; i++) {
        bitmapBuf[i * 4] = 255 // R
        bitmapBuf[i * 4 + 1] = 0 // G
        bitmapBuf[i * 4 + 2] = 0 // B
        bitmapBuf[i * 4 + 3] = 255 // A
      }
      const ni = nativeImage.createFromBitmap(bitmapBuf, { width, height })
      clipboard.clear()
      clipboard.writeImage(ni)
      await focusWell()
      await ctx.delay(40)
      pasteKey()
      const pasted = await ctx.poll(async () => (await imageCount()) === 1, 4000)
      const assetId = await firstAssetId()
      const relOk =
        !!assetId && /^assets[/\\][0-9a-f]{40}\.png$/.test(assetId) && !assetId.startsWith('data:')
      const fileOk = !!assetId && existsSync(join(tmp, assetId))
      parts.push({
        name: 'whiteboard-paste-image',
        ok: pasted && relOk && fileOk,
        detail:
          pasted && relOk && fileOk
            ? `paste wrote ${assetId} (relative path, blob on disk)`
            : JSON.stringify({ pasted, assetId, relOk, fileOk })
      })
    } catch (err) {
      parts.push({
        name: 'whiteboard-paste-image',
        ok: false,
        detail: 'ERR: ' + String((err as Error)?.message ?? err)
      })
    } finally {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    }
    return parts
  }
}

// ── W5 export (SLIVER, T3): raster the PNG artifact through the renderer BUILD pipeline
// (buildExport → offscreen-canvas raster), WITHOUT the native save dialog. PNG raster is
// the irreducible native bit — the pure SVG build, image-embed, and missing-asset fallback
// moved DOWN to whiteboardExport.test.ts (T3 push-down). Seeds note+stroke+checklist so the
// raster has content, then asserts the PNG byte stream is non-trivial.
export const whiteboardExport: E2EProbe = {
  name: 'whiteboard-export',
  async run(ctx): Promise<E2EPart[]> {
    const planId = ctx.ids.planId
    if (!planId) return [{ name: 'whiteboard-export', ok: false, detail: 'planId not seeded' }]
    const id = JSON.stringify(planId)
    const parts: E2EPart[] = []
    const tmp = mkdtempSync(join(tmpdir(), 'canvas-w5-'))
    try {
      await createProject(tmp, 'w5', {})
      setCurrentDir(tmp)

      // Seed note + stroke + checklist so the SVG has several element nodes.
      await ctx.evalIn(
        `window.__canvasE2E.patchBoard(${id}, { elements: [
          { id: 'ex-note', kind: 'note', x: 20, y: 20, w: 156, h: 96, tint: 'blue', text: 'export me', rotation: 0 },
          { id: 'ex-stroke', kind: 'stroke', x: 0, y: 0, points: [40,200,80,240,120,210] },
          { id: 'ex-check', kind: 'checklist', x: 220, y: 20, w: 240, h: 0, title: 'T', items: [{ id:'a', label:'one', done:true }, { id:'b', label:'two', done:false }] }
        ] })`
      )
      await ctx.delay(120)

      const pngOut = await ctx.evalIn<{ byteLength: number } | null>(
        `window.__canvasE2E.exportBoard(${id}, 'png')`
      )
      const pngOk = !!pngOut && pngOut.byteLength > 200
      parts.push({
        name: 'whiteboard-export-png',
        ok: pngOk,
        detail: pngOk ? `png ${pngOut!.byteLength}B` : `bad png: ${JSON.stringify(pngOut)}`
      })
    } finally {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    return parts
  }
}
