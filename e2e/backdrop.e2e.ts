import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Canvas backdrop probes (docs/canvas-backdrop/spec.md section 7, S4):
 *  1. persist-reload — a scene backdrop survives the REAL save IPC + a disk reopen of
 *     a fresh temp project (no persistent-userData pollution; teardown in finally).
 *  2. input passthrough — with a backdrop active, a real OS drag (sendInputEvent, not
 *     synthetic dispatch) still reaches board content THROUGH the layer and moves it
 *     (pointer-events: none + below-React-Flow z-order). NOTE: an XYFlow node drag
 *     (d3-drag) does not engage from any e2e input seam (see groups.e2e.ts), so the
 *     gesture under test is the proven whiteboard arrow-endpoint drag — real input
 *     onto canvas content that a mis-stacked backdrop WOULD intercept.
 *  3. missing asset — a file backdrop whose asset is gone shows the keyed toast and
 *     reverts the stored kind to 'none' (never a silent black hole).
 *  4. reduced-motion freeze (S7, PR 2) — the registered blossom-river scene animates
 *     under normal motion (two strided pixel-hashes differ) and freezes to ONE
 *     pixel-stable still when prefers-reduced-motion flips live via emulateMedia.
 *
 * Registry state: since PR 2 `blossom-river` is REGISTERED (probes 1 and 4 ride the
 * real scene canvas); the passthrough probe's `probe-scene` id stays deliberately
 * UNKNOWN to keep the PR-1 forward-compat path pinned (id preserved verbatim through
 * save/load, layer renders the dim veil only).
 */
test.describe('@chrome canvas backdrop (S4)', () => {
  test('persist-reload: a scene backdrop survives save -> reopen from disk', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'backdrop-persist-',
      'backdrop-persist'
    )
    try {
      // Open the real temp project so the store carries a project dir (save target).
      const opened = await evalIn<{ status: string }>(
        page,
        `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
      )
      expect(opened.status, 'fresh temp project opens clean').toBe('open')

      // Set a scene backdrop through the real store action (the picker's path).
      await evalIn(
        page,
        `window.__canvasE2E.setBackground({ kind: 'scene', scene: 'blossom-river', dim: 0.4, saturation: 0.9, gridDots: false })`
      )
      expect(
        await pollEval(page, `!!document.querySelector('[data-test="backdrop-layer"]')`, 2000),
        'backdrop layer mounted once a scene is active'
      ).toBe(true)

      // Flush through the REAL save IPC (the autosave path's own call — deterministic,
      // no 1s-debounce wait). expectedDir guards against racing a project switch.
      const saved = await evalIn<boolean>(
        page,
        `window.api.project.save(JSON.parse(window.__canvasE2E.serializeDoc()), ${JSON.stringify(tmp)})`
      )
      expect(saved, 'project:save accepted the doc').toBe(true)

      // Wipe the live store so the backdrop can ONLY come back from disk.
      await evalIn(page, 'window.__canvasE2E.reset()')
      expect(await evalIn(page, 'window.__canvasE2E.getBackground()')).toBeNull()
      expect(
        await evalIn<boolean>(
          page,
          `document.querySelector('[data-test="backdrop-layer"]') === null`
        ),
        'layer unmounts on reset'
      ).toBe(true)

      // Reopen from disk -> the backdrop settings round-trip (scene id verbatim).
      const reopened = await evalIn<{ status: string }>(
        page,
        `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
      )
      expect(reopened.status, 'reopen succeeds').toBe('open')
      const bg = await evalIn<{
        kind: string
        scene?: string
        dim: number
        saturation: number
      } | null>(page, 'window.__canvasE2E.getBackground()')
      expect(bg, 'background restored from canvas.json').not.toBeNull()
      expect(bg).toMatchObject({ kind: 'scene', scene: 'blossom-river', dim: 0.4, saturation: 0.9 })
      expect(
        await pollEval(page, `!!document.querySelector('[data-test="backdrop-layer"]')`, 4000),
        'backdrop layer re-mounted after the reload'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('input passthrough: a real OS drag moves board content under an active backdrop', async ({
    page,
    electronApp
  }) => {
    // Seed a planning board with one arrow, then activate a backdrop OVER the whole pane.
    const planId = await seed(page, 'planning')
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 500, elements: [
      { id: 'bd-a', kind: 'arrow', x: 80, y: 320, x2: 300, y2: 120 }
    ] })`
    )
    await evalIn(
      page,
      `window.__canvasE2E.setBackground({ kind: 'scene', scene: 'probe-scene', dim: 0.25, saturation: 0.7, gridDots: false })`
    )
    expect(
      await pollEval(page, `!!document.querySelector('[data-test="backdrop-layer"]')`, 2000),
      'backdrop layer active before the gesture'
    ).toBe(true)
    await page.waitForTimeout(180)

    // Camera-fit the board on-screen (the proven whiteboard.e2e.ts dance).
    await evalIn(page, `window.__canvasE2E.enterCameraFullView(${JSON.stringify(planId)})`)
    const fitted = await pollEval(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         window.__canvasE2E.fitCameraInstant(id);
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well || !(well.offsetWidth > 0)) return false;
         const r = well.getBoundingClientRect();
         const scale = r.width / well.offsetWidth;
         return scale > 0.4 && r.left >= -2 && r.top >= -2 && r.right <= window.innerWidth + 2 && r.bottom <= window.innerHeight + 2;
       })()`,
      4000
    )
    expect(fitted, 'camera fit the board on-screen').toBe(true)
    await page.waitForTimeout(60)

    // Hit-test proof: the topmost element at the board's center is canvas content,
    // never the backdrop (pointer-events: none + below-RF stacking).
    const hit = await evalIn<{ inBackdrop: boolean; inFlow: boolean }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const r = node.getBoundingClientRect();
         const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
         return {
           inBackdrop: !!(el && el.closest('[data-test="backdrop-layer"]')),
           inFlow: !!(el && el.closest('.react-flow'))
         };
       })()`
    )
    expect(hit.inBackdrop, 'backdrop never wins the hit-test').toBe(false)
    expect(hit.inFlow, 'the canvas is what the pointer reaches').toBe(true)

    // Select the arrow (selection is not the surface under test) so its endpoint
    // handle renders; setPointerCapture throws on a synthetic pointer (harmless).
    const selected = await evalIn<boolean>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         const path = well && well.querySelector('svg > path');
         if (!well || !path) return false;
         try {
           path.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
         } catch {}
         try {
           well.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
         } catch {}
         return true;
       })()`
    )
    expect(selected, 'arrow path press dispatched').toBe(true)
    expect(
      await pollEval(page, `!!document.querySelector('[data-arrow-endpoint="end"]')`, 2000),
      'endpoint handle rendered'
    ).toBe(true)

    const t = await evalIn<{
      found: boolean
      hx: number
      hy: number
      tx: number
      ty: number
      bx: number
      by: number
    }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         const h = document.querySelector('[data-arrow-endpoint="end"]');
         if (!well || !h) return { found: false, hx: 0, hy: 0, tx: 0, ty: 0, bx: 0, by: 0 };
         const hr = h.getBoundingClientRect();
         const r = well.getBoundingClientRect();
         const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
         const bx = 200, by = 400; // board-local drop target, inside the 520x500 well
         return { found: true, hx: hr.left + hr.width / 2, hy: hr.top + hr.height / 2,
                  tx: r.left + bx * scale, ty: r.top + by * scale, bx, by };
       })()`
    )
    expect(t.found, 'handle + well located').toBe(true)

    // The REAL OS drag (MAIN sendInputEvent): down on the handle, move, up at target.
    const hx = Math.round(t.hx)
    const hy = Math.round(t.hy)
    const tx = Math.round(t.tx)
    const ty = Math.round(t.ty)
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: hx,
      y: hy,
      button: 'left',
      clickCount: 1
    })
    const mx = Math.round((hx + tx) / 2)
    const my = Math.round((hy + ty) / 2)
    await mainCall(electronApp, 'sendInput', { type: 'mouseMove', x: mx, y: my, button: 'left' })
    await page.waitForTimeout(40)
    await mainCall(electronApp, 'sendInput', { type: 'mouseMove', x: tx, y: ty, button: 'left' })
    await page.waitForTimeout(40)
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: tx,
      y: ty,
      button: 'left',
      clickCount: 1
    })
    await page.waitForTimeout(140)

    // The drag landed: the arrow head moved to the drop target (read via getBoards()).
    const res = await evalIn<{ x2: number; y2: number } | null>(
      page,
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)});
         const a = (b && b.type === 'planning' ? b.elements : []).find((e) => e.id === 'bd-a');
         return a ? { x2: a.x2, y2: a.y2 } : null;
       })()`
    )
    await evalIn(page, 'window.__canvasE2E.exitCameraFullView()')
    expect(res, 'arrow still in the store').not.toBeNull()
    expect(Math.abs(res!.x2 - t.bx), 'head x2 moved to the drop target').toBeLessThanOrEqual(8)
    expect(Math.abs(res!.y2 - t.by), 'head y2 moved to the drop target').toBeLessThanOrEqual(8)
  })

  test('reduced-motion: the scene freezes to one pixel-stable still (S7)', async ({ page }) => {
    // Pin the starting preference — the counter-control below needs motion allowed.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await evalIn(
      page,
      `window.__canvasE2E.setBackground({ kind: 'scene', scene: 'blossom-river', dim: 0.25, saturation: 0.7, gridDots: false })`
    )
    // The real scene canvas mounts (known-scene path, not the dim-veil fallback).
    expect(
      await pollEval(page, `!!document.querySelector('canvas[data-test="backdrop-scene"]')`, 2000),
      'scene canvas mounted'
    ).toBe(true)

    // Strided pixel hash computed in-page (no MB-sized dataURLs over the wire). The
    // stride (97) is coprime with the RGBA stride so samples rotate channels.
    const HASH = `(() => {
      const c = document.querySelector('canvas[data-test="backdrop-scene"]');
      if (!c || c.width === 0) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0;
      return h;
    })()`
    expect(await pollEval(page, `${HASH} !== null`, 4000), 'scene painted at least one frame').toBe(
      true
    )

    // Counter-control: with motion allowed, samples 450ms apart must differ
    // (clouds drift / shimmer / petals fall at <=30fps).
    const a1 = await evalIn<number>(page, HASH)
    await page.waitForTimeout(450)
    const a2 = await evalIn<number>(page, HASH)
    expect(a1 === a2, 'scene animates while motion is allowed').toBe(false)

    // Flip the OS preference LIVE (matchMedia change listener -> the layer recreates
    // the handle with reducedMotion baked in -> exactly one renderStill).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForTimeout(300)
    const s1 = await evalIn<number | null>(page, HASH)
    await page.waitForTimeout(450)
    const s2 = await evalIn<number | null>(page, HASH)
    expect(s1, 'still painted under reduced motion').not.toBeNull()
    expect(s1 === s2, 'pixel-stable under reduced motion (one static frame)').toBe(true)

    // Restore for any sibling probes.
    await page.emulateMedia({ reducedMotion: null })
    await evalIn(page, `window.__canvasE2E.setBackground({ kind: 'none' })`)
  })

  test('missing wallpaper asset: keyed toast + revert to none', async ({ page, electronApp }) => {
    // A real project dir so asset:read genuinely probes the disk (and finds nothing).
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'backdrop-missing-',
      'backdrop-missing'
    )
    try {
      await evalIn(
        page,
        `window.__canvasE2E.setBackground({ kind: 'file', assetId: 'assets/does-not-exist.png', dim: 0.25, saturation: 0.7, gridDots: false })`
      )
      // The keyed missing-asset toast surfaces in the island...
      expect(
        await pollEval(
          page,
          `(() => { const el = document.querySelector('[data-test="toast-island"]'); return !!el && /Backdrop file missing/.test(el.textContent || '') })()`,
          4000
        ),
        'missing-asset toast shown'
      ).toBe(true)
      // ...and the stored kind reverted to 'none' (the layer unmounts with it).
      expect(
        await pollEval(page, `(window.__canvasE2E.getBackground() || {}).kind === 'none'`, 2000),
        'background reverted to none'
      ).toBe(true)
      expect(
        await evalIn<boolean>(
          page,
          `document.querySelector('[data-test="backdrop-layer"]') === null`
        ),
        'layer gone after the revert'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
