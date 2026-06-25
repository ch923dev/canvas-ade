// e2e/terminalCrisp.e2e.ts — terminal DOM-renderer crispness (terminal-crisp umbrella,
// docs/research/2026-06-25-terminal-dom-renderer). The live terminal runs on xterm's built-in
// DOM renderer; the WebGL addon + the in-canvas FREEZE counter-scale that previously kept its
// canvas crisp were removed. DOM glyphs are re-rasterized by Chromium at the live camera scale
// — like the whiteboard — so the terminal stays crisp under pan/zoom with no counter-scale.
// (The full-view font scale-up / Pure A1 #235 is preserved and is covered by terminalScrollback.)
// This spec pins the invariants that keep the in-canvas path working:
//   1. the DOM renderer is active at every zoom (no WebGL <canvas> in the screen);
//   2. the render font is CONSTANT across zoom (no counter-scale — the element rides the camera
//      transform, so its on-screen scale IS the camera zoom);
//   3. cols/rows are FROZEN across zoom (a zoom never reflows the PTY/TUI);
//   4. a real font-pin change DOES reflow the grid (pin changes are not frozen);
//   5. drag-select stays cell-accurate at a settled fractional zoom (the selection shim corrects
//      by the raw camera scale);
//   6. the snap-to-100% detent still fires inside the band and leaves out-of-band zooms.
//
// Renderer discriminator: `.xterm-rows` is the DOM renderer's row container (created by it,
// removed on its dispose). With WebGL removed it must always be present, and the screen must
// hold no <canvas>.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const screenSel = (id: string): string => `.react-flow__node[data-id="${id}"] .xterm-screen`
const domRowsActive = (id: string): string =>
  `!!document.querySelector(${JSON.stringify(`${screenSel(id)} .xterm-rows`)})`
const canvasCount = (id: string): string =>
  `document.querySelectorAll(${JSON.stringify(`${screenSel(id)} canvas`)}).length`

interface CsProbe {
  effectiveFont: number
  cols: number
  rows: number
  netScale: number | null
  hSlack: number | null
  vSlack: number | null
}
/** Geometry probe via Playwright's native argument-passing evaluate — NO code construction
 *  (CodeQL js/bad-code-sanitization: building eval source around dynamic values is flagged). */
function readCs(page: Parameters<typeof evalIn>[0], id: string): Promise<CsProbe | null> {
  return page.evaluate((bid) => {
    const g = globalThis as unknown as {
      __canvasE2E?: { terminalCounterScale(b: string): CsProbe | null }
    }
    return g.__canvasE2E?.terminalCounterScale(bid) ?? null
  }, id)
}

/** Drive the camera to `z` and wait for the live zoom to land there. */
async function zoomTo(page: Parameters<typeof evalIn>[0], z: number): Promise<void> {
  await evalIn(page, `window.__canvasE2E.setZoom(${z})`)
  await pollEval(page, `Math.abs(window.__canvasE2E.getZoom() - ${z}) < 1e-6`, 3_000)
}

/** Wait until the terminal's on-screen scale (netScale) tracks the camera zoom `z` — i.e. the
 *  element rides the raw camera transform (no counter-scale pinning it to 1). */
async function settledAt(page: Parameters<typeof evalIn>[0], id: string, z: number): Promise<void> {
  const deadline = Date.now() + 4_000
  for (;;) {
    const ns = (await readCs(page, id))?.netScale
    if (ns !== null && ns !== undefined && Math.abs(ns - z) < 0.02) return
    if (Date.now() > deadline) return
    await page.waitForTimeout(100)
  }
}

/** Wait until the terminal buffer stops changing — the shell's startup banner has finished
 *  streaming over the PTY — so a later reset+write is not raced by late output that would
 *  scroll the written content out of the viewport. */
async function waitQuiet(page: Parameters<typeof evalIn>[0], id: string): Promise<void> {
  const read = `window.__canvasE2E.readTerminal(${JSON.stringify(id)}) ?? ''`
  let last = ''
  const deadline = Date.now() + 8_000
  for (;;) {
    const cur = (await evalIn<string>(page, read)) ?? ''
    if (cur.length > 0 && cur === last) return // two identical reads ⇒ idle
    last = cur
    if (Date.now() > deadline) return
    await page.waitForTimeout(400)
  }
}

async function seedTerminal(page: Parameters<typeof evalIn>[0]): Promise<string> {
  // Pin the sticky font for determinism — the persistent userData dir carries localStorage
  // across runs/specs (mirrors terminalClip's reset).
  await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '12.5')`)
  const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
  await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 10_000)
  await zoomTo(page, 1)
  await settledAt(page, id, 1)
  return id
}

test.describe('@terminal terminal DOM renderer (crisp under the camera)', () => {
  test('the DOM renderer is active at every zoom (no WebGL canvas)', async ({ page }) => {
    const id = await seedTerminal(page)
    // The DOM renderer's row container is present and there is no <canvas> in the screen.
    expect(await evalIn<boolean>(page, domRowsActive(id)), '.xterm-rows present at z=1').toBe(true)
    expect(await evalIn<number>(page, canvasCount(id)), 'no <canvas> at z=1').toBe(0)
    for (const z of [1.3, 0.8]) {
      await zoomTo(page, z)
      await settledAt(page, id, z)
      expect(await evalIn<boolean>(page, domRowsActive(id)), `DOM renderer at z=${z}`).toBe(true)
      expect(await evalIn<number>(page, canvasCount(id)), `no <canvas> at z=${z}`).toBe(0)
    }
  })

  test('font constant + on-screen scale tracks the camera + cols/rows FROZEN', async ({ page }) => {
    const id = await seedTerminal(page)
    const base = (await readCs(page, id))!
    expect(base.effectiveFont).toBeCloseTo(12.5, 2)

    for (const z of [1.3, 0.8, 0.6]) {
      await zoomTo(page, z)
      await settledAt(page, id, z)
      const cs = (await readCs(page, id))!
      // No counter-scale: the render font is the pin, unchanged by zoom.
      expect(cs.effectiveFont, `render font constant at z=${z}`).toBeCloseTo(12.5, 2)
      // The element rides the raw camera transform → its on-screen scale IS the zoom.
      expect(cs.netScale, `netScale present at z=${z}`).not.toBeNull()
      expect(Math.abs((cs.netScale ?? 0) - z), `netScale ≈ camera z at z=${z}`).toBeLessThan(0.02)
      // FREEZE: a zoom must never reflow the PTY grid.
      expect(cs.cols, `cols frozen across zoom (z=${z})`).toBe(base.cols)
      expect(cs.rows, `rows frozen across zoom (z=${z})`).toBe(base.rows)
    }

    await zoomTo(page, 1)
    await settledAt(page, id, 1)
    const back = (await readCs(page, id))!
    expect(back.cols, 'cols unchanged after the round trip').toBe(base.cols)
    expect(back.rows, 'rows unchanged after the round trip').toBe(base.rows)
  })

  test('a real font nudge still reflows the grid (pin changes are NOT frozen)', async ({
    page
  }) => {
    const id = await seedTerminal(page)
    await zoomTo(page, 0.8)
    await settledAt(page, id, 0.8)
    const before = (await readCs(page, id))!
    // Pin 12.5 → 18: taller cells ⇒ fewer rows. The grid reflows regardless of zoom.
    await evalIn(page, `window.__canvasE2E.setBoardFont(${JSON.stringify(id)}, 18)`)
    await pollEval(
      page,
      `(window.__canvasE2E.terminalCounterScale(${JSON.stringify(id)})?.effectiveFont ?? 0) >= 17.9`,
      3_000
    )
    const after = (await readCs(page, id))!
    expect(after.effectiveFont, 'render font is the new pin (not counter-scaled)').toBeCloseTo(
      18,
      2
    )
    expect(after.rows, 'rows dropped under the bigger pin').toBeLessThan(before.rows)
  })

  test('drag-select stays cell-accurate at a settled fractional zoom', async ({ page }) => {
    const id = await seedTerminal(page)
    // Wait for the shell banner to finish, then write the known content at z=1 and verify it
    // reached row 0 (async term.write must land BEFORE the drag). FREEZE keeps it on screen
    // across the zoom below; quiescence keeps late PTY output from scrolling it away.
    await waitQuiet(page, id)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`
    )
    expect(
      await pollEval(
        page,
        `(window.__canvasE2E.readTerminal(${JSON.stringify(id)}) ?? '').startsWith('ABCDEFGHIJ')`,
        5_000
      ),
      'ABC… written to row 0'
    ).toBe(true)
    // Now zoom to a fractional settled zoom: the element rides the camera at netScale 0.82, so
    // the selection shim must correct the pointer by that scale for the drag to land right.
    await zoomTo(page, 0.82)
    await settledAt(page, id, 0.82)
    const p1 = await evalIn<{ x: number; y: number } | null>(
      page,
      `window.__canvasE2E.terminalCellPoint(${JSON.stringify(id)}, 2, 0, 0.25)`
    )
    const p2 = await evalIn<{ x: number; y: number } | null>(
      page,
      `window.__canvasE2E.terminalCellPoint(${JSON.stringify(id)}, 12, 0, 0.75)`
    )
    expect(p1).not.toBeNull()
    expect(p2).not.toBeNull()
    await page.mouse.move(p1!.x, p1!.y)
    await page.mouse.down()
    await page.mouse.move(p2!.x, p2!.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const sel = await evalIn<string>(
      page,
      `window.__canvasE2E.terminalSelection(${JSON.stringify(id)})`
    )
    expect(sel, 'selection spans exactly the dragged cells').toBe('CDEFGHIJKLM')
  })

  test('a settled zoom inside the snap band lands on exactly 100%', async ({ page }) => {
    await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await evalIn(page, `window.__canvasE2E.setZoom(0.97)`)
    const snapped = await pollEval(page, `window.__canvasE2E.getZoom() === 1`, 3_000)
    expect(snapped, 'settled 0.97 snapped to exactly 1').toBe(true)
  })

  test('a settled zoom outside the band is left untouched', async ({ page }) => {
    await evalIn(page, `window.__canvasE2E.setZoom(1.3)`)
    // A "did NOT change" assertion is inherently time-bounded — there is no event to await for a
    // snap that must never fire. 800ms is >3x the 250ms settle debounce.
    await page.waitForTimeout(800)
    const zoom = await evalIn<number>(page, `window.__canvasE2E.getZoom()`)
    expect(zoom).toBeCloseTo(1.3, 5)
  })
})
