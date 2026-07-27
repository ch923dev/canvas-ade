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
import { useState, type ReactElement } from 'react'
import type { AttentionKind } from '../../../store/attentionStore'
import type { SwarmRun } from '../../../store/swarmStore'
import {
  SWARM_BLOCKED_TAGS,
  type SwarmBlockedTag,
  type SwarmMergeStep,
  type SwarmTriageAction,
  type SwarmTriageRow
} from '../../../../../shared/swarmLedgerTypes'

/**
 * Row severity → the visual lane. Amber is reserved for "a human is the blocker".
 *
 * S3: `overlap` joins the `bad` (err) lane — merging blind silently reverts somebody's work, which
 * is an err-class outcome — but deliberately NOT the amber lane, because nobody is asking the
 * human a question. `merge_ready` gets its own accent lane (`seq`): it is neither a hazard nor a
 * question, it is the run telling you it is ready for you. `dirty_worktree` stays neutral —
 * nothing is at risk, which is the entire point of the keep-on-dirty rule.
 */
const HOT: ReadonlySet<SwarmBlockedTag> = new Set<SwarmBlockedTag>(['needs_input'])
const BAD: ReadonlySet<SwarmBlockedTag> = new Set<SwarmBlockedTag>([
  'lost',
  'failing_check',
  'overlap'
])
const SEQ: ReadonlySet<SwarmBlockedTag> = new Set<SwarmBlockedTag>(['merge_ready'])

const GLYPH: Record<SwarmBlockedTag, string> = {
  needs_input: '!',
  lost: '×',
  failing_check: '×',
  overlap: '⇄',
  stalled: '◌',
  dependency: '⇣',
  dirty_worktree: '◍',
  unreviewed: '✓',
  merge_ready: '⑂'
}

/** Human-facing tag chip text — the closed vocabulary, spelled for a person. */
const TAG_LABEL: Record<SwarmBlockedTag, string> = {
  needs_input: 'needs input',
  lost: 'lost',
  failing_check: 'failing check',
  overlap: 'overlap',
  stalled: 'stalled',
  dependency: 'blocked',
  dirty_worktree: 'dirty worktree',
  unreviewed: 'unreviewed',
  merge_ready: 'merge ready'
}

const ACTION_LABEL: Record<SwarmTriageAction, string> = {
  open: 'Open ▸',
  reassign: 'Reassign',
  accept: 'Accept',
  wait: 'Wait',
  dismiss: 'Dismiss',
  resolve: 'Resolve…'
}

/** The primary (accented) action in each row — the one the human most likely wants. */
const PRIMARY: Record<SwarmBlockedTag, SwarmTriageAction> = {
  needs_input: 'open',
  lost: 'reassign',
  failing_check: 'reassign',
  overlap: 'open',
  stalled: 'reassign',
  dependency: 'open',
  dirty_worktree: 'resolve',
  unreviewed: 'open',
  // The merge row carries no ledger action at all — its control is the renderer-side expander.
  merge_ready: 'open'
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

/**
 * S3 — the merge sequence, rendered UNDER its `merge_ready` row when expanded. This is the whole
 * deliverable of the integration surface: the branches, in the order to merge them, with the ones
 * that have to be rebased marked. There is deliberately NO merge button — auto-merge is deferred
 * in three separate documents, and a button here would imply otherwise.
 */
function MergeSequence({ steps }: { steps: SwarmMergeStep[] }): ReactElement {
  return (
    <div className="sw-seq" data-test="swarm-merge-sequence">
      {steps.map((step, i) => (
        <div key={step.taskId} className="sw-seq-row">
          <span className="sw-seq-n">{i + 1}.</span>
          <span className="sw-seq-br" title={step.branch}>
            {step.branch}
          </span>
          <span className="sw-seq-meta">
            {step.label} · {step.files} file{step.files === 1 ? '' : 's'}
          </span>
          {step.overlapsWith.length > 0 && (
            <span className="sw-seq-warn">
              ⇄ overlaps {step.overlapsWith.map((n) => `#${n}`).join(', ')}
            </span>
          )}
          {step.dirty && <span className="sw-seq-warn">◍ uncommitted</span>}
        </div>
      ))}
      <div className="sw-seq-foot">
        merge in this order · re-run the role&apos;s acceptance checks between each · Expanse does
        not merge for you
      </div>
    </div>
  )
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
  // Expanded by default: a sequence nobody opens is a sequence nobody follows, and the row only
  // exists at all once there is something to merge.
  const [seqOpen, setSeqOpen] = useState(true)
  const rows = mergeTriage(run.workerIds, attention, run.ledger?.triage ?? [])
  const nowCount = rows.filter((r) => r.tag === 'needs_input').length
  const sequence = run.ledger?.mergeSequence ?? []

  return (
    <div className="sw-needs" data-test="swarm-needs-you">
      <div className="sw-needs-head">
        Triage{rows.length > 0 ? ` · ${rows.length}` : ''}
        {nowCount > 0 && <b>({nowCount} needs you now)</b>}
      </div>
      <div className="sw-needs-list">
        {rows.length === 0 && <div className="sw-needs-quiet">nothing needs you</div>}
        {rows.map((row) => (
          <div key={row.id} className="sw-tri-group">
            <div
              className={`sw-tri${HOT.has(row.tag) ? ' hot' : BAD.has(row.tag) ? ' bad' : SEQ.has(row.tag) ? ' seq' : ''}`}
              data-test={`swarm-triage-${row.tag}`}
            >
              <span className="sw-tri-ico" aria-hidden="true">
                {GLYPH[row.tag]}
              </span>
              <span className="sw-tri-tag">{TAG_LABEL[row.tag]}</span>
              <span className="sw-tri-txt">
                {/* A run-level row (`merge_ready`) is about the RUN, not any one worker, so it
                    carries no bold worker title. An `overlap` row is about TWO workers: MAIN sends
                    both ids and never a title, so the second name is resolved here. */}
                {row.tag !== 'merge_ready' && (
                  <>
                    <b>{titleOf(row.boardId)}</b>
                    {row.boardId2 ? ` and ${titleOf(row.boardId2)} ` : ' '}
                  </>
                )}
                {row.text}
              </span>
              <span className="sw-tri-acts">
                {row.tag === 'merge_ready' && (
                  <button
                    type="button"
                    className="sw-btn sm go"
                    data-test="swarm-triage-sequence-toggle"
                    aria-expanded={seqOpen}
                    onClick={() => setSeqOpen((v) => !v)}
                  >
                    {seqOpen ? 'Hide ▴' : 'Show ▾'}
                  </button>
                )}
                {row.actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={`sw-btn sm${action === PRIMARY[row.tag] ? ' go' : ''}`}
                    data-test={`swarm-triage-${action}`}
                    onClick={() =>
                      action === 'open' ? onOpen(row.boardId) : onAction(row, action)
                    }
                  >
                    {ACTION_LABEL[action]}
                  </button>
                ))}
              </span>
            </div>
            {row.tag === 'merge_ready' && seqOpen && sequence.length > 0 && (
              <MergeSequence steps={sequence} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
