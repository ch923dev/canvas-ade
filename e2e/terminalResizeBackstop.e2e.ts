// e2e/terminalResizeBackstop.e2e.ts
//
// Phase 5 · S2 — lossless drag-resize. A board resize that changes the terminal's COLUMN count
// would otherwise hit xterm's buffer reflow (#5319), which trims + duplicates scrollback. The
// backstop snapshots → resizes → resets → re-writes so every line survives. This is the corruption
// repro: seed 120 marker lines into a dead (`exit`) PTY, drive a real board resize wider then
// narrower via setBoardSize (→ resizeBoard → RF re-render → ResizeObserver → fitWhole), and assert
// EXACTLY 120 markers remain after each (a trim drops below 120; a dup climbs above it). 70-char
// lines wrap at the narrow width and unwrap at the wide one, so the re-wrap path is exercised.
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const readBuf = (id: string): string => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
const markerCount = (id: string): string => `(${readBuf(id)}.match(/L\\d{3}/g) || []).length`
const sizeBoard = (id: string, w: number, h: number): string =>
  `window.__canvasE2E.setBoardSize(${JSON.stringify(id)}, ${w}, ${h})`
const WRITE_LINES = `Array.from({length: 120}, (_, i) => 'L' + String(i).padStart(3,'0') + '=' + 'x'.repeat(70)).join('\\r\\n')`

test.describe('@terminal resize backstop — lossless drag-resize (S2)', () => {
  test('every scrollback line survives a widen + narrow (no reflow trim/dup)', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit', width: 760, height: 420 })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    expect(
      await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000),
      'shell exited (PTY drained — established grid, no further output to race)'
    ).toBe(true)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, ${WRITE_LINES})`
    )
    expect(
      await pollEval(page, `${markerCount(id)} === 120`, 6000),
      'seeded exactly 120 marker lines'
    ).toBe(true)

    // WIDEN: cols increase → backstop snapshots + re-wraps wide. Every marker survives.
    await evalIn(page, sizeBoard(id, 1280, 420))
    expect(
      await pollEval(page, `${markerCount(id)} === 120`, 6000),
      'all 120 survive the widen (no trim/dup)'
    ).toBe(true)

    // NARROW: cols decrease → the classic reflow trim/dup case; lines re-wrap to 2 rows each.
    await evalIn(page, sizeBoard(id, 520, 420))
    expect(
      await pollEval(page, `${markerCount(id)} === 120`, 6000),
      'all 120 survive the narrow (no trim/dup)'
    ).toBe(true)

    // Spot-check the boundary markers are intact (count alone can't catch a swapped pair).
    const buf = await evalIn<string>(page, readBuf(id))
    expect(buf).toContain('L000=')
    expect(buf).toContain('L059=')
    expect(buf).toContain('L119=')
  })
})
