// e2e/terminalIO.e2e.ts
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, mainCall, pollCall, seed } from './helpers'

/** Concatenated bytes the terminal posted to its PTY — read as a VALUE (structured clone), so the
 *  board id is never spliced into page code. */
const readInput = (page: Page, id: string): Promise<string> =>
  callE2E<string>(page, { m: 'readTerminalInput', a: [id] })
/** Whole xterm framebuffer for a board, read the same way. */
const readBuf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })

/** Poll a predicate over the recorded PTY input. The comparison runs HERE, in Node (the
 *  terminalScrollback `pollScale` shape), so no needle or id ever reaches the page as code.
 *  Same boolean contract as `pollEval`. */
async function pollInput(
  page: Page,
  id: string,
  pred: (v: string) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => pred(await readInput(page, id)), { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

/** `pollInput` for the terminal buffer text. */
async function pollBuf(
  page: Page,
  id: string,
  pred: (buf: string) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => pred((await readBuf(page, id)) ?? ''), { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@terminal terminal I/O', () => {
  test('Shift+Enter posts LF (Ctrl+J newline), never ESC+CR or a bare \\r', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await callE2E(page, { m: 'focusTerminal', a: [id] })
    await callE2E(page, { m: 'clearTerminalInput', a: [id] })
    // Synthetic keydown with explicit shiftKey (reliable for chord probes).
    await callE2E(page, { m: 'dispatchTerminalKey', a: [id, { key: 'Enter', shiftKey: true }] })
    // LF (0x0A = Ctrl+J) is the universal newline claude inserts in every terminal. The old ESC+CR
    // (`\x1b\r`) form was ConPTY-fragile (ESC split from CR → cancel+submit, no newline). It must be
    // EXACTLY LF: carries the newline, no ESC byte rides along, and it is not a bare CR. See TERMINAL_NEWLINE.
    // Recorded input may also carry benign async terminal reports (e.g. a focus-in report),
    // so assert the SPECIFIC contract: LF (0x0A) is posted, and the old ConPTY-fragile ESC+CR is
    // not. String.fromCharCode keeps the control byte out of the source literal (the comparison
    // itself now runs here in Node — nothing reaches the page as code).
    const sawLf = await pollInput(page, id, (v) => v.includes(String.fromCharCode(10)), 3000)
    expect(sawLf, 'Shift+Enter posts LF (0x0A)').toBe(true)
    const raw = await readInput(page, id)
    const escCr = String.fromCharCode(0x1b) + String.fromCharCode(13)
    expect(
      raw.includes(escCr),
      `Shift+Enter must not post the ConPTY-fragile ESC+CR; recorded ${JSON.stringify(raw)}`
    ).toBe(false)
  })

  test('Ctrl+C with a selection copies it to the clipboard', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await callE2E(page, { m: 'focusTerminal', a: [id] })
    // Wait for the terminal to write something to its buffer before selecting.
    await pollBuf(page, id, (buf) => buf.trim().length > 0, 8000)
    // Select 5 cells on the first row and copy.
    await callE2E(page, { m: 'selectTerminal', a: [id, 0, 0, 5] })
    const sel = await callE2E<string>(page, { m: 'terminalSelection', a: [id] })
    await callE2E(page, { m: 'dispatchTerminalKey', a: [id, { key: 'c', ctrlKey: true }] })
    await page.waitForTimeout(200) // settle the async clipboard.writeText IPC
    const copied = await mainCall<string>(electronApp, 'readClipboardText')
    expect(copied).toBe(sel)
    expect(copied.length).toBeGreaterThan(0)
  })

  test('Ctrl+V pastes clipboard text into the terminal', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await callE2E(page, { m: 'focusTerminal', a: [id] })
    await callE2E(page, { m: 'clearTerminalInput', a: [id] })
    await mainCall(electronApp, 'putTextOnClipboard', 'HELLO_PASTE_123')
    await callE2E(page, { m: 'dispatchTerminalKey', a: [id, { key: 'v', ctrlKey: true }] })
    const pasted = await pollInput(page, id, (v) => v.includes('HELLO_PASTE_123'), 3000)
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
      await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`)
      await callE2E(page, { m: 'focusTerminal', a: [id] })
      await callE2E(page, { m: 'clearTerminalInput', a: [id] })
      await mainCall(electronApp, 'putRedBitmapOnClipboard', 4, 4)
      await callE2E(page, { m: 'dispatchTerminalKey', a: [id, { key: 'v', ctrlKey: true }] })
      // The injected payload is a quoted path ending in .png inside .canvas/tmp.
      const injected = await pollInput(
        page,
        id,
        (v) => v.includes('.canvas') && v.includes('paste-') && v.includes('.png'),
        4000
      )
      expect(injected, 'a staged .png path was injected').toBe(true)
      // And the staged file actually exists on disk.
      const raw = await readInput(page, id)
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
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    // Let the launchCommand's PTY output settle FIRST, then frame + zoom out so the camera
    // scale would otherwise break selection.
    await pollBuf(page, id, (buf) => buf.includes('ready'), 8000)
    await callE2E(page, { m: 'fitView', a: [id] })
    await evalIn(page, `window.__canvasE2E.setZoom(0.6)`)
    await page.waitForTimeout(150)
    // Known content on row 0 — written AFTER the PTY settled so a late shell chunk can't
    // overwrite/scroll it. Poll until xterm has actually rendered it onto row 0 before
    // measuring cells (the write + render is async).
    await callE2E(page, { m: 'focusTerminal', a: [id] })
    await callE2E(page, { m: 'resetTerminalWrite', a: [id, 'ABCDEFGHIJKLMNOPQRST'] })
    await pollBuf(page, id, (buf) => buf.startsWith('ABCDEFGHIJ'), 3000)
    // Drag from clearly INSIDE cell 0 to clearly inside cell 10 (real OS mouse input).
    // Use non-center intra-cell fractions: xterm rounds at the exact half-cell boundary
    // (ceil), so a cell-CENTER anchor can resolve to either neighbour (off-by-one). 0.25
    // is unambiguously in cell 0 → the selection anchors deterministically at 'A'.
    const p0 = await callE2E<{ x: number; y: number }>(page, {
      m: 'terminalCellPoint',
      a: [id, 0, 0, 0.25]
    })
    const p1 = await callE2E<{ x: number; y: number }>(page, {
      m: 'terminalCellPoint',
      a: [id, 10, 0, 0.75]
    })
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
    const sel = await callE2E<string>(page, { m: 'terminalSelection', a: [id] })
    // With the shim, the selection starts at A and spans roughly the first ~10 cells.
    // Without it, the zoom-0.6 mapping would land ~6 cells short (wrong prefix/length).
    expect(sel.startsWith('ABCDEFGHIJ'), `selection was "${sel}"`).toBe(true)
  })

  test('drag-select is correct in FULL VIEW while the camera is zoomed (shim defers to z=1)', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    await pollBuf(page, id, (buf) => buf.includes('ready'), 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(0.6)`)
    await callE2E(page, { m: 'setFullView', a: [id] })
    await page.waitForTimeout(300)
    await callE2E(page, { m: 'resetTerminalWrite', a: [id, 'ABCDEFGHIJKLMNOPQRST'] })
    await pollBuf(page, id, (buf) => buf.includes('ABCDEFGHIJ'), 4000)
    await callE2E(page, { m: 'focusTerminal', a: [id] })
    const p0 = await callE2E<{ x: number; y: number }>(page, {
      m: 'terminalCellPoint',
      a: [id, 0, 0, 0.25, 0.5]
    })
    const p1 = await callE2E<{ x: number; y: number }>(page, {
      m: 'terminalCellPoint',
      a: [id, 10, 0, 0.75, 0.5]
    })
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
    const sel = await callE2E<string>(page, { m: 'terminalSelection', a: [id] })
    expect(sel.startsWith('ABCDEFGHIJ'), `full-view selection was "${sel}"`).toBe(true)
    await evalIn(page, `window.__canvasE2E.setFullView(null)`)
  })

  test('F10: no application menu on Windows/Linux (Alt+V reaches xterm)', async ({
    electronApp
  }) => {
    const isNull = await mainCall<boolean>(electronApp, 'applicationMenuIsNull')
    expect(isNull, 'app menu is null on non-darwin so Alt+V is free').toBe(true)
  })
})
