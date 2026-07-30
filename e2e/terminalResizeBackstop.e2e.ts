// e2e/terminalResizeBackstop.e2e.ts
//
// Phase 5 · S2 — lossless drag-resize. A board resize that changes the terminal's COLUMN count
// would otherwise hit xterm's buffer reflow (#5319), which trims + duplicates scrollback. The
// backstop snapshots → resizes → resets → re-writes so every line survives. This is the corruption
// repro: seed 120 marker lines into a dead (`exit`) PTY, drive a real board resize wider then
// narrower via setBoardSize (→ resizeBoard → RF re-render → ResizeObserver → fitWhole), and assert
// EXACTLY 120 markers remain after each (a trim drops below 120; a dup climbs above it). 70-char
// lines wrap at the narrow width and unwrap at the wide one, so the re-wrap path is exercised.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, pollCall, seed } from './helpers'

// Typed VALUE reader — the id crosses as a real argument (structured clone), never spliced into
// an eval'd code string (CodeQL js/bad-code-sanitization).
const readBuf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })
const markerCount = (b: string | null): number => ((b ?? '').match(/L\d{3}/g) || []).length
// 120 lines with stable L### markers. Built HERE and passed to `resetTerminalWrite` as an
// argument (it used to be a generator expression evaluated in the page — the same code-string
// sink the ids were).
const WRITE_LINES = Array.from(
  { length: 120 },
  (_, i) => 'L' + String(i).padStart(3, '0') + '=' + 'x'.repeat(70)
).join('\r\n')

/** Poll a predicate over the terminal buffer text — the comparison runs HERE in Node. Same
 *  boolean contract as `pollEval`. */
async function pollBuf(
  page: Page,
  id: string,
  pred: (b: string | null) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect.poll(async () => pred(await readBuf(page, id)), { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@terminal resize backstop — lossless drag-resize (S2)', () => {
  test('every scrollback line survives a widen + narrow (no reflow trim/dup)', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit', width: 760, height: 420 })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    expect(
      await pollBuf(page, id, (b) => (b || '').includes('process exited'), 8000),
      'shell exited (PTY drained — established grid, no further output to race)'
    ).toBe(true)
    await callE2E(page, { m: 'resetTerminalWrite', a: [id, WRITE_LINES] })
    expect(
      await pollBuf(page, id, (b) => markerCount(b) === 120, 6000),
      'seeded exactly 120 marker lines'
    ).toBe(true)

    // WIDEN: cols increase → backstop snapshots + re-wraps wide. Every marker survives.
    await callE2E(page, { m: 'setBoardSize', a: [id, 1280, 420] })
    expect(
      await pollBuf(page, id, (b) => markerCount(b) === 120, 6000),
      'all 120 survive the widen (no trim/dup)'
    ).toBe(true)

    // NARROW: cols decrease → the classic reflow trim/dup case; lines re-wrap to 2 rows each.
    await callE2E(page, { m: 'setBoardSize', a: [id, 520, 420] })
    expect(
      await pollBuf(page, id, (b) => markerCount(b) === 120, 6000),
      'all 120 survive the narrow (no trim/dup)'
    ).toBe(true)

    // Spot-check the boundary markers are intact (count alone can't catch a swapped pair).
    const buf = await readBuf(page, id)
    expect(buf).toContain('L000=')
    expect(buf).toContain('L059=')
    expect(buf).toContain('L119=')
  })
})
