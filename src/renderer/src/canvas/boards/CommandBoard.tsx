/**
 * Command board content — the orchestrator's on-canvas face (Combined ⑤). The BoardFrame chrome + a
 * titlebar seg (Kanban / Groups) + the submit well + worker-pool discovery strip + the five-column
 * lifecycle kanban, plus a collapsed one-line rail. SINGLETON (enforced in `canvasStore.addBoard`).
 *
 * Phase C makes dispatch live: `SubmitWell` (with composition chips) hands a task to
 * `useCommandDispatch`, which spawns a worker group + dispatches over the renderer→MAIN orchestrator
 * IPC and marches each `TaskCard` through the kanban (queued → routing → executing → done/failed),
 * serialized at the worker-pool cap. Recap/diff is Phase D; group roll-up content is Phase E. All
 * task state is ephemeral `commandStore` — never serialized; pool counts derive from the live boards.
 *
 * Owns this file; the shared surface (BoardFrame, schema, stores) is consumed, never modified. The
 * submit well, task card, and dispatch hook live in `./command/`.
 */
import { useCallback, useMemo, type CSSProperties, type ReactElement } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { CommandBoard as CommandBoardData } from '../../lib/boardSchema'
import { DEFAULT_BOARD_SIZE } from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { useTerminalRuntimeStore } from '../../store/terminalRuntimeStore'
import {
  useCommandStore,
  tasksInColumn,
  type CommandTask,
  type CommandView,
  type TaskStatus
} from '../../store/commandStore'
import { deriveWorkerPool } from '../../store/workerPool'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { useTerminalFlip } from './useTerminalFlip'
import { SubmitWell } from './command/SubmitWell'
import { TaskCard } from './command/TaskCard'
import { CommandRecapView } from './command/CommandRecapView'
import { WorkerConfigDialog } from './command/WorkerConfigDialog'
import { useCommandDispatch } from './command/useCommandDispatch'

/**
 * Collapsed (rail) board height. The 34px titlebar + the rail's well/track/counts stack need ≈130px;
 * 136 leaves a little breathing room. Intentionally below MIN_BOARD_SIZE — that clamp only gates
 * manual drag-resize (and a fresh project always reopens expanded, so the on-load clamp never bites).
 */
const COLLAPSED_H = 136

/** The five kanban lifecycle columns, in TaskStatus order. `failed` tasks bucket into Done. */
const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'queued', label: 'Queued' },
  { key: 'routing', label: 'Routing' },
  { key: 'executing', label: 'Executing' },
  { key: 'reporting', label: 'Reporting' },
  { key: 'done', label: 'Done' }
]

export function CommandBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onStartConnect
}: BoardViewProps<CommandBoardData>): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const boards = useCanvasStore((s) => s.boards)
  const running = useTerminalRuntimeStore((s) => s.running)
  const view = useCommandStore((s) => s.view)
  const setView = useCommandStore((s) => s.setView)
  const collapsed = useCommandStore((s) => s.collapsed)
  const expandedHeight = useCommandStore((s) => s.expandedHeight)
  const setCollapsed = useCommandStore((s) => s.setCollapsed)
  const tasks = useCommandStore((s) => s.tasks)
  const configuringTaskId = useCommandStore((s) => s.configuringTaskId)
  const lastWorkerConfig = useCommandStore((s) => s.lastWorkerConfig)

  const pool = useMemo(() => deriveWorkerPool(boards, running), [boards, running])
  // The Phase C dispatch choreography: submit → engineer → worker-config dialog → spawn group →
  // handoff → advance the kanban, serialized at the worker-pool cap. The board is a singleton, so
  // this mounts once.
  const { dispatch, confirmConfig, cancelConfig, reconfigure, retry, interrupt } =
    useCommandDispatch(pool.cap)

  // Phase D — flip-to-recap (reuses the terminal's generic 3D fold; ephemeral, never persisted) and
  // the ↗ zone jump: camera-fit a finished task's spawned group via the React Flow instance (the
  // Command board is a node, so it lives inside the RF provider). Missing member ids are ignored.
  const flip = useTerminalFlip()
  const rf = useReactFlow()
  const jumpToZone = useCallback(
    (task: CommandTask): void => {
      const g = task.group
      if (!g) return
      const ids = [g.terminalId, g.planningId, g.browserId].filter(
        (x): x is string => typeof x === 'string'
      )
      if (ids.length === 0) return
      void rf.fitView({
        nodes: ids.map((id) => ({ id })),
        padding: 0.25,
        duration: 200,
        maxZoom: 1.5
      })
    },
    [rf]
  )
  // C2d: the task whose worker-config dialog is open (the engineered prompt + agent/flags are
  // chosen here before the worker spawns). Looked up from the store's single-at-a-time lock.
  const configuringTask = useMemo(
    () => (configuringTaskId ? (tasks.find((t) => t.id === configuringTaskId) ?? null) : null),
    [configuringTaskId, tasks]
  )

  // Bucket tasks by status in ONE pass for the rail roll-up. The kanban column lists use the pure
  // `tasksInColumn` (the single source of the failed→Done bucketing); each column count badge is
  // just that list's length, so a badge can never disagree with the cards rendered beneath it.
  const buckets = useMemo(() => {
    const b: Record<TaskStatus, number> = {
      queued: 0,
      routing: 0,
      executing: 0,
      reporting: 0,
      done: 0,
      failed: 0
    }
    for (const t of tasks) b[t.status]++
    return b
  }, [tasks])
  const counts = {
    running: buckets.routing + buckets.executing,
    reporting: buckets.reporting,
    failed: buckets.failed,
    done: buckets.done,
    total: tasks.length
  }
  const progress = counts.total ? counts.done / counts.total : 0

  // Collapse swaps the board to a compact rail footprint (a real geometry change so the hub takes
  // less canvas space); expand restores the remembered height. The collapsed flag is ephemeral —
  // a reopened project starts expanded.
  const collapse = (): void => {
    setCollapsed(true, board.h)
    updateBoard(board.id, { h: COLLAPSED_H })
  }
  const expand = (): void => {
    updateBoard(board.id, { h: expandedHeight ?? DEFAULT_BOARD_SIZE.command.h })
    setCollapsed(false)
  }

  // ── Titlebar actions (the BoardFrame `actions` slot, left of maximize/⋯) ──
  // Phase D: a ⟲ recap toggle flips to the orchestrator recap face; the Kanban/Groups seg is hidden
  // while flipped (it governs the front face only). Collapse stays available from either face.
  const actions = collapsed ? (
    <CtlBtn label="⤢ expand" title="Expand" onClick={expand} />
  ) : (
    <>
      {!flip.flipped && <Seg view={view} onSelect={setView} />}
      <CtlBtn
        label="⟲ recap"
        title={flip.flipped ? 'Back to kanban' : 'Flip to recap'}
        active={flip.flipped}
        onClick={flip.toggle}
      />
      <CtlBtn label="⤡ collapse" title="Collapse to rail" onClick={collapse} />
    </>
  )

  return (
    <BoardFrame
      type={board.type}
      boardId={board.id}
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      actions={actions}
      onFull={onFull}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onAddToGroup={onAddToGroup}
      onRemoveFromGroup={onRemoveFromGroup}
      onStartConnect={onStartConnect}
    >
      {configuringTask && (
        <WorkerConfigDialog
          zoneName={configuringTask.zoneName ?? configuringTask.title}
          engineeredPrompt={configuringTask.prompt ?? configuringTask.title}
          initial={lastWorkerConfig}
          onDispatch={(r) => confirmConfig(configuringTask.id, r)}
          onCancel={() => cancelConfig(configuringTask.id)}
        />
      )}
      {collapsed ? (
        <div style={railStyle}>
          <SubmitWell onSubmit={dispatch} showComposition={false} />
          <div style={railTrackStyle}>
            <span style={{ ...fillStyle, width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div style={railCountsStyle}>
            <Count
              dot="var(--ok)"
              label={`${counts.running} running`}
              muted={counts.running === 0}
            />
            <Count
              dot="var(--warn)"
              label={`${counts.reporting} reporting`}
              muted={counts.reporting === 0}
            />
            <Count dot="var(--err)" label={`${counts.failed} failed`} muted={counts.failed === 0} />
            <span style={{ marginLeft: 'auto', color: 'var(--text-3)', font: 'inherit' }}>
              {counts.done} / {counts.total} done
            </span>
          </div>
        </div>
      ) : (
        // Phase D: the body is a flip STAGE (flat at rest). FRONT = kanban/groups (always mounted);
        // BACK = the opaque CommandRecapView overlay, rendered only while flipped.
        <div style={{ position: 'absolute', inset: 0, ...flip.perspectiveStyle }}>
          <div style={flip.stageStyle}>
            <div style={{ ...bodyStyle, pointerEvents: flip.flipped ? 'none' : 'auto' }}>
              <SubmitWell onSubmit={dispatch} />
              <PoolStrip pool={pool} />
              {view === 'kanban' ? (
                <>
                  <div style={kanbanStyle}>
                    {COLUMNS.map((col) => {
                      const colTasks = tasksInColumn(tasks, col.key)
                      return (
                        <div key={col.key} style={colStyle(col.key === 'executing')}>
                          <div style={colHeadStyle}>
                            <span style={colNameStyle}>{col.label}</span>
                            <span style={colCountStyle}>{colTasks.length}</span>
                          </div>
                          <div style={colBodyStyle}>
                            {colTasks.length === 0 ? (
                              <div style={slotStyle} />
                            ) : (
                              colTasks.map((t) => (
                                <TaskCard
                                  key={t.id}
                                  task={t}
                                  configuring={configuringTaskId === t.id}
                                  onRetry={retry}
                                  onInterrupt={interrupt}
                                  onReconfigure={reconfigure}
                                  onJumpToZone={jumpToZone}
                                />
                              ))
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {tasks.length === 0 && (
                    <div style={emptyHintStyle}>
                      <div style={emptyBigStyle}>No tasks yet</div>
                      <div style={emptySubStyle}>
                        Describe a task above and Dispatch — it spawns a worker zone and runs.
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div style={emptyHintStyle}>
                  <div style={emptyBigStyle}>No groups yet</div>
                  <div style={emptySubStyle}>
                    Each dispatched task spawns its own named group of worker boards.
                  </div>
                </div>
              )}
            </div>
            {flip.flipped && <CommandRecapView onJumpToZone={jumpToZone} onRetry={retry} />}
          </div>
        </div>
      )}
    </BoardFrame>
  )
}

// ── Titlebar seg control ──────────────────────────────────────────────────────
function Seg({
  view,
  onSelect
}: {
  view: CommandView
  onSelect: (v: CommandView) => void
}): ReactElement {
  const tab = (v: CommandView, label: string): ReactElement => (
    <button
      className="nodrag"
      aria-pressed={view === v}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(v)
      }}
      style={{
        padding: '3px 11px',
        fontSize: 11,
        border: 'none',
        cursor: 'pointer',
        color: view === v ? 'var(--text)' : 'var(--text-3)',
        background: view === v ? 'var(--surface-overlay)' : 'transparent'
      }}
    >
      {label}
    </button>
  )
  return (
    <span
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-ctl)',
        overflow: 'hidden',
        flex: 'none'
      }}
    >
      {tab('kanban', 'Kanban')}
      {tab('groups', 'Groups')}
    </span>
  )
}

// ── A small text control button (collapse / expand) ───────────────────────────
function CtlBtn({
  label,
  title,
  onClick,
  active = false
}: {
  label: string
  title: string
  onClick: () => void
  /** Accent (selected) styling — used for the ⟲ recap toggle while the board is flipped. */
  active?: boolean
}): ReactElement {
  return (
    <button
      className="nodrag"
      title={title}
      aria-pressed={active}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{
        height: 22,
        padding: '0 9px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 'var(--r-ctl)',
        border: `1px solid ${active ? 'rgba(79,140,255,.4)' : 'var(--border-subtle)'}`,
        color: active ? 'var(--accent-hover)' : 'var(--text-3)',
        fontSize: 11,
        background: active ? 'var(--accent-wash)' : 'transparent',
        cursor: 'pointer',
        flex: 'none',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </button>
  )
}

// ── Worker-pool discovery strip ────────────────────────────────────────────────
function PoolStrip({ pool }: { pool: ReturnType<typeof deriveWorkerPool> }): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        background: 'var(--inset)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-inner)',
        flex: 'none',
        flexWrap: 'wrap'
      }}
    >
      <span style={{ color: 'var(--text-3)', fontSize: 11, display: 'inline-flex', gap: 6 }}>
        <span style={{ color: 'var(--accent)' }}>⚡</span> Worker pool
      </span>
      {pool.terminalsRunning > 0 && (
        <Chip dot="var(--ok)" label={`${pool.terminalsRunning} in use`} />
      )}
      <Chip dot="var(--text-faint)" label={`${pool.terminalsIdle} terminals idle`} />
      {pool.browsers > 0 && <Chip label={`${pool.browsers} browser`} muted />}
      {pool.planning > 0 && <Chip label={`${pool.planning} planning`} muted />}
      <span
        style={{
          marginLeft: 'auto',
          color: 'var(--text-faint)',
          fontFamily: 'var(--mono)',
          fontSize: 10
        }}
      >
        spawn cap {pool.cap} · {pool.terminalsRunning} in use
      </span>
    </div>
  )
}

function Chip({
  dot,
  label,
  muted = false
}: {
  dot?: string
  label: string
  muted?: boolean
}): ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: muted ? 'var(--text-faint)' : 'var(--text-2)',
        padding: '2px 8px',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-pill)',
        background: 'var(--surface-raised)'
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: 999, background: dot }} />}
      {label}
    </span>
  )
}

function Count({
  dot,
  label,
  muted
}: {
  dot: string
  label: string
  muted: boolean
}): ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: muted ? 'var(--text-faint)' : 'var(--text-2)',
        fontFamily: 'var(--mono)',
        fontSize: 11
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: muted ? 'var(--text-faint)' : dot
        }}
      />
      {label}
    </span>
  )
}

// ── Static style objects ───────────────────────────────────────────────────────
const bodyStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  padding: 11,
  display: 'flex',
  flexDirection: 'column',
  gap: 11,
  overflow: 'hidden'
}
const railStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 9
}
const railTrackStyle: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--inset)',
  overflow: 'hidden',
  border: '1px solid var(--border-subtle)',
  flex: 'none'
}
const fillStyle: CSSProperties = { display: 'block', height: '100%', background: 'var(--accent)' }
const railCountsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  fontFamily: 'var(--mono)',
  fontSize: 11
}
const kanbanStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flex: 1,
  minHeight: 0
}
const colStyle = (hot: boolean): CSSProperties => ({
  flex: 1,
  minWidth: 0,
  background: 'var(--inset)',
  border: `1px solid ${hot ? 'rgba(79,140,255,.25)' : 'var(--border-subtle)'}`,
  borderRadius: 'var(--r-inner)',
  padding: '8px 8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 7
})
const colHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 1px 1px'
}
const colNameStyle: CSSProperties = {
  color: 'var(--text-3)',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  flex: 1
}
const colCountStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 10
}
const slotStyle: CSSProperties = {
  flex: 1,
  border: '1px dashed var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  minHeight: 30
}
const colBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 6
}
const emptyHintStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  padding: '12px 0 6px',
  textAlign: 'center',
  flex: 'none'
}
const emptyBigStyle: CSSProperties = { color: 'var(--text-2)', fontSize: 12.5 }
const emptySubStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 10.5
}
