import { test, expect } from './fixtures'
import { callE2E, mainCall, seed } from './helpers'

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
    const id = await seed(page, 'swarm')
    // Camera-based canvas: under the FULL suite prior specs' seeds push the cursor far right,
    // so the board lands off-viewport and clicks fail actionability — fit it first.
    await callE2E(page, { m: 'fitView', a: [id] })
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
    await callE2E(page, { m: 'fitView', a: [idA] })
    await first.locator('[data-test="swarm-composer"]').fill('run A goal')
    await first.locator('[data-test="swarm-send"]').click()
    await expect(first.locator('.sw-msg.you')).toContainText('run A goal')
    await expect(first.locator('.sw-msg.orch').first()).toBeVisible({ timeout: 10000 })
    // The second board's run is untouched — empty transcript, idle timer.
    await expect(second.locator('.sw-msg')).toHaveCount(0)
    await expect(second.locator('[data-test="swarm-run-timer"]')).toContainText('no run yet')
    // And it can run its own independent turn.
    await callE2E(page, { m: 'fitView', a: [idB] })
    await second.locator('[data-test="swarm-composer"]').fill('run B goal')
    await second.locator('[data-test="swarm-send"]').click()
    await expect(second.locator('.sw-msg.you')).toContainText('run B goal')
    await expect(first.locator('.sw-msg.you')).not.toContainText('run B goal')
  } finally {
    await mainCall(electronApp, 'setLlmMock', false)
  }
})

test('@core pause toggles + is narrated in the chat spine', async ({ page }) => {
  const id = await seed(page, 'swarm')
  await callE2E(page, { m: 'fitView', a: [id] })
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

test('@core docked worker renders INSIDE the swarm board (no canvas node); pop-out and re-dock hand the live surface across', async ({
  page
}) => {
  const swarmId = await seed(page, 'swarm')
  const workerId = await seed(page, 'terminal', { title: 'w-dock', dockedIn: swarmId })
  // Run membership through the same store action the real workerSpawned push drives — the
  // rail card and the popped-out board's re-dock pill key off it.
  await callE2E(
    page,
    { m: 'swarmAddWorker', a: [swarmId, workerId, 'reviewer'] },
    { m: 'fitView', a: [swarmId] }
  )
  const board = page.locator('[data-test="swarm-board"]')
  // The worker renders as a dock pane + a rail tab — and NOT as a React Flow canvas node.
  await expect(board.locator(`[data-test="swarm-dock-pane-${workerId}"]`)).toBeVisible()
  await expect(board.locator(`[data-test="swarm-card-${workerId}"]`)).toBeVisible()
  await expect(board.locator('[data-test="swarm-workers"]')).toContainText('Workers · 1')
  await expect(page.locator(`.react-flow__node[data-id="${workerId}"]`)).toHaveCount(0)
  // Pop out → a real canvas TerminalBoard node appears and the pane is gone; the rail card
  // stays (marked ↗ — it now jumps to the canvas board).
  await board.locator(`[data-test="swarm-dock-popout-${workerId}"]`).click()
  await expect(page.locator(`.react-flow__node[data-id="${workerId}"]`)).toHaveCount(1)
  await expect(board.locator(`[data-test="swarm-dock-pane-${workerId}"]`)).toHaveCount(0)
  await expect(board.locator(`[data-test="swarm-card-${workerId}"] .sw-popped`)).toBeVisible()
  // Re-dock from the popped-out board's title-bar pill → back inside the dock, node gone.
  await callE2E(page, { m: 'fitView', a: [workerId] })
  await page.locator(`[data-test="swarm-redock-${workerId}"]`).click()
  await expect(page.locator(`.react-flow__node[data-id="${workerId}"]`)).toHaveCount(0)
  await callE2E(page, { m: 'fitView', a: [swarmId] })
  await expect(board.locator(`[data-test="swarm-dock-pane-${workerId}"]`)).toBeVisible()
  // Re-dock corpse regression: the pane must hold a LIVE xterm (a fresh registry entry), not
  // the previous mount's dead DOM. Without the DockedPaneGate handoff serializer, the dying
  // canvas surface killed the freshly re-adopted session one commit later — pane visible,
  // terminal frozen at the pop-out width, registry empty.
  await expect
    .poll(() => callE2E<boolean>(page, { m: 'terminalMounted', a: [workerId] }), {
      timeout: 8000
    })
    .toBe(true)
})

test('@core dock ✕ removes the docked worker board (the only delete path — no canvas node to select)', async ({
  page
}) => {
  const swarmId = await seed(page, 'swarm')
  const workerId = await seed(page, 'terminal', { title: 'w-close', dockedIn: swarmId })
  await callE2E(page, { m: 'fitView', a: [swarmId] })
  const board = page.locator('[data-test="swarm-board"]')
  await expect(board.locator(`[data-test="swarm-dock-pane-${workerId}"]`)).toBeVisible()
  await board.locator(`[data-test="swarm-dock-close-${workerId}"]`).click()
  await expect(board.locator(`[data-test="swarm-dock-pane-${workerId}"]`)).toHaveCount(0)
  const boards = await callE2E<Array<{ id: string }>>(page, { m: 'getBoards' })
  expect(boards.some((b) => b.id === workerId)).toBe(false)
  // Undo restores the board INTO the dock (dockedIn survives the snapshot round-trip).
  await callE2E(page, { m: 'undo' })
  await expect(board.locator(`[data-test="swarm-dock-pane-${workerId}"]`)).toBeVisible()
})

test('@core dock regions resize: dragging the rail divider widens the rail and persists dockLayout', async ({
  page
}) => {
  const swarmId = await seed(page, 'swarm')
  await seed(page, 'terminal', { title: 'w-1', dockedIn: swarmId })
  await callE2E(page, { m: 'fitView', a: [swarmId] })
  const board = page.locator('[data-test="swarm-board"]')
  const rail = board.locator('.sw-rail')
  const before = (await rail.boundingBox())!.width
  const div = board.locator('[data-test="swarm-div-rail"]')
  const box = (await div.boundingBox())!
  // A real pointer drag on the divider (pointer-captured) — +60 screen px to the right.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  const after = (await rail.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 10)
  // The commit landed on the board doc (PATCHABLE_KEYS.swarm carries dockLayout).
  const docs = await callE2E<Array<{ id: string; dockLayout?: { rail?: number } }>>(page, {
    m: 'getBoards'
  })
  expect(docs.find((b) => b.id === swarmId)?.dockLayout?.rail).toBeGreaterThan(200)
})

test('@core deleting the host swarm board pops its docked workers back onto the canvas', async ({
  page
}) => {
  const swarmId = await seed(page, 'swarm')
  const workerId = await seed(page, 'terminal', { title: 'w-orphan', dockedIn: swarmId })
  await expect(page.locator(`.react-flow__node[data-id="${workerId}"]`)).toHaveCount(0)
  await callE2E(page, { m: 'deleteBoard', a: [swarmId] })
  // The worker must not be stranded invisible — it lands as an ordinary canvas terminal.
  await expect(page.locator(`.react-flow__node[data-id="${workerId}"]`)).toHaveCount(1)
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
