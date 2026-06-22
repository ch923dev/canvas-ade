/**
 * Phase D — the Command board's flip-to-recap back face (the ② face). The orchestrator-level recap:
 * NOW (in-flight zones with their live sub-state) + TIMELINE (finished tasks, newest-first, each with
 * its snapshotted BoardResult — status · summary · refs · diffstat · view-diff). Mounted only while
 * the board is flipped (`useTerminalFlip`), as an opaque overlay over the kanban (the kanban never
 * unmounts — same discipline as the terminal recap). Reads the SAME ephemeral `commandStore` the
 * kanban does, so there is ZERO new data path; `RecapView` is terminal-recap-specific and can't be
 * reused. `nodrag nowheel` keeps clicks/scroll off the React Flow canvas.
 */
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import {
  useCommandStore,
  recapBuckets,
  type CommandTask,
  type TaskStatus
} from '../../../store/commandStore'
import { parseDiffStat, hasDiff } from '../../../lib/diffStat'

const STATUS_DOT: Record<TaskStatus, string> = {
  queued: 'var(--text-faint)',
  routing: 'var(--accent)',
  executing: 'var(--ok)',
  reporting: 'var(--warn)',
  done: 'var(--ok)',
  failed: 'var(--err)'
}

/** The live sub-state line for an in-flight NOW row (honest, terse). */
function liveLabel(status: TaskStatus): string {
  switch (status) {
    case 'routing':
      return 'spawning worker group…'
    case 'executing':
      return 'running…'
    case 'reporting':
      return 'collecting result · computing diff…'
    default:
      return ''
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** `finishedAt` (wall-clock ms) → HH:MM for the timeline; '' when absent (e.g. board-gone failure). */
function fmtTime(ms: number | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function CommandRecapView({
  onJumpToZone,
  onRetry
}: {
  onJumpToZone?: (task: CommandTask) => void
  onRetry?: (task: CommandTask) => void
}): ReactElement {
  const tasks = useCommandStore((s) => s.tasks)
  const { now, timeline } = useMemo(() => recapBuckets(tasks), [tasks])
  // The single timeline row whose raw diff panel is open (one-at-a-time keeps the overlay compact).
  const [openDiff, setOpenDiff] = useState<string | null>(null)

  return (
    <div style={rootStyle} className="nodrag nowheel">
      <section style={zoneStyle}>
        <header style={zHeadStyle}>
          <span style={zNameStyle}>Now</span>
          <span style={zCountStyle}>{now.length === 0 ? 'idle' : `${now.length} active`}</span>
        </header>
        {now.length === 0 ? (
          <div style={emptyStyle}>No active tasks.</div>
        ) : (
          now.map((t) => (
            <div key={t.id} style={nowRowStyle}>
              <span style={{ ...dotStyle, background: STATUS_DOT[t.status] }} />
              <span style={nowNameStyle}>{t.zoneName ?? t.title}</span>
              <span style={nowStatusStyle}>{t.status}</span>
              <span style={nowLiveStyle}>{liveLabel(t.status)}</span>
            </div>
          ))
        )}
      </section>

      <div style={sepStyle} />

      <section style={zoneStyle}>
        <header style={zHeadStyle}>
          <span style={zNameStyle}>Timeline</span>
          <span style={zCountStyle}>
            {timeline.length === 0 ? 'empty' : `${timeline.length} finished · newest first`}
          </span>
        </header>
        {timeline.length === 0 ? (
          <div style={emptyStyle}>Nothing finished yet.</div>
        ) : (
          <div style={tlStyle}>
            {timeline.map((t) => (
              <TimelineRow
                key={t.id}
                task={t}
                diffOpen={openDiff === t.id}
                onToggleDiff={() => setOpenDiff((cur) => (cur === t.id ? null : t.id))}
                onJumpToZone={onJumpToZone}
                onRetry={onRetry}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function TimelineRow({
  task,
  diffOpen,
  onToggleDiff,
  onJumpToZone,
  onRetry
}: {
  task: CommandTask
  diffOpen: boolean
  onToggleDiff: () => void
  onJumpToZone?: (task: CommandTask) => void
  onRetry?: (task: CommandTask) => void
}): ReactElement {
  const failed = task.status === 'failed'
  const showDiff = hasDiff(task.diff)
  const stat = showDiff ? parseDiffStat(task.diff) : null
  const refs = task.result?.refs ?? []
  const summary =
    task.result?.summary ?? (failed ? 'Worker ended without reporting a result.' : undefined)

  return (
    <div style={tlRowStyle}>
      <span style={tsStyle}>{fmtTime(task.finishedAt)}</span>
      <span style={{ ...tMarkStyle, background: STATUS_DOT[task.status] }} />
      <div style={tBodyStyle}>
        <span style={tNameStyle}>{task.zoneName ?? task.title}</span>
        {summary !== undefined && (
          <span style={{ ...tSumStyle, ...(failed ? { color: 'var(--err)' } : null) }}>
            {summary}
          </span>
        )}
        <div style={tRefsStyle}>
          {refs.slice(0, 3).map((r) => (
            <span key={r} style={refStyle} title={r}>
              {r}
            </span>
          ))}
          {refs.length > 3 && <span style={refStyle}>+{refs.length - 3} more</span>}
          {stat && (
            <span style={diffstatStyle}>
              <span style={{ color: 'var(--ok)' }}>+{stat.insertions}</span>
              <span style={{ color: 'var(--err)' }}>−{stat.deletions}</span>
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            {showDiff && (
              <button
                style={{ ...btnStyle, ...(diffOpen ? btnOnStyle : null) }}
                onClick={onToggleDiff}
              >
                {diffOpen ? 'hide diff' : 'view diff'}
              </button>
            )}
            {onJumpToZone && task.group && (
              <button
                style={{
                  ...btnStyle,
                  color: 'var(--accent-hover)',
                  borderColor: 'rgba(79,140,255,.4)'
                }}
                title="Camera-fit the spawned zone"
                onClick={() => onJumpToZone(task)}
              >
                ↗ zone
              </button>
            )}
            {failed && onRetry && (
              <button style={btnStyle} title="Retry" onClick={() => onRetry(task)}>
                ↻ retry
              </button>
            )}
          </span>
        </div>
        {diffOpen && showDiff && (
          <div style={diffWrapStyle}>
            <div style={diffScopeStyle}>
              git diff HEAD · working-tree changes vs HEAD · whole repo
            </div>
            <pre style={diffTextStyle}>{task.diff}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────────
const rootStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--surface)',
  overflowY: 'auto',
  padding: 11,
  display: 'flex',
  flexDirection: 'column',
  gap: 11
}
const zoneStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 7 }
const zHeadStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8 }
const zNameStyle: CSSProperties = {
  color: 'var(--text-3)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '.08em',
  textTransform: 'uppercase'
}
const zCountStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 9.5
}
const emptyStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  padding: '4px 2px'
}
const sepStyle: CSSProperties = { height: 1, background: 'var(--border-subtle)', flex: 'none' }
const dotStyle: CSSProperties = { width: 8, height: 8, borderRadius: 999, flex: 'none' }
const nowRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '7px 9px',
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)'
}
const nowNameStyle: CSSProperties = { color: 'var(--text)', fontSize: 11.5, flex: 'none' }
const nowStatusStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--accent-hover)'
}
const nowLiveStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--text-3)',
  flex: 1,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis'
}
const tlStyle: CSSProperties = { display: 'flex', flexDirection: 'column' }
const tlRowStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '8px 4px',
  borderTop: '1px solid var(--border-subtle)'
}
const tsStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--text-faint)',
  flex: 'none',
  width: 38,
  paddingTop: 1
}
const tMarkStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  flex: 'none',
  marginTop: 3
}
const tBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: 1,
  minWidth: 0
}
const tNameStyle: CSSProperties = { color: 'var(--text)', fontSize: 11.5 }
const tSumStyle: CSSProperties = {
  color: 'var(--text-2)',
  fontSize: 10.5,
  lineHeight: 1.4,
  overflowWrap: 'anywhere'
}
const tRefsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  alignItems: 'center'
}
const refStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  color: 'var(--text-3)',
  padding: '0 5px',
  borderRadius: 3,
  background: 'var(--surface-overlay)',
  border: '1px solid var(--border-subtle)',
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}
const diffstatStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  display: 'inline-flex',
  gap: 5,
  alignItems: 'center'
}
const btnStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--text-3)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-pill)',
  padding: '1px 8px',
  background: 'transparent',
  cursor: 'pointer'
}
const btnOnStyle: CSSProperties = {
  color: 'var(--accent-hover)',
  borderColor: 'rgba(79,140,255,.4)',
  background: 'var(--accent-wash)'
}
const diffWrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3 }
// GAP-006: clarify the diff scope (working-tree vs HEAD, repo-wide) so it isn't read as
// agent-attributed. A quiet caption, not a redesign — no color/glow.
const diffScopeStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 8.5,
  color: 'var(--text-faint)'
}
const diffTextStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  lineHeight: 1.5,
  color: 'var(--text-2)',
  padding: '6px 8px',
  background: 'var(--void)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)',
  whiteSpace: 'pre',
  overflow: 'auto',
  maxHeight: 220
}
