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
    const sel = await evalIn<string>(
      page,
      `window.__canvasE2E.terminalSelection(${JSON.stringify(id)})`
    )
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

  test('Ctrl+V with a clipboard image stages a PNG and injects its path', async ({
    page,
    electronApp
  }) => {
    // Needs a project dir so .canvas/tmp has a home.
    const proj = await mainCall<string>(
      electronApp,
      'createTempProject',
      'canvas-e2e-img-',
      'imgproj'
    )
    try {
      const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
      await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`)
      await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
      await mainCall(electronApp, 'putRedBitmapOnClipboard', 4, 4)
      await evalIn(
        page,
        `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'v', ctrlKey: true })`
      )
      // The injected payload is a quoted path ending in .png inside .canvas/tmp.
      const injected = await pollEval(
        page,
        `${readInput(id)}.includes('.canvas') && ${readInput(id)}.includes('paste-') && ${readInput(id)}.includes('.png')`,
        4000
      )
      expect(injected, 'a staged .png path was injected').toBe(true)
      // And the staged file actually exists on disk.
      const raw = await evalIn<string>(page, readInput(id))
      const m = raw.match(/"([^"]+\.png)"/)
      expect(m, 'path is quoted in the input').not.toBeNull()
      const exists = await mainCall<boolean>(electronApp, 'fileExists', m![1])
      expect(exists, 'staged file exists on disk').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', proj)
    }
  })

  test('drag-select tracks the cursor at zoom ≠ 1 (scale-correct selection)', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    // Let the launchCommand's PTY output settle FIRST, then frame + zoom out so the camera
    // scale would otherwise break selection.
    await pollEval(
      page,
      `(window.__canvasE2E.readTerminal(${JSON.stringify(id)}) ?? '').includes('ready')`,
      8000
    )
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, `window.__canvasE2E.setZoom(0.6)`)
    await page.waitForTimeout(150)
    // Known content on row 0 — written AFTER the PTY settled so a late shell chunk can't
    // overwrite/scroll it. Poll until xterm has actually rendered it onto row 0 before
    // measuring cells (the write + render is async).
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, 'ABCDEFGHIJKLMNOPQRST')`
    )
    await pollEval(
      page,
      `(window.__canvasE2E.readTerminal(${JSON.stringify(id)}) ?? '').startsWith('ABCDEFGHIJ')`,
      3000
    )
    // Drag from clearly INSIDE cell 0 to clearly inside cell 10 (real OS mouse input).
    // Use non-center intra-cell fractions: xterm rounds at the exact half-cell boundary
    // (ceil), so a cell-CENTER anchor can resolve to either neighbour (off-by-one). 0.25
    // is unambiguously in cell 0 → the selection anchors deterministically at 'A'.
    const p0 = await evalIn<{ x: number; y: number }>(
      page,
      `window.__canvasE2E.terminalCellPoint(${JSON.stringify(id)}, 0, 0, 0.25)`
    )
    const p1 = await evalIn<{ x: number; y: number }>(
      page,
      `window.__canvasE2E.terminalCellPoint(${JSON.stringify(id)}, 10, 0, 0.75)`
    )
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: Math.round(p0.x),
      y: Math.round(p0.y),
      button: 'left',
      clickCount: 1
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseMove',
      x: Math.round((p0.x + p1.x) / 2),
      y: Math.round(p0.y),
      button: 'left'
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseMove',
      x: Math.round(p1.x),
      y: Math.round(p1.y),
      button: 'left'
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: Math.round(p1.x),
      y: Math.round(p1.y),
      button: 'left',
      clickCount: 1
    })
    await page.waitForTimeout(100)
    const sel = await evalIn<string>(
      page,
      `window.__canvasE2E.terminalSelection(${JSON.stringify(id)})`
    )
    // With the shim, the selection starts at A and spans roughly the first ~10 cells.
    // Without it, the zoom-0.6 mapping would land ~6 cells short (wrong prefix/length).
    expect(sel.startsWith('ABCDEFGHIJ'), `selection was "${sel}"`).toBe(true)
  })
})
