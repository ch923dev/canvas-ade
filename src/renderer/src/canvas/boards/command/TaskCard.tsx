/**
 * One task card in a kanban column (Phase C / C2 · C2d). Shows the lifecycle dot + the user's raw
 * task title, the spawned group's member tags (term/plan/brow), an honest sub-state line, and the
 * per-card controls: ⚙ Configure on a not-yet-configured queued task (re-opens the worker-config
 * dialog), ■ interrupt on executing (gated Ctrl-C), ↻ retry on failed (re-spawns, reusing the config).
 * Clicking the card reveals the engineered prompt (also a hover tooltip). `nodrag` keeps card clicks
 * off the board drag.
 *
 * Phase D (collect/merge): a settled done/failed card grows a RESULT ZONE — the worker's one-line
 * summary, touched-file refs, the `+N −M` diffstat (from the captured raw diff), an inline view-diff
 * panel, and a ↗ zone jump that camera-fits the spawned group.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
import type { CommandTask, TaskStatus } from '../../../store/commandStore'
import { memberTags } from '../../../lib/commandDispatch'
import { parseDiffStat, hasDiff } from '../../../lib/diffStat'

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

/**
 * Honest in-flight sub-state copy for the card (none for ready-queued / done / failed).
 *
 * P4: a FED worker's sub-state is not ours to narrate — every local phrase here describes the
 * LOCAL dispatch choreography ("starting worker…", "collecting result…"), none of which is
 * happening for a worker some external orchestrator is driving. Its card speaks through the
 * MAIN-composed `disclose` line instead, so the board never invents a stage it cannot observe.
 */
function sublabelFor(task: CommandTask, configuring: boolean): string | undefined {
  if (task.external) return undefined
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
  onReconfigure,
  onJumpToZone
}: {
  task: CommandTask
  /** True iff this task's worker-config dialog is currently open (drives the "configuring…" line). */
  configuring: boolean
  onRetry: (task: CommandTask) => void
  onInterrupt: (task: CommandTask) => void
  onReconfigure: (task: CommandTask) => void
  /** Phase D — camera-fit the task's spawned zone (↗ on a settled card). */
  onJumpToZone?: (task: CommandTask) => void
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const tags = memberTags(task.group)
  const sub = sublabelFor(task, configuring)
  const prompt = task.prompt
  // Phase D — the settled result zone (done/failed only). The summary falls back to an honest line
  // when a task failed with no recorded result (e.g. its worker board was closed mid-flight).
  const settled = task.status === 'done' || task.status === 'failed'
  const failed = task.status === 'failed'
  // P4 — a FED worker (external orchestrator's). We did not spawn it, so ⚙ Configure and ↻ Retry
  // are impossible (there is no stored launchCommand to re-run and no local pump slot to re-enter)
  // and ■ Interrupt is not ours to offer — interrupting someone else's worker mid-run is a decision
  // that belongs on ITS board, not on a read-only mirror of it.
  const fed = task.external === true
  const blocked = fed && typeof task.blockedTag === 'string' && task.blockedTag.length > 0
  const showDiff = hasDiff(task.diff)
  const stat = showDiff ? parseDiffStat(task.diff) : null
  const refs = task.result?.refs ?? []
  const summary =
    task.result?.summary ??
    (failed && !task.external ? 'Worker ended without reporting a result.' : undefined)
  // P4: a FED worker shows its result zone as soon as it HAS one, not only once settled. An
  // off-vocabulary status parks the card in `reporting` on purpose (the safe, non-terminal
  // fallback) — hiding the very report that could not be classified would be the worst of both.
  const hasResultZone = (settled || fed) && (summary !== undefined || refs.length > 0 || showDiff)
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
          {(tags.length > 0 || sub || fed) && (
            <span style={metaRowStyle}>
              {/* P4 — the origin chip. It is FIRST because "I did not dispatch this" changes how
                  every other thing on the card should be read: no controls, no diff, and a summary
                  that is the worker's own claim rather than a settle this board observed. */}
              {fed && <span style={extTagStyle}>ext</span>}
              {blocked && <span style={blockedTagStyle}>blocked</span>}
              {tags.map((t) => (
                <span key={t} style={{ ...tagStyle, color: TAG_COLOR[t] }}>
                  {t}
                </span>
              ))}
              {fed && task.role && <span style={cardSubStyle}>{task.role}</span>}
              {/* Settled fed results are the worker's own CLAIM — never a verification this board
                  performed. S2's rule: the UI may not launder one into the other. */}
              {fed && settled && <span style={cardSubStyle}>claimed · not verified</span>}
              {sub && <span style={cardSubStyle}>{sub}</span>}
            </span>
          )}
          {/* P4 — MAIN's composed disclosure (off-vocabulary status, block reason, salvage note).
              Rendered verbatim and always: a reason that is not in the surface does not exist. */}
          {task.disclose && (
            <span style={blocked ? discloseWarnStyle : cardSubStyle}>{task.disclose}</span>
          )}
        </button>
        {!fed && needsConfig && (
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
        {!fed && task.status === 'executing' && (
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
        {!fed && task.status === 'failed' && (
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
      {hasResultZone && (
        <div style={resultStyle}>
          {summary !== undefined && (
            <div style={{ ...rSummaryStyle, ...(failed ? { color: 'var(--err)' } : null) }}>
              {summary}
            </div>
          )}
          {(refs.length > 0 || stat) && (
            <div style={rRefsStyle}>
              {refs.slice(0, 2).map((r) => (
                <span key={r} style={refStyle} title={r}>
                  {r}
                </span>
              ))}
              {refs.length > 2 && <span style={refStyle}>+{refs.length - 2} more</span>}
              {stat && (
                <span style={diffstatStyle}>
                  <span style={{ color: 'var(--ok)' }}>+{stat.insertions}</span>
                  <span style={{ color: 'var(--err)' }}>−{stat.deletions}</span>
                </span>
              )}
            </div>
          )}
          {(showDiff || (onJumpToZone && task.group)) && (
            <div style={rActionsStyle}>
              {showDiff && (
                <button
                  className="nodrag"
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e)
                    setDiffOpen((v) => !v)
                  }}
                  style={{ ...rBtnStyle, ...(diffOpen ? rBtnOnStyle : null) }}
                >
                  {diffOpen ? '⌃ hide diff' : '⌄ view diff'}
                </button>
              )}
              {onJumpToZone && task.group && (
                <button
                  className="nodrag"
                  title="Camera-fit the spawned zone"
                  aria-label="Jump to zone"
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e)
                    onJumpToZone(task)
                  }}
                  style={zoneBtnStyle}
                >
                  ↗ zone
                </button>
              )}
            </div>
          )}
          {diffOpen && showDiff && (
            <div style={diffPanelStyle} className="nowheel">
              <div style={diffHeadStyle}>
                <span style={diffLblStyle}>git diff HEAD</span>
                <span style={diffClampStyle}>{(task.diff ?? '').length} B</span>
              </div>
              <div style={diffScopeStyle}>working-tree changes vs HEAD · whole repo</div>
              <pre style={diffTextStyle}>{task.diff}</pre>
            </div>
          )}
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
// ── P4 — the fed-worker chips + disclosure line ────────────────────────────────────────────────
/** The origin chip. Accent-tinted (the one functional accent) — it is a FACT about the card, not
 *  a status, so it borrows the accent rather than any of the status colours. */
const extTagStyle: CSSProperties = {
  ...tagStyle,
  color: 'var(--accent)',
  background: 'var(--accent-wash)',
  border: '1px solid rgba(79,140,255,.35)'
}
/** The blocked chip. Warn-tinted to match the board's `blocked` attention ring — the same worker
 *  state told twice, on the board and on the card, in the same colour. */
const blockedTagStyle: CSSProperties = {
  ...tagStyle,
  color: 'var(--warn)',
  background: 'var(--warn-wash)',
  border: '1px solid rgba(232,179,57,.35)'
}
/** The disclosure line when it carries a BLOCK reason — warn, because it is the reason the card
 *  is asking for attention. Every other disclosure stays quiet (`cardSubStyle`). */
const discloseWarnStyle: CSSProperties = { ...cardSubStyle, color: 'var(--warn)' }
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

// ── Phase D — result zone (collect/merge) ──────────────────────────────────────
const resultStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 7px',
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)'
}
const rSummaryStyle: CSSProperties = {
  color: 'var(--text-2)',
  fontSize: 10.5,
  lineHeight: 1.4,
  overflowWrap: 'anywhere'
}
const rRefsStyle: CSSProperties = {
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
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}
const diffstatStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  display: 'inline-flex',
  gap: 5,
  alignItems: 'center',
  marginLeft: 'auto'
}
const rActionsStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' }
const rBtnStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--text-3)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-pill)',
  padding: '1px 8px',
  background: 'transparent',
  cursor: 'pointer'
}
const rBtnOnStyle: CSSProperties = {
  color: 'var(--accent-hover)',
  borderColor: 'rgba(79,140,255,.4)',
  background: 'var(--accent-wash)'
}
const zoneBtnStyle: CSSProperties = {
  ...rBtnStyle,
  color: 'var(--accent-hover)',
  borderColor: 'rgba(79,140,255,.4)'
}
const diffPanelStyle: CSSProperties = {
  background: 'var(--void)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)',
  overflow: 'hidden'
}
const diffHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 7px',
  borderBottom: '1px solid var(--border-subtle)'
}
const diffLblStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)'
}
const diffClampStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 8.5,
  color: 'var(--text-faint)'
}
// GAP-006: clarify the diff scope (working-tree vs HEAD, repo-wide) so it isn't read as
// agent-attributed. A quiet caption, not a redesign — no color/glow.
const diffScopeStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 8.5,
  color: 'var(--text-faint)',
  padding: '3px 7px 0'
}
const diffTextStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  lineHeight: 1.5,
  color: 'var(--text-2)',
  padding: '6px 8px',
  whiteSpace: 'pre',
  overflow: 'auto',
  maxHeight: 150
}
