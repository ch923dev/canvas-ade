// e2e/terminalScrollback.e2e.ts
//
// Regression guard for full-view scrollback integrity across grid changes.
//
// History: the original bug (docs/research/2026-06-23-terminal-scrollback-reflow) was a
// column-changing term.resize() on the full-view toggle driving xterm's LOSSY reflow —
// truncated/missing lines and duplicated pre-scroll lines. Pure A1 fixed it by FREEZING the
// grid in full view and scaling the font only — at the cost of a letterbox on the non-binding
// axis (the "dead space at the right"). S3 (terminal-display fix) unfroze the grid: full view
// now REFITS cols/rows to the modal at the scaled font THROUGH the lossless S2 backstop
// (snapshot → resize → reset → re-write), so the spare axis becomes real columns and the
// buffer still survives byte-for-byte.
//
// The OUTCOME assert (the user's actual complaint — "sustain the terminal text"): every written
// line survives a full-view round-trip exactly once. We tag each line with a unique "L###"
// marker and check the markers are exactly L000..L119 before AND after — a dropped line removes
// a marker, a duplicated line repeats one. Robust to where lines wrap, so it tests text
// preservation, not cosmetics.
//
// The MECHANISM asserts: in full view the cols REFIT (grow, for a board whose height binds the
// scale — the letterbox axis gets filled) and the right-slack is bounded to ~a cell; on exit the
// grid settles back to the exact in-canvas cols. The old FROZEN build fails the growth assert;
// the pre-A1 build (plain reflow) fails the survival assert.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const PINNED = 12.5 // the factory/sticky default font (reset in afterEach for determinism)
const readBuf = (id: string) => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
const colsOf = (id: string) =>
  `window.__canvasE2E.terminalCounterScale(${JSON.stringify(id)})?.cols`
const fontOf = (id: string) =>
  `window.__canvasE2E.terminalCounterScale(${JSON.stringify(id)})?.effectiveFont`
const rowsOf = (id: string) =>
  `window.__canvasE2E.terminalCounterScale(${JSON.stringify(id)})?.rows`
// 120 wrapping lines (each ~74 chars > any reasonable in-canvas column count), each uniquely tagged.
const WRITE_LINES = `Array.from({length: 120}, (_, i) => 'L' + String(i).padStart(3,'0') + '=' + 'x'.repeat(70)).join('\\r\\n')`
const EXPECTED_MARKERS = Array.from({ length: 120 }, (_, i) => 'L' + String(i).padStart(3, '0'))
// The board content is in the modal once the portal has relocated the live xterm there.
const IN_MODAL = `!!document.querySelector('.fullview-host .xterm')`
// Every line marker in buffer order. Each logical line contributes exactly ONE "L###" (at its start;
// wrapped continuation rows are bare x's). Lossless rewrap ⇒ exactly L000..L119, in order, no repeats.
const markers = (buf: string | null): string[] => (buf ?? '').match(/L\d{3}/g) ?? []

async function readMarkers(page: import('@playwright/test').Page, id: string): Promise<string[]> {
  return markers(await evalIn<string | null>(page, readBuf(id)))
}

// Poll until the column count stops changing (the re-raster fit + no-clip rAF loop and — since S3 —
// the async backstop rewrite settle a few frames after a change). Reading a still-settling value as
// a baseline would misjudge the grid; this mirrors the real flow (camera settles, THEN you maximize).
async function settledCols(
  page: import('@playwright/test').Page,
  id: string
): Promise<number | undefined> {
  let prev: number | undefined
  for (let i = 0; i < 24; i++) {
    const c = await evalIn<number | undefined>(page, colsOf(id))
    if (typeof c === 'number' && c === prev) return c
    prev = c
    await page.waitForTimeout(150)
  }
  return prev
}

// Rows analogue of settledCols — poll until term.rows stops changing (the in-canvas fit + no-clip
// loop settle a few frames after seeding). Used as the in-canvas baseline for the fill test.
async function settledRows(
  page: import('@playwright/test').Page,
  id: string
): Promise<number | undefined> {
  let prev: number | undefined
  for (let i = 0; i < 24; i++) {
    const r = await evalIn<number | undefined>(page, rowsOf(id))
    if (typeof r === 'number' && r === prev) return r
    prev = r
    await page.waitForTimeout(150)
  }
  return prev
}

test.describe('@terminal full-view scrollback is preserved across the S3 backstop refit', () => {
  test.afterEach(async ({ page }) => {
    await evalIn(page, `window.__canvasE2E.setFullView(null)`)
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${PINNED}')`)
  })

  // Drain the live PTY before writing: the board launches `exit`, so the shell dies and can emit no
  // further bytes. We wait for the "[process exited]" marker the bridge prints, THEN reset+write our
  // block into the now-dead terminal — eliminating the live-shell race entirely (a live shell's
  // startup banner/prompt would otherwise stream in mid-test and its cursor-positioned redraw would
  // overwrite our lines, flaking under load). The xterm + buffer stay fully functional after exit;
  // full view and the refit logic operate on the board/term, independent of PTY state.
  async function fillBuffer(page: import('@playwright/test').Page, id: string): Promise<void> {
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    expect(
      await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000),
      'shell exited (PTY drained — no further output)'
    ).toBe(true)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, ${WRITE_LINES})`
    )
    expect(
      await pollEval(
        page,
        `(${readBuf(id)}.match(/L\\d{3}/g) || []).length === ${EXPECTED_MARKERS.length}`,
        6000
      ),
      'clean written block present before the round-trip'
    ).toBe(true)
  }

  // The async backstop rewrite parses over frames — never diff markers mid-parse.
  async function awaitMarkersSettled(
    page: import('@playwright/test').Page,
    id: string
  ): Promise<void> {
    await pollEval(
      page,
      `(${readBuf(id)}.match(/L\\d{3}/g) || []).length === ${EXPECTED_MARKERS.length}`,
      8000
    )
  }

  test('cols REFIT to the modal in full view (lossless); every line survives; cols restore on exit', async ({
    page
  }) => {
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${PINNED}')`)
    // A SQUARE board on a wide viewport: the modal's HEIGHT binds the font scale, so the old
    // frozen grid letterboxed the width (the user's "dead space at the right"). S3 must fill
    // that slack with real columns: cols in full view STRICTLY exceed the in-canvas count.
    const id = await seed(page, 'terminal', { launchCommand: 'exit', w: 520, h: 520 })
    await evalIn(page, `window.__canvasE2E.setZoom(1)`) // snapped working zoom (the common maximize case)
    await fillBuffer(page, id)

    expect(await readMarkers(page, id), 'sanity: all 120 lines present before').toEqual(
      EXPECTED_MARKERS
    )
    const colsBefore = await settledCols(page, id)
    expect(typeof colsBefore === 'number' && colsBefore > 0, 'sanity: cols read').toBe(true)

    // Two full-view round-trips — the cols-up-then-down cycle that corrupted the pre-A1 buffer
    // and that the S3 backstop must now survive losslessly.
    for (let i = 0; i < 2; i++) {
      await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(id)})`)
      expect(await pollEval(page, IN_MODAL, 4000), `relocated to modal (round ${i})`).toBe(true)
      // MECHANISM: the letterboxed width becomes real columns (the refit lands a few frames
      // after the portal settles — font seam applies, then the deferred backstop fit).
      expect(
        await pollEval(page, `(${colsOf(id)} ?? 0) > ${colsBefore}`, 6000),
        `cols grew past the in-canvas count (round ${i})`
      ).toBe(true)
      expect(
        (await evalIn<number | undefined>(page, fontOf(id))) ?? 0,
        `font still scaled up in full view (round ${i})`
      ).toBeGreaterThanOrEqual(PINNED)
      // The right gutter is bounded to ~a cell + the 12px well pad once the refit settles
      // (hSlack = well.right − grid.right). The frozen build left hundreds of px here.
      expect(
        await pollEval(
          page,
          `(() => { const c = window.__canvasE2E.terminalCounterScale(${JSON.stringify(id)}); if (!c || c.hSlack == null) return false; return c.hSlack >= -2 && c.hSlack <= (c.effectiveFont || 18) * 1.2 + 24 })()`,
          6000
        ),
        `grid fills the modal width without clipping (round ${i})`
      ).toBe(true)
      await evalIn(page, `window.__canvasE2E.setFullView(null)`)
      expect(await pollEval(page, `!(${IN_MODAL})`, 4000), `back on canvas (round ${i})`).toBe(true)
      // RESTORE: the exit refit settles back to the exact in-canvas grid (board unchanged,
      // font back to pinned ⇒ the fit re-proposes the same cols).
      expect(
        await pollEval(page, `${colsOf(id)} === ${colsBefore}`, 6000),
        `cols restored on exit (round ${i})`
      ).toBe(true)
    }

    // OUTCOME: no truncation, no duplication — exactly the same 120 lines, same order.
    await awaitMarkersSettled(page, id)
    expect(await readMarkers(page, id), 'every line survives the full-view round-trips').toEqual(
      EXPECTED_MARKERS
    )
  })

  test('full view fills the modal height (fit-driven rows); grid restores on exit', async ({
    page
  }) => {
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${PINNED}')`)
    // A wide, SHORT board so WIDTH binds the full-view scale — the case that left a big BOTTOM
    // letterbox and could hide the agent's input. The S3 refit grows rows to fill the modal
    // height (pre-S3 this was the rows-only fill hook; now the backstop fit owns both axes).
    const id = await seed(page, 'terminal', { launchCommand: 'exit', w: 900, h: 200 })
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await fillBuffer(page, id)

    const inCanvasRows = await settledRows(page, id)
    const inCanvasCols = await settledCols(page, id)
    expect((inCanvasRows ?? 0) > 0 && (inCanvasCols ?? 0) > 0, 'sanity: in-canvas grid read').toBe(
      true
    )

    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(id)})`)
    expect(await pollEval(page, IN_MODAL, 4000), 'relocated to modal').toBe(true)

    // FILL: rows grow to fill the modal height (the refit lands a few frames after the portal
    // settles). More rows than in-canvas ⇒ no more bottom letterbox.
    expect(
      await pollEval(page, `(${rowsOf(id)} ?? 0) > ${inCanvasRows}`, 6000),
      'rows grew to fill the modal height'
    ).toBe(true)
    // FILLED, not clipped: once the open-stretch settles (transform → identity, so the rect reads are
    // layout-true), the grid bottom sits within ~one cell + the 12px well pad. The OLD font-only fill
    // left MANY cells (hundreds of px) of black gutter here; this bounds it to one cell (~font×1.4)
    // plus the padding. `vSlack` = well.bottom − grid.bottom (from terminalCounterScale, full-view-safe).
    expect(
      await pollEval(
        page,
        `(() => { const c = window.__canvasE2E.terminalCounterScale(${JSON.stringify(id)}); if (!c) return false; const v = c.vSlack; const maxGutter = (c.effectiveFont || 18) * 1.4 + 24; return v >= -2 && v <= maxGutter })()`,
        4000
      ),
      'grid fills the modal height without clipping (no big bottom gutter)'
    ).toBe(true)

    await evalIn(page, `window.__canvasE2E.setFullView(null)`)
    expect(await pollEval(page, `!(${IN_MODAL})`, 4000), 'back on canvas').toBe(true)

    // RESTORE: the exit refit settles back to the exact in-canvas grid.
    expect(
      await pollEval(page, `${rowsOf(id)} === ${inCanvasRows}`, 6000),
      'rows restored to the in-canvas count on exit'
    ).toBe(true)
    expect(
      await pollEval(page, `${colsOf(id)} === ${inCanvasCols}`, 6000),
      'cols restored to the in-canvas count on exit'
    ).toBe(true)

    // OUTCOME: every line survives — the backstop rewrite never loses/dupes a line.
    await awaitMarkersSettled(page, id)
    expect(await readMarkers(page, id), 'every line survives the fill round-trip').toEqual(
      EXPECTED_MARKERS
    )
  })

  test('every line survives a full-view round-trip at a NON-1 zoom (DOM host rides the camera)', async ({
    page
  }) => {
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${PINNED}')`)
    const id = await seed(page, 'terminal', { launchCommand: 'exit' })
    // A non-1 camera zoom: under the DOM renderer the in-canvas host rides the camera transform
    // directly (NO counter-scale — the render font stays pinned regardless of zoom). Full view
    // flips to the portal (font scales up via fullViewScale, then the S3 backstop refit) and back.
    // cols settle differently across that transition, but NO LINE may be lost/duped.
    await evalIn(page, `window.__canvasE2E.setZoom(1.5)`)
    expect(
      await pollEval(page, `Math.abs(window.__canvasE2E.getZoom() - 1.5) < 1e-6`, 4000),
      'camera settled at 1.5 (render font stays pinned in-canvas)'
    ).toBe(true)
    await fillBuffer(page, id)

    expect(await readMarkers(page, id), 'sanity: all 120 lines present before').toEqual(
      EXPECTED_MARKERS
    )

    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(id)})`)
    expect(await pollEval(page, IN_MODAL, 4000), 'relocated to modal').toBe(true)
    // Full view scales the render font up (Pure A1's magnification is preserved) — font > pinned.
    expect(
      (await evalIn<number | undefined>(page, fontOf(id))) ?? 0,
      'font scaled up in full view'
    ).toBeGreaterThanOrEqual(PINNED)
    await evalIn(page, `window.__canvasE2E.setFullView(null)`)
    expect(await pollEval(page, `!(${IN_MODAL})`, 4000), 'back on canvas').toBe(true)

    await awaitMarkersSettled(page, id)
    expect(
      await readMarkers(page, id),
      'every line survives the non-1-zoom full-view round-trip'
    ).toEqual(EXPECTED_MARKERS)
  })
})
