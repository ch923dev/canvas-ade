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
      await page.waitForTimeout(60) // let the ResizeObserver fit + xterm render settle
      const geo = await evalIn<Geo | null>(page, geoOf(id))
      if (geo && geo.overflow > TOLERANCE) offenders.push({ h, ...geo })
    }
    expect(
      offenders,
      `bottom-row clip at heights (overflow px shown): ${JSON.stringify(offenders, null, 2)}`
    ).toEqual([])
  })
})
