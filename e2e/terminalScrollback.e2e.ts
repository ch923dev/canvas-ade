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
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, pollCall, pollEval, seed } from './helpers'

const PINNED = 12.5 // the factory/sticky default font (reset in afterEach for determinism)

/** What `terminalCounterScale` reports. Read as a VALUE (see below) rather than probed through an
 *  expression string, so no id or baseline is ever spliced into page code. */
interface CounterScale {
  cols?: number
  rows?: number
  effectiveFont?: number
  hSlack?: number | null
  vSlack?: number | null
}
const scaleOf = (page: Page, id: string): Promise<CounterScale | null | undefined> =>
  callE2E<CounterScale | null | undefined>(page, { m: 'terminalCounterScale', a: [id] })
const readBuf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })

// 120 wrapping lines (each ~74 chars > any reasonable in-canvas column count), each uniquely tagged.
// Built HERE and passed to `resetTerminalWrite` as an argument — it used to be a generator
// expression evaluated in the page, which is the same code-string sink the ids were.
const WRITE_LINES = Array.from(
  { length: 120 },
  (_, i) => 'L' + String(i).padStart(3, '0') + '=' + 'x'.repeat(70)
).join('\r\n')
const EXPECTED_MARKERS = Array.from({ length: 120 }, (_, i) => 'L' + String(i).padStart(3, '0'))
// The board content is in the modal once the portal has relocated the live xterm there. A literal
// probe with nothing interpolated — the one shape `evalIn` is still for.
const IN_MODAL = `!!document.querySelector('.fullview-host .xterm')`
// Every line marker in buffer order. Each logical line contributes exactly ONE "L###" (at its start;
// wrapped continuation rows are bare x's). Lossless rewrap ⇒ exactly L000..L119, in order, no repeats.
const markers = (buf: string | null): string[] => (buf ?? '').match(/L\d{3}/g) ?? []

async function readMarkers(page: Page, id: string): Promise<string[]> {
  return markers(await readBuf(page, id))
}

// ── Phase-A flake instrumentation (scrollback-flake diagnosis lane, 2026-07-30) ──
// Logs, at each step, exactly what the predicates already read (values come back over
// callE2E; the read + serialization happen HERE in Node — nothing is spliced into page
// code). `terminalGeometry` is node-scoped so it reads null while the xterm lives in the
// full-view portal — that null is itself signal (in-modal probes rely on counterScale).
async function logProbe(page: Page, id: string, tag: string): Promise<void> {
  const s = await scaleOf(page, id).catch(() => 'ERR')
  const g = await callE2E<unknown>(page, { m: 'terminalGeometry', a: [id] }).catch(() => 'ERR')
  const nMarkers = markers(await readBuf(page, id).catch(() => null)).length
  console.log(`[scrollback-probe] ${tag} ${JSON.stringify({ s, g, nMarkers })}`)
}

/** Camera forensics: where the viewport sits when a test begins / after its zoom call —
 *  pins down which spec/test leaves the camera at the position that hides the seeded board. */
async function logCamera(page: Page, tag: string): Promise<void> {
  const vp = await callE2E<{ x: number; y: number; zoom: number }>(page, {
    m: 'getViewport',
    a: []
  }).catch(() => null)
  console.log(`[scrollback-probe] ${tag} ${JSON.stringify({ vp })}`)
}

/** Poll a predicate over the live counter-scale. The comparison runs HERE, in Node, so a baseline
 *  like `colsBefore` never has to reach the page at all. Same boolean contract as `pollEval`. */
async function pollScale(
  page: Page,
  id: string,
  pred: (s: CounterScale | null | undefined) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect.poll(async () => pred(await scaleOf(page, id)), { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

/** `pollScale` for the terminal buffer text. */
async function pollBuf(
  page: Page,
  id: string,
  pred: (buf: string) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => pred((await readBuf(page, id)) ?? ''), { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

// Poll until the column count stops changing (the re-raster fit + no-clip rAF loop and — since S3 —
// the async backstop rewrite settle a few frames after a change). Reading a still-settling value as
// a baseline would misjudge the grid; this mirrors the real flow (camera settles, THEN you maximize).
async function settledCols(page: Page, id: string): Promise<number | undefined> {
  let prev: number | undefined
  for (let i = 0; i < 24; i++) {
    const c = (await scaleOf(page, id))?.cols
    if (typeof c === 'number' && c === prev) return c
    prev = c
    await page.waitForTimeout(150)
  }
  return prev
}

// Rows analogue of settledCols — poll until term.rows stops changing (the in-canvas fit + no-clip
// loop settle a few frames after seeding). Used as the in-canvas baseline for the fill test.
async function settledRows(page: Page, id: string): Promise<number | undefined> {
  let prev: number | undefined
  for (let i = 0; i < 24; i++) {
    const r = (await scaleOf(page, id))?.rows
    if (typeof r === 'number' && r === prev) return r
    prev = r
    await page.waitForTimeout(150)
  }
  return prev
}

test.describe('@terminal full-view scrollback is preserved across the S3 backstop refit', () => {
  test.afterEach(async ({ page }) => {
    await callE2E(page, { m: 'setFullView', a: [null] })
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${PINNED}')`)
  })

  // Drain the live PTY before writing: the board launches `exit`, so the shell dies and can emit no
  // further bytes. We wait for the "[process exited]" marker the bridge prints, THEN reset+write our
  // block into the now-dead terminal — eliminating the live-shell race entirely (a live shell's
  // startup banner/prompt would otherwise stream in mid-test and its cursor-positioned redraw would
  // overwrite our lines, flaking under load). The xterm + buffer stay fully functional after exit;
  // full view and the refit logic operate on the board/term, independent of PTY state.
  async function fillBuffer(page: Page, id: string): Promise<void> {
    // best-effort, exactly as before: the buffer asserts below are the real gate
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    const exited = await pollBuf(page, id, (buf) => buf.includes('process exited'), 8000)
    if (!exited) {
      // Phase-A forensics for the paired-adjacency failure (this exact assert, every repro):
      // discriminates "board off-viewport ⇒ Lane-A liveness gate HOLDS the PTY bytes"
      // (held > 0, live false, buf empty — test-side visibility assumption) from "liveness
      // flag stale while visible" (live false but board ∩ viewport ≠ ∅ — a production bug)
      // from "PTY never spawned/emitted" (held 0, buf empty).
      const mounted = await callE2E<boolean>(page, { m: 'terminalMounted', a: [id] }).catch(
        () => 'ERR'
      )
      const live = await callE2E<boolean>(page, { m: 'terminalLive', a: [id] }).catch(() => 'ERR')
      const held = await callE2E<number>(page, { m: 'terminalHeldBytes', a: [id] }).catch(
        () => 'ERR'
      )
      const vp = await callE2E<{ x: number; y: number; zoom: number }>(page, {
        m: 'getViewport',
        a: []
      }).catch(() => null)
      const boards = await callE2E<
        Array<{ id: string; x: number; y: number; w: number; h: number }>
      >(page, { m: 'getBoards', a: [] }).catch(() => null)
      const b = boards?.find((bd) => bd.id === id)
      const buf = await readBuf(page, id)
      const win = await evalIn(page, `window.innerWidth + 'x' + window.innerHeight`)
      console.log(
        `[scrollback-probe] fill:exit-marker-missing ${JSON.stringify({
          mounted,
          live,
          held,
          vp,
          win,
          board: b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null,
          buf: buf === null ? null : { len: buf.length, tail: buf.slice(-160) }
        })}`
      )
    }
    expect(exited, 'shell exited (PTY drained — no further output)').toBe(true)
    await callE2E(page, { m: 'focusTerminal', a: [id] })
    await callE2E(page, { m: 'resetTerminalWrite', a: [id, WRITE_LINES] })
    const clean = await pollBuf(
      page,
      id,
      (buf) => markers(buf).length === EXPECTED_MARKERS.length,
      6000
    )
    if (!clean) await logProbe(page, id, 'fill:write-incomplete')
    expect(clean, 'clean written block present before the round-trip').toBe(true)
  }

  // The async backstop rewrite parses over frames — never diff markers mid-parse.
  async function awaitMarkersSettled(page: Page, id: string): Promise<void> {
    await pollBuf(page, id, (buf) => markers(buf).length === EXPECTED_MARKERS.length, 8000)
  }

  test('cols REFIT to the modal in full view (lossless); every line survives; cols restore on exit', async ({
    page
  }) => {
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${PINNED}')`)
    // A SQUARE board on a wide viewport: the modal's HEIGHT binds the font scale, so the old
    // frozen grid letterboxed the width (the user's "dead space at the right"). S3 must fill
    // that slack with real columns: cols in full view STRICTLY exceed the in-canvas count.
    const id = await seed(page, 'terminal', { launchCommand: 'exit', w: 520, h: 520 })
    await logCamera(page, 't1:post-seed')
    await callE2E(page, { m: 'setZoom', a: [1] }) // snapped working zoom (the common maximize case)
    await fillBuffer(page, id)

    expect(await readMarkers(page, id), 'sanity: all 120 lines present before').toEqual(
      EXPECTED_MARKERS
    )
    const colsBefore = await settledCols(page, id)
    expect(typeof colsBefore === 'number' && colsBefore > 0, 'sanity: cols read').toBe(true)

    // Two full-view round-trips — the cols-up-then-down cycle that corrupted the pre-A1 buffer
    // and that the S3 backstop must now survive losslessly.
    for (let i = 0; i < 2; i++) {
      await callE2E(page, { m: 'setFullView', a: [id] })
      expect(await pollEval(page, IN_MODAL, 4000), `relocated to modal (round ${i})`).toBe(true)
      // MECHANISM: the letterboxed width becomes real columns (the refit lands a few frames
      // after the portal settles — font seam applies, then the deferred backstop fit).
      expect(
        await pollScale(page, id, (s) => (s?.cols ?? 0) > (colsBefore ?? 0), 6000),
        `cols grew past the in-canvas count (round ${i})`
      ).toBe(true)
      expect(
        (await scaleOf(page, id))?.effectiveFont ?? 0,
        `font still scaled up in full view (round ${i})`
      ).toBeGreaterThanOrEqual(PINNED)
      // The right gutter is bounded to ~a cell + the 12px well pad once the refit settles
      // (hSlack = well.right − grid.right). The frozen build left hundreds of px here.
      expect(
        await pollScale(
          page,
          id,
          (s) =>
            s?.hSlack != null && s.hSlack >= -2 && s.hSlack <= (s.effectiveFont || 18) * 1.2 + 24,
          6000
        ),
        `grid fills the modal width without clipping (round ${i})`
      ).toBe(true)
      await callE2E(page, { m: 'setFullView', a: [null] })
      expect(await pollEval(page, `!(${IN_MODAL})`, 4000), `back on canvas (round ${i})`).toBe(true)
      // RESTORE: the exit refit settles back to the exact in-canvas grid (board unchanged,
      // font back to pinned ⇒ the fit re-proposes the same cols).
      expect(
        await pollScale(page, id, (s) => s?.cols === colsBefore, 6000),
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
    await logCamera(page, 't2:post-seed')
    await callE2E(page, { m: 'setZoom', a: [1] })
    await fillBuffer(page, id)

    const inCanvasRows = await settledRows(page, id)
    const inCanvasCols = await settledCols(page, id)
    expect((inCanvasRows ?? 0) > 0 && (inCanvasCols ?? 0) > 0, 'sanity: in-canvas grid read').toBe(
      true
    )

    await callE2E(page, { m: 'setFullView', a: [id] })
    expect(await pollEval(page, IN_MODAL, 4000), 'relocated to modal').toBe(true)

    // FILL: rows grow to fill the modal height (the refit lands a few frames after the portal
    // settles). More rows than in-canvas ⇒ no more bottom letterbox.
    expect(
      await pollScale(page, id, (s) => (s?.rows ?? 0) > (inCanvasRows ?? 0), 6000),
      'rows grew to fill the modal height'
    ).toBe(true)
    // FILLED, not clipped: once the open-stretch settles (transform → identity, so the rect reads are
    // layout-true), the grid bottom sits within ~one cell + the 12px well pad. The OLD font-only fill
    // left MANY cells (hundreds of px) of black gutter here; this bounds it to one cell (~font×1.4)
    // plus the padding. `vSlack` = well.bottom − grid.bottom (from terminalCounterScale, full-view-safe).
    expect(
      await pollScale(
        page,
        id,
        (s) =>
          s?.vSlack != null && s.vSlack >= -2 && s.vSlack <= (s.effectiveFont || 18) * 1.4 + 24,
        4000
      ),
      'grid fills the modal height without clipping (no big bottom gutter)'
    ).toBe(true)

    await callE2E(page, { m: 'setFullView', a: [null] })
    expect(await pollEval(page, `!(${IN_MODAL})`, 4000), 'back on canvas').toBe(true)

    // RESTORE: the exit refit settles back to the exact in-canvas grid.
    expect(
      await pollScale(page, id, (s) => s?.rows === inCanvasRows, 6000),
      'rows restored to the in-canvas count on exit'
    ).toBe(true)
    expect(
      await pollScale(page, id, (s) => s?.cols === inCanvasCols, 6000),
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
    await logCamera(page, 't3:post-seed')
    // A non-1 camera zoom: under the DOM renderer the in-canvas host rides the camera transform
    // directly (NO counter-scale — the render font stays pinned regardless of zoom). Full view
    // flips to the portal (font scales up via fullViewScale, then the S3 backstop refit) and back.
    // cols settle differently across that transition, but NO LINE may be lost/duped.
    await callE2E(page, { m: 'setZoom', a: [1.5] })
    expect(
      await pollEval(page, `Math.abs(window.__canvasE2E.getZoom() - 1.5) < 1e-6`, 4000),
      'camera settled at 1.5 (render font stays pinned in-canvas)'
    ).toBe(true)
    await fillBuffer(page, id)
    await logProbe(page, id, 'nz:filled')

    expect(await readMarkers(page, id), 'sanity: all 120 lines present before').toEqual(
      EXPECTED_MARKERS
    )

    await callE2E(page, { m: 'setFullView', a: [id] })
    expect(await pollEval(page, IN_MODAL, 4000), 'relocated to modal').toBe(true)
    await logProbe(page, id, 'nz:in-modal')
    // Full view scales the render font up (Pure A1's magnification is preserved) — font > pinned.
    // NOTE (Phase A): single-shot read — a null counterScale here reads as 0 and fails without
    // a poll; the probe line above records what the read actually saw.
    expect(
      (await scaleOf(page, id))?.effectiveFont ?? 0,
      'font scaled up in full view'
    ).toBeGreaterThanOrEqual(PINNED)
    await callE2E(page, { m: 'setFullView', a: [null] })
    expect(await pollEval(page, `!(${IN_MODAL})`, 4000), 'back on canvas').toBe(true)
    await logProbe(page, id, 'nz:back-on-canvas')

    await awaitMarkersSettled(page, id)
    const after = await readMarkers(page, id)
    // Marker forensics BEFORE the assert: a lost line shows as `missing`, a duplicated one as
    // `duped`, a reorder as inOrder:false — the toEqual diff alone buries this in 120 lines.
    const counts = new Map<string, number>()
    for (const m of after) counts.set(m, (counts.get(m) ?? 0) + 1)
    console.log(
      `[scrollback-probe] nz:final ${JSON.stringify({
        n: after.length,
        missing: EXPECTED_MARKERS.filter((m) => !counts.has(m)).slice(0, 12),
        duped: [...counts.entries()]
          .filter(([, c]) => c > 1)
          .map(([m]) => m)
          .slice(0, 12),
        inOrder: after.join(',') === EXPECTED_MARKERS.join(',')
      })}`
    )
    expect(after, 'every line survives the non-1-zoom full-view round-trip').toEqual(
      EXPECTED_MARKERS
    )
  })
})
