// e2e/terminalTheme.e2e.ts — Lane B terminal theming (DOM renderer)
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, pollCall, seed } from './helpers'

/** Value readers (structured clone — no board id is ever spliced into page code). */
const bgOf = async (page: Page, id: string): Promise<string> =>
  ((await callE2E<string | undefined>(page, { m: 'terminalThemeBg', a: [id] })) || '').toLowerCase()
const familyOf = (page: Page, id: string): Promise<string | undefined> =>
  callE2E<string | undefined>(page, { m: 'terminalFontFamily', a: [id] })
const readBuf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })

/** Poll a Node-side check until true (the terminalScrollback poller shape, generalized — each poll
 *  below compares a different reader, so the check closes over the reader). Same boolean contract
 *  as `pollEval`. */
async function pollTrue(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(check, { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@terminal terminal theming', () => {
  // The persistent _electron userData carries localStorage across specs, so clear the sticky
  // theme/font keys after each test to keep an unthemed seed deterministic (defaults to Canvas/System).
  test.afterEach(async ({ page }) => {
    await evalIn(
      page,
      `window.localStorage.removeItem('ca.terminal.themeId'); window.localStorage.removeItem('ca.terminal.fontFamilyId')`
    )
  })

  test('a theme switch applies live, persists, and does NOT respawn the PTY', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit' })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    // Drain the PTY before the direct buffer write (the terminalScrollback discipline): the
    // shell launches `exit`, and once the bridge's "[process exited]" line lands no further
    // bytes can arrive. Without this, a slow shell banner — held in the write coalescer until
    // the first fit under batch load — flushed AFTER the marker write and repainted over row 0,
    // breaking the position-sensitive selection probe below (the batch-order flake). The xterm
    // + buffer stay live after exit; the no-respawn contract (themeId must never be a spawn
    // dep) is provable on a drained term exactly the same way.
    expect(
      await pollTrue(
        async () => ((await readBuf(page, id)) || '').includes('process exited'),
        8000
      ),
      'shell exited (PTY drained — no further output)'
    ).toBe(true)

    // An unthemed board resolves to the Canvas default palette (--inset bg).
    expect(await bgOf(page, id)).toBe('#0e0e10')

    // Write a unique marker into the buffer — a respawn would dispose the term and wipe it.
    const MARKER = 'THEMETESTMARKER'
    await callE2E(page, { m: 'resetTerminalWrite', a: [id, MARKER] })
    // Select-then-read in ONE callE2E batch (one synchronous turn, like the old comma-expression);
    // the === MARKER comparison runs here in Node.
    const landed = await pollTrue(
      async () =>
        (await callE2E<string>(
          page,
          { m: 'selectTerminal', a: [id, 0, 0, MARKER.length] },
          { m: 'terminalSelection', a: [id] }
        )) === MARKER,
      3000
    )
    expect(landed, 'marker written into the live buffer').toBe(true)

    // Switch theme exactly the way the dialog Apply does (updateBoard with a themeId patch).
    await callE2E(page, { m: 'patchBoard', a: [id, { themeId: 'dracula' }] })

    // Live apply: the ANSI palette repaints on the SAME term (Dracula background #282a36).
    const applied = await pollTrue(async () => (await bgOf(page, id)) === '#282a36', 3000)
    expect(applied, 'theme applied live without a respawn').toBe(true)

    // No respawn: the buffer marker survives (a respawn disposes the term + resets the buffer).
    await callE2E(page, { m: 'selectTerminal', a: [id, 0, 0, MARKER.length] })
    const survived = await callE2E<string>(page, { m: 'terminalSelection', a: [id] })
    expect(survived, 'PTY/buffer survived the theme switch (no respawn)').toBe(MARKER)

    // Persisted on the board.
    const boards = await evalIn<Array<{ id: string; themeId?: string }>>(
      page,
      `window.__canvasE2E.getBoards()`
    )
    expect(boards.find((b) => b.id === id)?.themeId).toBe('dracula')
  })

  test('a font-family switch applies live and persists', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)

    // Default 'system' resolves to the hinted OS terminal stack (--term-mono).
    const start = await familyOf(page, id)
    expect(start).toContain('Cascadia Mono')

    await callE2E(page, { m: 'patchBoard', a: [id, { fontFamilyId: 'courier' }] })
    const applied = await pollTrue(
      async () => /Courier/.test((await familyOf(page, id)) || ''),
      3000
    )
    expect(applied, 'font family applied live (Courier)').toBe(true)

    const boards = await evalIn<Array<{ id: string; fontFamilyId?: string }>>(
      page,
      `window.__canvasE2E.getBoards()`
    )
    expect(boards.find((b) => b.id === id)?.fontFamilyId).toBe('courier')
  })

  test('an unknown themeId degrades to the Canvas default on load (id preserved)', async ({
    page
  }) => {
    // Simulate a doc written by a NEWER build: the board carries a theme id this build doesn't know.
    const id = await seed(page, 'terminal', {
      themeId: 'some-future-theme',
      launchCommand: 'echo ready'
    })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)

    // The terminal renders as the Canvas default (degrade-at-resolve) — never broken/empty.
    expect(await bgOf(page, id), 'unknown theme degraded to Canvas').toBe('#0e0e10')

    // The stored id is PRESERVED verbatim (not rewritten) — forward-compat (ADR 0007).
    const boards = await evalIn<Array<{ id: string; themeId?: string }>>(
      page,
      `window.__canvasE2E.getBoards()`
    )
    expect(boards.find((b) => b.id === id)?.themeId).toBe('some-future-theme')
  })
})
