// e2e/terminalFont.e2e.ts
//
// Flake note (terminal-crisp umbrella): a Ctrl+-/Ctrl+0 font change is applied ASYNCHRONOUSLY — the
// custom key handler advances the live font ref, and the apply effect writes `term.options.fontSize`
// on the NEXT React commit (paint). Deep in the full Linux-Docker matrix run (this is test ~174/213,
// under sustained xvfb memory/CPU pressure) that commit can lag past a tight 3s poll, so the assert
// `fontOf === before-1` would intermittently time out on the slow leg (Windows + isolated Linux are
// fast). The handler is always attached before we dispatch (we poll `terminalMounted` first), so the
// keypress is NOT dropped — it's pure apply latency. Give the font-apply polls the same 8s headroom
// the mount polls already use; `pollEval` returns the instant the value lands, so fast runs (~0.5s)
// pay nothing. (Not masking a bug — the apply is correct, the test was just under-provisioned for the
// contended leg.)
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const fontOf = (id: string) => `window.__canvasE2E.terminalFontSize(${JSON.stringify(id)})`

// Reset the sticky font to a deterministic value with headroom before each test so the
// suite is idempotent regardless of how many prior runs have ratcheted the localStorage
// value down toward MIN_TERMINAL_FONT (8). Without this reset the sticky drifts to 8
// after enough runs and Ctrl+- becomes a no-op (already at floor), making both tests fail.
// 14 is well above MIN (8) and below MAX (22), so Ctrl+- reliably produces 13.
const KNOWN_STICKY = '14'
const resetSticky = (page: Parameters<typeof evalIn>[0]) =>
  // JSON.stringify (not raw interpolation) keeps CodeQL happy + matches the JSON.stringify(id)
  // pattern used elsewhere here — the value lands as a quoted JS string literal ("14").
  evalIn(
    page,
    `window.localStorage.setItem('ca.terminal.fontSize', ${JSON.stringify(KNOWN_STICKY)})`
  )

test.describe('@terminal terminal font resize', () => {
  test.afterEach(async ({ page }) => {
    await evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '12.5')`)
  })

  test('Ctrl+- shrinks the live font and persists it on the board', async ({ page }) => {
    // Seed the terminal AFTER resetting the sticky so it opens at the known value.
    await resetSticky(page)
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    const before = await evalIn<number>(page, fontOf(id))
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: '-', ctrlKey: true })`
    )
    const shrank = await pollEval(page, `${fontOf(id)} < ${before}`, 8000)
    expect(shrank, 'live font shrank by Ctrl+-').toBe(true)
    const boards = await evalIn<Array<{ id: string; fontSize?: number }>>(
      page,
      `window.__canvasE2E.getBoards()`
    )
    const persisted = boards.find((b) => b.id === id)?.fontSize
    expect(persisted).toBe(before - 1)
  })

  test('a synchronous burst of Ctrl+- steps once per notch (no step-skip)', async ({ page }) => {
    // Regression for the stale-xterm-option read: nudgeFont must step from the synchronously
    // advanced liveFontRef, not xterm's options.fontSize (updated only after the apply effect runs
    // next paint). Firing 4 ticks in ONE round-trip guarantees no paint between them — the apply
    // effect cannot run mid-burst — so a stale read would collapse all 4 into a single step.
    await resetSticky(page) // 14 -> headroom for 4 steps down to 10 (> MIN 8)
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    const before = await evalIn<number>(page, fontOf(id))
    await evalIn(
      page,
      `for (let i = 0; i < 4; i++) window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: '-', ctrlKey: true })`
    )
    const dropped = await pollEval(page, `${fontOf(id)} === ${before - 4}`, 8000)
    expect(dropped, '4 synchronous Ctrl+- ticks dropped the font by exactly 4').toBe(true)
  })

  test('undo reverts the first font nudge on an unpinned terminal', async ({ page }) => {
    // Regression for the sticky-fallback drift: an unpinned board's apply effect must fall back to
    // its BORN font (frozen at mount), not the live sticky (which this board's own nudge mutates).
    // Otherwise undo clears the pin to undefined but the font stays at the nudged size.
    await resetSticky(page)
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    const born = await evalIn<number>(page, fontOf(id)) // == sticky (14); board has no pin yet
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: '-', ctrlKey: true })`
    )
    await pollEval(page, `${fontOf(id)} === ${born - 1}`, 8000) // nudged down one
    await evalIn(page, `window.__canvasE2E.undo()`)
    const reverted = await pollEval(page, `${fontOf(id)} === ${born}`, 8000)
    expect(reverted, 'undo restored the unpinned font to its born size').toBe(true)
    const boards = await evalIn<Array<{ id: string; fontSize?: number }>>(
      page,
      `window.__canvasE2E.getBoards()`
    )
    expect(
      boards.find((b) => b.id === id)?.fontSize,
      'pin cleared back to undefined'
    ).toBeUndefined()
  })

  test('a new terminal inherits the sticky last-used size', async ({ page }) => {
    // Reset sticky BEFORE seeding A so both A and B start from a known baseline.
    await resetSticky(page)
    const a = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(a)})`, 8000)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(a)})`)
    const start = await evalIn<number>(page, fontOf(a))
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(a)}, { key: '-', ctrlKey: true })`
    )
    // Assert on the integer PIN + sticky (metric-independent), NOT the live render font. The
    // clip-free no-clip step-down (#125) nudges term.options.fontSize a sub-pixel BELOW the pin
    // whenever the grid would overflow — which it does on the Linux matrix leg's mono-font metrics
    // (DejaVu) but not on Windows (Cascadia) — so an exact `fontOf === start-1` LIVE check is fragile
    // across environments (this test passed on Windows but failed the Linux leg every run). The pin
    // (board.fontSize) and the sticky localStorage ARE the "last-used size" contract and are
    // metric-independent — the sibling Ctrl+- test asserts the pin and is reliable on both legs.
    const pinDropped = await pollEval(
      page,
      `window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(a)})?.fontSize === ${JSON.stringify(start - 1)}`,
      8000
    )
    expect(pinDropped, 'A pin shrank to the sticky size (start-1) before seeding B').toBe(true)
    const stickySaved = await evalIn<number>(
      page,
      `parseFloat(window.localStorage.getItem('ca.terminal.fontSize'))`
    )
    expect(stickySaved, 'sticky last-used size updated to start-1').toBe(start - 1)
    const b = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(b)})`, 8000)
    // B is UNPINNED → it reads the sticky on construction. Its render font must be the sticky size
    // (start-1 = 13), clearly above the 12.5 factory default it would show if inheritance were broken.
    // `> 12.5` is robust to the sub-pixel step-down (a 13 sticky steps to ~12.6 at most, still > 12.5),
    // unlike the old exact `=== sticky` live check.
    const inherited = await pollEval(page, `${fontOf(b)} > 12.5`, 8000)
    expect(inherited, 'new terminal opened at the sticky size, not the 12.5 factory default').toBe(
      true
    )
  })

  test('Reset font (Ctrl+0) is per-board — it does NOT touch the global sticky default', async ({
    page
  }) => {
    await resetSticky(page) // 14
    const a = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(a)})`, 8000)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(a)})`)
    const start = await evalIn<number>(page, fontOf(a)) // 14
    // Nudge A down → the sticky default becomes 13.
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(a)}, { key: '-', ctrlKey: true })`
    )
    // Metric-independent: assert the PIN dropped (the live font can be sub-pixel-stepped by the clip
    // guard on the Linux leg's font metrics — see the sibling "inherits the sticky" test's note).
    await pollEval(
      page,
      `window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(a)})?.fontSize === ${JSON.stringify(start - 1)}`,
      8000
    )
    // Reset A (Ctrl+0): A returns to ~the factory default (12.5) but must NOT rewrite the sticky.
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(a)}, { key: '0', ctrlKey: true })`
    )
    await pollEval(page, `Math.abs(${fontOf(a)} - 12.5) < 0.5`, 8000) // back to factory (step-down tolerant)
    // The CORE claim: Ctrl+0 is per-board — the GLOBAL sticky is unchanged (still start-1). Asserted on
    // the sticky localStorage directly, which is the metric-independent source of truth.
    const stickyKept = await evalIn<number>(
      page,
      `parseFloat(window.localStorage.getItem('ca.terminal.fontSize'))`
    )
    expect(stickyKept, 'Ctrl+0 did not rewrite the global sticky').toBe(start - 1)
    // A new terminal still inherits the user's sticky (start-1 = 13), not the per-board reset value (12.5).
    const b = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(b)})`, 8000)
    const keptSticky = await pollEval(page, `${fontOf(b)} > 12.5`, 8000)
    expect(keptSticky, 'new terminal kept the sticky size, not the 12.5 reset value').toBe(true)
  })
})
