import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

test.describe('whiteboard slivers (real OS input / native pipeline)', () => {
  test('full-view add-note: a real click lands in-bounds through the live camera transform', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 500, elements: [
      { id: 'fv-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
      { id: 'fv-b', kind: 'note', x: 300, y: 320, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
    ] })`
    )
    await page.waitForTimeout(180)
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
    const t = await evalIn<{
      found: boolean
      sx: number
      sy: number
      scale: number
      bx: number
      by: number
    }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well) return { found: false, sx: 0, sy: 0, scale: 0, bx: 0, by: 0 };
         const r = well.getBoundingClientRect();
         const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
         const bx = 260, by = 250;
         return { found: true, sx: r.left + bx * scale, sy: r.top + by * scale, scale, bx, by };
       })()`
    )
    expect(t.found).toBe(true)
    await evalIn(
      page,
      `(() => {
       const id = ${JSON.stringify(planId)};
       const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
       const well = node && node.querySelector('.pl-well');
       if (well) { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); }
     })()`
    )
    await page.waitForTimeout(60)
    const x = Math.round(t.sx),
      y = Math.round(t.sy)
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x,
      y,
      button: 'left',
      clickCount: 1
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x,
      y,
      button: 'left',
      clickCount: 1
    })
    await page.waitForTimeout(140)
    const res = await evalIn<{
      count: number
      nx: number
      ny: number
      nw: number
      bw: number
      bh: number
    }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const b = window.__canvasE2E.getBoards().find((x) => x.id === id);
         const els = b && b.type === 'planning' ? b.elements : [];
         const added = els.filter((e) => e.kind === 'note' && e.id !== 'fv-a' && e.id !== 'fv-b').pop();
         return { count: els.length, nx: added ? added.x : -999999, ny: added ? added.y : -999999, nw: added ? added.w : 0, bw: b ? b.w : 0, bh: b ? b.h : 0 };
       })()`
    )
    await evalIn(page, 'window.__canvasE2E.exitCameraFullView()')
    const clickX = res.nx + res.nw / 2,
      clickY = res.ny + 20
    expect(res.count, 'a third note was added').toBe(3)
    expect(
      res.nx >= 0 && res.nx <= res.bw && res.ny >= 0 && res.ny <= res.bh,
      'note in bounds'
    ).toBe(true)
    expect(
      Math.abs(clickX - t.bx) <= 10 && Math.abs(clickY - t.by) <= 10,
      'note near the click point'
    ).toBe(true)
  })

  test('real Ctrl+V paste persists a blob to assets/<sha1>.png (relative path, on disk)', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'canvas-w4-', 'w4')
    try {
      await evalIn(
        page,
        `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [] })`
      )
      await page.waitForTimeout(80)
      await mainCall(electronApp, 'putRedBitmapOnClipboard', 10, 10)
      await evalIn(
        page,
        `(() => { const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(JSON.stringify(planId))} + ']'); const w = n && n.querySelector('.pl-well'); if (w) w.focus(); })()`
      )
      await page.waitForTimeout(40)
      await mainCall(electronApp, 'sendInput', {
        type: 'keyDown',
        keyCode: 'V',
        modifiers: ['control']
      })
      await mainCall(electronApp, 'sendInput', {
        type: 'char',
        keyCode: 'V',
        modifiers: ['control']
      })
      await mainCall(electronApp, 'sendInput', {
        type: 'keyUp',
        keyCode: 'V',
        modifiers: ['control']
      })
      const pasted = await pollEval(
        page,
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${JSON.stringify(planId)}); return b && b.type === 'planning' ? b.elements.filter(e => e.kind === 'image').length === 1 : false; })()`,
        4000
      )
      const assetId = await evalIn<string | null>(
        page,
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${JSON.stringify(planId)}); const img = (b && b.type === 'planning' ? b.elements : []).find(e => e.kind === 'image'); return img ? img.assetId : null; })()`
      )
      const relOk =
        !!assetId && /^assets[/\\][0-9a-f]{40}\.png$/.test(assetId) && !assetId.startsWith('data:')
      const fileOk =
        !!assetId &&
        (await mainCall<boolean>(
          electronApp,
          'fileExists',
          await mainCall<string>(electronApp, 'joinPath', tmp, assetId)
        ))
      expect(pasted, 'one image element added').toBe(true)
      expect(relOk, 'relative assets/<sha1>.png path').toBe(true)
      expect(fileOk, 'blob written to disk').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('PNG export rasters a non-trivial byte stream through the offscreen-canvas pipeline', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'canvas-w5-', 'w5')
    try {
      await evalIn(
        page,
        `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
        { id: 'ex-note', kind: 'note', x: 20, y: 20, w: 156, h: 96, tint: 'blue', text: 'export me', rotation: 0 },
        { id: 'ex-stroke', kind: 'stroke', x: 0, y: 0, points: [40,200,80,240,120,210] },
        { id: 'ex-check', kind: 'checklist', x: 220, y: 20, w: 240, h: 0, title: 'T', items: [{ id:'a', label:'one', done:true }, { id:'b', label:'two', done:false }] }
      ] })`
      )
      await page.waitForTimeout(120)
      const png = await evalIn<{ byteLength: number } | null>(
        page,
        `window.__canvasE2E.exportBoard(${JSON.stringify(planId)}, 'png')`
      )
      expect(png, 'export returned a PNG summary').not.toBeNull()
      expect(png!.byteLength, 'PNG bytes are non-trivial').toBeGreaterThan(200)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
