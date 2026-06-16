/**
 * Command board content (Phase A — the SHELL of the orchestrator's on-canvas face).
 *
 * Realizes the approved Combined (⑤) production mock: the BoardFrame chrome + a titlebar seg
 * control (Kanban / Groups) + an inert submit well + the worker-pool discovery strip + the empty
 * five-column lifecycle kanban, plus a collapsed one-line rail. SINGLETON (one orchestrator face;
 * enforced in `canvasStore.addBoard`).
 *
 * Phase A is read-only/inert: the well does NOT dispatch (Phase C), cards do not flow (Phase B),
 * and there is no recap/diff (Phase D) or group roll-up content (Phase E). All state is ephemeral
 * `commandStore` — never serialized. Worker-pool counts derive from the live board list (PR-3's
 * app-model `canvas` tier, mirrored renderer-side).
 *
 * Owns this file; the shared surface (BoardFrame, schema, stores) is consumed, never modified.
 */
import { useMemo, type CSSProperties, type ReactElement } from 'react'
import type { CommandBoard as CommandBoardData } from '../../lib/boardSchema'
import { DEFAULT_BOARD_SIZE } from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { useTerminalRuntimeStore } from '../../store/terminalRuntimeStore'
import { useCommandStore, type CommandView, type TaskStatus } from '../../store/commandStore'
import { deriveWorkerPool } from '../../store/workerPool'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'

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

  const pool = useMemo(() => deriveWorkerPool(boards, running), [boards, running])

  // Bucket tasks by status in ONE pass, then derive both the rail roll-up and the per-column
  // counts from it (all 0 in Phase A — the queue is empty until Phase C; Phase B fills it).
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
  // `failed` is not its own column — failed tasks bucket into Done (matches the COLUMNS note + the
  // mock's Done column, which shows a failed card with a retry affordance). Phase B renders cards.
  const countFor = (status: TaskStatus): number =>
    status === 'done' ? buckets.done + buckets.failed : buckets[status]

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
  const actions = collapsed ? (
    <CtlBtn label="⤢ expand" title="Expand" onClick={expand} />
  ) : (
    <>
      <Seg view={view} onSelect={setView} />
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
      {collapsed ? (
        <div style={railStyle}>
          <SubmitWell />
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
        <div style={bodyStyle}>
          <SubmitWell />
          <PoolStrip pool={pool} />
          {view === 'kanban' ? (
            <>
              <div style={kanbanStyle}>
                {COLUMNS.map((col) => (
                  <div key={col.key} style={colStyle(col.key === 'executing')}>
                    <div style={colHeadStyle}>
                      <span style={colNameStyle}>{col.label}</span>
                      <span style={colCountStyle}>{countFor(col.key)}</span>
                    </div>
                    <div style={slotStyle} />
                  </div>
                ))}
              </div>
              {tasks.length === 0 && (
                <div style={emptyHintStyle}>
                  <div style={emptyBigStyle}>No tasks yet</div>
                  <div style={emptySubStyle}>
                    Describe a task above to dispatch a feature zone (Phase&nbsp;C).
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={emptyHintStyle}>
              <div style={emptyBigStyle}>No groups yet</div>
              <div style={emptySubStyle}>
                Each dispatched task spawns its own named group of worker boards (Phase&nbsp;C).
              </div>
            </div>
          )}
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
  onClick
}: {
  label: string
  title: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      className="nodrag"
      title={title}
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
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-3)',
        fontSize: 11,
        background: 'transparent',
        cursor: 'pointer',
        flex: 'none',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </button>
  )
}

// ── The inert submit well (renders, but dispatch is Phase C) ───────────────────
function SubmitWell(): ReactElement {
  return (
    <div
      style={{
        background: 'var(--inset)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-inner)',
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: 'none'
      }}
    >
      <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>›</span>
      <span
        style={{
          color: 'var(--text-faint)',
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        Describe a task to dispatch…
      </span>
      <span
        style={{
          color: 'var(--text-faint)',
          fontSize: 11,
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-ctl)',
          padding: '3px 9px',
          flex: 'none'
        }}
      >
        Dispatch ⏎
      </span>
    </div>
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
