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

const boardTypeCount = (page: Page, type: string): Promise<number> =>
  page.evaluate(
    (t) =>
      ((globalThis as any).__canvasE2E.getBoards() as { type: string }[]).filter(
        (b) => b.type === t
      ).length,
    type
  )
const commandCount = (page: Page): Promise<number> => boardTypeCount(page, 'command')

// Drive the trusted confirm modal like a human (the dispatch gate blocks on it). Mirrors mcp.e2e.ts.
const MODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
const APPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`

test.describe('@core command board shell (Phase A/B/C)', () => {
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

  test('Phase C: composition chips — Terminal locked, +Planning/+Browser opt-in', async ({
    page
  }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)
    // Terminal is always-on (locked); the two opt-ins start OFF (terminal-only default).
    await expect(node.getByText('Terminal', { exact: true })).toBeVisible()
    const planning = node.getByRole('button', { name: '+ Planning' })
    const browser = node.getByRole('button', { name: '+ Browser' })
    await expect(planning).toHaveAttribute('aria-pressed', 'false')
    await expect(browser).toHaveAttribute('aria-pressed', 'false')
    await browser.click()
    await expect(browser).toHaveAttribute('aria-pressed', 'true')
    await expect(planning).toHaveAttribute('aria-pressed', 'false') // independent toggles
  })

  test('Phase C: dispatch spawns a worker group + advances the card (confirm-gated)', async ({
    page
  }) => {
    test.slow() // real spawn → PTY → confirm gate → settle
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)
    await expect(node.getByText('No tasks yet')).toBeVisible()

    // Submit: the card appears immediately (synchronous enqueue) and the empty hint clears.
    const input = node.locator('input.cmd-submit-input')
    await input.fill('Wire the login form')
    await input.press('Enter')
    await expect(node.getByText('Wire the login form')).toBeVisible()
    await expect(node.getByText('No tasks yet')).toHaveCount(0)

    // The dispatch choreography spawns a worker terminal through the renderer→MAIN→renderer path…
    await expect.poll(async () => boardTypeCount(page, 'terminal'), { timeout: 15_000 }).toBe(1)
    // …attaches the group to the card (the `term` member tag) and moves it out of Queued.
    await expect(node.getByText('term', { exact: true })).toBeVisible()

    // handoffPrompt's write is confirm-gated — drive the human gate so it doesn't dangle.
    await expect.poll(async () => evalIn<boolean>(page, MODAL), { timeout: 15_000 }).toBe(true)
    await evalIn(page, APPROVE)
  })
})
