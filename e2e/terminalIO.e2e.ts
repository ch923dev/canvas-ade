// e2e/terminalIO.e2e.ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

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

  test('Ctrl+C with a selection copies it to the clipboard', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    // Wait for the terminal to write something to its buffer before selecting.
    await pollEval(
      page,
      `(window.__canvasE2E.readTerminal(${JSON.stringify(id)}) ?? '').trim().length > 0`,
      8000
    )
    // Select 5 cells on the first row and copy.
    await evalIn(page, `window.__canvasE2E.selectTerminal(${JSON.stringify(id)}, 0, 0, 5)`)
    const sel = await evalIn<string>(page, `window.__canvasE2E.terminalSelection(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'c', ctrlKey: true })`
    )
    await page.waitForTimeout(200) // settle the async clipboard.writeText IPC
    const copied = await mainCall<string>(electronApp, 'readClipboardText')
    expect(copied).toBe(sel)
    expect(copied.length).toBeGreaterThan(0)
  })

  test('Ctrl+V pastes clipboard text into the terminal', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
    await mainCall(electronApp, 'putTextOnClipboard', 'HELLO_PASTE_123')
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'v', ctrlKey: true })`
    )
    const pasted = await pollEval(page, `${readInput(id)}.includes('HELLO_PASTE_123')`, 3000)
    expect(pasted, 'pasted text reached the PTY input').toBe(true)
  })
})
