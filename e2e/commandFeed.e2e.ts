import { test, expect } from './fixtures'
import { evalIn, mainCall, seed, selectForInspector } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @mcp Orchestration P4 — a worker the app never dispatched still renders on the Command board.
 *
 * This is the gap the lane exists to close: `write_result` is the only no-confirm worker self-report
 * channel, and before P4 it dead-ended in a MAIN in-memory Map with no push behind it. A worker
 * dispatched THROUGH the Command board surfaced in its recap (that dispatch parks `awaitSettled` on
 * it); a worker an EXTERNAL orchestrator spawned surfaced nowhere at all.
 *
 * What this proves that the jsdom tier cannot: the REAL MAIN `recordBoardResult` seam → the REAL
 * feed → the REAL `sendMcpCommand` IPC → the REAL renderer applier → the REAL `commandStore`, in a
 * REAL Electron app — plus the on-canvas attention ring rendering in the live board DOM.
 *
 * Isolation: the base `page` fixture resets the canvas between tests, and every result this spec
 * records is pruned by `pruneBoardResults` on the next project lifecycle event — but the feed's
 * cards live in the ephemeral `commandStore`, so each test clears them itself rather than leaving
 * a previous test's cards as the next one's starting state (the S2 leaked-camera lesson).
 */

interface FedTask {
  id: string
  title: string
  status: string
  external?: true
  blockedTag?: string
  disclose?: string
  result?: { status?: string; summary?: string; refs?: string[] }
}

const fedTasks = (page: Page): Promise<FedTask[]> =>
  page.evaluate(() =>
    ((globalThis as any).__canvasE2E.getCommandTasks() as FedTask[]).filter((t) => t.external)
  )

/** Poll until the fed card for a board has arrived AND reached the expected status. */
async function awaitFed(page: Page, status: string): Promise<FedTask> {
  await expect
    .poll(async () => (await fedTasks(page)).find((t) => t.status === status)?.status, {
      timeout: 10_000
    })
    .toBe(status)
  const t = (await fedTasks(page)).find((x) => x.status === status)
  if (!t) throw new Error(`no fed task in status ${status}`)
  return t
}

const clearTasks = (page: Page): Promise<unknown> =>
  evalIn(page, `window.__canvasE2E.setCommandTasks([])`)

test.describe('@mcp P4 external-worker feed', () => {
  test('a write_result from a board nobody dispatched renders as an `ext` card', async ({
    page,
    electronApp
  }) => {
    await seed(page, 'command')
    const worker = await seed(page, 'terminal', { title: 'reviewer-1' })
    try {
      // The ONE call a worker's `write_result` tool makes on the host. No dispatch, no awaitSettled,
      // no Command-board involvement — exactly the case that used to render nowhere.
      await mainCall(electronApp, 'mcpRecordResult', worker, {
        present: true,
        status: 'done',
        summary: '3 findings — one real, two low.',
        refs: ['src/main/pty.ts:774', 'src/main/pty.ts:839']
      })

      const card = await awaitFed(page, 'done')
      // The renderer resolved the title itself — MAIN carried only the board id.
      expect(card.title).toBe('reviewer-1')
      expect(card.external).toBe(true)
      expect(card.result?.summary).toContain('3 findings')
      expect(card.result?.refs).toEqual(['src/main/pty.ts:774', 'src/main/pty.ts:839'])
    } finally {
      await clearTasks(page)
    }
  })

  test('the `ext` chip and the worker summary render in the live board DOM', async ({
    page,
    electronApp
  }) => {
    const board = await seed(page, 'command')
    const worker = await seed(page, 'terminal', { title: 'reviewer-2' })
    try {
      await mainCall(electronApp, 'mcpRecordResult', worker, {
        present: true,
        status: 'done',
        summary: 'pid reuse in killTree'
      })
      await awaitFed(page, 'done')
      await evalIn(page, `window.__canvasE2E.fitView()`)
      const node = page.locator(`[data-id="${board}"]`)
      // The chip is what tells the human "I did not dispatch this", which changes how every other
      // thing on the card should be read.
      await expect(node.getByText('ext', { exact: true }).first()).toBeVisible()
      await expect(node.getByText('pid reuse in killTree')).toBeVisible()
      // A fed result is the worker's CLAIM — the card must never present it as a verification.
      await expect(node.getByText('claimed · not verified')).toBeVisible()
    } finally {
      await clearTasks(page)
    }
  })

  test('a blocked report chips the card AND raises the blocked ring on the worker board', async ({
    page,
    electronApp
  }) => {
    await seed(page, 'command')
    const worker = await seed(page, 'terminal', { title: 'builder-1' })
    try {
      await mainCall(electronApp, 'mcpRecordResult', worker, {
        present: true,
        status: 'blocked',
        summary: 'needs a decision on the schema'
      })
      // Blocked stays in `executing`: the column axis is lifecycle, and the block is a chip — a
      // sixth column would strand a finished-but-blocked worker outside Done.
      const card = await awaitFed(page, 'executing')
      expect(card.blockedTag).toBe('blocked')

      // …and the ring the human actually sees, read off the live board node DOM.
      await expect
        .poll(
          () =>
            page.evaluate(
              (id) => (globalThis as any).__canvasE2E.attentionKind(id) as string | null,
              worker
            ),
          { timeout: 10_000 }
        )
        .toBe('needs-input')
    } finally {
      await clearTasks(page)
    }
  })

  test('🔒 an off-vocabulary status parks the card UNSETTLED and says why', async ({
    page,
    electronApp
  }) => {
    const board = await seed(page, 'command')
    const worker = await seed(page, 'terminal', { title: 'reviewer-3' })
    try {
      await mainCall(electronApp, 'mcpRecordResult', worker, {
        present: true,
        status: 'partial-ok',
        summary: 'half the files reviewed'
      })
      // Not `done` (that would launder an unknown into success) and not `failed` (that would claim
      // a failure nobody reported) — `reporting` keeps the human watching.
      const card = await awaitFed(page, 'reporting')
      expect(card.disclose).toBe('unrecognized status "partial-ok" — treated as unsettled')

      await evalIn(page, `window.__canvasE2E.fitView()`)
      // The reason must be ON the surface, not merely in the store.
      await expect(
        page.locator(`[data-id="${board}"]`).getByText('unrecognized status "partial-ok"')
      ).toBeVisible()
    } finally {
      await clearTasks(page)
    }
  })

  test('🔒 a re-report lands on the SAME card, not a second one', async ({ page, electronApp }) => {
    await seed(page, 'command')
    const worker = await seed(page, 'terminal', { title: 'builder-2' })
    try {
      await mainCall(electronApp, 'mcpRecordResult', worker, {
        present: true,
        status: 'blocked',
        summary: 'waiting'
      })
      await awaitFed(page, 'executing')
      await mainCall(electronApp, 'mcpRecordResult', worker, {
        present: true,
        status: 'done',
        summary: 'finished'
      })
      const card = await awaitFed(page, 'done')

      // The newest-first board→task lookup: a first-match scan would have pinned this on a stale
      // row (the live `[critical]` in S2, and the root of S3's).
      expect(await fedTasks(page)).toHaveLength(1)
      expect(card.result?.summary).toBe('finished')
      // The stale block reason did not outlive the block.
      expect(card.blockedTag).toBeUndefined()
    } finally {
      await clearTasks(page)
    }
  })

  test('🔒 N reports raise ZERO confirm modals — the constraint the design turns on', async ({
    page,
    electronApp
  }) => {
    await seed(page, 'command')
    const workers = [
      await seed(page, 'terminal', { title: 'w-a' }),
      await seed(page, 'terminal', { title: 'w-b' }),
      await seed(page, 'terminal', { title: 'w-c' })
    ]
    try {
      for (const [i, w] of workers.entries()) {
        await mainCall(electronApp, 'mcpRecordResult', w, {
          present: true,
          status: 'done',
          summary: `worker ${i} reported`
        })
      }
      await expect.poll(async () => (await fedTasks(page)).length, { timeout: 10_000 }).toBe(3)
      // `commandStore` is runtime-only and never serialized, so no push here is a durable content
      // write — which is exactly why status can ride this channel at N-worker frequency.
      await expect(page.locator('[data-testid="batch-confirm-approve"]')).toHaveCount(0)
      await expect(page.locator('[data-test="confirm-modal"]')).toHaveCount(0)
    } finally {
      await clearTasks(page)
    }
  })

  test('🔒 the recap face RENDERS with fed workers (React #185 regression guard)', async ({
    page,
    electronApp
  }) => {
    // The `PublishFindingsBar` originally selected `boards.filter().map()` straight out of zustand,
    // which returns a fresh array on every notification — an unbounded render loop that took the
    // WHOLE Command board to "This board failed to render". Every unit + e2e case passed, because
    // none of them flipped to the recap face. The manual dev check caught it; this keeps it caught.
    const board = await seed(page, 'command')
    const worker = await seed(page, 'terminal', { title: 'reviewer-5' })
    try {
      await mainCall(electronApp, 'mcpRecordResult', worker, {
        present: true,
        status: 'done',
        summary: 'a finding worth keeping'
      })
      await awaitFed(page, 'done')
      await selectForInspector(page, board)
      await page.locator('[data-test="inspector-command-recap"]').click({ timeout: 5000 })
      await page.waitForTimeout(400)

      const node = page.locator(`[data-id="${board}"]`)
      await expect(node.getByText('This board failed to render')).toHaveCount(0)
      await expect(node.getByText('TIMELINE').first()).toBeVisible()
      await expect(node.getByText('a finding worth keeping').first()).toBeVisible()
      // Absence, stated: no kanban board on this canvas, so the bar says so rather than vanishing.
      await expect(node.getByText(/no kanban board on this canvas/).first()).toBeVisible()
    } finally {
      await clearTasks(page)
    }
  })

  test('🔒 Publish findings opens ONE batch modal that describes what it actually does', async ({
    page,
    electronApp
  }) => {
    const board = await seed(page, 'command')
    const w1 = await seed(page, 'terminal', { title: 'reviewer-6' })
    const w2 = await seed(page, 'terminal', { title: 'reviewer-7' })
    await seed(page, 'kanban', { title: 'Review findings' })
    try {
      // The same claim from two workers — corroboration, so the batch must MERGE and say so.
      for (const w of [w1, w2]) {
        await mainCall(electronApp, 'mcpRecordResult', w, {
          present: true,
          status: 'done',
          summary: 'ignored',
          refs: ['src/main/pty.ts:774 high — pid reuse']
        })
      }
      await expect.poll(async () => (await fedTasks(page)).length, { timeout: 10_000 }).toBe(2)

      await selectForInspector(page, board)
      await page.locator('[data-test="inspector-command-recap"]').click({ timeout: 5000 })
      // The publish control lives ON the board (the inspector's recap toggle does not), so the
      // camera has to actually be looking at it before a real click can land.
      await evalIn(page, `window.__canvasE2E.setSelection([])`)
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(board)})`)
      await page.getByRole('button', { name: /Publish findings/ }).click({ timeout: 8000 })

      const modal = page.locator('[data-testid="batch-confirm-modal"]')
      await expect(modal).toBeVisible({ timeout: 10_000 })
      // ONE modal, and the merge collapsed two reports into ONE row.
      await expect(page.locator('[data-testid^="batch-confirm-row-"]')).toHaveCount(1)
      // 🔒 It must NOT wear the relay_prompts default, which claims the approved rows will RUN and
      // be written into a terminal. Nothing here runs; every row becomes a passive card.
      await expect(modal.getByText(/never runs anything/)).toBeVisible()
      await expect(modal.getByText(/each is written into its own terminal/)).toHaveCount(0)
      // …and the disclosure reaches the human at DECISION time, not just the return value.
      await expect(page.locator('[data-testid="batch-confirm-disclose"]')).toContainText(
        'merged by (path, line, note)'
      )
      // Leave nothing armed for the next spec (the S2 leaked-state lesson).
      await page.locator('[data-testid="batch-confirm-deny"]').click()
      await expect(modal).toHaveCount(0)
    } finally {
      await clearTasks(page)
    }
  })

  test('a result for a board that is gone does not invent a card', async ({
    page,
    electronApp
  }) => {
    await seed(page, 'command')
    try {
      await mainCall(electronApp, 'mcpRecordResult', 'never-on-this-canvas', {
        present: true,
        status: 'done',
        summary: 'ghost'
      })
      // A card assigned to a board the human cannot open is a dead reference; the applier refuses.
      await page.waitForTimeout(600)
      expect(await fedTasks(page)).toHaveLength(0)
    } finally {
      await clearTasks(page)
    }
  })
})
