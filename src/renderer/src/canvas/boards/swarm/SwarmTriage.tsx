/**
 * Swarm triage queue (region 4, orchestration S2) — S1's flat "needs you" jump list becomes a
 * risk-ordered, tagged, ACTIONABLE queue.
 *
 * 🔒 The two-source rule (see `swarmLedgerProject.ts`). Rows come from two places that each know
 * something the other cannot:
 *   - `needs_input` rows are built HERE from `attentionStore` — the live authority on "an agent is
 *     asking a human right now". MAIN has no better signal, and duplicating it would create two
 *     disagreeing truths.
 *   - every other tag (`lost` · `failing_check` · `stalled` · `dependency` · `unreviewed`) comes
 *     from MAIN's ledger projection, which is the only thing that survives a reload.
 * Both are merged and sorted by the SHARED `SWARM_BLOCKED_TAGS` order, in which `needs_input` is
 * index 0 — so the human-blocking rows land on top without either side knowing about the other.
 *
 * Actions are REQUESTS, never writes: `reassign` asks the orchestrator to re-dispatch (which pays
 * the normal confirm gate), and every ledger mutation is re-validated MAIN-side. "The reply
 * proposes, MAIN disposes."
 */
import { type ReactElement } from 'react'
import type { AttentionKind } from '../../../store/attentionStore'
import type { SwarmRun } from '../../../store/swarmStore'
import {
  SWARM_BLOCKED_TAGS,
  type SwarmBlockedTag,
  type SwarmTriageAction,
  type SwarmTriageRow
} from '../../../../../shared/swarmLedgerTypes'

/** Row severity → the visual lane. Amber is reserved for "a human is the blocker". */
const HOT: ReadonlySet<SwarmBlockedTag> = new Set<SwarmBlockedTag>(['needs_input'])
const BAD: ReadonlySet<SwarmBlockedTag> = new Set<SwarmBlockedTag>(['lost', 'failing_check'])

const GLYPH: Record<SwarmBlockedTag, string> = {
  needs_input: '!',
  lost: '×',
  failing_check: '×',
  stalled: '◌',
  dependency: '⇣',
  unreviewed: '✓'
}

/** Human-facing tag chip text — the closed vocabulary, spelled for a person. */
const TAG_LABEL: Record<SwarmBlockedTag, string> = {
  needs_input: 'needs input',
  lost: 'lost',
  failing_check: 'failing check',
  stalled: 'stalled',
  dependency: 'blocked',
  unreviewed: 'unreviewed'
}

const ACTION_LABEL: Record<SwarmTriageAction, string> = {
  open: 'Open ▸',
  reassign: 'Reassign',
  accept: 'Accept',
  wait: 'Wait',
  dismiss: 'Dismiss'
}

/** The primary (accented) action in each row — the one the human most likely wants. */
const PRIMARY: Record<SwarmBlockedTag, SwarmTriageAction> = {
  needs_input: 'open',
  lost: 'reassign',
  failing_check: 'reassign',
  stalled: 'reassign',
  dependency: 'open',
  unreviewed: 'open'
}

const rank = (t: SwarmBlockedTag): number => {
  const i = SWARM_BLOCKED_TAGS.indexOf(t)
  return i < 0 ? SWARM_BLOCKED_TAGS.length : i
}

/**
 * Merge the attention-derived `needs_input` rows with the ledger's, then risk-order. Exported for
 * unit test: the ordering contract is the whole point of the queue.
 */
export function mergeTriage(
  workerIds: string[],
  attention: Record<string, AttentionKind>,
  ledgerRows: SwarmTriageRow[]
): SwarmTriageRow[] {
  // A board can appear in BOTH sources (a stalled task whose agent then asked a question). The
  // live needs-input row wins — answering the question is what unblocks it.
  const asking = workerIds.filter((id) => attention[id] === 'needs-input')
  const askingSet = new Set(asking)
  const rows: SwarmTriageRow[] = [
    ...asking.map(
      (id): SwarmTriageRow => ({
        id: `attn:${id}`,
        tag: 'needs_input',
        boardId: id,
        text: 'is waiting on input — answer in the terminal',
        actions: ['open']
      })
    ),
    ...ledgerRows.filter((r) => !askingSet.has(r.boardId))
  ]
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row.tag) - rank(b.row.tag) || a.i - b.i)
    .map((e) => e.row)
}

export function SwarmTriage({
  run,
  attention,
  titleOf,
  onOpen,
  onAction
}: {
  run: SwarmRun
  attention: Record<string, AttentionKind>
  titleOf: (id: string) => string
  onOpen: (boardId: string) => void
  onAction: (row: SwarmTriageRow, action: SwarmTriageAction) => void
}): ReactElement {
  const rows = mergeTriage(run.workerIds, attention, run.ledger?.triage ?? [])
  const nowCount = rows.filter((r) => r.tag === 'needs_input').length

  return (
    <div className="sw-needs" data-test="swarm-needs-you">
      <div className="sw-needs-head">
        Triage{rows.length > 0 ? ` · ${rows.length}` : ''}
        {nowCount > 0 && <b>({nowCount} needs you now)</b>}
      </div>
      <div className="sw-needs-list">
        {rows.length === 0 && <div className="sw-needs-quiet">nothing needs you</div>}
        {rows.map((row) => (
          <div
            key={row.id}
            className={`sw-tri${HOT.has(row.tag) ? ' hot' : BAD.has(row.tag) ? ' bad' : ''}`}
            data-test={`swarm-triage-${row.tag}`}
          >
            <span className="sw-tri-ico" aria-hidden="true">
              {GLYPH[row.tag]}
            </span>
            <span className="sw-tri-tag">{TAG_LABEL[row.tag]}</span>
            <span className="sw-tri-txt">
              <b>{titleOf(row.boardId)}</b> {row.text}
            </span>
            <span className="sw-tri-acts">
              {row.actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={`sw-btn sm${action === PRIMARY[row.tag] ? ' go' : ''}`}
                  data-test={`swarm-triage-${action}`}
                  onClick={() => (action === 'open' ? onOpen(row.boardId) : onAction(row, action))}
                >
                  {ACTION_LABEL[action]}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
