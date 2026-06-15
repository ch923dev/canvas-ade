/**
 * D4-B keyboard-first canvas (audit A3/A4) -- the real-app slivers jsdom can't prove:
 *  - real-OS key delivery through the ONE window keymap (the mid-dispatch listener-removal
 *    class only real input catches). The Tab-cycle test is the keeper that proves real keys
 *    reach that listener; arrow-move / Alt-resize / Enter-focus ride the SAME listener, so
 *    their deltas, clamps and key-repeat-burst -> ONE-undo coalescing are pinned as pure
 *    logic in useBoardKeyboardNav.test.tsx (the move handler keys off event ORDER, not
 *    e.repeat -- a synthetic keydown burst is byte-equivalent to OS key-repeat).
 *    (The A3 focus-return-from-a-focused-NATIVE-preview test was dropped in OS-3 Phase 5:
 *    OSR is the default engine and never takes OS keyboard focus — its keyboard routes
 *    through a renderer composition-proxy textarea, so there is no native focus to return.)
 *  - the negative probes: Tab/arrows from a focused xterm or planning well must NOT drive
 *    board selection -- only REAL focus on those surfaces exercises the whitelist guard.
 * The component contract (cycle order, deltas, clamps, checkpoint discipline) is pinned in
 * useBoardKeyboardNav.test.tsx. (dx-audit MT-2 / PR-4 removed the arrow-burst, Alt-resize
 * and Enter-focus e2e tests -- fully redundant with that contract + the Tab delivery sliver.)
 *
 * Renderer state crosses via structured-arg page.evaluate -- ids flow as DATA, never
 * interpolated into eval'd code (CodeQL js/bad-code-sanitization, #82 pattern).
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'

interface BoardLite {
  id: string
  x: number
  y: number
  w: number
  h: number
}

const getSelection = (page: Page): Promise<string[]> =>
  evalIn<string[]>(page, `window.__canvasE2E.getSelection()`)

const boardOf = (page: Page, id: string): Promise<BoardLite | undefined> =>
  page.evaluate((boardId) => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as BoardLite[]
    const b = boards.find((x) => x.id === boardId)
    return b ? { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h } : undefined
  }, id)

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((sel) => (globalThis as any).__canvasE2E.setSelection(sel), ids)

/** Seed `n` planning boards (cheap: no PTY, no native view). seedBoard staggers x at a
 *  shared y, so spatial reading order (y, then x) === seed order. Selection cleared. */
async function seedPlanningRow(page: Page, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await seed(page, 'planning'))
  await select(page, [])
  await evalIn(page, `window.__canvasE2E.fitView()`)
  await page.waitForTimeout(300)
  return ids
}

test.describe('@chrome board keyboard nav (real OS input, D4-B)', () => {
  test('Tab cycles selection in reading order; Shift+Tab reverses; wraps', async ({ page }) => {
    const [a, b, c] = await seedPlanningRow(page, 3)

    await page.keyboard.press('Tab') // nothing selected -> enters at the first board
    await expect.poll(() => getSelection(page)).toEqual([a])
    await page.keyboard.press('Tab')
    await expect.poll(() => getSelection(page)).toEqual([b])
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => getSelection(page)).toEqual([a])
    await page.keyboard.press('Shift+Tab') // wraps backward to the last board
    await expect.poll(() => getSelection(page)).toEqual([c])
  })

  test('negative: Tab/arrows in a focused xterm do not drive board selection', async ({ page }) => {
    const termId = await seed(page, 'terminal')
    const planId = await seed(page, 'planning')
    await select(page, [planId])
    const before = (await boardOf(page, planId))!

    // Focus the terminal's xterm (its helper textarea takes real focus).
    await expect
      .poll(() =>
        page.evaluate((id) => (globalThis as any).__canvasE2E.terminalMounted(id), termId)
      )
      .toBe(true)
    await page.evaluate((id) => (globalThis as any).__canvasE2E.focusTerminal(id), termId)
    await expect
      .poll(() => evalIn<string>(page, `(document.activeElement?.className || '')`))
      .toContain('xterm-helper-textarea')

    await page.keyboard.press('Tab')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)
    // Board selection and geometry are untouched -- the keys belonged to the terminal.
    expect(await getSelection(page)).toEqual([planId])
    expect((await boardOf(page, planId))!.x).toBe(before.x)
  })

  test('negative: arrows in a focused planning well nudge the ELEMENT, never the board', async ({
    page
  }) => {
    const planId = await seed(page, 'planning')
    await page.evaluate(
      ({ boardId, elements }) => {
        ;(globalThis as any).__canvasE2E.patchBoard(boardId, { elements })
      },
      {
        boardId: planId,
        elements: [
          {
            id: 'kb-neg',
            kind: 'note',
            x: 40,
            y: 40,
            w: 156,
            h: 96,
            tint: 'yellow',
            text: 'N',
            rotation: 0
          }
        ]
      }
    )
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const boardBefore = (await boardOf(page, planId))!

    // Real grip click: selects the note + native focus routing lands on the well
    // (the D3-C precondition).
    await page
      .locator(`[data-id="${planId}"] .pl-note-grip`)
      .first()
      .click({ position: { x: 6, y: 6 } })
    await expect
      .poll(() => evalIn<string>(page, `(document.activeElement?.className || '')`))
      .toContain('pl-well')

    await page.keyboard.press('ArrowRight')
    // The element nudged (D3-C owns arrows there)...
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const boards = (globalThis as any).__canvasE2E.getBoards() as {
            id: string
            elements?: { id: string; x: number }[]
          }[]
          return boards.find((b) => b.id === id)?.elements?.find((e) => e.id === 'kb-neg')?.x
        }, planId)
      )
      .toBe(41)
    // ...and the BOARD did not move (the whitelist guard kept the canvas keymap out).
    expect((await boardOf(page, planId))!.x).toBe(boardBefore.x)

    // Tab from the well must not cycle board selection either.
    const selBefore = await getSelection(page)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    expect(await getSelection(page)).toEqual(selBefore)
  })
})
