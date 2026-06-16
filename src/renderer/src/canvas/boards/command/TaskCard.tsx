/**
 * One task card in a kanban column (Phase C / C2). Shows the lifecycle dot + title, the spawned
 * group's member tags (term/plan/brow), the honest "awaiting completion…" sub-state while executing,
 * and the per-card controls: ■ interrupt on executing (gated Ctrl-C), ↻ retry on failed (re-spawns a
 * fresh group). The ↗ zone jump + diffstat arrive in Phase D. `nodrag` keeps card clicks off the board drag.
 */
import type { CSSProperties, ReactElement } from 'react'
import type { CommandTask, TaskStatus } from '../../../store/commandStore'
import { memberTags } from '../../../lib/commandDispatch'

const STATUS_DOT: Record<TaskStatus, string> = {
  queued: 'var(--text-faint)',
  routing: 'var(--accent)',
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

const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation()

export function TaskCard({
  task,
  onRetry,
  onInterrupt
}: {
  task: CommandTask
  onRetry: (task: CommandTask) => void
  onInterrupt: (task: CommandTask) => void
}): ReactElement {
  const tags = memberTags(task.group)
  return (
    <div className="nodrag" style={cardStyle} onPointerDown={stop}>
      <span style={{ ...cardDotStyle, background: STATUS_DOT[task.status] }} />
      <span style={cardBodyStyle}>
        <span style={cardTitleStyle}>{task.title}</span>
        {(tags.length > 0 || task.status === 'executing') && (
          <span style={metaRowStyle}>
            {tags.map((t) => (
              <span key={t} style={{ ...tagStyle, color: TAG_COLOR[t] }}>
                {t}
              </span>
            ))}
            {task.status === 'executing' && <span style={cardSubStyle}>awaiting completion…</span>}
          </span>
        )}
      </span>
      {task.status === 'executing' && (
        <button
          className="nodrag"
          title="Interrupt (Ctrl-C)"
          aria-label="Interrupt task"
          onPointerDown={stop}
          onClick={(e) => {
            stop(e)
            onInterrupt(task)
          }}
          style={stopBtnStyle}
        >
          ■
        </button>
      )}
      {task.status === 'failed' && (
        <button
          className="nodrag"
          title="Retry"
          aria-label="Retry task"
          onPointerDown={stop}
          onClick={(e) => {
            stop(e)
            onRetry(task)
          }}
          style={retryBtnStyle}
        >
          ↻
        </button>
      )}
    </div>
  )
}

const cardStyle: CSSProperties = {
  display: 'flex',
  gap: 7,
  alignItems: 'flex-start',
  padding: '6px 8px',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  flex: 'none'
}
const cardDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  flex: 'none',
  marginTop: 4
}
const cardBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  flex: 1,
  minWidth: 0
}
const cardTitleStyle: CSSProperties = {
  color: 'var(--text-2)',
  fontSize: 11,
  lineHeight: 1.3,
  overflowWrap: 'anywhere'
}
const metaRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  flexWrap: 'wrap'
}
const tagStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  padding: '0 4px',
  borderRadius: 3,
  background: 'var(--surface-overlay)'
}
const cardSubStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 9.5
}
const btnBase: CSSProperties = {
  flex: 'none',
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 11,
  padding: 0
}
const stopBtnStyle: CSSProperties = {
  ...btnBase,
  color: 'var(--err)',
  borderColor: 'rgba(242,84,91,.32)',
  background: 'rgba(242,84,91,.07)',
  fontSize: 9
}
const retryBtnStyle: CSSProperties = { ...btnBase, color: 'var(--text-3)' }
