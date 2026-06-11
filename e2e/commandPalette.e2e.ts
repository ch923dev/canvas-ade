import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * D4-A command palette — the real-input slivers jsdom can't prove:
 *  - the Ctrl+K / ? chords arriving through the real OS path into the window keymap
 *    (mid-dispatch listener-removal class — D1-B/C lesson, real input only),
 *  - the Esc LAYERING against the capture-phase full-view listener (palette closes
 *    first, full view second — the [data-palette-open] yield),
 *  - the rename verb's close→intent→title-input focus handoff across Modal's
 *    focus-restore (ordering is timing-real, not simulated),
 *  - ADR 0002: a live native preview detaches while the palette is up.
 * The component contract (filtering, roving active row, registry gating) is pinned
 * in the palette unit/integration tier.
 */
const palette = (page: Page) => page.locator('[data-test=command-palette]')
const boardCount = (page: Page): Promise<number> =>
  evalIn<number>(page, `window.__canvasE2E.getBoards().length`)
const runtimeLive = (id: string): string =>
  `!!(window.__canvasE2E.getRuntime(${JSON.stringify(id)}) || {}).live`

test.describe('command palette (real OS input)', () => {
  test('Ctrl+K opens focused; type-to-filter + Enter runs the verb (board created)', async ({
    page
  }) => {
    await seed(page, 'planning')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(200)
    const before = await boardCount(page)

    await page.keyboard.press('Control+k')
    await expect(palette(page)).toBeVisible()
    // Modal initial focus = the search input, so typing filters immediately.
    await page.keyboard.type('new terminal')
    await expect(page.locator('[data-test=palette-row-new-terminal]')).toBeVisible()
    await expect(page.locator('[data-test=palette-row-tidy]')).toHaveCount(0)
    await page.keyboard.press('Enter')

    await expect(palette(page)).toHaveCount(0)
    await expect.poll(() => boardCount(page)).toBe(before + 1)
  })

  test('Esc closes; Ctrl+K toggles (second chord closes without running anything)', async ({
    page
  }) => {
    await seed(page, 'planning')
    const before = await boardCount(page)

    await page.keyboard.press('Control+k')
    await expect(palette(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)

    await page.keyboard.press('Control+k')
    await expect(palette(page)).toBeVisible()
    await page.keyboard.press('Control+k') // toggle — the chord fires even from the input
    await expect(palette(page)).toHaveCount(0)
    expect(await boardCount(page)).toBe(before)
  })

  test('? opens straight to the shortcuts view', async ({ page }) => {
    await seed(page, 'planning')
    await page.keyboard.press('?')
    await expect(palette(page)).toBeVisible()
    await expect(palette(page).locator('.cp-title')).toHaveText('Keyboard shortcuts')
    // The sheet lists rows that are NOT palette verbs — the registry is the one source.
    await expect(palette(page).getByText('Newline without submitting')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)
  })

  test('Esc layering vs full view: first Esc closes the palette, second exits full view', async ({
    page
  }) => {
    // A URL-less browser board full-views as plain HTML (state card) — focus stays in
    // the DOM so the real chord reaches the window keymap (a full-view TERMINAL's xterm
    // swallows Ctrl+K by design — that path is pinned as a shortcuts-sheet row instead).
    const id = await seed(page, 'browser')
    await evalIn(page, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(id)})`)
    await expect(page.locator('.fullview-scrim')).toBeVisible()
    await page.waitForTimeout(250)

    await page.keyboard.press('Control+k')
    await expect(palette(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)
    // The capture-phase listener yielded: full view MUST still be up after Esc #1.
    await expect(page.locator('.fullview-scrim')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('.fullview-scrim')).toHaveCount(0)
  })

  test('rename verb: palette closes, then the title editor opens focused (intent handoff)', async ({
    page
  }) => {
    const id = await seed(page, 'planning')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await evalIn(page, `window.__canvasE2E.setSelection(${JSON.stringify([id])})`)
    await page.waitForTimeout(200)

    await page.keyboard.press('Control+k')
    await expect(palette(page)).toBeVisible()
    await page.keyboard.type('rename')
    await expect(page.locator('[data-test=palette-row-rename-board]')).toBeVisible()
    await page.keyboard.press('Enter')

    // The intent fires one macrotask after close; the input must end up focused
    // (Modal's focus-restore ran first — ordering only a real run can prove).
    const input = page.locator('.board-title-edit')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    await input.fill('renamed via palette')
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        page.evaluate((boardId) => {
          const boards = (globalThis as any).__canvasE2E.getBoards() as {
            id: string
            title: string
          }[]
          return boards.find((b) => b.id === boardId)?.title
        }, id)
      )
      .toBe('renamed via palette')
  })

  test('open palette detaches a live native preview; close reattaches (ADR 0002)', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(250)
    const liveBefore = await pollEval(page, runtimeLive(id), 8000)
    expect(liveBefore, 'live before open').toBe(true)

    await page.keyboard.press('Control+k')
    await expect(palette(page)).toBeVisible()
    await expect.poll(() => evalIn<boolean>(page, runtimeLive(id))).toBe(false)

    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)
    const liveAfter = await pollEval(page, runtimeLive(id), 8000)
    expect(liveAfter, 'reattached on close').toBe(true)
  })
})
