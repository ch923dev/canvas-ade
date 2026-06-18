/**
 * Phase E — the Command board's Groups roll-up tab (the ③ face). The zone-centric index: one row
 * per dispatched task (each task IS a feature zone), showing its LIVE Named-Group name + member tags
 * + status + (when done) diffstat, with a ↗ focus that camera-fits the whole zone (grouped focus,
 * reusing the Phase-D jumpToZone over the group's member boards). A header rolls up the counts + an
 * aggregate done-fraction bar. Derived from the ephemeral commandStore + canvasStore groups — no
 * schema change, no new data path. Empty until the first task is submitted.
 */
import { useMemo, type CSSProperties, type ReactElement } from 'react'
import { useCommandStore, type CommandTask, type TaskStatus } from '../../../store/commandStore'
import { useCanvasStore } from '../../../store/canvasStore'
import { groupRollup, memberTags } from '../../../lib/commandDispatch'
import { parseDiffStat, hasDiff } from '../../../lib/diffStat'

const STATUS_DOT: Record<TaskStatus, string> = {
  queued: 'var(--text-faint)',
  routing: 'var(--accent)',
  executing: 'var(--ok)',
  reporting: 'var(--warn)',
  done: 'var(--ok)',
  failed: 'var(--err)'
}
const STATUS_WORD_COLOR: Record<TaskStatus, string> = {
  queued: 'var(--text-3)',
  routing: 'var(--accent-hover)',
  executing: 'var(--ok)',
  reporting: 'var(--warn)',
  done: 'var(--ok)',
  failed: 'var(--err)'
}
const TAG_COLOR: Record<'term' | 'plan' | 'brow', string> = {
  term: 'var(--ok)',
  plan: 'var(--warn)',
  brow: 'var(--accent-hover)'
}

/** Terse trailing sub-state for an in-flight zone row (none for terminal states). */
function zoneSub(status: TaskStatus): string | undefined {
  switch (status) {
    case 'queued':
      return 'waiting for a worker slot'
    case 'routing':
      return 'spawning…'
    case 'executing':
      return 'running…'
    case 'reporting':
      return 'collecting result…'
    default:
      return undefined
  }
}

export function GroupsView({
  onJumpToZone
}: {
  onJumpToZone?: (task: CommandTask) => void
}): ReactElement {
  const tasks = useCommandStore((s) => s.tasks)
  const groups = useCanvasStore((s) => s.groups)
  const { zones, counts, progress } = useMemo(() => groupRollup(tasks, groups), [tasks, groups])

  if (zones.length === 0) {
    return (
      <div style={emptyHintStyle}>
        <div style={emptyBigStyle}>No groups yet</div>
        <div style={emptySubStyle}>
          Each dispatched task spawns its own named group of worker boards.
        </div>
      </div>
    )
  }

  return (
    <div style={rootStyle}>
      <div style={headStyle}>
        <span style={headTitleStyle}>Groups</span>
        <span style={headCountStyle}>
          {counts.total} {counts.total === 1 ? 'zone' : 'zones'}
        </span>
        <span style={headRollupStyle}>
          <HeadCount dot="var(--ok)" label={`${counts.done} done`} muted={counts.done === 0} />
          <HeadCount
            dot="var(--accent)"
            label={`${counts.running} running`}
            muted={counts.running === 0}
          />
          <HeadCount
            dot="var(--text-faint)"
            label={`${counts.queued} queued`}
            muted={counts.queued === 0}
          />
          {counts.failed > 0 && <HeadCount dot="var(--err)" label={`${counts.failed} failed`} />}
        </span>
      </div>
      <div style={trackStyle}>
        <span
          className="ca-t-fill"
          style={{ ...fillStyle, width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      <div style={listStyle}>
        {zones.map(({ task, name }) => {
          const tags = memberTags(task.group)
          const sub = zoneSub(task.status)
          const showDiff = task.status === 'done' && hasDiff(task.diff)
          const stat = showDiff ? parseDiffStat(task.diff) : null
          return (
            <div key={task.id} style={zoneRowStyle(task.status === 'executing')}>
              <span style={{ ...dotStyle, background: STATUS_DOT[task.status] }} />
              <span style={zNameStyle} title={name}>
                {name}
              </span>
              {tags.length > 0 && (
                <span style={membersStyle}>
                  {tags.map((t) => (
                    <span key={t} style={{ ...tagStyle, color: TAG_COLOR[t] }}>
                      {t}
                    </span>
                  ))}
                </span>
              )}
              <span style={statusStyle}>
                <span style={{ color: STATUS_WORD_COLOR[task.status] }}>{task.status}</span>
                {sub && <span style={{ color: 'var(--text-faint)' }}> · {sub}</span>}
              </span>
              {stat && (
                <span style={diffstatStyle}>
                  <span style={{ color: 'var(--ok)' }}>+{stat.insertions}</span>
                  <span style={{ color: 'var(--err)' }}>−{stat.deletions}</span>
                </span>
              )}
              <span style={{ flex: 1 }} />
              {onJumpToZone && task.group && (
                <button
                  style={focusBtnStyle}
                  title="Camera-fit this zone"
                  onClick={() => onJumpToZone(task)}
                >
                  ↗ focus
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HeadCount({
  dot,
  label,
  muted = false
}: {
  dot: string
  label: string
  muted?: boolean
}): ReactElement {
  return (
    <span style={{ ...headCountItemStyle, color: muted ? 'var(--text-faint)' : 'var(--text-2)' }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: muted ? 'var(--text-faint)' : dot
        }}
      />
      {label}
    </span>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────────
const rootStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 9
}
const headStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 10 }
const headTitleStyle: CSSProperties = {
  color: 'var(--text-3)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '.08em',
  textTransform: 'uppercase'
}
const headCountStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 9.5
}
const headRollupStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  gap: 12,
  fontFamily: 'var(--mono)',
  fontSize: 9.5
}
const headCountItemStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5 }
const trackStyle: CSSProperties = {
  height: 5,
  borderRadius: 3,
  background: 'var(--inset)',
  overflow: 'hidden',
  border: '1px solid var(--border-subtle)',
  flex: 'none'
}
const fillStyle: CSSProperties = { display: 'block', height: '100%', background: 'var(--accent)' }
const listStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 7 }
const zoneRowStyle = (hot: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  background: 'var(--inset)',
  border: `1px solid ${hot ? 'rgba(79,140,255,.25)' : 'var(--border-subtle)'}`,
  borderRadius: 'var(--r-inner)'
})
const dotStyle: CSSProperties = { width: 8, height: 8, borderRadius: 999, flex: 'none' }
const zNameStyle: CSSProperties = {
  color: 'var(--text)',
  fontSize: 12,
  flex: 'none',
  maxWidth: 160,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}
const membersStyle: CSSProperties = { display: 'inline-flex', gap: 3 }
const tagStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  padding: '0 4px',
  borderRadius: 3,
  background: 'var(--surface-overlay)'
}
const statusStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  minWidth: 0
}
const diffstatStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  display: 'inline-flex',
  gap: 5,
  flex: 'none'
}
const focusBtnStyle: CSSProperties = {
  flex: 'none',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--accent-hover)',
  border: '1px solid rgba(79,140,255,.4)',
  borderRadius: 'var(--r-pill)',
  padding: '2px 9px',
  background: 'transparent',
  cursor: 'pointer'
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
