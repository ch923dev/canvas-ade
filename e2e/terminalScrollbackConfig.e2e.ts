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
import { callE2E, evalIn, openInspectorSection, pollCall, seed } from './helpers'

// Typed VALUE readers — the id crosses as a real argument (structured clone), never spliced into
// an eval'd code string (CodeQL js/bad-code-sanitization).
const liveScrollback = (page: Page, id: string): Promise<number | undefined> =>
  callE2E<number | undefined>(page, { m: 'terminalScrollback', a: [id] })
const readBuf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })
// Read the persisted board pin via a STRUCTURED ARG to page.evaluate — never interpolate the id
// into an eval'd code string (CodeQL js/bad-code-sanitization; the newTerminal.e2e.ts convention).
const boardScrollback = (page: Page, id: string): Promise<number | undefined> =>
  page.evaluate(
    (a) => (globalThis as any).__canvasE2E.getBoards().find((b: any) => b.id === a)?.scrollback,
    id
  )

/** Poll the live xterm scrollback option until it equals `want` — the comparison runs HERE in
 *  Node, so the expected value never reaches the page. Same boolean contract as `pollEval`. */
async function pollScrollback(
  page: Page,
  id: string,
  want: number,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => (await liveScrollback(page, id)) === want, { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

/** Poll a predicate over the terminal buffer text. Same boolean contract as `pollEval`. */
async function pollBuf(
  page: Page,
  id: string,
  pred: (b: string | null) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect.poll(async () => pred(await readBuf(page, id)), { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

// Clear the per-machine sticky default so a test that asserts the BASELINE isn't tainted by an
// earlier test (the Electron instance — hence localStorage — is shared across specs).
const clearSticky = (page: Page) =>
  evalIn(page, `window.localStorage.removeItem('ca.terminal.scrollback')`)

async function seedMounted(page: Page): Promise<string> {
  const id = await seed(page, 'terminal', { launchCommand: 'exit' })
  await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
  // Drain the PTY before any direct buffer write (the terminalScrollback discipline): wait for
  // the bridge's "[process exited]" line so no late ConPTY banner — held in the write coalescer
  // until the first fit under batch load — can flush AFTER a spec's resetTerminalWrite and clear
  // the sentinel with its screen-repaint sequences (the batch-order flake).
  await pollBuf(page, id, (b) => (b || '').includes('process exited'), 8000)
  return id
}

test.describe('@terminal configurable scrollback', () => {
  test('defaults to 2000; a live edit applies without losing the session (no respawn)', async ({
    page
  }) => {
    await clearSticky(page)
    const id = await seedMounted(page)

    // Fresh terminal with no sticky/pin → the SLICE-012 default.
    expect(await pollScrollback(page, id, 2000, 6000), 'default 2000').toBe(true)

    // A known buffer so we can prove the session SURVIVES a scrollback change.
    await callE2E(page, { m: 'resetTerminalWrite', a: [id, 'SENTINEL-LINE'] })
    expect(await pollBuf(page, id, (b) => (b || '').includes('SENTINEL-LINE'), 6000)).toBe(true)

    // Patch scrollback (not a spawn dep) → the live effect raises term.options.scrollback in place.
    await callE2E(page, { m: 'patchBoard', a: [id, { scrollback: 10000 }] })
    expect(await pollScrollback(page, id, 10000, 6000), 'live-applied without respawn').toBe(true)
    // The buffer is intact → no respawn (a respawn would have cleared it).
    expect(
      await pollBuf(page, id, (b) => (b || '').includes('SENTINEL-LINE'), 4000),
      'session preserved'
    ).toBe(true)
  })

  test('Settings → Appearance → a preset chip persists the pin and applies it live', async ({
    page
  }) => {
    await clearSticky(page)
    const id = await seedMounted(page)
    await callE2E(page, { m: 'setSelection', a: [[id]] })
    await callE2E(page, { m: 'fitView', a: [id] })

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
    expect(await pollScrollback(page, id, 50000, 6000), 'applied live').toBe(true)
  })

  test('a new terminal inherits the sticky last-used default', async ({ page }) => {
    // Simulate a prior dialog apply having written the sticky default.
    await evalIn(page, `window.localStorage.setItem('ca.terminal.scrollback', '10000')`)
    const id = await seedMounted(page)

    // Construction read the sticky → 10000, with NO per-board pin (it just follows the default).
    expect(await pollScrollback(page, id, 10000, 6000), 'inherited sticky').toBe(true)
    await expect
      .poll(() => boardScrollback(page, id), { timeout: 4000, message: 'no pin' })
      .toBeUndefined()
    await clearSticky(page)
  })
})
