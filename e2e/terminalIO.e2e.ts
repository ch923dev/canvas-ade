// e2e/terminalIO.e2e.ts
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const readInput = (id: string) => `window.__canvasE2E.readTerminalInput(${JSON.stringify(id)})`

test.describe('terminal I/O', () => {
  test('Shift+Enter posts \\x1b\\r (newline insert), not a bare \\r', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
    // Synthetic keydown with explicit shiftKey (reliable for chord probes).
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'Enter', shiftKey: true })`
    )
    const sawNewline = await pollEval(page, `${readInput(id)}.includes('\\u001b\\r')`, 3000)
    expect(sawNewline, 'shift+enter posted ESC+CR').toBe(true)
  })
})
