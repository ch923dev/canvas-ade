/**
 * DIAGNOSTIC (not a permanent gate) — measures whether the native WebContentsView's
 * bounds stay congruent with its HTML `.bb-frame` after camera pan / zoom / board resize.
 *
 * The native layer is positioned by `worldRectToScreen(deviceStageRect(...))` and the HTML
 * frame by the identical `deviceFrameRect` under the same camera, so at rest they must match
 * (native == frame inset 1px). The user reports the native white page escaping its frame on
 * EVERY pan/move/resize. This probe reads the native rect (`viewBounds`, main) and the frame
 * rect (`getBoundingClientRect`, renderer) after each motion settles and logs the divergence,
 * so we MEASURE which operation breaks congruence instead of guessing. Run explicitly:
 *   pnpm build; pnpm exec playwright test e2e/preview-align.e2e.ts
 */
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

interface NativeBounds {
  attached: boolean
  bounds: { x: number; y: number; width: number; height: number }
}
interface FrameRect {
  left: number
  top: number
  width: number
  height: number
}
interface Row {
  label: string
  attached: boolean
  maxAbs?: number
  delta?: { dx: number; dy: number; dw: number; dh: number }
  native?: NativeBounds['bounds']
  frameInset?: { x: number; y: number; width: number; height: number }
  note?: string
}

const runtimeStatus = (id: string, status: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`
const runtimeLive = (id: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === true; })()`
const frameRectExpr = (id: string): string =>
  `(() => { const el = document.querySelector('[data-bb-frame="${id}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`

test.describe('preview alignment diagnostic', () => {
  test('native rect tracks the .bb-frame across pan / zoom / resize', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 12_000)).toBe(true)
    await pollEval(page, runtimeLive(id), 8000)
    await page.waitForTimeout(300)

    const dpr = await evalIn<number>(page, 'window.devicePixelRatio')
    const rows: Row[] = []
    const border = 1

    async function measure(label: string): Promise<void> {
      const nb = await mainCall<NativeBounds | null>(electronApp, 'viewBounds', id)
      const fr = await evalIn<FrameRect | null>(page, frameRectExpr(id))
      if (!nb || !fr) {
        rows.push({ label, attached: nb?.attached ?? false, note: 'no native and/or frame rect' })
        return
      }
      const frameInset = {
        x: fr.left + border,
        y: fr.top + border,
        width: fr.width - border * 2,
        height: fr.height - border * 2
      }
      const delta = {
        dx: Math.round((nb.bounds.x - frameInset.x) * 100) / 100,
        dy: Math.round((nb.bounds.y - frameInset.y) * 100) / 100,
        dw: Math.round((nb.bounds.width - frameInset.width) * 100) / 100,
        dh: Math.round((nb.bounds.height - frameInset.height) * 100) / 100
      }
      const maxAbs =
        Math.round(
          Math.max(Math.abs(delta.dx), Math.abs(delta.dy), Math.abs(delta.dw), Math.abs(delta.dh)) *
            100
        ) / 100
      rows.push({ label, attached: nb.attached, maxAbs, delta, native: nb.bounds, frameInset })
    }

    await measure('rest')

    const dbg0 = await evalIn<string>(page, 'JSON.stringify(window.__previewDebug)')
    // Plain pans (pump-only path: onChange→startPump repositions the still-attached view).
    await evalIn(page, 'window.__canvasE2E.panBy(140, 0)')
    await page.waitForTimeout(300)
    const dbg1 = await evalIn<string>(page, 'JSON.stringify(window.__previewDebug)')
    // eslint-disable-next-line no-console
    console.log(`\n--- __previewDebug BEFORE first panBy: ${dbg0}`)
    // eslint-disable-next-line no-console
    console.log(`--- __previewDebug AFTER  first panBy: ${dbg1}`)
    await measure('pan +140,0')
    await evalIn(page, 'window.__canvasE2E.panBy(140, 90)')
    await page.waitForTimeout(300)
    await measure('pan +140,+90')
    await evalIn(page, 'window.__canvasE2E.panBy(-120, -110)')
    await page.waitForTimeout(300)
    await measure('pan -120,-110')

    // Gesture-wrapped pan: full detach→move→reattach path (mirrors a real mouse drag-pan).
    await evalIn(page, 'window.__canvasE2E.setGesture(true)')
    await page.waitForTimeout(150)
    await evalIn(page, 'window.__canvasE2E.panBy(160, 70)')
    await page.waitForTimeout(150)
    await evalIn(page, 'window.__canvasE2E.setGesture(false)')
    await page.waitForTimeout(600)
    await measure('gesture-pan +160,+70')

    // Zoom in / out at the centered rest.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await page.waitForTimeout(350)
    await evalIn(page, 'window.__canvasE2E.setZoom(1.4)')
    await page.waitForTimeout(400)
    await measure('zoom 1.4')
    await evalIn(page, 'window.__canvasE2E.setZoom(0.8)')
    await page.waitForTimeout(400)
    await measure('zoom 0.8')

    // Resize WITHOUT a gesture (the reconcile bounds-push race, RC2): immediate then settled.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await page.waitForTimeout(350)
    const boards = await evalIn<Array<{ id: string; w: number; h: number }>>(
      page,
      'window.__canvasE2E.getBoards()'
    )
    const b0 = boards.find((b) => b.id === id)!
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(id)}, ${JSON.stringify({ w: b0.w + 260, h: b0.h + 200 })})`
    )
    await measure('resize-nogesture immediate')
    await page.waitForTimeout(500)
    await measure('resize-nogesture settled')

    // Resize WITH a gesture (NodeResizer path: setNodeGesture true → detach → reattach).
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await page.waitForTimeout(350)
    await evalIn(page, 'window.__canvasE2E.setGesture(true)')
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(id)}, ${JSON.stringify({ w: b0.w, h: b0.h })})`
    )
    await page.waitForTimeout(150)
    await evalIn(page, 'window.__canvasE2E.setGesture(false)')
    await page.waitForTimeout(600)
    await measure('gesture-resize settled')

    // ── REAL OS input (sendInputEvent) — drives d3-zoom/pan → useOnViewportChange, the
    // ACTUAL path a mouse pan/zoom takes. panBy/setZoom above are programmatic setViewport
    // which may not fire the camera pump; this is the decisive artifact-vs-real check.
    // Input lands at (50,300) — the empty left margin after fitView, clear of the board's
    // native device-stage rect (so the wheel zooms the canvas, not the page). ──
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await page.waitForTimeout(400)
    await measure('pre real-input (fit)')

    for (let i = 0; i < 6; i++) {
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseWheel',
        x: 50,
        y: 300,
        deltaX: 0,
        deltaY: -120
      })
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(800)
    const dbgWheel = await evalIn<string>(page, 'JSON.stringify(window.__previewDebug)')
    // eslint-disable-next-line no-console
    console.log(`--- __previewDebug AFTER  real wheel zoom: ${dbgWheel}`)
    await measure('after REAL wheel zoom-in')

    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: 50,
      y: 300,
      button: 'left',
      clickCount: 1
    })
    for (let i = 1; i <= 6; i++) {
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseMove',
        x: 50 + i * 28,
        y: 300 - i * 16,
        button: 'left'
      })
      await page.waitForTimeout(30)
    }
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: 218,
      y: 204,
      button: 'left',
      clickCount: 1
    })
    await page.waitForTimeout(800)
    await measure('after REAL drag-pan')

    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await page.waitForTimeout(400)
    await measure('final rest')

    // eslint-disable-next-line no-console
    console.log(`\n=== PREVIEW ALIGNMENT DIAGNOSTIC (devicePixelRatio=${dpr}) ===`)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 2))
    const offenders = rows.filter((r) => typeof r.maxAbs === 'number' && (r.maxAbs as number) > 2)
    // eslint-disable-next-line no-console
    console.log(`\nOFFENDERS (>2px divergence): ${offenders.length}/${rows.length}`)
    for (const o of offenders) {
      // eslint-disable-next-line no-console
      console.log(`  ${o.label}: maxAbs=${o.maxAbs}px delta=${JSON.stringify(o.delta)}`)
    }

    // Always surface the data; the offenders list is the real signal. A live view must
    // have been measured at least once or the probe itself failed to set up.
    expect(
      rows.some((r) => r.attached),
      'at least one measurement saw a live native view'
    ).toBe(true)
  })

  test('CLEAN panOnScroll only — does the native track the frame?', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 12_000)).toBe(true)
    await pollEval(page, runtimeLive(id), 8000)
    await page.waitForTimeout(600)
    const border = 1

    async function measureClean(label: string): Promise<void> {
      const nb = await mainCall<NativeBounds | null>(electronApp, 'viewBounds', id)
      const fr = await evalIn<FrameRect | null>(page, frameRectExpr(id))
      const dbg = await evalIn<string>(page, 'JSON.stringify(window.__previewDebug)')
      if (!nb || !fr) {
        // eslint-disable-next-line no-console
        console.log(`CLEAN ${label}: attached=${nb?.attached} no rect`)
        return
      }
      const ex = {
        x: fr.left + border,
        y: fr.top + border,
        width: fr.width - border * 2,
        height: fr.height - border * 2
      }
      const maxAbs =
        Math.round(
          Math.max(
            Math.abs(nb.bounds.x - ex.x),
            Math.abs(nb.bounds.y - ex.y),
            Math.abs(nb.bounds.width - ex.width),
            Math.abs(nb.bounds.height - ex.height)
          ) * 100
        ) / 100
      // eslint-disable-next-line no-console
      console.log(
        `CLEAN ${label}: maxAbs=${maxAbs}px attached=${nb.attached} native=${JSON.stringify(nb.bounds)} frameInset=${JSON.stringify(ex)} dbg=${dbg}`
      )
    }

    await measureClean('baseline (after programmatic fit)')
    // Real panOnScroll steps over the empty left margin (x:60), clear of the device stage.
    // deltaY scrolls = the app PANS (panOnScroll; zoom needs Ctrl/Meta). 700ms settle each.
    for (let step = 0; step < 4; step++) {
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseWheel',
        x: 60,
        y: 380,
        deltaX: 0,
        deltaY: -90
      })
      await page.waitForTimeout(700)
      await measureClean(`after panOnScroll step ${step}`)
    }
  })
})
