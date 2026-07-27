import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

/**
 * @core Workspace isolation (orchestration S3) — the parallel-writers slice, against the REAL app.
 *
 * The S3 exit proof (`07-swarm-board.md` §6): three builders on disjoint areas each work in their
 * own worktree/branch with no file races; worktree chips render on the worker cards; overlapping
 * touched-file sets raise an overlap warning in triage; the branches are surfaced for the human to
 * merge, in sequence, not clobbered. These specs cover it in two halves:
 *
 *   1. against a REAL git repo — the shipped allocator gives three workers three disjoint trees on
 *      three branches, refuses when the tree would be dirty, and never deletes a branch;
 *   2. against a seeded ledger — the chip, the overlap row and the merge sequence render from the
 *      durable record, and a read-only worker's card carries no worktree line at all.
 *
 * 🔒 TEARDOWN. Every worktree, branch and repo this file creates lives INSIDE the temp project it
 * owns, and every spec deletes that project in a `finally`. One app is reused across every spec
 * file, so a leaked current dir becomes the next spec's PTY cwd — and this is the first lane that
 * also writes real git state, which is exactly the third leak class the S2 lane warned about.
 */

const MIN = 60_000

const assignment = (
  boardId: string,
  at: number,
  worktree: string | null,
  branch: string | null
): Record<string, unknown> => ({
  boardId,
  role: worktree ? 'builder' : 'code-reviewer',
  spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
  dispatchedAt: at,
  lastActivityAt: at,
  stallCount: 0,
  worktree,
  branch
})

const finished = (
  taskId: string,
  boardId: string,
  at: number,
  worktree: string | null,
  branch: string | null,
  refs: string[]
): Record<string, unknown> => ({
  taskId,
  content: `Migrate ${taskId}`,
  activeForm: `Migrating ${taskId}…`,
  state: 'done',
  assignment: assignment(boardId, at, worktree, branch),
  result: { status: 'done', summary: 'ok', refs, provenance: 'claimed', at }
})

function ledgerFor(boardId: string, now: number, tasks: Array<Record<string, unknown>>): unknown {
  return {
    version: 1,
    runId: boardId,
    boardId,
    title: 'ship the thing',
    createdAt: now - 20 * MIN,
    lastActiveAt: now - MIN,
    // Every result predates this, so nothing shows up as `unreviewed` and the queue holds ONLY
    // the integration rows under test.
    lastSeenAt: now,
    state: 'live',
    planBoardId: null,
    planItems: [],
    tasks,
    events: [],
    eventSeq: 1
  }
}

/** Open a temp project and get the swarm board out of the way of the recap/digest chrome. */
async function openBoard(page: Parameters<typeof seed>[0], tmp: string): Promise<string> {
  await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
  await page
    .getByRole('button', { name: /^no thanks$/i })
    .click({ timeout: 8000 })
    .catch(() => undefined)
  await evalIn(page, `window.__canvasE2E.closeDigest()`)
  const id = await seed(page, 'swarm')
  await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
  return id
}

test('@core three write workers get three disjoint worktrees on three branches — the real allocator', async ({
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'swarm-wt-', 'swarm-wt')
  const made: string[] = []
  try {
    // 🔒 The refusal comes FIRST, before there is a repo: Expanse never runs `git init` for you.
    const beforeRepo = await mainCall<{ ok: boolean; reason?: string }>(
      electronApp,
      'swarmAllocateWorktree',
      'run-aaaa',
      'builder-1'
    )
    expect(beforeRepo.ok).toBe(false)
    expect(beforeRepo.reason).toContain('never runs `git init`')

    expect(await mainCall<boolean>(electronApp, 'gitInitProject')).toBe(true)

    for (const name of ['builder-1', 'builder-2', 'builder-3']) {
      const out = await mainCall<{ ok: boolean; worktree?: string; branch?: string }>(
        electronApp,
        'swarmAllocateWorktree',
        'run-aaaa',
        name
      )
      expect(out.ok).toBe(true)
      expect(out.branch).toBe(`swarm/runaaaa/${name}`)
      made.push(out.worktree!)
    }

    // DISJOINT by construction — three distinct trees, three distinct branches. This is the whole
    // claim: two builders can no longer race on one working tree.
    expect(new Set(made).size).toBe(3)
    // Each is a real directory git will talk to (the `safeCwd` guard proved it before returning).
    for (const wt of made) {
      const st = await mainCall<{ exists: boolean; dirty: boolean }>(
        electronApp,
        'swarmWorktreeStatus',
        wt
      )
      expect(st.exists).toBe(true)
      expect(st.dirty).toBe(false)
    }

    // Clean teardown removes the tree with no --force. (The branch survives — that is what the
    // merge sequence is built from, and Expanse never deletes one.)
    const removed = await mainCall<{ removed: boolean; reason?: string }>(
      electronApp,
      'swarmRemoveWorktree',
      made[0]
    )
    // Assert THROUGH the reason: a refusal that only says `false` is a failure you have to
    // reproduce by hand, and this path has four distinct refusal reasons.
    expect(removed.reason ?? 'removed').toBe('removed')
    expect(removed.removed).toBe(true)
    expect(
      (await mainCall<{ exists: boolean }>(electronApp, 'swarmWorktreeStatus', made[0])).exists
    ).toBe(false)
  } finally {
    // Belt and braces: the temp project delete takes the repo, its branches and every remaining
    // worktree with it, but ask the allocator first so a failure here is visible rather than
    // silently folded into a directory removal.
    for (const wt of made) {
      await mainCall(electronApp, 'swarmRemoveWorktree', wt).catch(() => undefined)
    }
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

test('@core the board renders the worktree chip, the overlap warning and the merge sequence', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'swarm-wt2-', 'swarm-wt2')
  try {
    const id = await openBoard(page, tmp)
    const now = Date.now()
    // Two isolated builders that touched the SAME file in two different worktrees (different
    // spellings, as two real agents would report them), plus a read-only reviewer with no tree.
    const wrote = await mainCall<boolean>(
      electronApp,
      'writeSwarmRun',
      id,
      ledgerFor(id, now, [
        finished(
          't1',
          'w-b1',
          now - 10 * MIN,
          `${tmp}/.canvas/worktrees/builder-1`,
          'swarm/rrrr/builder-1',
          [
            `${tmp}/.canvas/worktrees/builder-1/src/main/load.ts:42`,
            `${tmp}/.canvas/worktrees/builder-1/src/a.ts`
          ]
        ),
        finished(
          't2',
          'w-b2',
          now - 9 * MIN,
          `${tmp}/.canvas/worktrees/builder-2`,
          'swarm/rrrr/builder-2',
          ['./src/main/LOAD.ts']
        ),
        finished('t3', 'w-rev', now - 8 * MIN, null, null, ['src/z.ts'])
      ])
    )
    expect(wrote).toBe(true)

    expect(
      (await evalIn<{ restored: boolean }>(page, `window.api.swarm.restore(${JSON.stringify(id)})`))
        .restored
    ).toBe(true)

    const board = page.locator('[data-test="swarm-board"]')

    // 1 — the chip: leaf on the card, full branch in the title. Isolation is VISIBLE.
    const b1 = board.locator('[data-test="swarm-card-w-b1"]')
    await expect(b1.locator('.sw-wt')).toContainText('builder-1')
    await expect(b1.locator('.sw-wt')).toHaveAttribute('title', 'swarm/rrrr/builder-1')
    // 2 — and a read-only worker has NO line at all: isolation cost is paid by writers alone.
    await expect(board.locator('[data-test="swarm-card-w-rev"] .sw-wt')).toHaveCount(0)

    // 3 — the overlap warning, naming BOTH workers and the file, in the err lane (not amber:
    // nobody is asking the human a question).
    const overlap = board.locator('[data-test="swarm-triage-overlap"]')
    await expect(overlap).toBeVisible()
    await expect(overlap).toContainText('load.ts')
    await expect(overlap).toContainText('rebase the other')
    await expect(overlap).toHaveClass(/bad/)

    // 4 — the merge sequence: both branches, in order, with the LATER one marked to rebase.
    const seq = board.locator('[data-test="swarm-merge-sequence"]')
    await expect(seq).toBeVisible()
    const branches = await seq.locator('.sw-seq-br').allTextContents()
    expect(branches).toEqual(['swarm/rrrr/builder-1', 'swarm/rrrr/builder-2'])
    await expect(seq.locator('.sw-seq-warn')).toContainText('overlaps #1')
    // 5 — and it says plainly that Expanse will not merge for you. Auto-merge is deferred, so
    // there is no merge button anywhere on this surface.
    await expect(seq.locator('.sw-seq-foot')).toContainText('does not merge for you')
    await expect(board.getByRole('button', { name: /^merge/i })).toHaveCount(0)

    // 6 — risk order holds with the new tags in the vocabulary: overlap above merge_ready.
    const tags = await board.locator('.sw-tri .sw-tri-tag').allTextContents()
    expect(tags).toEqual(['overlap', 'merge ready'])
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})
