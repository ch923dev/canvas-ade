// e2e/terminalFont.e2e.ts
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const fontOf = (id: string) => `window.__canvasE2E.terminalFontSize(${JSON.stringify(id)})`

test.describe('terminal font resize', () => {
  test('Ctrl+- shrinks the live font and persists it on the board', async ({ page }) => {
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
