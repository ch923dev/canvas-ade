import { test, expect } from './fixtures'
import { evalIn, seed, selectForInspector } from './helpers'
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
    // P5: the Kanban/Groups seg lives in the Board Inspector's View section.
    await selectForInspector(page, id)
    await page
      .locator('[data-test="board-inspector"]')
      .getByRole('radio', { name: 'Groups' })
      .click()
    await expect(node.getByText('No groups yet')).toBeVisible()
  })

  test('collapse shrinks the board to the rail; expand restores the height', async ({ page }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)
    const expanded = (await boardById(page, id))!.h
    expect(expanded).toBeGreaterThan(300)

    // P5: collapse/expand live in the Board Inspector's View section.
    await selectForInspector(page, id)
    await page.locator('[data-test="inspector-command-collapse"]').click()
    await expect.poll(async () => (await boardById(page, id))?.h).toBe(136)
    // The rail roll-up replaces the kanban (the done fraction is its tail).
    await expect(node.getByText(/\d+ \/ \d+ done/)).toBeVisible()

    await page.locator('[data-test="inspector-command-expand"]').click()
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

  test('Phase D: a done task shows the result zone — summary · refs · diffstat · view diff', async ({
    page
  }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)

    // Inject a SETTLED done task carrying a result + a captured raw diff (no real spawn). The card's
    // collect/merge result zone derives from the task fields, so it renders immediately.
    await page.evaluate(() =>
      (globalThis as any).__canvasE2E.setCommandTasks([
        {
          id: 'task-d1',
          title: 'bump deps',
          zoneName: 'Bump Deps',
          status: 'done',
          group: { groupId: 'g-d1', terminalId: 't-d1' },
          result: {
            present: true,
            status: 'success',
            summary: 'Updated 12 deps; lockfile clean.',
            refs: ['package.json', 'pnpm-lock.yaml']
          },
          diff: 'diff --git a/package.json b/package.json\nindex 1234567..89abcde 100644\n--- a/package.json\n+++ b/package.json\n@@ -1,3 +1,3 @@\n   "dependencies": {\n+  "left-pad": "1.3.0"\n-  "left-pad": "1.2.0"\n   }'
        }
      ])
    )

    await expect(node.getByText('Updated 12 deps; lockfile clean.')).toBeVisible()
    await expect(node.getByText('package.json', { exact: true })).toBeVisible()
    await expect(node.getByText('+1', { exact: true })).toBeVisible() // diffstat insertion
    await expect(node.getByRole('button', { name: /zone/ })).toBeVisible() // ↗ zone (group set)

    // view diff expands the raw unified diff inline.
    await node.getByRole('button', { name: 'view diff' }).click()
    await expect(node.getByText('git diff HEAD')).toBeVisible()
    await expect(node.getByText(/left-pad.*1\.3\.0/)).toBeVisible()
  })

  test('Phase D: flip to recap shows the finished-task TIMELINE (NOW empty)', async ({ page }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)

    await page.evaluate(() =>
      (globalThis as any).__canvasE2E.setCommandTasks([
        {
          id: 'task-d2',
          title: 'auth',
          zoneName: 'Auth Feature',
          status: 'done',
          result: { present: true, status: 'success', summary: 'Added reset-token flow.' },
          finishedAt: 222
        }
      ])
    )

    // Flip to the recap face. "Timeline" / "No active tasks." / "newest first" are recap-ONLY
    // markers (the kanban front face has none of them): TIMELINE is non-empty, NOW is empty. The
    // summary itself renders on BOTH faces (the kanban Done card stays mounted behind the opaque
    // recap overlay — the terminal-flip discipline), so it legitimately resolves twice → `.first()`.
    await selectForInspector(page, id)
    await page.locator('[data-test="inspector-command-recap"]').click()
    await expect(node.getByText('Timeline')).toBeVisible()
    await expect(node.getByText(/newest first/)).toBeVisible()
    await expect(node.getByText('No active tasks.')).toBeVisible()
    await expect(node.getByText('Added reset-token flow.').first()).toBeVisible()

    // Flip back (let the fold settle so the toggle's re-entrancy guard doesn't drop the click):
    // the recap face unmounts, so its unique "Timeline" marker is gone.
    await page.waitForTimeout(350)
    await page.locator('[data-test="inspector-command-recap"]').click()
    await expect(node.getByText('Timeline')).toHaveCount(0)
  })

  test('Phase E: the Groups tab rolls up spawned zones — names · counts · focus', async ({
    page
  }) => {
    const id = await seed(page, 'command')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const node = page.locator(`[data-id="${id}"]`)

    await page.evaluate(() =>
      (globalThis as any).__canvasE2E.setCommandTasks([
        {
          id: 'z-1',
          title: 'auth',
          zoneName: 'Auth Feature',
          status: 'done',
          group: { groupId: 'g-1', terminalId: 't-1', planningId: 'p-1' },
          result: { present: true, status: 'success', summary: 'shipped' },
          diff: 'diff --git a/x b/x\n+a\n+b\n-c'
        },
        {
          id: 'z-2',
          title: 'dark',
          zoneName: 'Dark Mode',
          status: 'executing',
          group: { groupId: 'g-2', terminalId: 't-2' }
        },
        { id: 'z-3', title: 'signup', zoneName: 'Signup Flow', status: 'queued' }
      ])
    )

    // P5: the Kanban/Groups seg lives in the Board Inspector's View section.
    await selectForInspector(page, id)
    await page
      .locator('[data-test="board-inspector"]')
      .getByRole('radio', { name: 'Groups' })
      .click()
    // One zone row per task (the queued one too), labelled by its zone name.
    await expect(node.getByText('Auth Feature')).toBeVisible()
    await expect(node.getByText('Dark Mode')).toBeVisible()
    await expect(node.getByText('Signup Flow')).toBeVisible()
    // Header roll-up counts.
    await expect(node.getByText('3 zones')).toBeVisible()
    await expect(node.getByText('1 done')).toBeVisible()
    // ↗ focus only for spawned zones (done + executing own a group; the queued one does not).
    await expect(node.getByRole('button', { name: /focus/ })).toHaveCount(2)
  })

  // The full dispatch choreography (submit → spawn an agent group → engineer the prompt → hand off,
  // confirm-gated → advance) is covered deterministically by the useCommandDispatch hook unit test
  // (mocked window.api) + the spawn primitive by spawnGroup.e2e + the confirm gate by mcp.e2e. A
  // real-spawn e2e here would leak a worker into MAIN's spawn-cap `tracked` (freed only past
  // spawnGraceMs — see mcpLifecycle.reconcile), tipping the cap-edge spawnGroup.e2e over. So this
  // spec stays at the no-spawn board UI; the chips test above is its Phase-C surface.
})
