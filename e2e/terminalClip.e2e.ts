// e2e/terminalClip.e2e.ts
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

type Geo = {
  dpr: number
  rows: number
  cols: number
  cellHeight: number
  gridBottom: number
  wellBottom: number
  overflow: number
}
const geoOf = (id: string) => `window.__canvasE2E.terminalGeometry(${JSON.stringify(id)})`
const TOLERANCE = 1 // px -- sub-pixel rounding only; a clipped glyph is >=~6px

test.describe('terminal clip-free fit', () => {
  test.afterEach(async ({ page }) => {
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '12.5')`)
  })

  test('the grid never spills past the well across a height sweep', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    // Fill down to the last row so a clipped row shows a glyph, not whitespace.
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, Array.from({length: 60}, (_, i) => 'ROW' + i).join('\\r\\n'))`
    )
    const offenders: Array<{ h: number } & Geo> = []
    // Odd step hits fractional remainders that a coarse step would skip.
    for (let h = 200; h <= 620; h += 7) {
      await evalIn(page, `window.__canvasE2E.setBoardSize(${JSON.stringify(id)}, 460, ${h})`)
      // Settle the async fit (ResizeObserver + xterm render run off-frame) instead of a fixed
      // sleep. pollEval RETURNS on timeout (never throws), so a genuine clip falls through to the
      // read below and still lands in the offenders list — the diagnostic is preserved.
      await pollEval(page, `(${geoOf(id)})?.overflow <= ${TOLERANCE}`, 2000)
      const geo = await evalIn<Geo | null>(page, geoOf(id))
      if (geo && geo.overflow > TOLERANCE) offenders.push({ h, ...geo })
    }
    expect(
      offenders,
      `bottom-row clip at heights (overflow px shown): ${JSON.stringify(offenders, null, 2)}`
    ).toEqual([])
  })

  test('stays clip-free across font sizes', async ({ page }) => {
    // Reset sticky font for determinism (persistent userData dir carries localStorage across runs).
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '14')`)
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, Array.from({length: 60}, (_, i) => 'ROW' + i).join('\\r\\n'))`
    )
    const offenders: Array<{ font: number; h: number; overflow: number }> = []
    for (const font of [8, 11, 14, 18, 22]) {
      await evalIn(page, `window.__canvasE2E.setBoardFont(${JSON.stringify(id)}, ${font})`)
      await pollEval(page, `(${geoOf(id)})?.overflow <= ${TOLERANCE}`, 2000) // settle reactive apply + refit
      for (let h = 220; h <= 600; h += 11) {
        await evalIn(page, `window.__canvasE2E.setBoardSize(${JSON.stringify(id)}, 460, ${h})`)
        await pollEval(page, `(${geoOf(id)})?.overflow <= ${TOLERANCE}`, 2000) // settle, then read below
        const geo = await evalIn<Geo | null>(page, geoOf(id))
        if (geo && geo.overflow > TOLERANCE) offenders.push({ font, h, overflow: geo.overflow })
      }
    }
    expect(offenders, `clip across font×height: ${JSON.stringify(offenders, null, 2)}`).toEqual([])
  })
})
