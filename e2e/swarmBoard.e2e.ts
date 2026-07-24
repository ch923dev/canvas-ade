import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

/**
 * @core Swarm board (orchestration S1) — the chat-driven orchestration surface, against the
 * REAL app: the v23 board type mounts through BoardNode's per-type dispatch + lazy chunk with
 * all five regions; the composer round-trips a REAL turn through MAIN's per-board orchestrator
 * session (swarm:turn:start → streamed deltas → done) under CANVAS_LLM_MOCK (deterministic,
 * zero egress); and the multi-instance contract holds — two boards = two independent runs.
 *
 * Also pins the lead-entry revamp's renderer halves: the LEAD badge appears/disappears on the
 * REAL `orchestration:leadChanged` push (grant/revoke via the same consent-gated RunningMcp
 * surface the UI drives), and the Settings pane no longer renders the deleted picker.
 */

test('@core swarm board mounts with all five regions (v23 type, multi-instance)', async ({
  page
}) => {
  await seed(page, 'swarm')
  const board = page.locator('[data-test="swarm-board"]')
  await expect(board).toBeVisible()
  // Region 1 — chat spine with the hot composer.
  await expect(board.locator('[data-test="swarm-chat"]')).toBeVisible()
  await expect(board.locator('[data-test="swarm-composer"]')).toBeVisible()
  // Region 2 — plan strip (read-only empty state until a run draws one).
  await expect(board.locator('[data-test="swarm-plan-strip"]')).toContainText('no plan yet')
  // Region 3 — worker canvas head.
  await expect(board.locator('[data-test="swarm-workers"]')).toContainText('Workers · 0')
  // Region 4 — needs-you strip, quiet.
  await expect(board.locator('[data-test="swarm-needs-you"]')).toContainText('nothing needs you')
  // Region 5 — header: timer idle + pause control.
  await expect(board.locator('[data-test="swarm-run-timer"]')).toContainText('no run yet')
  await expect(board.locator('[data-test="swarm-pause"]')).toBeVisible()
})

test('@core composer round-trips a real MAIN turn (mock brain): user bubble + streamed orch reply', async ({
  page,
  electronApp
}) => {
  await mainCall(electronApp, 'setLlmMock', true)
  try {
    await seed(page, 'swarm')
    const board = page.locator('[data-test="swarm-board"]')
    await board.locator('[data-test="swarm-composer"]').fill('hello swarm')
    await board.locator('[data-test="swarm-send"]').click()
    // The user bubble lands synchronously; the orch bubble streams from MAIN (two deltas).
    await expect(board.locator('.sw-msg.you')).toContainText('hello swarm')
    await expect(board.locator('.sw-msg.orch').first()).toBeVisible({ timeout: 10000 })
    // The run timer starts with the first message.
    await expect(board.locator('[data-test="swarm-run-timer"]')).toContainText('run ')
  } finally {
    await mainCall(electronApp, 'setLlmMock', false)
  }
})

test('@core multi-instance: two swarm boards hold two independent runs (no state bleed)', async ({
  page,
  electronApp
}) => {
  await mainCall(electronApp, 'setLlmMock', true)
  try {
    const idA = await seed(page, 'swarm')
    const idB = await seed(page, 'swarm')
    const boards = page.locator('[data-test="swarm-board"]')
    await expect(boards).toHaveCount(2)
    const first = boards.nth(0)
    const second = boards.nth(1)
    // The canvas is camera-based (no scrolling): fit the board being DRIVEN into the viewport
    // before clicking into it — the sibling assertions are DOM-only and don't need the camera.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(idA)})`)
    await first.locator('[data-test="swarm-composer"]').fill('run A goal')
    await first.locator('[data-test="swarm-send"]').click()
    await expect(first.locator('.sw-msg.you')).toContainText('run A goal')
    await expect(first.locator('.sw-msg.orch').first()).toBeVisible({ timeout: 10000 })
    // The second board's run is untouched — empty transcript, idle timer.
    await expect(second.locator('.sw-msg')).toHaveCount(0)
    await expect(second.locator('[data-test="swarm-run-timer"]')).toContainText('no run yet')
    // And it can run its own independent turn.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(idB)})`)
    await second.locator('[data-test="swarm-composer"]').fill('run B goal')
    await second.locator('[data-test="swarm-send"]').click()
    await expect(second.locator('.sw-msg.you')).toContainText('run B goal')
    await expect(first.locator('.sw-msg.you')).not.toContainText('run B goal')
  } finally {
    await mainCall(electronApp, 'setLlmMock', false)
  }
})

test('@core pause toggles + is narrated in the chat spine', async ({ page }) => {
  await seed(page, 'swarm')
  const board = page.locator('[data-test="swarm-board"]')
  await board.locator('[data-test="swarm-pause"]').click()
  await expect(board.locator('[data-test="swarm-pause"]')).toContainText('Resume')
  await expect(board.locator('.sw-statusline').last()).toContainText('paused')
  await board.locator('[data-test="swarm-pause"]').click()
  await expect(board.locator('[data-test="swarm-pause"]')).toContainText('Pause all')
})

test('@core LEAD badge rides the real leadChanged push: grant shows it, revoke clears it', async ({
  page,
  electronApp
}) => {
  const terminalId = await seed(page, 'terminal', { title: 'lead-me' })
  // The board must reach MAIN's mirror before grantLead validates it (async publish).
  await expect
    .poll(
      async () =>
        (await mainCall<{ ok: boolean } | null>(electronApp, 'mcpLeadGrant', terminalId))?.ok ??
        false,
      { timeout: 8000 }
    )
    .toBe(true)
  await expect(page.locator('[data-test="terminal-lead-badge"]')).toBeVisible()
  await mainCall(electronApp, 'mcpLeadRevoke')
  await expect(page.locator('[data-test="terminal-lead-badge"]')).toHaveCount(0)
})

test('@core Settings › Orchestration no longer renders the deleted Lead terminal picker', async ({
  page
}) => {
  await page.click('[title="Settings"]')
  await expect(page.locator('[data-test="settings-panel"]')).toBeVisible()
  await page.click('[data-test="settings-tab-agents"]')
  await page.click('[data-test="settings-section-orchestration"]')
  await expect(page.locator('[data-test="settings-orchestration-row"]')).toBeVisible()
  await expect(page.locator('[data-test="settings-lead-section"]')).toHaveCount(0)
  await expect(page.locator('[data-test="settings-lead-pick"]')).toHaveCount(0)
})
