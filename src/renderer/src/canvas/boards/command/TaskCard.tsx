/**
 * One task card in a kanban column (Phase C / C2 · C2d). Shows the lifecycle dot + the user's raw
 * task title, the spawned group's member tags (term/plan/brow), an honest sub-state line, and the
 * per-card controls: ⚙ Configure on a not-yet-configured queued task (re-opens the worker-config
 * dialog), ■ interrupt on executing (gated Ctrl-C), ↻ retry on failed (re-spawns, reusing the config).
 * Clicking the card reveals the engineered prompt (also a hover tooltip). The ↗ zone jump + diffstat
 * arrive in Phase D. `nodrag` keeps card clicks off the board drag.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
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

/** Honest in-flight sub-state copy for the card (none for ready-queued / done / failed). */
function sublabelFor(task: CommandTask, configuring: boolean): string | undefined {
  switch (task.status) {
    case 'queued':
      if (configuring) return 'configuring…'
      if (!task.prompt) return 'engineering…'
      if (!task.launchCommand) return 'needs config'
      return undefined // configured + waiting for a worker slot
    case 'routing':
      return 'starting worker…'
    case 'executing':
      return 'awaiting completion…'
    case 'reporting':
      return 'collecting result…'
    default:
      return undefined
  }
}

export function TaskCard({
  task,
  configuring,
  onRetry,
  onInterrupt,
  onReconfigure
}: {
  task: CommandTask
  /** True iff this task's worker-config dialog is currently open (drives the "configuring…" line). */
  configuring: boolean
  onRetry: (task: CommandTask) => void
  onInterrupt: (task: CommandTask) => void
  onReconfigure: (task: CommandTask) => void
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const tags = memberTags(task.group)
  const sub = sublabelFor(task, configuring)
  const prompt = task.prompt
  // A queued task whose config was cancelled / not yet set (has an engineered prompt but no launch
  // command, and its dialog is not currently open) — offer to re-open the config dialog.
  const needsConfig = task.status === 'queued' && !!prompt && !task.launchCommand && !configuring

  const copyPrompt = (): void => {
    if (prompt) void navigator.clipboard?.writeText(prompt)?.catch(() => {})
  }

  return (
    <div className="nodrag" style={cardStyle} onPointerDown={stop}>
      <div style={cardRowStyle}>
        <span style={{ ...cardDotStyle, background: STATUS_DOT[task.status] }} />
        <button
          type="button"
          className="nodrag"
          style={cardBodyBtnStyle}
          title={prompt ? `${prompt}\n\n(click to ${expanded ? 'hide' : 'show'})` : undefined}
          onPointerDown={stop}
          onClick={(e) => {
            stop(e)
            if (prompt) setExpanded((v) => !v)
          }}
        >
          <span style={cardTitleStyle}>{task.title}</span>
          {(tags.length > 0 || sub) && (
            <span style={metaRowStyle}>
              {tags.map((t) => (
                <span key={t} style={{ ...tagStyle, color: TAG_COLOR[t] }}>
                  {t}
                </span>
              ))}
              {sub && <span style={cardSubStyle}>{sub}</span>}
            </span>
          )}
        </button>
        {needsConfig && (
          <button
            className="nodrag"
            title="Configure worker"
            aria-label="Configure worker"
            onPointerDown={stop}
            onClick={(e) => {
              stop(e)
              onReconfigure(task)
            }}
            style={cfgBtnStyle}
          >
            ⚙
          </button>
        )}
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
      {expanded && prompt && (
        <div style={promptPanelStyle}>
          <div style={promptLabelRowStyle}>
            <span style={promptLabelStyle}>Engineered prompt</span>
            <button
              className="nodrag"
              title="Copy prompt"
              aria-label="Copy prompt"
              onPointerDown={stop}
              onClick={(e) => {
                stop(e)
                copyPrompt()
              }}
              style={copyBtnStyle}
            >
              copy
            </button>
          </div>
          <div style={promptTextStyle}>{prompt}</div>
        </div>
      )}
    </div>
  )
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 8px',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  flex: 'none'
}
const cardRowStyle: CSSProperties = { display: 'flex', gap: 7, alignItems: 'flex-start' }
const cardDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  flex: 'none',
  marginTop: 4
}
const cardBodyBtnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  flex: 1,
  minWidth: 0,
  border: 'none',
  background: 'transparent',
  padding: 0,
  margin: 0,
  textAlign: 'left',
  cursor: 'pointer',
  font: 'inherit'
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
const promptPanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 7px',
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)'
}
const promptLabelRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6
}
const promptLabelStyle: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)'
}
const promptTextStyle: CSSProperties = {
  color: 'var(--text-2)',
  fontSize: 10.5,
  lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere'
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
const cfgBtnStyle: CSSProperties = { ...btnBase, color: 'var(--accent)' }
const stopBtnStyle: CSSProperties = {
  ...btnBase,
  color: 'var(--err)',
  borderColor: 'rgba(242,84,91,.32)',
  background: 'rgba(242,84,91,.07)',
  fontSize: 9
}
const retryBtnStyle: CSSProperties = { ...btnBase, color: 'var(--text-3)' }
const copyBtnStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--text-3)',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  cursor: 'pointer',
  padding: 0
}
