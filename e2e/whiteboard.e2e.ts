import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, mainCall, pollEval, seed } from './helpers'

/** The slice of `getBoards()` these probes read. `callE2E` carries ids as REAL args and the
 *  finds/filters below run in Node, so no runtime value ever enters an eval'd code string
 *  (CodeQL js/bad-code-sanitization). Field presence follows the element kind actually read. */
interface WbEl {
  id: string
  kind: string
  x: number
  y: number
  w: number
  x2: number
  y2: number
  assetId: string | null
}
interface WbBoard {
  id: string
  type: string
  w: number
  h: number
  elements?: WbEl[]
}
const boardsOf = (page: Page): Promise<WbBoard[]> => callE2E<WbBoard[]>(page, { m: 'getBoards' })

/** Poll a Node-side probe until truthy — `pollEval`'s boolean contract, values compared HERE. */
async function pollTrue(read: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(read, { timeout: timeoutMs }).toBeTruthy()
    return true
  } catch {
    return false
  }
}

/** One tick of the camera-fit dance: instant re-fit, then measure the well on-screen. RF measures
 *  freshly-resized nodes lazily (memory e2e-rf-measurement-race), so every tick re-fits before
 *  checking. The board id crosses as a STRUCTURED ARG, never spliced into page code. */
function fitTick(page: Page, id: string): Promise<boolean> {
  return page.evaluate((bid) => {
    const g = globalThis as any
    g.__canvasE2E.fitCameraInstant(bid)
    const node = g.document.querySelector('.react-flow__node[data-id=' + JSON.stringify(bid) + ']')
    const well = node && node.querySelector('.pl-well')
    if (!well || !(well.offsetWidth > 0)) return false
    const r = well.getBoundingClientRect()
    const scale = r.width / well.offsetWidth
    return (
      scale > 0.4 &&
      r.left >= -2 &&
      r.top >= -2 &&
      r.right <= g.innerWidth + 2 &&
      r.bottom <= g.innerHeight + 2
    )
  }, id)
}
const pollCameraFit = (page: Page, id: string, timeoutMs: number): Promise<boolean> =>
  pollTrue(() => fitTick(page, id), timeoutMs)

test.describe('@planning whiteboard slivers (real OS input / native pipeline)', () => {
  test('full-view add-note: a real click lands in-bounds through the live camera transform', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    await callE2E(page, {
      m: 'patchBoard',
      a: [
        planId,
        {
          w: 520,
          h: 500,
          elements: [
            {
              id: 'fv-a',
              kind: 'note',
              x: 40,
              y: 40,
              w: 156,
              h: 96,
              tint: 'yellow',
              text: 'A',
              rotation: 0
            },
            {
              id: 'fv-b',
              kind: 'note',
              x: 300,
              y: 320,
              w: 156,
              h: 96,
              tint: 'blue',
              text: 'B',
              rotation: 0
            }
          ]
        }
      ]
    })
    await page.waitForTimeout(180)
    await callE2E(page, { m: 'enterCameraFullView', a: [planId] })
    const fitted = await pollCameraFit(page, planId, 4000)
    expect(fitted, 'camera fit the board on-screen').toBe(true)
    await page.waitForTimeout(60)
    const t = await page.evaluate<
      { found: boolean; sx: number; sy: number; scale: number; bx: number; by: number },
      string
    >((bid) => {
      const g = globalThis as any
      const node = g.document.querySelector(
        '.react-flow__node[data-id=' + JSON.stringify(bid) + ']'
      )
      const well = node && node.querySelector('.pl-well')
      if (!well) return { found: false, sx: 0, sy: 0, scale: 0, bx: 0, by: 0 }
      const r = well.getBoundingClientRect()
      const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1
      const bx = 260,
        by = 250
      return { found: true, sx: r.left + bx * scale, sy: r.top + by * scale, scale, bx, by }
    }, planId)
    expect(t.found).toBe(true)
    await page.evaluate((bid) => {
      const g = globalThis as any
      const node = g.document.querySelector(
        '.react-flow__node[data-id=' + JSON.stringify(bid) + ']'
      )
      const well = node && node.querySelector('.pl-well')
      if (well) {
        well.focus()
        well.dispatchEvent(new g.KeyboardEvent('keydown', { key: 'n', bubbles: true }))
      }
    }, planId)
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
    const boards = await boardsOf(page)
    const board = boards.find((x) => x.id === planId)
    const els = board && board.type === 'planning' ? (board.elements ?? []) : []
    const added = els.filter((e) => e.kind === 'note' && e.id !== 'fv-a' && e.id !== 'fv-b').pop()
    const res = {
      count: els.length,
      nx: added ? added.x : -999999,
      ny: added ? added.y : -999999,
      nw: added ? added.w : 0,
      bw: board ? board.w : 0,
      bh: board ? board.h : 0
    }
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

  test('arrow endpoint drag: a real OS drag on the head handle re-binds x2/y2 in one undo step (D3-B)', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    await callE2E(page, {
      m: 'patchBoard',
      a: [
        planId,
        {
          w: 520,
          h: 500,
          elements: [{ id: 'ep-a', kind: 'arrow', x: 80, y: 320, x2: 300, y2: 120 }]
        }
      ]
    })
    await page.waitForTimeout(180)
    await callE2E(page, { m: 'enterCameraFullView', a: [planId] })
    const fitted = await pollCameraFit(page, planId, 4000)
    expect(fitted, 'camera fit the board on-screen').toBe(true)
    await page.waitForTimeout(60)
    // Select the arrow synthetically (selection is not the surface under test): press
    // its committed <path>, settle with pointer-up on the well. setPointerCapture
    // throws on a synthetic pointer — harmless, drag state is set before it (memory
    // e2e-whiteboard-probes) — so the dispatch is wrapped.
    const selected = await page.evaluate((bid) => {
      const g = globalThis as any
      const node = g.document.querySelector(
        '.react-flow__node[data-id=' + JSON.stringify(bid) + ']'
      )
      const well = node && node.querySelector('.pl-well')
      const path = well && well.querySelector('svg > path')
      if (!well || !path) return false
      try {
        path.dispatchEvent(
          new g.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 })
        )
      } catch {
        /* pointerdown ctor/dispatch is best-effort — the old in-page IIFE swallowed it too */
      }
      try {
        well.dispatchEvent(
          new g.PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 })
        )
      } catch {
        /* pointerdown ctor/dispatch is best-effort — the old in-page IIFE swallowed it too */
      }
      return true
    }, planId)
    expect(selected, 'arrow path press dispatched').toBe(true)
    // The head handle's hit circle (r=12) renders once the arrow is selected.
    const handleReady = await pollEval(
      page,
      `!!document.querySelector('[data-arrow-endpoint="end"]')`,
      2000
    )
    expect(handleReady, 'endpoint handles rendered').toBe(true)
    const t = await page.evaluate<
      { found: boolean; hx: number; hy: number; tx: number; ty: number; bx: number; by: number },
      string
    >((bid) => {
      const g = globalThis as any
      const node = g.document.querySelector(
        '.react-flow__node[data-id=' + JSON.stringify(bid) + ']'
      )
      const well = node && node.querySelector('.pl-well')
      const h = g.document.querySelector('[data-arrow-endpoint="end"]')
      if (!well || !h) return { found: false, hx: 0, hy: 0, tx: 0, ty: 0, bx: 0, by: 0 }
      const hr = h.getBoundingClientRect()
      const r = well.getBoundingClientRect()
      const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1
      const bx = 200,
        by = 400 // board-local drop target, inside the 520x500 well
      return {
        found: true,
        hx: hr.left + hr.width / 2,
        hy: hr.top + hr.height / 2,
        tx: r.left + bx * scale,
        ty: r.top + by * scale,
        bx,
        by
      }
    }, planId)
    expect(t.found, 'handle + well located').toBe(true)
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
    const boards = await boardsOf(page)
    const board = boards.find((x) => x.id === planId)
    const arrow = (board && board.type === 'planning' ? (board.elements ?? []) : []).find(
      (e) => e.id === 'ep-a'
    )
    const res = arrow ? { x: arrow.x, y: arrow.y, x2: arrow.x2, y2: arrow.y2 } : null
    expect(res, 'arrow still in the store').not.toBeNull()
    // Tail untouched; head landed at the drop target (±8px tolerance for the
    // screen→board rounding through the camera scale).
    expect(res!.x, 'tail x unchanged').toBe(80)
    expect(res!.y, 'tail y unchanged').toBe(320)
    expect(Math.abs(res!.x2 - t.bx), 'head x2 at the drop target').toBeLessThanOrEqual(8)
    expect(Math.abs(res!.y2 - t.by), 'head y2 at the drop target').toBeLessThanOrEqual(8)
    // The whole drag is ONE undo step: a single undo restores the seeded head.
    await evalIn(page, 'window.__canvasE2E.undo()')
    const boardsAfterUndo = await boardsOf(page)
    const boardAfterUndo = boardsAfterUndo.find((x) => x.id === planId)
    const arrowAfterUndo = (
      boardAfterUndo && boardAfterUndo.type === 'planning' ? (boardAfterUndo.elements ?? []) : []
    ).find((e) => e.id === 'ep-a')
    const undone = arrowAfterUndo ? { x2: arrowAfterUndo.x2, y2: arrowAfterUndo.y2 } : null
    await evalIn(page, 'window.__canvasE2E.exitCameraFullView()')
    expect(undone, 'arrow survives the undo').not.toBeNull()
    expect(undone!.x2, 'one undo restores the head x2').toBe(300)
    expect(undone!.y2, 'one undo restores the head y2').toBe(120)
  })

  test('real Ctrl+V paste persists a blob to assets/<sha1>.png (relative path, on disk)', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'canvas-w4-', 'w4')
    try {
      await callE2E(page, { m: 'patchBoard', a: [planId, { elements: [] }] })
      await page.waitForTimeout(80)
      await mainCall(electronApp, 'putRedBitmapOnClipboard', 10, 10)
      await page.evaluate((bid) => {
        const g = globalThis as any
        const n = g.document.querySelector('.react-flow__node[data-id=' + JSON.stringify(bid) + ']')
        const w = n && n.querySelector('.pl-well')
        if (w) w.focus()
      }, planId)
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
      const pasted = await pollTrue(async () => {
        const b = (await boardsOf(page)).find((x) => x.id === planId)
        return b && b.type === 'planning'
          ? (b.elements ?? []).filter((e) => e.kind === 'image').length === 1
          : false
      }, 4000)
      const bAfterPaste = (await boardsOf(page)).find((x) => x.id === planId)
      const img = (
        bAfterPaste && bAfterPaste.type === 'planning' ? (bAfterPaste.elements ?? []) : []
      ).find((e) => e.kind === 'image')
      const assetId = img ? img.assetId : null
      const relOk =
        !!assetId && /^assets[/\\][0-9a-f]{40}\.png$/.test(assetId) && !assetId.startsWith('data:')
      // ADR 0009: the stored assetId stays `assets/<sha>.png`, but the blob is written under
      // `<project>/.canvas/assets/` — resolve the on-disk path through `.canvas/`.
      const fileOk =
        !!assetId &&
        (await mainCall<boolean>(
          electronApp,
          'fileExists',
          await mainCall<string>(electronApp, 'joinPath', tmp, '.canvas', assetId)
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
      await callE2E(page, {
        m: 'patchBoard',
        a: [
          planId,
          {
            elements: [
              {
                id: 'ex-note',
                kind: 'note',
                x: 20,
                y: 20,
                w: 156,
                h: 96,
                tint: 'blue',
                text: 'export me',
                rotation: 0
              },
              { id: 'ex-stroke', kind: 'stroke', x: 0, y: 0, points: [40, 200, 80, 240, 120, 210] },
              {
                id: 'ex-check',
                kind: 'checklist',
                x: 220,
                y: 20,
                w: 240,
                h: 0,
                title: 'T',
                items: [
                  { id: 'a', label: 'one', done: true },
                  { id: 'b', label: 'two', done: false }
                ]
              }
            ]
          }
        ]
      })
      await page.waitForTimeout(120)
      const png = await callE2E<{ byteLength: number } | null>(page, {
        m: 'exportBoard',
        a: [planId, 'png']
      })
      expect(png, 'export returned a PNG summary').not.toBeNull()
      expect(png!.byteLength, 'PNG bytes are non-trivial').toBeGreaterThan(200)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
