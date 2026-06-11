// e2e/terminalCrisp.e2e.ts — settled-zoom native re-raster, FREEZE variant
// (docs/research/2026-06-12-terminal-native-reraster-audit.md; supersedes the #122
// renderer-swap policy this spec previously pinned).
// Pins the invariants that keep terminal text crisp at EVERY settled zoom:
//   1. WebGL is held at every settled zoom — the renderer never swaps on zoom (the
//      counter-scale keeps the GL backing store 1:1 with device pixels);
//   2. counter-scale geometry — the grid's NET visual scale is 1 at any settled zoom,
//      and the effective render font tracks pinned × settledZoom;
//   3. FREEZE — cols/rows never change from a zoom settle (no PTY/TUI reflow on zoom);
//   4. zoom snap — a settled zoom inside [ZOOM_SNAP_LO, ZOOM_SNAP_HI] lands on exactly 1
//      (kept from #122 — the zero-slack comfort state);
//   5. failed-attach sweep — a GL activation that throws after appending its canvas must
//      not leak canvases across zoom cycles;
//   6. selection stays cell-accurate at a settled fractional zoom (the audit's proven
//      shim double-correct bug: the shim must see the NET scale, not the camera z).
//
// Renderer discriminator: `.xterm-rows` is created by xterm's DOM renderer and REMOVED
// on its dispose, so rows-present ⇔ DOM renderer painting and rows-absent ⇔ WebGL
// painting. Deliberately NOT the <canvas> element: a failed GL activation can orphan a
// dead canvas in .xterm-screen (the Linux-leg diagnosis), so canvas-presence lies.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const screenSel = (id: string): string => `.react-flow__node[data-id="${id}"] .xterm-screen`
const domRowsActive = (id: string): string =>
  `!!document.querySelector(${JSON.stringify(`${screenSel(id)} .xterm-rows`)})`
const canvasCount = (id: string): string =>
  `document.querySelectorAll(${JSON.stringify(`${screenSel(id)} canvas`)}).length`
/** Counter-scale probe via Playwright's native argument-passing evaluate — NO code
 *  construction (CodeQL js/bad-code-sanitization: building eval source around dynamic
 *  values is flagged; a function callback with an argument carries no such risk). */
interface CsProbe {
  effectiveFont: number
  cols: number
  rows: number
  netScale: number | null
  hSlack: number | null
  vSlack: number | null
}
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

/** Wait for the settle (250ms debounce) to publish: the effective font reaches ≈ pin × z.
 *  Tolerant downward — the no-clip correction may step the render font below pin × z by a
 *  few percent at zooms where xterm's integer-cell quantization would otherwise clip. */
async function settleAt(
  page: Parameters<typeof evalIn>[0],
  id: string,
  expectedFont: number
): Promise<void> {
  // Non-throwing on timeout (mirrors pollEval): the caller's asserts then fail with a
  // readable diagnostic instead of a poll-timeout stack. Lower bound derivation: the
  // no-clip correction steps the font by at most x0.97 four times (0.97^4 ~= 0.885), so
  // any corrected value sits above expectedFont * 0.88; below that is a real failure.
  const deadline = Date.now() + 5_000
  for (;;) {
    const f = (await readCs(page, id))?.effectiveFont ?? 0
    if (f <= expectedFont + 0.01 && f >= expectedFont * 0.88) return
    if (Date.now() > deadline) return
    await page.waitForTimeout(100)
  }
}

async function seedSettled(page: Parameters<typeof evalIn>[0]): Promise<string> {
  // Pin the sticky font for determinism — the persistent userData dir carries
  // localStorage across runs/specs, and every effective-font assert below derives
  // from this base (mirrors terminalClip's reset).
  await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '12.5')`)
  const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
  await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 10_000)
  await zoomTo(page, 1)
  await settleAt(page, id, 12.5)
  return id
}

test.describe('terminal native re-raster (FREEZE)', () => {
  test('WebGL is held across settled zooms (no renderer swap on zoom)', async ({ page }) => {
    const id = await seedSettled(page)
    // WebGL active ⇔ the DOM renderer's rows container was disposed. If rows persist
    // at z=1, GL is unavailable/broken in this environment (the addon's activation
    // fails and xterm stays on the DOM renderer) — the hold policy is then
    // unobservable; skip rather than fail on the environment. (The counter-scale
    // geometry/freeze tests below run regardless — they hold on both renderers.)
    const glActive = await pollEval(page, `!(${domRowsActive(id)})`, 10_000)
    test.skip(!glActive, 'WebGL unavailable in this environment — hold policy unobservable')

    await zoomTo(page, 1.3)
    await settleAt(page, id, 12.5 * 1.3)
    expect(
      await evalIn<boolean>(page, domRowsActive(id)),
      'still WebGL at settled 1.3 (no DOM fallback)'
    ).toBe(false)

    await zoomTo(page, 0.8)
    await settleAt(page, id, 10)
    expect(
      await evalIn<boolean>(page, domRowsActive(id)),
      'still WebGL at settled 0.8 (no DOM fallback)'
    ).toBe(false)
  })

  test('counter-scale: net scale 1 + effective font pin×z + FROZEN cols/rows', async ({ page }) => {
    const id = await seedSettled(page)
    const base = (await readCs(page, id))!
    expect(base.effectiveFont).toBeCloseTo(12.5, 2)

    for (const z of [1.3, 0.8, 0.6]) {
      await zoomTo(page, z)
      await settleAt(page, id, 12.5 * z)
      const cs = (await readCs(page, id))!
      expect(cs.effectiveFont, `effective font tracks pin×z at z=${z}`).toBeCloseTo(12.5 * z, 2)
      expect(cs.cols, `cols frozen across zoom (z=${z})`).toBe(base.cols)
      expect(cs.rows, `rows frozen across zoom (z=${z})`).toBe(base.rows)
      expect(cs.netScale, `net visual scale is 1 at settled z=${z}`).not.toBeNull()
      expect(Math.abs((cs.netScale ?? 0) - 1), `net scale ≈ 1 at z=${z}`).toBeLessThan(0.002)
    }

    // Back to 100%: the effective font returns to the pin and the grid never moved.
    await zoomTo(page, 1)
    await settleAt(page, id, 12.5)
    const back = (await readCs(page, id))!
    expect(back.cols, 'cols unchanged after the round trip').toBe(base.cols)
    expect(back.rows, 'rows unchanged after the round trip').toBe(base.rows)
  })

  test('the frozen grid never clips the well at quantization-hostile zooms', async ({ page }) => {
    // xterm quantizes cell dims to whole px, so at some zooms eff = pin×cs lands the
    // frozen grid one cell-step WIDER than the wrapper (measured: -44.7px at 0.82
    // pre-correction — ~7 columns of live TUI clipped). The no-clip correction must
    // step the render font down until the grid fits; hSlack/vSlack >= 0 ⇔ no clip.
    const id = await seedSettled(page)
    for (const z of [0.82, 0.7, 1.3, 0.6]) {
      await zoomTo(page, z)
      await settleAt(page, id, 12.5 * z)
      const deadline = Date.now() + 4_000
      let cs = await readCs(page, id)
      const fitsNow = (c: CsProbe | null): boolean =>
        !!c && c.hSlack !== null && c.hSlack >= -0.5 && c.vSlack !== null && c.vSlack >= -0.5
      while (!fitsNow(cs) && Date.now() < deadline) {
        await page.waitForTimeout(100)
        cs = await readCs(page, id)
      }
      const fits = fitsNow(cs)
      expect(fits, `grid fits the well at settled z=${z} (slack ${JSON.stringify(cs)})`).toBe(true)
    }
  })

  test('a real font nudge still reflows the grid (pin changes are NOT frozen)', async ({
    page
  }) => {
    const id = await seedSettled(page)
    await zoomTo(page, 0.8)
    await settleAt(page, id, 10)
    const before = (await readCs(page, id))!
    // Pin 12.5 → 18 at settled 0.8: effective = 18 × 0.8 = 14.4 AND the grid refits
    // (taller cells ⇒ fewer rows) — the FREEZE applies to zoom changes only.
    await evalIn(page, `window.__canvasE2E.setBoardFont(${JSON.stringify(id)}, 18)`)
    await settleAt(page, id, 18 * 0.8)
    const after = (await readCs(page, id))!
    expect(after.rows, 'rows dropped under the bigger pin').toBeLessThan(before.rows)
  })

  test('zoom cycles never accumulate renderer canvases (failed GL attaches are swept)', async ({
    page
  }) => {
    // Baseline-relative on purpose — the legitimate canvas population differs by GL
    // state (working GL: the addon's render canvas + its xterm-link-layer = 2;
    // broken GL post-sweep: 0), so the contract is NO GROWTH across cycles.
    const id = await seedSettled(page)
    await page.waitForTimeout(500) // first attach (or failed attach + sweep) fully lands
    const baseline = await evalIn<number>(page, canvasCount(id))
    for (const z of [1.3, 1, 1.3, 1]) {
      await zoomTo(page, z)
      await page.waitForTimeout(500) // let the settle (250ms) + re-raster land
    }
    const count = await evalIn<number>(page, canvasCount(id))
    expect(count, 'canvas count did not grow across zoom cycles').toBeLessThanOrEqual(baseline)
  })

  test('drag-select stays cell-accurate at a settled fractional zoom', async ({ page }) => {
    // The audit's proven failure mode: with the counter-scale active the grid's net
    // scale is 1, so a shim still correcting by the CAMERA z over-corrects and the
    // selection lands wide (got 14 chars for an 11-char drag). Pin the fixed contract.
    const id = await seedSettled(page)
    await zoomTo(page, 0.82)
    await settleAt(page, id, 12.5 * 0.82)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`
    )
    await pollEval(
      page,
      `(window.__canvasE2E.readTerminal(${JSON.stringify(id)}) ?? '').startsWith('ABCDEFGHIJ')`,
      3_000
    )
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
    // Snap needs no board, but seed one so the canvas matches real use.
    await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await evalIn(page, `window.__canvasE2E.setZoom(0.97)`)
    const snapped = await pollEval(page, `window.__canvasE2E.getZoom() === 1`, 3_000)
    expect(snapped, 'settled 0.97 snapped to exactly 1').toBe(true)
  })

  test('a settled zoom outside the band is left untouched', async ({ page }) => {
    await evalIn(page, `window.__canvasE2E.setZoom(1.3)`)
    // A "did NOT change" assertion is inherently time-bounded — there is no event to
    // await for a snap that must never fire. 800ms is >3x the 250ms settle debounce
    // (which starts from the synchronous zoomTo above, not from test scheduling), so
    // a late timer still lands well inside the window.
    await page.waitForTimeout(800)
    const zoom = await evalIn<number>(page, `window.__canvasE2E.getZoom()`)
    expect(zoom).toBeCloseTo(1.3, 5)
  })
})
