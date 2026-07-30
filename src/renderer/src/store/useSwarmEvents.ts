/**
 * Swarm event router (orchestration S1) — the ONE global subscription that mirrors MAIN's
 * per-board orchestrator sessions into the renderer swarmStore (the useNotifications pattern:
 * mounted once in AppChrome; guarded for non-electron test/smoke renders). Two channels:
 *
 *   - `swarm:turn:event` — a turn's streamed lifecycle. Deltas open/append a streaming orch
 *     bubble (one per turn, tracked in a module map); done settles it; error becomes a status
 *     line; act events render as collapsed status lines while a gated tool waits/lands.
 *   - `swarm:runEvent` — the run mirror: worker spawned (membership + role), plan drawn (the
 *     strip binding), activity lines, settled provenance.
 *
 * Everything is keyed by runId = the swarm board id, so N concurrent runs never cross streams.
 */
import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { useSwarmStore } from './swarmStore'

/** turnKey (runId:turnId) → the streaming orch message id it appends into. */
const streamMsg = new Map<string, number>()

/** Human-readable act lines for the chat spine's collapsed status rows. */
const ACT_LINE: Record<string, (summary: string) => string | null> = {
  confirm: (s) => `waiting for your confirm — ${s}`,
  denied: (s) => `denied — ${s}`,
  error: (s) => `failed — ${s}`,
  // 'running'/'ok' for reads are noise; ok for writes is narrated by the model itself.
  running: () => null,
  ok: () => null
}

/**
 * A worker's display name for a narration: the LIVE canvas title first (the human may have renamed
 * the board), then the title it was spawned with — which is the only one left once the board has
 * been deleted, i.e. exactly the "a worker died" case. Falls back to '' so the sentence still
 * reads, rather than printing a raw uuid at the human.
 */
function workerTitle(runId: string, boardId: string): string {
  const live = useCanvasStore.getState().boards.find((b) => b.id === boardId)?.title
  return live ?? useSwarmStore.getState().runs.get(runId)?.workerMeta[boardId]?.title ?? ''
}

export function useSwarmEvents(): void {
  useEffect(() => {
    const api = window.api?.swarm
    if (!api) return

    const offTurn = api.onTurnEvent((ev) => {
      const store = useSwarmStore.getState()
      const key = `${ev.runId}:${ev.id}`
      if (ev.kind === 'delta') {
        let msgId = streamMsg.get(key)
        if (msgId === undefined) {
          store.setTurnActive(ev.runId, true)
          msgId = store.beginOrchMessage(ev.runId)
          streamMsg.set(key, msgId)
        }
        store.appendOrchDelta(ev.runId, msgId, ev.text)
      } else if (ev.kind === 'done') {
        const msgId = streamMsg.get(key)
        streamMsg.delete(key)
        if (msgId !== undefined) store.settleOrchMessage(ev.runId, msgId)
        else if (ev.text.trim().length > 0) {
          // A turn can settle without any delta having streamed (tool-only turns) — land the
          // final text as one bubble rather than dropping it.
          const id = store.beginOrchMessage(ev.runId)
          store.appendOrchDelta(ev.runId, id, ev.text)
          store.settleOrchMessage(ev.runId, id)
        }
        if (ev.cancelled) store.addStatusLine(ev.runId, 'turn interrupted')
        store.setTurnActive(ev.runId, false)
      } else if (ev.kind === 'error') {
        const msgId = streamMsg.get(key)
        streamMsg.delete(key)
        if (msgId !== undefined) store.settleOrchMessage(ev.runId, msgId)
        store.addStatusLine(
          ev.runId,
          ev.reason === 'no-key'
            ? 'no LLM key — configure Context · LLM in Settings'
            : ev.reason === 'budget-exceeded'
              ? 'daily LLM budget exhausted'
              : `turn failed: ${ev.reason}`
        )
        store.setTurnActive(ev.runId, false)
      } else if (ev.kind === 'act') {
        const line = ACT_LINE[ev.phase]?.(ev.summary)
        if (line) store.addStatusLine(ev.runId, line)
      }
    })

    const offRun = api.onRunEvent(({ runId, ev }) => {
      const store = useSwarmStore.getState()
      if (ev.kind === 'workerSpawned') {
        store.addWorker(runId, ev.workerId, {
          role: ev.role,
          title: ev.title,
          activity: 'Spawning…'
        })
      } else if (ev.kind === 'planDrawn') {
        store.setPlanBoard(runId, ev.planBoardId)
      } else if (ev.kind === 'activity') {
        store.setWorkerMeta(runId, ev.workerId, { activity: ev.text })
      } else if (ev.kind === 'workerSettled') {
        store.setWorkerMeta(runId, ev.workerId, { provenance: ev.provenance })
      } else if (ev.kind === 'ledger') {
        // S2: MAIN's durable projection — worker states, triage rows, plan board, restored flag.
        store.setLedger(runId, ev.snapshot)
      } else if (ev.kind === 'narrate') {
        // S2: a between-turns event (worker died / stalled). MAIN sends the sentence TAIL and a
        // board id; the TITLE is resolved here, because the renderer is the only title authority.
        const who = ev.boardId ? workerTitle(runId, ev.boardId) : ''
        if (ev.status) store.addStatusLine(runId, who ? `${who} · ${ev.status}` : ev.status)
        store.addOrchMessage(runId, who ? `${who} ${ev.text}` : ev.text)
      } else if (ev.kind === 'consent') {
        // base P5: the active session-consent snapshot — the header's revocable chip row.
        store.setConsents(runId, ev.consents)
      }
    })

    return () => {
      offTurn()
      offRun()
    }
  }, [])

  // Board-lifecycle cleanup, owned HERE so canvasStore stays swarm-free (its max-lines ratchet
  // is the enforcement): a deleted swarm board drops its run; a deleted worker leaves every
  // run; a project load/switch (boards wholesale-replaced) kills every run. The subscription
  // fires per store commit — the identity gate + one O(boards) id sweep make it negligible
  // (no React re-render rides this; it is a plain store-to-store bridge).
  useEffect(() => {
    let prevBoards = useCanvasStore.getState().boards
    let prevDir = useCanvasStore.getState().project.dir
    return useCanvasStore.subscribe((s) => {
      if (s.project.dir !== prevDir) {
        prevDir = s.project.dir
        prevBoards = s.boards
        useSwarmStore.getState().clearAll() // runs never survive a project switch
        return
      }
      if (s.boards === prevBoards) return
      const gone = prevBoards.filter((b) => !s.boards.some((n) => n.id === b.id))
      prevBoards = s.boards
      if (gone.length === 0) return
      const swarm = useSwarmStore.getState()
      for (const b of gone) {
        if (b.type === 'swarm') {
          swarm.removeRun(b.id)
          // S2: the durable run dies with its board — otherwise a deleted swarm board leaves an
          // orphan ledger that the retention sweep would keep alive for 19 more runs.
          void window.api?.swarm?.destroyRun?.(b.id)
        } else {
          for (const [runId, run] of swarm.runs) {
            if (run.workerIds.includes(b.id)) swarm.removeWorker(runId, b.id)
          }
        }
      }
    })
  }, [])
}
