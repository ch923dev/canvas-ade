/**
 * Integration tier (TESTING.md) for the orchestration-S2 MAIN⇄renderer surface — deliberately a
 * REAL-CHANNEL test, not two stubs facing each other. The S1 lesson: a shape agreed by a MAIN mock
 * and a renderer mock passes both unit suites and still drifts, because neither side ever sees the
 * other's actual bytes.
 *
 * So: MAIN's real `registerSwarmHandlers` runs behind the standard `ipcTestHarness`; whatever it
 * pushes on `swarm:runEvent` is CAPTURED VERBATIM and handed to the renderer's real `useSwarmEvents`
 * router, and the assertions are made on the renderer's real `swarmStore`. A field renamed on either
 * side fails here.
 *
 * Lives in the RENDERER tree, not beside the other MAIN integration suites: it needs JSX + the DOM
 * (it mounts the router hook), and `tsconfig.node.json` — which owns `src/main/**` AND `e2e/**` —
 * carries no DOM lib. A `.tsx` under `src/main` drags DOM types into the node project and breaks
 * the e2e specs' typecheck. It still drives MAIN's REAL handlers; only the file's address moved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { registerSwarmHandlers, type SwarmRunEventPush } from '../../../main/swarmChatIpc'
import { createSwarmLedgerStore, type LedgerMemory } from '../../../main/swarmLedger'
import { createIpcCapture, foreignEvent, mainFrame } from '../../../main/ipcTestHarness'
import { useSwarmEvents } from './useSwarmEvents'
import { runFor, useSwarmStore } from './swarmStore'
import type { SwarmRunEventPayload } from '../../../preload/swarm'

/**
 * The window shape MAIN's own signature asks for, derived from it — a renderer-tree file may not
 * import `electron` (security invariant, enforced by eslint), and it does not need to.
 */
type GetWin = Parameters<typeof registerSwarmHandlers>[1]

const RUN = 'swarm-board-1'
const WORKER = 'worker-1'

/** In-memory run-sidecar slice, JSON round-tripped exactly like the real atomic writer. */
function memoryStub(): LedgerMemory & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    writeRun(id, data) {
      files.set(id, JSON.stringify(data))
      return true
    },
    readRun(id) {
      const raw = files.get(id)
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    removeRun(id) {
      files.delete(id)
    },
    listRunIds() {
      return [...files.keys()]
    }
  }
}

/** The renderer's real event router, mounted exactly as AppChrome mounts it. */
function Probe(): null {
  useSwarmEvents()
  return null
}

interface Harness {
  cap: ReturnType<typeof createIpcCapture>
  /** Advance the shared MAIN clock (the ledger's `now`). */
  at: (ms: number) => void
  store: ReturnType<typeof createSwarmLedgerStore>
  /** Everything MAIN pushed on swarm:runEvent, in order. */
  pushes: SwarmRunEventPush[]
  /** Replay MAIN's pushes into the renderer router — the real cross-process hop. */
  deliver: () => void
}

function harness(): Harness {
  let clock = 1000
  const store = createSwarmLedgerStore({
    getProjectDir: () => '/proj',
    now: () => clock,
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
  registerSwarmHandlers(cap.ipcMain, () => win, { ledgerStore: store })

  let delivered = 0
  return {
    cap,
    store,
    pushes,
    at: (ms) => {
      clock = ms
    },
    deliver: () => {
      for (; delivered < pushes.length; delivered++) {
        // The preload forwards the payload UNCHANGED — so the renderer sees MAIN's own object,
        // typed as the preload's declared payload. A drift is a compile error right here.
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

/** Seed a run with one dispatched task, the way the tool executor's ledger hook would. */
function seedRun(store: ReturnType<typeof createSwarmLedgerStore>): void {
  store.ensureRun(RUN, 'ship the thing')
  store.update(RUN, (l) => {
    l.planBoardId = 'plan-1'
    l.planItems = [{ id: 'p1', label: 'Migrate readers', done: false }]
    l.tasks.push({
      taskId: 't1',
      planItemId: 'p1',
      content: 'Migrate readers',
      activeForm: 'Migrating readers…',
      state: 'in_progress',
      assignment: {
        boardId: WORKER,
        role: 'builder',
        spec: { objective: 'o', context: 'c', boundaries: 'b', outputFormat: 'f' },
        dispatchedAt: 0,
        lastActivityAt: 0,
        stallCount: 0,
        worktree: null,
        branch: null
      }
    })
  })
}

describe('swarm S2 IPC ⇄ renderer — the ledger snapshot crosses intact', () => {
  it('restore pushes a snapshot MAIN built and the renderer store adopts it', async () => {
    const h = harness()
    seedRun(h.store)

    const res = await h.cap.invoke('swarm:restore', { runId: RUN })
    expect(res).toEqual({ restored: true })
    expect(h.pushes).toHaveLength(1)

    h.deliver()
    const run = runFor(useSwarmStore.getState().runs, RUN)
    expect(run.restored).toBe(true)
    expect(run.ledger?.counts.workers).toBe(1)
    // Membership + the plan board come back for a session that never saw a spawn event.
    expect(run.workerIds).toEqual([WORKER])
    expect(run.planBoardId).toBe('plan-1')
    // The card's activity line is the ledger's activeForm, not a spinner.
    expect(run.workerMeta[WORKER]?.activity).toBe('Migrating readers…')
  })

  it('a run with no ledger restores nothing and pushes nothing (S1 degradation, not an error)', async () => {
    const h = harness()
    const res = await h.cap.invoke('swarm:restore', { runId: 'never-ran' })
    expect(res).toEqual({ restored: false })
    expect(h.pushes).toHaveLength(0)
  })

  it('triage rows survive the hop, ordered by risk, with their actions', async () => {
    const h = harness()
    seedRun(h.store)
    h.store.update(RUN, (l) => {
      l.tasks[0].state = 'blocked'
      l.tasks[0].blockedTag = 'lost'
      l.tasks[0].result = {
        status: 'partial',
        summary: 'touched 6 files',
        refs: ['a'],
        provenance: 'synthesized',
        at: 1
      }
    })
    await h.cap.invoke('swarm:restore', { runId: RUN })
    h.deliver()

    const rows = runFor(useSwarmStore.getState().runs, RUN).ledger?.triage ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 't1', tag: 'lost', boardId: WORKER })
    expect(rows[0].actions).toEqual(['accept', 'reassign'])
    // MAIN carries the id; the row's text is the sentence TAIL the renderer prefixes a title to.
    expect(rows[0].text).toContain('result salvaged')
  })

  it('a triage action re-validates MAIN-side and reassign comes back as a PROMPT, not a dispatch', async () => {
    const h = harness()
    seedRun(h.store)
    h.store.update(RUN, (l) => {
      l.tasks[0].state = 'blocked'
      l.tasks[0].blockedTag = 'lost'
    })
    await h.cap.invoke('swarm:restore', { runId: RUN })

    const bad = await h.cap.invoke('swarm:triageAction', {
      runId: RUN,
      taskId: 't1',
      action: 'not-a-real-action'
    })
    expect(bad).toEqual({ ok: false }) // closed vocabulary: an off-contract action changes nothing

    const ghost = await h.cap.invoke('swarm:triageAction', {
      runId: RUN,
      taskId: 'nope',
      action: 'reassign'
    })
    expect(ghost).toEqual({ ok: false })

    const out = (await h.cap.invoke('swarm:triageAction', {
      runId: RUN,
      taskId: 't1',
      action: 'reassign'
    })) as { ok: boolean; prompt?: string }
    expect(out.ok).toBe(true)
    expect(out.prompt).toContain('Reassign plan item 1')
    expect(out.prompt).not.toMatch(/[\r\n]/) // one approval = one PTY-safe line
    // The task went back to the queue, unassigned — it no longer produces rows for dead work.
    const after = h.store.readRun(RUN)
    expect(after?.tasks[0].state).toBe('pending')
    expect(after?.tasks[0].assignment).toBeUndefined()
  })

  it('markSeen bounds the unreviewed rows, and the renderer sees the re-push', async () => {
    const h = harness()
    seedRun(h.store)
    h.store.update(RUN, (l) => {
      l.tasks[0].state = 'done'
      l.tasks[0].result = {
        status: 'success',
        summary: 'did it',
        refs: [],
        provenance: 'claimed',
        at: 5000
      }
    })
    await h.cap.invoke('swarm:restore', { runId: RUN })
    h.deliver()
    // The result landed AFTER the human's last visit → it is unreviewed.
    expect(runFor(useSwarmStore.getState().runs, RUN).ledger?.triage).toHaveLength(1)

    h.at(9000)
    await h.cap.invoke('swarm:markSeen', { runId: RUN })
    h.deliver()
    // The result predates the human's last visit now — it has been on screen, so it stops nagging.
    expect(runFor(useSwarmStore.getState().runs, RUN).ledger?.triage).toHaveLength(0)
  })

  it('destroyRun drops the durable run with its board', async () => {
    const h = harness()
    seedRun(h.store)
    expect(h.store.readRun(RUN)).not.toBeNull()
    await h.cap.invoke('swarm:destroyRun', { runId: RUN })
    expect(h.store.readRun(RUN)).toBeNull()
  })

  it('🔒 every S2 channel refuses a foreign sender', async () => {
    const h = harness()
    seedRun(h.store)
    expect(await h.cap.invokeAs(foreignEvent, 'swarm:restore', { runId: RUN })).toEqual({
      restored: false
    })
    expect(await h.cap.invokeAs(foreignEvent, 'swarm:markSeen', { runId: RUN })).toEqual({
      ok: false
    })
    expect(
      await h.cap.invokeAs(foreignEvent, 'swarm:triageAction', {
        runId: RUN,
        taskId: 't1',
        action: 'dismiss'
      })
    ).toEqual({ ok: false })
    expect(await h.cap.invokeAs(foreignEvent, 'swarm:destroyRun', { runId: RUN })).toEqual({
      ok: false
    })
    // Nothing a foreign frame asked for happened.
    expect(h.pushes).toHaveLength(0)
    expect(h.store.readRun(RUN)).not.toBeNull()
  })
})

describe('swarm S2 IPC ⇄ renderer — between-turn narration', () => {
  it('a narrate push becomes a status line + an orchestrator bubble, title-resolved renderer-side', () => {
    const h = harness()
    // MAIN's watcher composes exactly this shape (swarmWatch.narrate → push).
    h.pushes.push({
      runId: RUN,
      ev: { kind: 'narrate', boardId: WORKER, status: 'exited', text: 'died on task 1 — salvaged' }
    })
    h.deliver()

    const msgs = runFor(useSwarmStore.getState().runs, RUN).messages
    expect(msgs.map((m) => m.role)).toEqual(['status', 'orch'])
    // No canvas board with this id in the test render ⇒ no title to prefix; the sentence still reads.
    expect(msgs[1].text).toContain('died on task 1')
    expect(msgs[1].streaming).toBeUndefined() // a between-turns bubble is complete, not streaming
  })
})
