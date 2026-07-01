/**
 * CommandInspector — the Command board's per-type content for the Board Inspector (P2). Presentation-
 * only: CommandBoard owns all state/handlers and portals this into the shell's slot, so every control
 * reuses the EXACT same handler its title-bar counterpart uses (no duplication, no lifted state).
 *
 * Additive: the titlebar seg / recap-flip / collapse stay as-is; this surfaces them as labelled rows
 * plus a read-only roll-up of the kanban counts + the worker-pool + the orchestration-consent gate —
 * the visibility win. Sections mirror docs/research/mocks/board-inspector-popover-mock (Command hero);
 * View + Status start expanded, Worker pool + Orchestration start COLLAPSED to keep the popover short.
 * The shell owns the head (glyph/type/title/jump) + the Duplicate foot, so this renders sections only.
 */
import type { ReactElement } from 'react'
import { Icon } from '../../Icon'
import type { CommandView } from '../../../store/commandStore'
import {
  InspectorAction,
  InspectorMeta,
  InspectorRow,
  InspectorSection,
  InspectorSegmented
} from '../../inspector/primitives'

export interface CommandInspectorProps {
  // View / layout (the titlebar actions)
  collapsed: boolean
  onExpand: () => void
  onCollapse: () => void
  view: CommandView
  onView: (v: CommandView) => void
  flipped: boolean
  onToggleRecap: () => void
  // Status roll-up (read-only, mirrors the rail counts)
  counts: { running: number; reporting: number; failed: number; done: number; total: number }
  progress: number
  // Worker pool discovery
  pool: { cap: number; inUse: number; idle: number; browsers: number; planning: number }
  // Orchestration consent gate
  orchestrationEnabled: boolean
  onEnableOrchestration: () => void
}

const VIEW_OPTS: ReadonlyArray<{ value: CommandView; label: string }> = [
  { value: 'kanban', label: 'Kanban' },
  { value: 'groups', label: 'Groups' }
]

export function CommandInspector({
  collapsed,
  onExpand,
  onCollapse,
  view,
  onView,
  flipped,
  onToggleRecap,
  counts,
  progress,
  pool,
  orchestrationEnabled,
  onEnableOrchestration
}: CommandInspectorProps): ReactElement {
  return (
    <>
      <InspectorSection label="View">
        {collapsed ? (
          <InspectorAction
            icon={<Icon name="maximize" size={14} />}
            onClick={onExpand}
            dataTest="inspector-command-expand"
          >
            Expand from rail
          </InspectorAction>
        ) : (
          <>
            {!flipped && (
              <InspectorRow>
                <InspectorSegmented
                  fill
                  ariaLabel="Board view"
                  value={view}
                  options={VIEW_OPTS}
                  onChange={onView}
                />
              </InspectorRow>
            )}
            <InspectorAction
              icon={<Icon name="refresh" size={14} />}
              active={flipped}
              onClick={onToggleRecap}
              dataTest="inspector-command-recap"
            >
              {flipped ? 'Back to board' : 'Flip to recap'}
            </InspectorAction>
            <InspectorAction icon={<Icon name="minimize" size={14} />} onClick={onCollapse}>
              Collapse to rail
            </InspectorAction>
          </>
        )}
      </InspectorSection>

      <InspectorSection label="Status">
        <InspectorRow>
          <div className="ca-inspector-chips">
            <span className="ca-inspector-status" data-tone="ok">
              <span className="ca-inspector-status-dot" aria-hidden />
              {counts.running} running
            </span>
            <span className="ca-inspector-status" data-tone="warn">
              <span className="ca-inspector-status-dot" aria-hidden />
              {counts.reporting} reporting
            </span>
            <span className="ca-inspector-status" data-tone="err">
              <span className="ca-inspector-status-dot" aria-hidden />
              {counts.failed} failed
            </span>
          </div>
        </InspectorRow>
        <InspectorMeta label="Done" value={`${counts.done} / ${counts.total}`} />
        <InspectorRow>
          <span className="ca-inspector-pbar">
            <span
              className="ca-inspector-pfill"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </span>
        </InspectorRow>
      </InspectorSection>

      <InspectorSection label="Worker pool" defaultOpen={false}>
        <InspectorMeta label="Spawn cap" value={String(pool.cap)} />
        <InspectorMeta label="In use" value={`${pool.inUse} of ${pool.cap}`} />
        <InspectorMeta label="Idle" value={`${pool.idle} terminals`} />
        {pool.browsers > 0 && <InspectorMeta label="Browser" value={String(pool.browsers)} />}
        {pool.planning > 0 && <InspectorMeta label="Planning" value={String(pool.planning)} />}
      </InspectorSection>

      <InspectorSection label="Orchestration" defaultOpen={false}>
        {orchestrationEnabled ? (
          <InspectorMeta label="Status" value="Enabled" />
        ) : (
          <>
            <InspectorMeta label="Status" value="Not enabled" />
            <InspectorAction
              icon={<Icon name="settings" size={14} />}
              primary
              onClick={onEnableOrchestration}
              dataTest="inspector-command-enable"
            >
              Enable orchestration…
            </InspectorAction>
          </>
        )}
      </InspectorSection>
    </>
  )
}
