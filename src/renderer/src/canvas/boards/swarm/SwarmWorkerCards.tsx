/**
 * Swarm worker canvas (region 3) — the run's worker terminal boards as Layer-A glance cards
 * (09 §4): state icon · role badge · activity line · timer, attention-ordered so the lone
 * amber card is always the one that needs you (needs-input → working → spawning/idle → done).
 * Q11 lens model: each card is chrome over an ORDINARY terminal board on the canvas — the
 * card never forks terminal behavior; clicking jumps to (expands) the real board.
 */
import { type ReactElement } from 'react'
import type { AttentionKind } from '../../../store/attentionStore'
import type { SwarmRun } from '../../../store/swarmStore'

type CardState = 'needs-input' | 'working' | 'done' | 'error' | 'idle'

function stateOf(
  id: string,
  attention: Record<string, AttentionKind>,
  running: Record<string, boolean>
): CardState {
  const a = attention[id]
  if (a === 'needs-input') return 'needs-input'
  if (a === 'error') return 'error'
  if (a === 'done') return 'done'
  return running[id] ? 'working' : 'idle'
}

/** Attention ordering (09 §4): needs-input → working → idle → error → done. */
const ORDER: Record<CardState, number> = {
  'needs-input': 0,
  working: 1,
  idle: 2,
  error: 3,
  done: 4
}

function fmtMins(ms: number): string {
  const m = Math.floor(ms / 60000)
  return m > 0 ? `${m}m` : `${Math.floor(ms / 1000)}s`
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
  const cards = run.workerIds
    .map((id) => ({ id, state: stateOf(id, attention, running), meta: run.workerMeta[id] ?? {} }))
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
          {counts['needs-input'] && (counts.working || counts.done) ? ' · ' : ''}
          {counts.working ? `${counts.working} working` : ''}
          {counts.working && counts.done ? ' · ' : ''}
          {counts.done ? `${counts.done} done` : ''}
        </span>
      </div>
      <div className="sw-cards">
        {cards.map(({ id, state, meta }) => (
          <button
            key={id}
            type="button"
            className={`sw-card${state === 'needs-input' ? ' attn' : ''}${state === 'done' ? ' done' : ''}`}
            onClick={() => onOpen(id)}
            data-test={`swarm-card-${id}`}
            data-state={state}
          >
            <span className="sw-card-top">
              <span className={`sw-st ${state}`} aria-hidden="true" />
              <span className="sw-card-name">{titleOf(id)}</span>
              {meta.role && <span className="sw-role">{meta.role}</span>}
              <span className="sw-card-t">
                {meta.joinedAt && now > 0 ? fmtMins(now - meta.joinedAt) : ''}
              </span>
            </span>
            <span className="sw-activity">
              {state === 'needs-input'
                ? 'Waiting on input'
                : state === 'error'
                  ? 'Hit an error'
                  : state === 'done'
                    ? meta.provenance === 'claimed'
                      ? 'Done — agent-claimed, unverified'
                      : 'Done — derived from transcript'
                    : (meta.activity ?? (state === 'working' ? 'Working…' : 'Idle'))}
            </span>
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
