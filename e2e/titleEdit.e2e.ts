import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * D2-A inline board title edit — real-app slivers the jsdom tier can't prove:
 * real-OS key delivery into the mount-stable window listeners (the mid-dispatch
 * listener-removal class from D1-B/C — only real input catches it), the
 * double-click swap living inside React Flow's drag-handle/dblclick-zoom
 * machinery, and the F2 typing guard against xterm's hidden helper textarea.
 * The component contract (commit/cancel/no-op/undo) is pinned in
 * BoardFrame.titleedit.test.tsx.
 *
 * Renderer state is read via structured-arg page.evaluate — board ids flow as
 * DATA, never interpolated into an eval'd code string (CodeQL
 * js/bad-code-sanitization: a JSON.stringify'd value embedded in code can still
 * break out via U+2028/U+2029). Mirrors preview-align/evidence (#82 pattern).
 */
const titleOf = (page: Page, id: string): Promise<string | undefined> =>
  page.evaluate((boardId) => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as { id: string; title: string }[]
    return boards.find((b) => b.id === boardId)?.title
  }, id)
const selectOnly = (page: Page, id: string): Promise<void> =>
  page.evaluate((boardId) => {
    ;(globalThis as any).__canvasE2E.setSelection([boardId])
  }, id)

test.describe('inline board title edit (real OS input)', () => {
  test('double-click swaps to the input; typing + Enter commits to the store', async ({ page }) => {
    const id = await seed(page, 'planning')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)

    await page.locator(`[data-id="${id}"] .board-title`).dblclick()
    const input = page.locator('.board-title-edit')
    await expect(input).toBeVisible()
    await input.fill('renamed board')
    await page.keyboard.press('Enter')

    await expect(input).toHaveCount(0)
    expect(await titleOf(page, id)).toBe('renamed board')
    await expect(page.locator(`[data-id="${id}"] .board-title`)).toHaveText('renamed board')
  })

  test('real Escape cancels the edit (pins the mount-stable window-capture listener)', async ({
    page
  }) => {
    const id = await seed(page, 'planning')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const before = await titleOf(page, id)

    await page.locator(`[data-id="${id}"] .board-title`).dblclick()
    const input = page.locator('.board-title-edit')
    await expect(input).toBeVisible()
    await input.fill('throwaway draft')
    await page.keyboard.press('Escape')

    // Editor closed; the draft was discarded (the doneRef latch must also stop the
    // unmount blur from committing it).
    await expect(input).toHaveCount(0)
    expect(await titleOf(page, id)).toBe(before)
  })

  test('F2 on the single selected board opens the editor; Enter commits', async ({ page }) => {
    const id = await seed(page, 'planning')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await selectOnly(page, id)
    await page.waitForTimeout(300)

    await page.keyboard.press('F2')
    const input = page.locator('.board-title-edit')
    await expect(input).toBeVisible()
    await input.fill('f2 rename')
    await page.keyboard.press('Enter')

    expect(await titleOf(page, id)).toBe('f2 rename')
  })

  test('F2 while xterm owns focus stays with the terminal (no editor hijack)', async ({ page }) => {
    const id = await seed(page, 'terminal')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)

    // Click into the terminal: RF selects the board AND xterm's helper textarea takes
    // focus — the exact state where F2 must reach the agent, not the title editor.
    await page.locator('.xterm-screen').first().click()
    await expect
      .poll(() => evalIn<string>(page, `(document.activeElement?.className || '').toLowerCase()`))
      .toContain('xterm')
    expect(await titleOf(page, id)).toBeDefined()

    await page.keyboard.press('F2')
    await page.waitForTimeout(200)
    await expect(page.locator('.board-title-edit')).toHaveCount(0)
  })
})
