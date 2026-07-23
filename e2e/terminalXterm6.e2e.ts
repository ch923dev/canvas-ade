// e2e/terminalXterm6.e2e.ts
//
// T3 · xterm 5.5 → 6.0 migration coverage. Two gaps the epic called out:
//
//  1. A busy streaming buffer that is RESIZED and FULL-VIEW-ENTERED *mid-stream* must render without
//     litter/corruption. The resize-backstop spec drives a single `setBoardSize` on a fully-seeded
//     buffer; this one interleaves writes with a widen AND an ANIMATED full-view enter/exit (the T1b
//     resize-storm transition + the counterScale refit), which 6.0's reflow / synchronized-output
//     changes bear directly on. Every one of 120 markers must survive each transition (a reflow trim
//     drops below 120; a dup climbs above it).
//
//  2. DEC 2026 synchronized output — the sequences Claude Code emits that 5.5 IGNORED and 6.0 honors
//     natively (the closest app-side mitigation for the scrollback-litter class). Assert 6.0 parses a
//     BSU/ESU pair (`term.modes.synchronizedOutputMode` flips) and the buffered frame renders intact.
//
// A dead PTY (`launchCommand: 'exit'`) gives an established grid with no live output racing the direct
// e2e writes, so the marker invariant is deterministic.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const readBuf = (id: string): string => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
const markerCount = (id: string): string => `(${readBuf(id)}.match(/L\\d{3}/g) || []).length`
const writeTerm = (id: string, dataExpr: string): string =>
  `window.__canvasE2E.writeTerminal(${JSON.stringify(id)}, ${dataExpr})`
const syncOut = (id: string): string =>
  `window.__canvasE2E.terminalSyncOutput(${JSON.stringify(id)})`
const sizeBoard = (id: string, w: number, h: number): string =>
  `window.__canvasE2E.setBoardSize(${JSON.stringify(id)}, ${w}, ${h})`
const mounted = (id: string): string => `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`
// A batch of marker lines L{from..to} — 70-char bodies so they wrap at a narrow width and unwrap wide
// (the re-wrap path). The marker `L\d{3}` appears once per logical line regardless of wrapping.
const lines = (from: number, to: number): string =>
  `Array.from({length: ${to - from}}, (_, i) => 'L' + String(i + ${from}).padStart(3,'0') + '=' + 'x'.repeat(70)).join('\\r\\n') + '\\r\\n'`

test.describe('@terminal xterm 6.0 — streaming survives mid-stream resize + full view; DEC 2026', () => {
  test('every streamed line survives a mid-stream widen + animated full-view enter/exit', async ({
    page
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit', width: 820, height: 460 })
    await pollEval(page, mounted(id), 8000)
    expect(
      await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000),
      'shell exited — established grid, no live output racing the direct writes'
    ).toBe(true)

    // Stream chunk 1 (40 lines).
    await evalIn(page, writeTerm(id, lines(0, 40)))
    expect(await pollEval(page, `${markerCount(id)} === 40`, 6000), 'chunk 1 landed').toBe(true)

    // WIDEN mid-stream (cols up → S2 backstop re-wraps wide), then stream chunk 2 (→ 80).
    await evalIn(page, sizeBoard(id, 1280, 460))
    await evalIn(page, writeTerm(id, lines(40, 80)))
    expect(
      await pollEval(page, `${markerCount(id)} === 80`, 6000),
      'chunk 2 after the widen — all 80 survive (no trim/dup)'
    ).toBe(true)

    // ANIMATED full-view ENTER mid-stream — the T1b transition + counterScale refit to the modal —
    // then stream chunk 3 (→ 120) at the scaled font/grid.
    await evalIn(page, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(id)})`)
    await page.waitForTimeout(700) // > FULLVIEW_MS (320) + the enter refit settle
    await evalIn(page, writeTerm(id, lines(80, 120)))
    expect(
      await pollEval(page, `${markerCount(id)} === 120`, 6000),
      'chunk 3 in full view — all 120 survive the enter refit'
    ).toBe(true)

    // EXIT full view — the reverse refit back to the board grid rides the backstop too.
    await evalIn(page, 'window.__canvasE2E.closeFullViewAnimated()')
    await page.waitForTimeout(700)
    expect(
      await pollEval(page, `${markerCount(id)} === 120`, 6000),
      'all 120 survive the full-view exit refit (no trim/dup)'
    ).toBe(true)

    // Boundary spot-check — count alone can't catch a swapped/duplicated pair.
    const buf = await evalIn<string>(page, readBuf(id))
    expect(buf).toContain('L000=')
    expect(buf).toContain('L079=')
    expect(buf).toContain('L119=')
  })

  test('DEC 2026 synchronized output is parsed + honored (the 6.0 capability the pipeline relies on)', async ({
    page
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit', width: 640, height: 360 })
    await pollEval(page, mounted(id), 8000)
    await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000)

    // At rest: not in synchronized mode.
    expect(await evalIn<boolean>(page, syncOut(id)), 'synchronized-output off at rest').toBe(false)

    // BSU (`CSI ?2026 h`): 6.0 ENTERS synchronized output; on 5.5 this sequence was ignored (stays
    // false). This is the assertion that would fail on the pre-bump terminal.
    await evalIn(page, writeTerm(id, JSON.stringify('\x1b[?2026h')))
    expect(
      await pollEval(page, `${syncOut(id)} === true`, 4000),
      '6.0 entered DEC 2026 synchronized output on BSU'
    ).toBe(true)

    // Frame content is buffered while synchronized; ESU (`CSI ?2026 l`) exits the mode and the frame
    // renders intact — 2026 batches the render, it never drops data.
    await evalIn(page, writeTerm(id, JSON.stringify('SYNC-FRAME-OK\r\n\x1b[?2026l')))
    expect(
      await pollEval(page, `${syncOut(id)} === false`, 4000),
      'exited synchronized output on ESU'
    ).toBe(true)
    expect(
      await pollEval(page, `(${readBuf(id)} || '').includes('SYNC-FRAME-OK')`, 4000),
      'buffered frame rendered intact after ESU'
    ).toBe(true)
  })
})
