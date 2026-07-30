import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { apiCall, callE2E, evalIn, mainCall, seed } from './helpers'

/**
 * @core Swarm run ledger + triage (orchestration S2) — the survivability half, against the REAL
 * app. S1's run lived entirely in the ephemeral swarmStore and died with a reload; these specs
 * prove the durable half end to end:
 *
 *   1. a run this session NEVER created comes back off disk — MAIN's canonical `writeRun` puts a
 *      ledger in `.canvas/memory/`, the board's real restore IPC brings it back, and the header,
 *      the worker cards and the triage queue all render from it;
 *   2. a stalled / lost worker reads as such, with its threshold and provenance DISCLOSED in the
 *      visible string (the S1 eyeball rule: a reason not in the string does not exist);
 *   3. a triage action is a REQUEST — the reassign button asks MAIN, which re-validates and
 *      un-assigns the task, and the re-dispatch goes back through the orchestrator;
 *   4. the plan strip is editable mid-run and writes THROUGH to the Planning board.
 *
 * Everything is driven through the real IPC surface. No run is fabricated in the renderer.
 *
 * The ledger lives under `<project>/.canvas/memory/` (D1), so the two restore specs open a REAL
 * temp project and tear it down in a `finally` — the createTempProject/teardownProject pair every
 * project-scoped spec uses. Not optional bookkeeping: one app is reused across all spec files, and
 * a current dir left pointing at a throwaway project becomes the cwd of the next spec's PTY spawn.
 */

const MIN = 60_000

/** A ledger fixture: one run, `tasks` supplied by the caller. `now` anchors the stall math. */
function ledgerFor(
  boardId: string,
  now: number,
  tasks: Array<Record<string, unknown>>,
  planItems: Array<Record<string, unknown>> = []
): Record<string, unknown> {
  return {
    version: 1,
    runId: boardId,
    boardId,
    title: 'ship the thing',
    createdAt: now - 20 * MIN,
    lastActiveAt: now - MIN,
    lastSeenAt: now - 20 * MIN,
    state: 'live',
    planBoardId: null,
    planItems,
    tasks,
    events: [],
    eventSeq: 1
  }
}

const assignment = (boardId: string, at: number): Record<string, unknown> => ({
  boardId,
  role: 'builder',
  spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
  dispatchedAt: at,
  lastActivityAt: at,
  stallCount: 0,
  worktree: null,
  branch: null
})

/**
 * Read one checklist item field off the PLAN board through the store — the source of truth the
 * strip writes through to. The board id goes in as a STRUCTURED ARG, never interpolated into the
 * evaluated source (CodeQL js/bad-code-sanitization; the `preview-align.e2e.ts` pattern from #82).
 */
function planItemField<T>(page: Page, planId: string, field: 'done' | 'label'): Promise<T> {
  return page.evaluate(
    (a) => {
      const b = (globalThis as any).__canvasE2E.getBoards().find((x: any) => x.id === a.id)
      return b.elements[0].items[0][a.field]
    },
    { id: planId, field }
  ) as Promise<T>
}

/** Item COUNT on the plan board's checklist — same structured-arg discipline. */
function planItemCount(page: Page, planId: string): Promise<number> {
  return page.evaluate((a) => {
    const b = (globalThis as any).__canvasE2E.getBoards().find((x: any) => x.id === a)
    return b.elements[0].items.length
  }, planId)
}

test('@core a run restores from disk: the header chip, the worker cards and the triage queue', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'swarm-led-', 'swarm-led')
  try {
    await callE2E(page, { m: 'openProjectFromDisk', a: [tmp] })
    // A fresh project fires the one-time recap-consent prompt — a modal whose scrim sits over the
    // board and eats clicks. Dismiss it (best-effort: it asks once per undecided project).
    await page
      .getByRole('button', { name: /^no thanks$/i })
      .click({ timeout: 8000 })
      .catch(() => undefined)
    // Opening a project also opens the Context digest panel — a right-docked aside that overlaps
    // the board's right edge, where the triage row's buttons live. Close it.
    await evalIn(page, `window.__canvasE2E.closeDigest()`)
    const id = await seed(page, 'swarm')
    await callE2E(page, { m: 'fitView', a: [id] })
    const now = Date.now()

    const wrote = await mainCall<boolean>(
      electronApp,
      'writeSwarmRun',
      id,
      ledgerFor(
        id,
        now,
        [
          {
            taskId: 't1',
            planItemId: 'p1',
            content: 'Migrate the readers',
            activeForm: 'Migrating readers…',
            state: 'blocked',
            blockedTag: 'lost',
            assignment: assignment('worker-dead', now - 12 * MIN),
            result: {
              status: 'partial',
              summary: 'touched 6 files',
              refs: ['a', 'b', 'c'],
              provenance: 'synthesized',
              at: now - 2 * MIN
            }
          },
          {
            taskId: 't2',
            content: 'Write the migration tests',
            activeForm: 'Writing migration tests…',
            state: 'in_progress',
            assignment: {
              ...assignment('worker-quiet', now - 30 * MIN),
              lastActivityAt: now - 18 * MIN
            }
          }
        ],
        [{ id: 'p1', label: 'Migrate the readers', done: false }]
      )
    )
    expect(wrote).toBe(true)

    // The REAL restore IPC — the identical call the board makes on mount.
    const restored = await apiCall<{ restored: boolean }>(page, 'swarm.restore', id)
    expect(restored.restored).toBe(true)

    const board = page.locator('[data-test="swarm-board"]')
    // 1 — the ledger's one visible moment: honest about what survived.
    await expect(board.locator('[data-test="swarm-restored"]')).toContainText('restored')
    await expect(board.locator('[data-test="swarm-restored"]')).toContainText('2 workers')
    await expect(board.locator('[data-test="swarm-restored"]')).toContainText('1 result')
    // 2 — membership came back for a session that never saw a spawn event.
    await expect(board.locator('[data-test="swarm-workers"]')).toContainText('Workers · 2')
    // 3 — the dead worker reads LOST and discloses its salvaged result's provenance.
    const lost = board.locator('[data-test="swarm-card-worker-dead"]')
    await expect(lost).toHaveAttribute('data-state', 'lost')
    await expect(lost).toContainText('derived')
    await expect(lost).toContainText('3 files')
    // 4 — the quiet worker reads STALLED and discloses BOTH numbers. Deliberately NO card-level
    // class: per design §4 a stalled worker is not asking anyone for anything, so the signal is the
    // frozen state dot + the amber timer + the disclosed threshold, not an alarm ring.
    const stalled = board.locator('[data-test="swarm-card-worker-quiet"]')
    await expect(stalled).toHaveAttribute('data-state', 'stalled')
    await expect(stalled.locator('.sw-st')).toHaveClass(/stalled/)
    await expect(stalled).toContainText('18m')
    await expect(stalled).toContainText('threshold 10m')
    // 5 — the triage queue is risk-ordered: lost above stalled.
    await expect(board.locator('[data-test="swarm-triage-lost"]')).toBeVisible()
    await expect(board.locator('[data-test="swarm-triage-stalled"]')).toBeVisible()
    const tags = await board.locator('.sw-tri .sw-tri-tag').allTextContents()
    expect(tags).toEqual(['lost', 'stalled'])
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

test('@core a triage Reassign asks MAIN, which un-assigns the task and hands back a prompt', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'swarm-tri-', 'swarm-tri')
  try {
    await callE2E(page, { m: 'openProjectFromDisk', a: [tmp] })
    // A fresh project fires the one-time recap-consent prompt — a modal whose scrim sits over the
    // board and eats clicks. Dismiss it (best-effort: it asks once per undecided project).
    await page
      .getByRole('button', { name: /^no thanks$/i })
      .click({ timeout: 8000 })
      .catch(() => undefined)
    // Opening a project also opens the Context digest panel — a right-docked aside that overlaps
    // the board's right edge, where the triage row's buttons live. Close it.
    await evalIn(page, `window.__canvasE2E.closeDigest()`)
    const id = await seed(page, 'swarm')
    await callE2E(page, { m: 'fitView', a: [id] })
    const now = Date.now()
    await mainCall(
      electronApp,
      'writeSwarmRun',
      id,
      ledgerFor(id, now, [
        {
          taskId: 't1',
          planItemId: 'p1',
          content: 'Migrate the readers',
          activeForm: 'Migrating readers…',
          state: 'blocked',
          blockedTag: 'lost',
          assignment: assignment('worker-dead', now - 12 * MIN)
        }
      ])
    )
    await apiCall(page, 'swarm.restore', id)

    const board = page.locator('[data-test="swarm-board"]')
    const row = board.locator('[data-test="swarm-triage-lost"]')
    await expect(row).toBeVisible()
    await row.locator('[data-test="swarm-triage-reassign"]').click()

    // MAIN disposed: the task went back to the queue, unassigned — so it stops producing rows for
    // work nobody is doing. Read the DURABLE record back, not the renderer's copy of it.
    await expect
      .poll(async () => {
        const l = await mainCall<{ tasks: Array<{ state: string; assignment?: unknown }> } | null>(
          electronApp,
          'readSwarmRun',
          id
        )
        return l?.tasks[0]?.state
      })
      .toBe('pending')
    const after = await mainCall<{ tasks: Array<{ assignment?: unknown }> } | null>(
      electronApp,
      'readSwarmRun',
      id
    )
    expect(after?.tasks[0]?.assignment).toBeUndefined()
    // The re-dispatch travels the orchestrator, not a button: the prompt lands in the chat as a
    // human turn (and the row is gone, because nothing is assigned to complain about any more).
    await expect(board.locator('.sw-msg.you')).toContainText('Reassign')
    await expect(row).toHaveCount(0)
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

test('@core the plan strip edits write THROUGH to the Planning board (D2 always-live)', async ({
  page
}) => {
  // The SWARM board is seeded FIRST — deliberately, and not cosmetic. `reset()` restarts the
  // seed-x cursor but leaves the CAMERA where the last spec put it, so whatever this spec fits
  // last is what the next spec inherits. Seeding the swarm board at the origin keeps the fit
  // framed on x≈0, where the next spec's own board is seeded; fitting a board seeded to the
  // RIGHT of a plan board strands that origin off-viewport, and a board React Flow never renders
  // is a terminal that never mounts or spawns (it reads as a PTY failure and is not one). The
  // plan board is read through the STORE here, never clicked, so its position is irrelevant.
  const id = await seed(page, 'swarm')
  await callE2E(page, { m: 'fitView', a: [id] })
  const planId = await seed(page, 'planning', {
    elements: [
      {
        id: 'cl-1',
        kind: 'checklist',
        x: 20,
        y: 20,
        w: 260,
        title: 'Plan',
        items: [
          { id: 'i1', label: 'recon', done: false },
          { id: 'i2', label: 'migrate', done: false }
        ]
      }
    ]
  })
  // Bind the strip to that plan board through the run mirror's own event shape.
  await callE2E(page, { m: 'swarmSetPlanBoard', a: [id, planId] })

  const board = page.locator('[data-test="swarm-board"]')
  const chips = board.locator('[data-test="swarm-plan-chip"]')
  await expect(chips).toHaveCount(2)

  // Tick the first item from the STRIP — the plan board is the source of truth, so read it back.
  await board.locator('[data-test="swarm-plan-tick"]').first().click()
  await expect.poll(() => planItemField<boolean>(page, planId, 'done')).toBe(true)

  // Rename in place: Enter commits.
  await board.locator('[data-test="swarm-plan-rename"]').first().click()
  await board.locator('[data-test="swarm-plan-edit"]').fill('recon + notes')
  await board.locator('[data-test="swarm-plan-edit"]').press('Enter')
  await expect.poll(() => planItemField<string>(page, planId, 'label')).toBe('recon + notes')

  // The ＋ chip appends a real item to the plan of record.
  await board.locator('[data-test="swarm-plan-add"]').click()
  await board.locator('[data-test="swarm-plan-edit"]').fill('ship it')
  await board.locator('[data-test="swarm-plan-edit"]').press('Enter')
  await expect(chips).toHaveCount(3)
  await expect.poll(() => planItemCount(page, planId)).toBe(3)
})
