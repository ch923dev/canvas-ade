// e2e/terminalTheme.e2e.ts — Lane B terminal theming (DOM renderer)
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const J = (v: unknown): string => JSON.stringify(v)
const bgOf = (id: string) => `(window.__canvasE2E.terminalThemeBg(${J(id)}) || '').toLowerCase()`
const familyOf = (id: string) => `window.__canvasE2E.terminalFontFamily(${J(id)})`

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
    await pollEval(page, `window.__canvasE2E.terminalMounted(${J(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    // Drain the PTY before the direct buffer write (the terminalScrollback discipline): the
    // shell launches `exit`, and once the bridge's "[process exited]" line lands no further
    // bytes can arrive. Without this, a slow shell banner — held in the write coalescer until
    // the first fit under batch load — flushed AFTER the marker write and repainted over row 0,
    // breaking the position-sensitive selection probe below (the batch-order flake). The xterm
    // + buffer stay live after exit; the no-respawn contract (themeId must never be a spawn
    // dep) is provable on a drained term exactly the same way.
    expect(
      await pollEval(
        page,
        `(window.__canvasE2E.readTerminal(${J(id)}) || '').includes('process exited')`,
        8000
      ),
      'shell exited (PTY drained — no further output)'
    ).toBe(true)

    // An unthemed board resolves to the Canvas default palette (--inset bg).
    expect(await evalIn<string>(page, bgOf(id))).toBe('#0e0e10')

    // Write a unique marker into the buffer — a respawn would dispose the term and wipe it.
    const MARKER = 'THEMETESTMARKER'
    await evalIn(page, `window.__canvasE2E.resetTerminalWrite(${J(id)}, ${J(MARKER)})`)
    const landed = await pollEval(
      page,
      `(window.__canvasE2E.selectTerminal(${J(id)}, 0, 0, ${MARKER.length}), window.__canvasE2E.terminalSelection(${J(id)}) === ${J(MARKER)})`,
      3000
    )
    expect(landed, 'marker written into the live buffer').toBe(true)

    // Switch theme exactly the way the dialog Apply does (updateBoard with a themeId patch).
    await evalIn(page, `window.__canvasE2E.patchBoard(${J(id)}, { themeId: 'dracula' })`)

    // Live apply: the ANSI palette repaints on the SAME term (Dracula background #282a36).
    const applied = await pollEval(page, `${bgOf(id)} === '#282a36'`, 3000)
    expect(applied, 'theme applied live without a respawn').toBe(true)

    // No respawn: the buffer marker survives (a respawn disposes the term + resets the buffer).
    await evalIn(page, `window.__canvasE2E.selectTerminal(${J(id)}, 0, 0, ${MARKER.length})`)
    const survived = await evalIn<string>(page, `window.__canvasE2E.terminalSelection(${J(id)})`)
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
    await pollEval(page, `window.__canvasE2E.terminalMounted(${J(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)

    // Default 'system' resolves to the hinted OS terminal stack (--term-mono).
    const start = await evalIn<string>(page, familyOf(id))
    expect(start).toContain('Cascadia Mono')

    await evalIn(page, `window.__canvasE2E.patchBoard(${J(id)}, { fontFamilyId: 'courier' })`)
    const applied = await pollEval(page, `/Courier/.test(${familyOf(id)} || '')`, 3000)
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
    await pollEval(page, `window.__canvasE2E.terminalMounted(${J(id)})`, 8000)

    // The terminal renders as the Canvas default (degrade-at-resolve) — never broken/empty.
    expect(await evalIn<string>(page, bgOf(id)), 'unknown theme degraded to Canvas').toBe('#0e0e10')

    // The stored id is PRESERVED verbatim (not rewritten) — forward-compat (ADR 0007).
    const boards = await evalIn<Array<{ id: string; themeId?: string }>>(
      page,
      `window.__canvasE2E.getBoards()`
    )
    expect(boards.find((b) => b.id === id)?.themeId).toBe('some-future-theme')
  })
})
