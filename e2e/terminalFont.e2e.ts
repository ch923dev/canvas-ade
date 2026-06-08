// e2e/terminalFont.e2e.ts
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
  evalIn(page, `window.localStorage.setItem('ca.terminal.fontSize', '${KNOWN_STICKY}')`)

test.describe('terminal font resize', () => {
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
    const shrank = await pollEval(page, `${fontOf(id)} < ${before}`, 3000)
    expect(shrank, 'live font shrank by Ctrl+-').toBe(true)
    const persisted = await evalIn<number>(
      page,
      `window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(id)}).fontSize`
    )
    expect(persisted).toBe(before - 1)
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
    const aShrank = await pollEval(page, `${fontOf(a)} === ${start - 1}`, 3000)
    expect(aShrank, 'terminal A shrank before seeding B').toBe(true)
    const sticky = start - 1
    const b = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(b)})`, 8000)
    const inherited = await pollEval(page, `${fontOf(b)} === ${sticky}`, 3000)
    expect(inherited, 'new terminal opened at the sticky size').toBe(true)
  })
})
