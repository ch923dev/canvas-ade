/**
 * Swarm board (orchestration S1) — the chat-driven orchestration surface, five regions per the
 * signed-off design artifact (docs/orchestration/s1-design-artifact.html §2 · 07-swarm-board §3):
 *
 *   1 chat spine (left) — the ONE human channel: you/orch bubbles + collapsed status lines;
 *     the composer stays hot mid-run (steering is first-class). One voice: workers never post.
 *   2 plan strip (top) — READ-ONLY projection of the run's Planning-board checklist; click
 *     opens the Planning board. Editing → S2.
 *   3 worker canvas (right) — the run's worker terminal boards as glance cards (Q11 lens:
 *     ordinary boards; the card is chrome). Layer-A glance (09 §4): state icon · activity ·
 *     timer, attention-ordered (needs-input → working → spawning → done), [+ spawn] ghost.
 *   4 needs-you strip (bottom-right) — the existing attention marks as a jump list. S1 =
 *     surfacing only; approve/deny + batched confirms + stall watch → S2.
 *   5 header — run timer + Pause all. Cost meter → S4 (Q10).
 *
 * MULTI-INSTANCE: N boards = N runs; ALL state reads are keyed by this board's id (swarmStore).
 * The brain is app-resident (Stage 1): the composer drives MAIN's per-board orchestrator loop
 * over `window.api.swarm` (absent in test/smoke renders — every access optional-chains).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  SwarmBoard as SwarmBoardData,
  TerminalBoard as TerminalBoardData
} from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { useCanvasStore } from '../../store/canvasStore'
import { useSwarmStore, runFor, type SwarmRun } from '../../store/swarmStore'
import { useAttentionStore } from '../../store/attentionStore'
import { useTerminalRuntimeStore } from '../../store/terminalRuntimeStore'
import { useDockStore } from '../../store/dockStore'
import { SwarmWorkerCards } from './swarm/SwarmWorkerCards'
import { SwarmDock } from './swarm/SwarmDock'
import { SwarmPlanStrip } from './swarm/SwarmPlanStrip'
import { SwarmTriage } from './swarm/SwarmTriage'
import type { SwarmTriageAction, SwarmTriageRow } from '../../../../shared/swarmLedgerTypes'

/** Reference-stable empty owner map — a fresh `{}` per render would re-render the strip forever. */
const EMPTY_OWNERS: Record<string, 'working' | 'stalled'> = {}

/** Focus/select a board on the canvas (the notifications focus intent — camera-fit + select). */
function jumpToBoard(boardId: string): void {
  useCanvasStore.setState({ pendingFocusId: boardId })
  useCanvasStore.getState().selectBoard(boardId)
}

/** mm:ss / h:mm:ss elapsed formatter for the run timer. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}

export function SwarmBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onRemoveFromAllGroups,
  onStartConnect
}: BoardViewProps<SwarmBoardData>): ReactElement {
  const run: SwarmRun = useSwarmStore((s) => runFor(s.runs, board.id))
  const attention = useAttentionStore((s) => s.byId)
  const running = useTerminalRuntimeStore((s) => s.running)
  const [draft, setDraft] = useState('')
  // Run timer — a `now` STATE ticked once a second while a run is live (render stays pure: no
  // Date.now() in render, no sync setState in the effect body — the first paint after a run
  // starts shows "run 0s" until the first tick lands).
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (run.startedAt === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [run.startedAt])
  // Chat autoscroll: follow the tail while the user is at (or near) the bottom.
  const msgsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [run.messages])

  // S2: ask MAIN to re-push this run's durable projection. A board that mounts after a reload
  // gets its run back here; a fresh board (or a project with no ledger) simply gets nothing and
  // renders S1's empty state. Runs ONCE per board — later updates arrive on the run-event channel.
  useEffect(() => {
    void window.api?.swarm?.restore?.(board.id)
  }, [board.id])

  const send = useCallback((): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const api = window.api?.swarm
    if (!api?.startTurn) {
      // Test/smoke render or the brain surface is absent — say so instead of dropping the input.
      useSwarmStore.getState().addUserMessage(board.id, text)
      useSwarmStore.getState().addStatusLine(board.id, 'orchestrator brain unavailable')
      return
    }
    useSwarmStore.getState().addUserMessage(board.id, text)
    void api.startTurn(board.id, text).then((r) => {
      if (!r.ok) {
        useSwarmStore
          .getState()
          .addStatusLine(
            board.id,
            r.reason === 'no-key'
              ? 'no LLM key — configure Context · LLM in Settings'
              : r.reason === 'busy'
                ? 'a turn is already running'
                : `turn failed: ${r.reason ?? 'unknown'}`
          )
      }
    })
  }, [draft, board.id])

  const togglePause = useCallback((): void => {
    const next = !run.paused
    useSwarmStore.getState().setPaused(board.id, next)
    void window.api?.swarm?.setPaused?.(board.id, next)
    useSwarmStore
      .getState()
      .addStatusLine(board.id, next ? 'run paused — dispatch tools refuse' : 'run resumed')
  }, [board.id, run.paused])

  const boards = useCanvasStore((s) => s.boards)
  const titleOf = (id: string): string => boards.find((b) => b.id === id)?.title ?? id

  // Docked-terminals: this board's docked workers (rendered in the dock viewport, hidden from
  // the canvas by Canvas.tsx's visibleBoards filter) + the active tab. Opening a worker routes
  // by WHERE it lives: docked here → switch the dock tab; anywhere else (popped out / another
  // board's dock / the plan board) → the ordinary canvas jump.
  const dockedBoards = useMemo(
    () =>
      boards.filter(
        (b): b is TerminalBoardData => b.type === 'terminal' && b.dockedIn === board.id
      ),
    [boards, board.id]
  )
  const dockedIds = useMemo(() => dockedBoards.map((b) => b.id), [dockedBoards])
  const activeDockId = useDockStore((s) => s.active[board.id])
  const openWorker = useCallback(
    (id: string): void => {
      const b = useCanvasStore.getState().boards.find((x) => x.id === id)
      if (b && b.type === 'terminal' && b.dockedIn === board.id) {
        useDockStore.getState().setActive(board.id, id)
      } else {
        jumpToBoard(id)
      }
    },
    [board.id]
  )

  /**
   * S2: a triage row's non-`open` action. The button PROPOSES — MAIN re-validates the row against
   * the ledger and decides. A `reassign` comes back as a prompt rather than a dispatch, which we
   * send as the next orchestrator turn so the re-dispatch still pays the confirm gate and the
   * chat narrates it in one voice.
   */
  const onTriageAction = useCallback(
    (row: SwarmTriageRow, action: SwarmTriageAction): void => {
      const api = window.api?.swarm
      if (!api?.triageAction) return
      // 🔒 S3: `resolve` is NOT a ledger action — it disposes of a worktree, which needs async git
      // and raises its own chooser + destructive second confirm in MAIN. It takes its own channel
      // for exactly that reason; `applyAction` would refuse it (it is not in the row vocabulary
      // `offers()` re-derives), so routing it here is what makes the button work at all.
      if (action === 'resolve') {
        void api.worktreeDispose?.(board.id, row.id).then((r) => {
          useSwarmStore
            .getState()
            .addStatusLine(board.id, `worktree: ${r.detail || (r.ok ? 'done' : 'unchanged')}`)
        })
        return
      }
      void api.triageAction(board.id, row.id, action).then((r) => {
        if (!r.ok) {
          useSwarmStore.getState().addStatusLine(board.id, `triage: ${action} no longer applies`)
          return
        }
        if (!r.prompt) return
        useSwarmStore.getState().addUserMessage(board.id, r.prompt)
        void api.startTurn?.(board.id, r.prompt).then((t) => {
          if (!t.ok) {
            useSwarmStore
              .getState()
              .addStatusLine(
                board.id,
                t.reason === 'busy'
                  ? 'reassign queued — the orchestrator is mid-turn, ask again when it settles'
                  : `reassign failed: ${t.reason ?? 'unknown'}`
              )
          }
        })
      })
    },
    [board.id]
  )

  return (
    <BoardFrame
      type="swarm"
      boardId={board.id}
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      running={run.turnActive}
      contentBg="var(--surface)"
      onFull={onFull}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onAddToGroup={onAddToGroup}
      onRemoveFromGroup={onRemoveFromGroup}
      onRemoveFromAllGroups={onRemoveFromAllGroups}
      onStartConnect={onStartConnect}
    >
      <div className="sw-root" data-test="swarm-board">
        {/* ── region 5 · header strip + region 2 · plan strip ── */}
        <div className="sw-head">
          <div className="sw-head-row">
            <span className="sw-timer" data-test="swarm-run-timer">
              {run.startedAt !== null
                ? `run ${fmtElapsed(Math.max(0, now - run.startedAt))}`
                : 'no run yet'}
            </span>
            {/* S2: the ledger's one visible moment — this run came back from disk. Honest about
                what survived: the run's FACTS did, a dead worker's live PTY did not. */}
            {run.restored && run.ledger && (
              <span className="sw-restored" data-test="swarm-restored">
                restored · {run.ledger.counts.workers} worker
                {run.ledger.counts.workers === 1 ? '' : 's'} · {run.ledger.counts.results} result
                {run.ledger.counts.results === 1 ? '' : 's'}
              </span>
            )}
            {/* base P5: the visible, revocable session-consent grants (design gate 2026-07-30).
                One chip per pre-authorized role; Revoke applies on the NEXT dispatch (MAIN
                re-derives consent inside the gate per act — BUG-021). No chips = per-write. */}
            {run.consents.map((c) => (
              <span
                key={c.roleId}
                className="sw-consent-chip"
                data-test={`swarm-consent-${c.roleId}`}
              >
                <span className="sw-consent-dot" aria-hidden="true" />
                {c.roleId} · session-consented
                <button
                  type="button"
                  className="sw-consent-revoke"
                  data-test={`swarm-consent-revoke-${c.roleId}`}
                  onClick={() => {
                    void window.api?.swarm?.consentRevoke?.(board.id, c.roleId)
                  }}
                >
                  Revoke
                </button>
              </span>
            ))}
            <span className="sw-spacer" />
            <button
              type="button"
              className="sw-btn"
              onClick={togglePause}
              aria-pressed={run.paused}
              data-test="swarm-pause"
            >
              {run.paused ? 'Resume' : 'Pause all'}
            </button>
          </div>
          <SwarmPlanStrip
            planBoardId={run.planBoardId}
            owners={run.ledger?.planOwners ?? EMPTY_OWNERS}
            onOpen={jumpToBoard}
          />
        </div>

        <div className="sw-body">
          {/* ── region 1 · chat spine ── */}
          <aside className="sw-chat" data-test="swarm-chat">
            <div className="sw-chat-head">
              <span className="sw-orch-dot" data-active={run.turnActive || undefined} />
              <b>Orchestrator</b>
              <span className="sw-brain-chip">app-resident</span>
            </div>
            <div className="sw-msgs" ref={msgsRef}>
              {run.messages.length === 0 && (
                <div className="sw-empty">
                  Describe the work — the orchestrator plans, spawns workers, and narrates the run
                  here. Every dispatch still asks you first.
                </div>
              )}
              {run.messages.map((m) =>
                m.role === 'status' ? (
                  <div key={m.id} className="sw-statusline">
                    {m.text}
                  </div>
                ) : (
                  <div key={m.id} className={`sw-msg ${m.role === 'you' ? 'you' : 'orch'}`}>
                    <div className="sw-who">{m.role === 'you' ? 'you' : 'orch'}</div>
                    <p>
                      {m.text}
                      {m.streaming && <span className="sw-cursor" />}
                    </p>
                  </div>
                )
              )}
            </div>
            <div className="sw-composer">
              <div className="sw-composer-box">
                <input
                  type="text"
                  placeholder="Steer the run…"
                  aria-label="Message the orchestrator"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') send()
                    e.stopPropagation() // canvas hotkeys must not fire while typing here
                  }}
                  data-test="swarm-composer"
                />
                {run.turnActive ? (
                  <button
                    type="button"
                    className="sw-btn sm"
                    onClick={() => void window.api?.swarm?.cancelTurn?.(board.id)}
                    data-test="swarm-stop"
                  >
                    Stop
                  </button>
                ) : (
                  <button type="button" className="sw-btn sm" onClick={send} data-test="swarm-send">
                    Send
                  </button>
                )}
              </div>
              <div className="sw-hint">one voice — workers never post here</div>
            </div>
          </aside>

          {/* ── region 3 · worker dock: rail (tabs) + embedded terminal viewport ── */}
          <main className="sw-canvas" data-test="swarm-workers">
            <SwarmWorkerCards
              run={run}
              attention={attention}
              running={running}
              now={now}
              titleOf={titleOf}
              onOpen={openWorker}
              dockedIds={dockedIds}
              activeDockId={activeDockId ?? null}
            />
            <SwarmDock
              swarmId={board.id}
              docked={dockedBoards}
              run={run}
              attention={attention}
              running={running}
            />
          </main>

          {/* ── region 4 · triage queue ── */}
          <SwarmTriage
            run={run}
            attention={attention}
            titleOf={titleOf}
            onOpen={openWorker}
            onAction={onTriageAction}
          />
        </div>
      </div>
    </BoardFrame>
  )
}
