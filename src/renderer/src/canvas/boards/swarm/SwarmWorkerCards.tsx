/**
 * Swarm worker canvas (region 3) — the run's worker terminal boards as Layer-A glance cards
 * (09 §4): state icon · role badge · activity line · timer, attention-ordered so the lone
 * pulsing amber card is always the one that needs you (full order at `ORDER` below).
 * Q11 lens model: each card is chrome over an ORDINARY terminal board on the canvas — the
 * card never forks terminal behavior; clicking jumps to (expands) the real board.
 *
 * S2 adds a third line and two states the LEDGER knows about but the live signals cannot:
 *   - `stalled` — nominally running, nothing has moved past the threshold. Border stays NEUTRAL
 *     and the dot keeps the working colour but stops pulsing; only the TIMER goes amber. A
 *     stalled worker is not asking anyone for anything, and promoting it to the needs-input
 *     language would recreate the "everything is amber" failure the research names as the #1
 *     dashboard complaint.
 *   - `lost` — the worker died mid-task and its result was salvaged. Hollow `--err` (absent, not
 *     erroring) plus the salvage provenance on the disclosure line.
 * The mono disclosure line is composed MAIN-side (`swarmLedgerProject.discloseFor`) so there is
 * exactly one source for the threshold/exit-reason strings — the S1 eyeball bug's lesson.
 *
 * S3 adds a FOURTH line — the worktree/branch — to write workers only (design variant C, signed
 * off 2026-07-28). It is composed MAIN-side for the same reason, and its trailing note is the one
 * fact a human needs from a branch at that moment: how much is in it, that it is mergeable, or
 * that its tree was PRESERVED rather than destroyed.
 */
import { Fragment, type ReactElement } from 'react'
import type { AttentionKind } from '../../../store/attentionStore'
import type { SwarmRun } from '../../../store/swarmStore'
import type { SwarmWorkerLedgerState } from '../../../../../shared/swarmLedgerTypes'

export type CardState =
  | 'needs-input'
  | 'blocked'
  | 'working'
  | 'done'
  | 'error'
  | 'idle'
  | 'stalled'
  | 'lost'

export function stateOf(
  id: string,
  attention: Record<string, AttentionKind>,
  running: Record<string, boolean>,
  ledger: SwarmWorkerLedgerState | undefined
): CardState {
  const a = attention[id]
  // 🔒 Live human-blocking signals OUTRANK the ledger: a worker that is asking a question right
  // now must read as needs-input even if the ledger still thinks its task went quiet.
  if (a === 'needs-input') return 'needs-input'
  if (ledger?.state === 'lost') return 'lost'
  if (a === 'error') return 'error'
  if (ledger?.state === 'stalled') return 'stalled'
  // 🔒 `blocked` AFTER the ledger's lost/stalled: `workerAttention` derives blocked FROM those very
  // tags (and from everything off-vocabulary), so when the ledger can tell the specific story —
  // salvage provenance, stall threshold — the generic "cannot proceed" must not mask it. But it
  // outranks working/idle: a blocked worker's PTY may well still be live, and rendering it
  // "Working…" while the board ring above says blocked is the card/ring disagreement this fixes.
  if (a === 'blocked') return 'blocked'
  if (a === 'done') return 'done'
  return running[id] ? 'working' : 'idle'
}

/**
 * Attention ordering (09 §4, P4-extended):
 * needs-input → lost → stalled → blocked → working → idle → error → done.
 * `blocked` sits after the ledger states and before `working` for the same reason `stateOf`
 * resolves it there: lost/stalled are the SPECIFIC diagnoses (blocked attention is derived from
 * their tags), so their cards must not sort below the generic bucket — but a worker that cannot
 * proceed still deserves the eye before one that is merely progressing.
 */
export const ORDER: Record<CardState, number> = {
  'needs-input': 0,
  lost: 1,
  stalled: 2,
  blocked: 3,
  working: 4,
  idle: 5,
  error: 6,
  done: 7
}

function fmtMins(ms: number): string {
  const m = Math.floor(ms / 60000)
  return m > 0 ? `${m}m` : `${Math.floor(ms / 1000)}s`
}

/** The activity line — what the worker is doing, or what happened to it. */
export function activityLine(state: CardState, meta: SwarmRun['workerMeta'][string]): string {
  switch (state) {
    case 'needs-input':
      return 'Waiting on input'
    case 'blocked':
      // Not `meta.activity` — a blocked worker's last activity line is stale by definition, and
      // showing it would be the same disagreement one level down.
      return 'Blocked — waiting'
    case 'lost':
      return 'Lost mid-task — salvaged'
    case 'error':
      return 'Hit an error'
    case 'done':
      return meta.provenance === 'claimed'
        ? 'Done — agent-claimed, unverified'
        : 'Done — derived from transcript'
    default:
      return meta.activity ?? (state === 'working' || state === 'stalled' ? 'Working…' : 'Idle')
  }
}

export function SwarmWorkerCards({
  run,
  attention,
  running,
  now,
  titleOf,
  onOpen,
  dockedIds,
  activeDockId
}: {
  run: SwarmRun
  attention: Record<string, AttentionKind>
  running: Record<string, boolean>
  /** Wall-clock ms ticked by the host's 1s timer (render purity — no Date.now() in render). */
  now: number
  titleOf: (id: string) => string
  onOpen: (boardId: string) => void
  /**
   * Docked-terminals: the worker boards currently docked in this swarm board. The rail is the
   * dock's TAB strip, so it must list every docked board even one the run does not know (a
   * restored project with no ledger) — an unlisted docked board would be an unreachable tab.
   * Absent ⇒ the pre-dock rendering (glance cards only), for the test/story callers.
   */
  dockedIds?: readonly string[]
  /** The active dock tab (highlighted); a popped-out worker card gets the ↗ canvas marker. */
  activeDockId?: string | null
}): ReactElement {
  const byBoard = new Map((run.ledger?.workers ?? []).map((w) => [w.boardId, w]))
  const docked = new Set(dockedIds ?? [])
  // Rail membership = the run's workers ∪ the docked boards (order: run first — the attention
  // sort below owns the final order anyway; a docked-only orphan lands as `idle`).
  const ids = [...new Set([...run.workerIds, ...(dockedIds ?? [])])]
  const cards = ids
    .map((id) => {
      const led = byBoard.get(id)
      return {
        id,
        state: stateOf(id, attention, running, led),
        meta: run.workerMeta[id] ?? {},
        led
      }
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state])
  const counts = cards.reduce(
    (acc, c) => ((acc[c.state] = (acc[c.state] ?? 0) + 1), acc),
    {} as Partial<Record<CardState, number>>
  )

  return (
    <div className="sw-rail">
      <div className="sw-canvas-head">
        <span className="sw-canvas-lbl">Workers · {cards.length}</span>
        <span className="sw-canvas-counts">
          {/* P4 rewrote the pairwise-separator chain as a filter/join: adding `blocked` to the
              old form meant threading it through every `&&` arm, and a member the summary omits
              is the silence bug this lane exists to fix. */}
          {(
            [
              counts['needs-input'] ? <b>{counts['needs-input']} needs input</b> : null,
              counts.blocked ? `${counts.blocked} blocked` : null,
              counts.stalled ? `${counts.stalled} stalled` : null,
              counts.lost ? `${counts.lost} lost` : null,
              counts.working ? `${counts.working} working` : null,
              counts.done ? `${counts.done} done` : null
            ].filter(Boolean) as Array<ReactElement | string>
          ).map((part, i) => (
            <Fragment key={i}>
              {i > 0 ? ' · ' : ''}
              {part}
            </Fragment>
          ))}
        </span>
      </div>
      <div className="sw-cards">
        {cards.map(({ id, state, meta, led }) => (
          <button
            key={id}
            type="button"
            className={`sw-card${state === 'needs-input' ? ' attn' : ''}${state === 'blocked' ? ' blocked' : ''}${state === 'done' ? ' done' : ''}${state === 'lost' ? ' lost' : ''}${id === activeDockId ? ' active' : ''}`}
            onClick={() => onOpen(id)}
            data-test={`swarm-card-${id}`}
            data-state={state}
          >
            <span className="sw-card-top">
              <span className={`sw-st ${state}`} aria-hidden="true" />
              <span className="sw-card-name">{titleOf(id)}</span>
              {/* Docked-terminals: a rail-listed worker that is NOT docked lives on the canvas
                  (popped out) — the ↗ marker says "this tab opens the canvas board". Rendered
                  only when the dock is active at all (dockedIds present). */}
              {dockedIds !== undefined && !docked.has(id) && (
                <span className="sw-popped" title="on the canvas" aria-hidden="true">
                  ↗
                </span>
              )}
              {meta.role && <span className="sw-role">{meta.role}</span>}
              <span className={`sw-card-t${state === 'stalled' ? ' stale' : ''}`}>
                {/* A lost worker has no live clock — an incrementing timer would imply it is
                    still going. Show an em dash instead. */}
                {state === 'lost'
                  ? '—'
                  : meta.joinedAt && now > 0
                    ? fmtMins(now - meta.joinedAt)
                    : ''}
              </span>
            </span>
            <span className="sw-activity">{activityLine(state, meta)}</span>
            {/* S3 (design variant C): its own mono line, and ONLY when this worker actually holds
                a worktree — a read-only role's card is byte-identical to what S2 shipped, which is
                the visible proof that isolation cost is paid by writers alone. The leaf is what
                fits at ~200px; the full branch (what the human types into `git merge`) rides the
                title, and the copyable form lives in the merge-sequence row. */}
            {led?.worktree && (
              <span
                className={`sw-wt${led.worktree.dirty ? ' dirty' : ''}`}
                title={led.worktree.branch}
              >
                <span className="g" aria-hidden="true">
                  ⑂
                </span>
                <span className="b">{led.worktree.leaf}</span>
                <span className="dim">· {led.worktree.note}</span>
              </span>
            )}
            {led?.disclose && <span className="sw-disclose">{led.disclose}</span>}
          </button>
        ))}
        {/* The [+ spawn] ghost — S1 routes manual adds through the chat (the orchestrator owns
            membership); the affordance nudges toward the composer rather than forking a path. */}
        <div className="sw-card ghost" aria-hidden="true">
          ask the orchestrator to spawn workers
        </div>
      </div>
    </div>
  )
}
