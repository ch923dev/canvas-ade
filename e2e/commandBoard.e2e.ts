import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @core Command board shell (Phase A) — the new `command` board type, against the REAL app.
 *
 * Pins the slivers the jsdom tier can't: the board mounts through BoardNode's per-type dispatch +
 * the lazy chunk, renders the orchestrator frame (titlebar seg · inert submit well · worker-pool
 * strip · empty lifecycle kanban), is a SINGLETON (one orchestrator face), and the collapse toggle
 * really resizes the board to the one-line rail and back.
 *
 * Board state is read as DATA via structured-arg page.evaluate (ids never interpolated into an
 * eval'd code string — the #82 / CodeQL js/bad-code-sanitization pattern). The base `page` fixture
 * resets the canvas before each test.
 */
const boardById = (
  page: Page,
  id: string
): Promise<{ id: string; type: string; h: number } | undefined> =>
  page.evaluate((boardId) => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as {
      id: string
      type: string
      h: number
    }[]
    return boards.find((b) => b.id === boardId)
  }, id)

const commandCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      ((globalThis as any).__canvasE2E.getBoards() as { type: string }[]).filter(
        (b) => b.type === 'command'
      ).length
  )

test.describe('@core command board shell (Phase A/B)', () => {
  test('renders the orchestrator frame: COMMAND tag · worker pool · empty kanban', async ({
    page
  }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)
    await expect(node.getByText('COMMAND', { exact: true })).toBeVisible()
    await expect(node.getByText('Worker pool')).toBeVisible()
    await expect(node.getByText('No tasks yet')).toBeVisible()
    await expect(node.getByText('Queued')).toBeVisible()
    await expect(node.getByText('Done', { exact: true })).toBeVisible()
  })

  test('is a singleton — a second add returns + selects the existing board', async ({ page }) => {
    const first = await seed(page, 'command')
    const second = await seed(page, 'command')
    expect(second).toBe(first)
    expect(await commandCount(page)).toBe(1)
  })

  test('the seg control switches the body from kanban to the groups view', async ({ page }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)
    await expect(node.getByText('No tasks yet')).toBeVisible()
    await node.getByRole('button', { name: 'Groups' }).click()
    await expect(node.getByText('No groups yet')).toBeVisible()
  })

  test('collapse shrinks the board to the rail; expand restores the height', async ({ page }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)
    const expanded = (await boardById(page, id))!.h
    expect(expanded).toBeGreaterThan(300)

    await node.getByRole('button', { name: /collapse/ }).click()
    await expect.poll(async () => (await boardById(page, id))?.h).toBe(136)
    // The rail roll-up replaces the kanban (the done fraction is its tail).
    await expect(node.getByText(/\d+ \/ \d+ done/)).toBeVisible()

    await node.getByRole('button', { name: /expand/ }).click()
    await expect.poll(async () => (await boardById(page, id))?.h).toBe(expanded)
    await expect(node.getByText('No tasks yet')).toBeVisible()
  })

  test('Phase B: submitting a task enqueues a Queued card (Enter + Dispatch button)', async ({
    page
  }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)
    await expect(node.getByText('No tasks yet')).toBeVisible()

    // Enter submits: a queued card appears and the empty hint clears.
    const input = node.locator('input.cmd-submit-input')
    await input.fill('Build the auth flow')
    await input.press('Enter')
    await expect(node.getByText('Build the auth flow')).toBeVisible()
    await expect(node.getByText('No tasks yet')).toHaveCount(0)

    // The Dispatch button submits a second task → two cards live in the queue.
    await input.fill('Add dark mode')
    await node.getByRole('button', { name: /Dispatch/ }).click()
    await expect(node.getByText('Add dark mode')).toBeVisible()
    await expect(node.getByText('Build the auth flow')).toBeVisible()
  })
})
