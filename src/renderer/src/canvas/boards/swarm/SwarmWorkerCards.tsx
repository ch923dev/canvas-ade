/**
 * Swarm worker canvas (region 3) — the run's worker terminal boards as Layer-A glance cards
 * (09 §4): state icon · role badge · activity line · timer, attention-ordered so the lone
 * amber card is always the one that needs you (needs-input → working → spawning/idle → done).
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
 */
import { type ReactElement } from 'react'
import type { AttentionKind } from '../../../store/attentionStore'
import type { SwarmRun } from '../../../store/swarmStore'
import type { SwarmWorkerLedgerState } from '../../../../../shared/swarmLedgerTypes'

type CardState = 'needs-input' | 'working' | 'done' | 'error' | 'idle' | 'stalled' | 'lost'

function stateOf(
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
  if (a === 'done') return 'done'
  return running[id] ? 'working' : 'idle'
}

/** Attention ordering (09 §4): needs-input → lost → stalled → working → idle → error → done. */
const ORDER: Record<CardState, number> = {
  'needs-input': 0,
  lost: 1,
  stalled: 2,
  working: 3,
  idle: 4,
  error: 5,
  done: 6
}

function fmtMins(ms: number): string {
  const m = Math.floor(ms / 60000)
  return m > 0 ? `${m}m` : `${Math.floor(ms / 1000)}s`
}

/** The activity line — what the worker is doing, or what happened to it. */
function activityLine(state: CardState, meta: SwarmRun['workerMeta'][string]): string {
  switch (state) {
    case 'needs-input':
      return 'Waiting on input'
    case 'lost':
      return 'Lost mid-task — result salvaged'
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
  onOpen
}: {
  run: SwarmRun
  attention: Record<string, AttentionKind>
  running: Record<string, boolean>
  /** Wall-clock ms ticked by the host's 1s timer (render purity — no Date.now() in render). */
  now: number
  titleOf: (id: string) => string
  onOpen: (boardId: string) => void
}): ReactElement {
  const byBoard = new Map((run.ledger?.workers ?? []).map((w) => [w.boardId, w]))
  const cards = run.workerIds
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
    <main className="sw-canvas" data-test="swarm-workers">
      <div className="sw-canvas-head">
        <span className="sw-canvas-lbl">Workers · {cards.length}</span>
        <span className="sw-canvas-counts">
          {counts['needs-input'] ? <b>{counts['needs-input']} needs input</b> : null}
          {counts['needs-input'] && (counts.stalled || counts.lost || counts.working || counts.done)
            ? ' · '
            : ''}
          {counts.stalled ? `${counts.stalled} stalled` : ''}
          {counts.stalled && (counts.lost || counts.working || counts.done) ? ' · ' : ''}
          {counts.lost ? `${counts.lost} lost` : ''}
          {counts.lost && (counts.working || counts.done) ? ' · ' : ''}
          {counts.working ? `${counts.working} working` : ''}
          {counts.working && counts.done ? ' · ' : ''}
          {counts.done ? `${counts.done} done` : ''}
        </span>
      </div>
      <div className="sw-cards">
        {cards.map(({ id, state, meta, led }) => (
          <button
            key={id}
            type="button"
            className={`sw-card${state === 'needs-input' ? ' attn' : ''}${state === 'done' ? ' done' : ''}${state === 'lost' ? ' lost' : ''}`}
            onClick={() => onOpen(id)}
            data-test={`swarm-card-${id}`}
            data-state={state}
          >
            <span className="sw-card-top">
              <span className={`sw-st ${state}`} aria-hidden="true" />
              <span className="sw-card-name">{titleOf(id)}</span>
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
            {led?.disclose && <span className="sw-disclose">{led.disclose}</span>}
          </button>
        ))}
        {/* The [+ spawn] ghost — S1 routes manual adds through the chat (the orchestrator owns
            membership); the affordance nudges toward the composer rather than forking a path. */}
        <div className="sw-card ghost" aria-hidden="true">
          ask the orchestrator to spawn workers
        </div>
      </div>
    </main>
  )
}
