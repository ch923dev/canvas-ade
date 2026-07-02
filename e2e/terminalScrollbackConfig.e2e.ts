// e2e/terminalScrollbackConfig.e2e.ts
//
// Phase 3 — configurable + persisted terminal scrollback. Drives the REAL pipeline:
//   • the xterm constructor reads resolveInitialScrollback (sticky default else 2000),
//   • a live effect on board.scrollback sets term.options.scrollback WITHOUT respawning the PTY,
//   • the Settings → Appearance preset chips patch board.scrollback + write the sticky default.
// The pure clamp/sticky helpers are unit-tested (terminalScrollback.test.ts); this covers the
// integration the units cannot. Named `…Config` so it does NOT collide with the Phase-1 full-view
// spec `terminalScrollback.e2e.ts`.
//
// Determinism: boards launch `exit`, so the PTY dies and emits no more bytes; term.options are set
// at construction independent of PTY state, so we only wait for the mount.
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { evalIn, openInspectorSection, pollEval, seed } from './helpers'

const liveScrollback = (id: string) =>
  `window.__canvasE2E.terminalScrollback(${JSON.stringify(id)})`
const readBuf = (id: string) => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
// Read the persisted board pin via a STRUCTURED ARG to page.evaluate — never interpolate the id
// into an eval'd code string (CodeQL js/bad-code-sanitization; the newTerminal.e2e.ts convention).
const boardScrollback = (page: Page, id: string): Promise<number | undefined> =>
  page.evaluate(
    (a) => (globalThis as any).__canvasE2E.getBoards().find((b: any) => b.id === a)?.scrollback,
    id
  )

// Clear the per-machine sticky default so a test that asserts the BASELINE isn't tainted by an
// earlier test (the Electron instance — hence localStorage — is shared across specs).
const clearSticky = (page: Page) =>
  evalIn(page, `window.localStorage.removeItem('ca.terminal.scrollback')`)

async function seedMounted(page: Page): Promise<string> {
  const id = await seed(page, 'terminal', { launchCommand: 'exit' })
  await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
  return id
}

test.describe('@terminal configurable scrollback', () => {
  test('defaults to 2000; a live edit applies without losing the session (no respawn)', async ({
    page
  }) => {
    await clearSticky(page)
    const id = await seedMounted(page)

    // Fresh terminal with no sticky/pin → the SLICE-012 default.
    expect(await pollEval(page, `${liveScrollback(id)} === 2000`, 6000), 'default 2000').toBe(true)

    // A known buffer so we can prove the session SURVIVES a scrollback change.
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, 'SENTINEL-LINE')`
    )
    expect(await pollEval(page, `(${readBuf(id)} || '').includes('SENTINEL-LINE')`, 6000)).toBe(
      true
    )

    // Patch scrollback (not a spawn dep) → the live effect raises term.options.scrollback in place.
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(id)}, { scrollback: 10000 })`
    )
    expect(
      await pollEval(page, `${liveScrollback(id)} === 10000`, 6000),
      'live-applied without respawn'
    ).toBe(true)
    // The buffer is intact → no respawn (a respawn would have cleared it).
    expect(
      await pollEval(page, `(${readBuf(id)} || '').includes('SENTINEL-LINE')`, 4000),
      'session preserved'
    ).toBe(true)
  })

  test('Settings → Appearance → a preset chip persists the pin and applies it live', async ({
    page
  }) => {
    await clearSticky(page)
    const id = await seedMounted(page)
    await evalIn(page, `window.__canvasE2E.setSelection([${JSON.stringify(id)}])`)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

    // P5: the ⚙ cluster is gone — the dialog opens via Inspector › Configuration › Edit….
    await openInspectorSection(page, 'Configuration')
    await page.locator('[data-test="inspector-configure"]').click()
    const dialog = page.locator('[data-test="new-terminal-dialog"]')
    await expect(dialog).toBeVisible()

    // The control lives on the Appearance tab.
    await dialog.getByRole('button', { name: 'Appearance' }).click()
    await expect(dialog.locator('[data-test="terminal-scrollback"]')).toBeVisible()
    // Default chip is pre-selected (board has no pin, sticky cleared → 2000).
    await expect(dialog.locator('[data-test="scrollback-2000"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Pick 50,000 and apply.
    await dialog.locator('[data-test="scrollback-50000"]').click()
    await page.locator('[data-test="new-terminal-create"]').click()
    await expect(dialog).toHaveCount(0)

    await expect
      .poll(() => boardScrollback(page, id), { timeout: 6000, message: 'pin persisted' })
      .toBe(50000)
    expect(await pollEval(page, `${liveScrollback(id)} === 50000`, 6000), 'applied live').toBe(true)
  })

  test('a new terminal inherits the sticky last-used default', async ({ page }) => {
    // Simulate a prior dialog apply having written the sticky default.
    await evalIn(page, `window.localStorage.setItem('ca.terminal.scrollback', '10000')`)
    const id = await seedMounted(page)

    // Construction read the sticky → 10000, with NO per-board pin (it just follows the default).
    expect(await pollEval(page, `${liveScrollback(id)} === 10000`, 6000), 'inherited sticky').toBe(
      true
    )
    await expect
      .poll(() => boardScrollback(page, id), { timeout: 4000, message: 'no pin' })
      .toBeUndefined()
    await clearSticky(page)
  })
})
