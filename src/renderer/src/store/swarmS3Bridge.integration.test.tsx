/**
 * Integration tier (TESTING.md) for the orchestration-S3 MAIN⇄renderer surface — the same
 * REAL-CHANNEL discipline as the S2 bridge suite, for the same reason: a shape agreed by a MAIN
 * mock and a renderer mock passes both unit suites and still drifts, because neither side ever
 * sees the other's actual bytes.
 *
 * MAIN's real `registerSwarmHandlers` runs behind `ipcTestHarness` with a STUB worktree store
 * (git is the one thing that must not run here); whatever MAIN pushes on `swarm:runEvent` is
 * captured verbatim and fed to the renderer's real `useSwarmEvents`, and assertions land on the
 * real `swarmStore`. What it protects: the worktree chip, the merge sequence, and the disposition
 * round-trip — the three S3 shapes that cross the process boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { registerSwarmHandlers, type SwarmRunEventPush } from '../../../main/swarmChatIpc'
import { createSwarmLedgerStore, type LedgerMemory } from '../../../main/swarmLedger'
import { createIpcCapture, mainFrame } from '../../../main/ipcTestHarness'
import type { SwarmWorktreeStore } from '../../../main/swarmWorktree'
import { useSwarmEvents } from './useSwarmEvents'
import { runFor, useSwarmStore } from './swarmStore'
import type { SwarmRunEventPayload } from '../../../preload/swarm'

type GetWin = Parameters<typeof registerSwarmHandlers>[1]

const RUN = 'swarm-board-1'
const W1 = 'worker-1'
const W2 = 'worker-2'
const WT1 = 'M:/proj/.canvas/worktrees/builder-1'
const WT2 = 'M:/proj/.canvas/worktrees/builder-2'

function memoryStub(): LedgerMemory {
  const files = new Map<string, string>()
  return {
    writeRun: (id, data) => (files.set(id, JSON.stringify(data)), true),
    readRun: (id) => {
      const raw = files.get(id)
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    removeRun: (id) => void files.delete(id),
    listRunIds: () => [...files.keys()]
  }
}

/** A worktree store with no git behind it — the calls are recorded, the answers are scripted. */
function worktreeStub(
  dirty: Record<string, number> = {}
): SwarmWorktreeStore & { disposed: Array<[string, string]>; removed: string[] } {
  const disposed: Array<[string, string]> = []
  const removed: string[] = []
  return {
    disposed,
    removed,
    allocate: vi.fn(async () => ({
      ok: true as const,
      worktree: WT1,
      branch: 'swarm/rrrr/builder-1'
    })),
    status: vi.fn(async (p: string) => ({
      exists: true,
      dirty: (dirty[p] ?? 0) > 0,
      changed: dirty[p] ?? 0
    })),
    removeIfClean: vi.fn(async (p: string) => {
      if ((dirty[p] ?? 0) > 0)
        return { removed: false, reason: 'uncommitted changes — kept on disk' }
      removed.push(p)
      return { removed: true }
    }),
    dispose: vi.fn(async (p: string, choice: string) => {
      disposed.push([p, choice])
      if (choice !== 'keep') delete dirty[p]
      return { ok: true, detail: `${choice} done` }
    }),
    owns: () => true
  }
}

function Probe(): null {
  useSwarmEvents()
  return null
}

/** MAIN's own dep type, so a rename of the confirm contract is a compile error here. */
type SwarmDeps = NonNullable<Parameters<typeof registerSwarmHandlers>[2]>

function harness(opts: {
  worktrees: ReturnType<typeof worktreeStub>
  confirm?: SwarmDeps['confirm']
}): {
  cap: ReturnType<typeof createIpcCapture>
  store: ReturnType<typeof createSwarmLedgerStore>
  pushes: SwarmRunEventPush[]
  deliver: () => void
} {
  const store = createSwarmLedgerStore({
    getProjectDir: () => '/proj',
    now: () => 1000,
    memoryFor: () => memoryStub()
  })
  const pushes: SwarmRunEventPush[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        if (channel === 'swarm:runEvent') pushes.push(payload as SwarmRunEventPush)
      }
    }
  } as unknown as ReturnType<GetWin>
  const cap = createIpcCapture()
  registerSwarmHandlers(cap.ipcMain, () => win, {
    ledgerStore: store,
    worktrees: opts.worktrees,
    ...(opts.confirm ? { confirm: opts.confirm } : {})
  })
  let delivered = 0
  return {
    cap,
    store,
    pushes,
    deliver: () => {
      for (; delivered < pushes.length; delivered++) {
        onRun(pushes[delivered] as SwarmRunEventPayload)
      }
    }
  }
}

let onRun: (ev: SwarmRunEventPayload) => void

beforeEach(() => {
  cleanup()
  useSwarmStore.getState().clearAll()
  ;(window as unknown as { api: unknown }).api = {
    swarm: {
      onTurnEvent: vi.fn(() => () => {}),
      onRunEvent: vi.fn((h: (ev: SwarmRunEventPayload) => void) => {
        onRun = h
        return () => {}
      }),
      restore: vi.fn(async () => ({ restored: false }))
    }
  }
  render(<Probe />)
})

/** Two finished isolated builders that touched the same file — the S3 exit scenario. */
function seedOverlappingRun(store: ReturnType<typeof createSwarmLedgerStore>): void {
  store.ensureRun(RUN, 'ship the thing')
  store.update(RUN, (l) => {
    const mk = (
      taskId: string,
      boardId: string,
      worktree: string,
      branch: string,
      refs: string[]
    ): void => {
      l.tasks.push({
        taskId,
        content: 'Migrate readers',
        activeForm: 'Migrating readers…',
        state: 'done',
        assignment: {
          boardId,
          role: 'builder',
          spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
          dispatchedAt: 0,
          lastActivityAt: 0,
          stallCount: 0,
          worktree,
          branch
        },
        result: { status: 'done', summary: 'ok', refs, provenance: 'claimed', at: 0 }
      })
    }
    mk('t1', W1, WT1, 'swarm/rrrr/builder-1', ['src/main/load.ts', 'src/a.ts'])
    mk('t2', W2, WT2, 'swarm/rrrr/builder-2', ['./src/main/LOAD.ts'])
  })
}

/** Let MAIN's fire-and-forget `kickRefresh` (git status → re-push) settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('swarm S3 IPC ⇄ renderer — the worktree surface crosses intact', () => {
  it('restore carries the chip, the branch and the merge sequence into the renderer store', async () => {
    const h = harness({ worktrees: worktreeStub({ [WT2]: 7 }) })
    seedOverlappingRun(h.store)

    expect(await h.cap.invoke('swarm:restore', { runId: RUN })).toEqual({ restored: true })
    await flush()
    h.deliver()

    const run = runFor(useSwarmStore.getState().runs, RUN)
    const byBoard = new Map((run.ledger?.workers ?? []).map((w) => [w.boardId, w]))
    // The chip: full branch for the title, leaf for the card, state-dependent note.
    expect(byBoard.get(W1)?.worktree).toMatchObject({
      branch: 'swarm/rrrr/builder-1',
      leaf: 'builder-1',
      note: '2 files · ready'
    })
    // 🔒 The preserved tree says KEPT — the whole reassurance of the locked policy.
    expect(byBoard.get(W2)?.worktree).toMatchObject({ note: 'kept, 7 uncommitted', dirty: true })

    // The merge sequence, in dependency order, with the LATER branch marked for rebase.
    const seq = run.ledger?.mergeSequence ?? []
    expect(seq.map((s) => s.branch)).toEqual(['swarm/rrrr/builder-1', 'swarm/rrrr/builder-2'])
    expect(seq[0].overlapsWith).toEqual([])
    expect(seq[1].overlapsWith).toEqual([1])
    expect(seq[1].dirty).toBe(true)

    // And the rows the human acts on, risk-ordered by the SHARED tag order.
    const tags = (run.ledger?.triage ?? []).map((r) => r.tag)
    expect(tags).toEqual(['overlap', 'dirty_worktree', 'merge_ready'])
    const overlap = run.ledger!.triage.find((r) => r.tag === 'overlap')!
    // MAIN carries ids, never titles — the renderer resolves BOTH names.
    expect(overlap.boardId).toBe(W2)
    expect(overlap.boardId2).toBe(W1)
    expect(overlap.text).toContain('src/main/load.ts')
  })

  it('a run with no isolated worker pushes an empty sequence and no integration rows', async () => {
    const h = harness({ worktrees: worktreeStub() })
    h.store.ensureRun(RUN, 'run')
    h.store.update(RUN, (l) => {
      l.tasks.push({
        taskId: 't1',
        content: 'Review',
        activeForm: 'Reviewing…',
        state: 'done',
        assignment: {
          boardId: W1,
          role: 'code-reviewer',
          spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
          dispatchedAt: 0,
          lastActivityAt: 0,
          stallCount: 0,
          worktree: null,
          branch: null
        },
        result: { status: 'done', summary: 'clean', refs: [], provenance: 'claimed', at: 0 }
      })
    })
    await h.cap.invoke('swarm:restore', { runId: RUN })
    await flush()
    h.deliver()
    const run = runFor(useSwarmStore.getState().runs, RUN)
    expect(run.ledger?.mergeSequence).toEqual([])
    expect(run.ledger?.workers[0].worktree).toBeUndefined()
    expect((run.ledger?.triage ?? []).some((r) => r.tag === 'merge_ready')).toBe(false)
  })
})

describe('swarm:worktreeDispose — the locked keep-on-dirty prompt, over the real channel', () => {
  it('offers the four named choices with the LIVE file count, and commits when chosen', async () => {
    const seen: Array<Record<string, unknown>> = []
    const wt = worktreeStub({ [WT2]: 7 })
    const h = harness({
      worktrees: wt,
      confirm: vi.fn(async (req) => {
        seen.push(req as unknown as Record<string, unknown>)
        return { approved: true, choice: 'commit' }
      })
    })
    seedOverlappingRun(h.store)

    const out = await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't2' })
    expect(out).toMatchObject({ ok: true })
    expect(wt.disposed).toEqual([[WT2, 'commit']])

    const req = seen[0] as {
      body: string
      choices: { default: string; options: Array<{ id: string }> }
    }
    expect(req.choices.options.map((o) => o.id)).toEqual(['keep', 'commit', 'stash', 'discard'])
    // Keep is the default AND the cancel path — nothing destroys a tree without a named choice.
    expect(req.choices.default).toBe('keep')
    // The count is read LIVE at open time; a number stale by an hour is a disclosure that lies.
    expect(req.body).toContain('7 files')
    expect(req.body).toContain('branch is never deleted')
  })

  it('🔒 a cancel KEEPS the tree and runs nothing', async () => {
    const wt = worktreeStub({ [WT2]: 7 })
    const h = harness({ worktrees: wt, confirm: vi.fn(async () => ({ approved: false })) })
    seedOverlappingRun(h.store)
    const out = await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't2' })
    expect(out).toMatchObject({ ok: true, detail: expect.stringContaining('kept on disk') })
    expect(wt.dispose).not.toHaveBeenCalled()
  })

  it('🔒 an off-vocabulary choice falls back to KEEP, never to a destructive branch', async () => {
    const wt = worktreeStub({ [WT2]: 7 })
    const h = harness({
      worktrees: wt,
      confirm: vi.fn(async () => ({ approved: true, choice: 'rm -rf' }))
    })
    seedOverlappingRun(h.store)
    await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't2' })
    expect(wt.disposed).toEqual([[WT2, 'keep']])
  })

  it('🔒 discard pays a SECOND confirm, and declining it keeps the work', async () => {
    const wt = worktreeStub({ [WT2]: 7 })
    const titles: string[] = []
    const h = harness({
      worktrees: wt,
      confirm: vi.fn(async (req) => {
        titles.push(req.title)
        // Approve the chooser, decline the destructive follow-up.
        return titles.length === 1 ? { approved: true, choice: 'discard' } : { approved: false }
      })
    })
    seedOverlappingRun(h.store)
    const out = await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't2' })
    expect(titles[1]).toBe('Discard uncommitted work?')
    expect(out).toMatchObject({ ok: true, detail: expect.stringContaining('discard cancelled') })
    expect(wt.dispose).not.toHaveBeenCalled()
  })

  it('refuses a task that holds no worktree, without asking the human anything', async () => {
    const confirm = vi.fn(async () => ({ approved: true, choice: 'discard' }))
    const h = harness({ worktrees: worktreeStub(), confirm })
    h.store.ensureRun(RUN, 'run')
    expect(
      await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 'ghost' })
    ).toMatchObject({
      ok: false
    })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('a tree that stopped being dirty is just removed — no prompt on stale intent', async () => {
    const confirm = vi.fn(async () => ({ approved: true, choice: 'discard' }))
    const wt = worktreeStub() // nothing dirty
    const h = harness({ worktrees: wt, confirm })
    seedOverlappingRun(h.store)
    const out = await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't2' })
    expect(out).toMatchObject({ ok: true, detail: expect.stringContaining('already clean') })
    expect(confirm).not.toHaveBeenCalled()
    expect(wt.removed).toEqual([WT2])
  })

  it('after a disposition the board re-projects — the row disappears on its own', async () => {
    const wt = worktreeStub({ [WT2]: 7 })
    const h = harness({
      worktrees: wt,
      confirm: vi.fn(async () => ({ approved: true, choice: 'commit' }))
    })
    seedOverlappingRun(h.store)
    await h.cap.invoke('swarm:restore', { runId: RUN })
    await flush()
    h.deliver()
    expect(
      (runFor(useSwarmStore.getState().runs, RUN).ledger?.triage ?? []).some(
        (r) => r.tag === 'dirty_worktree'
      )
    ).toBe(true)

    await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't2' })
    await flush()
    h.deliver()
    // Self-healing: the status cache moved, so the next projection simply has no dirty row.
    expect(
      (runFor(useSwarmStore.getState().runs, RUN).ledger?.triage ?? []).some(
        (r) => r.tag === 'dirty_worktree'
      )
    ).toBe(false)
  })
})

describe('🔒 S3 — the dispose gate refuses a worktree a worker is still writing to', () => {
  /**
   * Defence in depth for the PR #394 `[critical]`. The projection no longer EMITS a row for a
   * live tree, but the row the human clicks may be seconds stale — a reused worker can take a new
   * task between the push and the click. MAIN re-derives liveness from the WORKTREE (never from
   * the row's own task, which is finished) and refuses before the chooser is even raised.
   */
  function seedReusedWorker(store: ReturnType<typeof createSwarmLedgerStore>): void {
    store.ensureRun(RUN, 'run')
    store.update(RUN, (l) => {
      const at = (taskId: string, state: 'done' | 'in_progress'): void => {
        l.tasks.push({
          taskId,
          content: 'Migrate',
          activeForm: 'Migrating…',
          state,
          assignment: {
            boardId: W1,
            role: 'builder',
            spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
            dispatchedAt: 0,
            lastActivityAt: 0,
            stallCount: 0,
            worktree: WT1,
            branch: 'swarm/rrrr/builder-1'
          },
          ...(state === 'done'
            ? {
                result: {
                  status: 'done',
                  summary: 'ok',
                  refs: ['src/a.ts'],
                  provenance: 'claimed' as const,
                  at: 0
                }
              }
            : {})
        })
      }
      at('t1', 'done') // older, finished — the row would anchor here
      at('t2', 'in_progress') // newer, RUNNING, same worker and therefore the same tree
    })
  }

  it('refuses the stale row without raising the chooser, and never runs a git write', async () => {
    const confirm = vi.fn(async () => ({ approved: true, choice: 'discard' }))
    const wt = worktreeStub({ [WT1]: 9 })
    const h = harness({ worktrees: wt, confirm })
    seedReusedWorker(h.store)

    const out = await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't1' })
    expect(out).toMatchObject({ ok: false })
    expect((out as { detail: string }).detail).toContain('working in that worktree right now')
    // The whole point: no modal, no `git clean -fd`, nothing touched.
    expect(confirm).not.toHaveBeenCalled()
    expect(wt.dispose).not.toHaveBeenCalled()
    expect(wt.removed).toEqual([])
  })

  it('and the board never offered that row in the first place', async () => {
    const h = harness({ worktrees: worktreeStub({ [WT1]: 9 }) })
    seedReusedWorker(h.store)
    await h.cap.invoke('swarm:restore', { runId: RUN })
    await flush()
    h.deliver()
    const run = runFor(useSwarmStore.getState().runs, RUN)
    expect((run.ledger?.triage ?? []).some((r) => r.tag === 'dirty_worktree')).toBe(false)
    // Nor is a half-written branch offered for merge.
    expect(run.ledger?.mergeSequence).toEqual([])
  })

  it('once the live task settles, the same row becomes disposable again', async () => {
    const wt = worktreeStub({ [WT1]: 9 })
    const h = harness({
      worktrees: wt,
      confirm: vi.fn(async () => ({ approved: true, choice: 'stash' }))
    })
    seedReusedWorker(h.store)
    h.store.update(RUN, (l) => {
      const t = l.tasks.find((x) => x.taskId === 't2')!
      t.state = 'done'
    })
    const out = await h.cap.invoke('swarm:worktreeDispose', { runId: RUN, taskId: 't1' })
    expect(out).toMatchObject({ ok: true })
    expect(wt.disposed).toEqual([[WT1, 'stash']])
  })
})
