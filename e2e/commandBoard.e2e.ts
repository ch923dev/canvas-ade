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

  test('Phase C: the routing overlay edge appears while in flight, vanishes on settle', async ({
    page
  }) => {
    await seed(page, 'command')
    const term = await seed(page, 'terminal')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)

    const routingEdge = page.locator('.react-flow__edge-routing')
    await expect(routingEdge).toHaveCount(0) // no in-flight task yet

    // Inject an EXECUTING task whose group's terminal is the seeded worker (no real spawn — that
    // would leak MAIN's cap). The overlay derives from the live task→group map, so the edge from
    // the Command board to its worker appears immediately.
    await page.evaluate(
      (tid) =>
        (globalThis as any).__canvasE2E.setCommandTasks([
          {
            id: 'task-c3',
            title: 'analyze repo',
            status: 'executing',
            group: { groupId: 'g-c3', terminalId: tid }
          }
        ]),
      term
    )
    await expect(routingEdge).toHaveCount(1)
    await expect(page.locator(`.react-flow__edge[data-id="routing-task-c3-${term}"]`)).toHaveCount(
      1
    )

    // Settle the task → the derived overlay vanishes (no teardown bookkeeping).
    await page.evaluate(() =>
      (globalThis as any).__canvasE2E.setCommandTasks([
        { id: 'task-c3', title: 'analyze repo', status: 'done' }
      ])
    )
    await expect(routingEdge).toHaveCount(0)
  })

  // The full dispatch choreography (submit → spawn an agent group → engineer the prompt → hand off,
  // confirm-gated → advance) is covered deterministically by the useCommandDispatch hook unit test
  // (mocked window.api) + the spawn primitive by spawnGroup.e2e + the confirm gate by mcp.e2e. A
  // real-spawn e2e here would leak a worker into MAIN's spawn-cap `tracked` (freed only past
  // spawnGraceMs — see mcpLifecycle.reconcile), tipping the cap-edge spawnGroup.e2e over. So this
  // spec stays at the no-spawn board UI; the chips test above is its Phase-C surface.
})
