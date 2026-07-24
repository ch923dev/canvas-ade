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
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { SwarmBoard as SwarmBoardData } from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { useCanvasStore } from '../../store/canvasStore'
import { useSwarmStore, runFor, type SwarmRun } from '../../store/swarmStore'
import { useAttentionStore } from '../../store/attentionStore'
import { useTerminalRuntimeStore } from '../../store/terminalRuntimeStore'
import { SwarmWorkerCards } from './swarm/SwarmWorkerCards'
import { SwarmPlanStrip } from './swarm/SwarmPlanStrip'

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

  // Needs-you rows: this run's workers carrying an attention mark, needs-input first.
  const needsYou = run.workerIds
    .filter((id) => attention[id] !== undefined)
    .sort(
      (a, b) =>
        (attention[a] === 'needs-input' ? -1 : 0) - (attention[b] === 'needs-input' ? -1 : 0)
    )
  const needsInputCount = needsYou.filter((id) => attention[id] === 'needs-input').length
  const boards = useCanvasStore((s) => s.boards)
  const titleOf = (id: string): string => boards.find((b) => b.id === id)?.title ?? id

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
          <SwarmPlanStrip planBoardId={run.planBoardId} onOpen={jumpToBoard} />
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

          {/* ── region 3 · worker canvas ── */}
          <SwarmWorkerCards
            run={run}
            attention={attention}
            running={running}
            now={now}
            titleOf={titleOf}
            onOpen={jumpToBoard}
          />

          {/* ── region 4 · needs-you strip ── */}
          <div className="sw-needs" data-test="swarm-needs-you">
            <div className="sw-needs-head">
              Needs you{needsInputCount > 0 ? ` · ${needsInputCount}` : ''}
              <span className="sw-needs-scope">approve/deny · batching · stall watch → S2</span>
            </div>
            <div className="sw-needs-list">
              {needsYou.length === 0 && <div className="sw-needs-quiet">nothing needs you</div>}
              {needsYou.map((id) => (
                <div key={id} className={`sw-tri${attention[id] === 'needs-input' ? ' hot' : ''}`}>
                  <span className="sw-tri-ico">
                    {attention[id] === 'needs-input' ? '!' : attention[id] === 'error' ? '×' : '✓'}
                  </span>
                  <span className="sw-tri-txt">
                    <b>{titleOf(id)}</b>
                    {attention[id] === 'needs-input'
                      ? ' is waiting on input — answer in the terminal'
                      : attention[id] === 'error'
                        ? ' hit an error'
                        : ' finished'}
                  </span>
                  <button type="button" className="sw-btn sm" onClick={() => jumpToBoard(id)}>
                    Open ▸
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </BoardFrame>
  )
}
