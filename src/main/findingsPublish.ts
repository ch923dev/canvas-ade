/**
 * Publishing a findings batch (orchestration P4) — the gate + the single durable write.
 *
 * `findingsBatch.ts` composes; this asks the human once and lands the result. The whole point is the
 * arithmetic: N findings would otherwise cost N `add_card` calls and therefore N confirm modals.
 * Here they cost ONE `confirmBatch` (the shipped per-row gate `relay_prompts` already uses) and ONE
 * `patchKanban` carrying N add-ops (the renderer applier has always accepted an op ARRAY). One
 * gesture, per-row vetoable, fail-closed.
 *
 * 🔒 FAIL-CLOSED, PER ROW. `requestConfirmBatch` returns decisions positionally 1:1 with the rows
 * and treats anything but an explicit approve as a deny. A row the human unchecks simply never
 * becomes a card — deny is free and granular, which is what makes ONE modal for N rows honest
 * rather than an all-or-nothing rubber stamp.
 *
 * 🔒 RE-DERIVED AT THE WRITE, NOT AT THE GATE. The human may sit on this modal for minutes while the
 * orchestrator keeps working. Every id is therefore re-resolved AFTER the decision returns (BUG-021
 * discipline): a destination board deleted mid-prompt fails the publish instead of writing into a
 * board that no longer exists. And the converse rule (S3's round-2 `[warning]`): when the human
 * approves NOTHING, that is a no-op, and a no-op must not be reported as a failure.
 */
import {
  composeFindings,
  findingLabel,
  findingRef,
  laneForSeverity,
  type Finding,
  type WorkerReport
} from './findingsBatch'
import type { KanbanOp, McpCommand, McpCommandAck } from '../shared/mcpTypes'

/** The lanes a fresh kanban board ships with — the fallback when a caller names none. */
const DEFAULT_LANE = 'backlog'

export interface FindingsPublishDeps {
  /** Every worker report MAIN currently holds, resolved at CALL time (never passed in by an agent). */
  collectReports(): WorkerReport[]
  /** Live board lookup: `{ type, title }` for an id, or undefined when it is gone. */
  lookupBoard(id: string): { type: string; title: string } | undefined
  /** The columns a kanban board actually has, so a finding is never routed to a lane that is absent. */
  lanesOf(boardId: string): string[]
  /** `mcpConfirm.requestConfirmBatch` — ONE modal, N rows, fail-closed. */
  confirmBatch(req: {
    title: string
    items: Array<{ label: string; body: string }>
  }): Promise<{ decisions: Array<{ approved: boolean }> }>
  /** `sendMcpCommand` bound to the live window. */
  send(command: McpCommand): Promise<McpCommandAck>
  /** Mint a card id. Injected so the unit tests are deterministic. */
  newCardId(): string
}

export interface FindingsPublishResult {
  ok: boolean
  /** Cards actually written. 0 with `ok:true` means the human approved nothing — a no-op, not a failure. */
  published: number
  /** Human-readable outcome, ALWAYS carrying the batch disclosure when there was one. */
  summary: string
}

/** Build one kanban add-op from an approved finding. */
function cardFor(
  f: Finding,
  id: string,
  columnId: string,
  titleOf: (b: string) => string
): KanbanOp {
  const ref = findingRef(f)
  const assignees = f.boardIds.map(titleOf)
  const tags = [f.severity, ...f.roles].filter((t, i, a) => t.length > 0 && a.indexOf(t) === i)
  // The description leads with provenance. A synthesized result was DERIVED from a dead worker's
  // transcript, and a card that reads like a self-report would launder that guess into a claim.
  const provenance = f.synthesized
    ? 'Derived from the transcript — the worker never reported this itself.'
    : 'Reported by the worker itself; the severity is its claim, not a verification.'
  const description =
    assignees.length > 1
      ? `${provenance}\n\nReported independently by: ${assignees.join(', ')}.`
      : provenance
  return {
    op: 'add',
    card: {
      id,
      columnId,
      title: f.note,
      tag: f.severity,
      tags,
      // `assignee` is a single field; a merged finding names its first reporter and the description
      // carries the full list rather than silently dropping the others.
      ...(assignees[0] !== undefined ? { assignee: assignees[0] } : {}),
      ...(ref.length > 0 ? { ref } : {}),
      ...(f.path !== undefined
        ? { fileRefs: [{ path: f.path, ...(f.line !== undefined ? { line: f.line } : {}) }] }
        : {}),
      description
    }
  }
}

/**
 * Compose → confirm → write. `boardId` must be a live KANBAN board; the caller (tool or UI action)
 * supplies only that and an optional lane override.
 */
export async function publishFindings(
  deps: FindingsPublishDeps,
  boardId: string,
  opts?: { lane?: string }
): Promise<FindingsPublishResult> {
  const target = deps.lookupBoard(boardId)
  if (!target) return { ok: false, published: 0, summary: `board not found: ${boardId}` }
  if (target.type !== 'kanban') {
    return {
      ok: false,
      published: 0,
      summary: `board ${boardId} is a ${target.type}, not a kanban`
    }
  }

  const reports = deps.collectReports()
  const batch = composeFindings(reports)
  if (batch.findings.length === 0) {
    // An empty batch is a legitimate outcome (a clean review IS a result), and it writes nothing —
    // so it must not be reported as a failure. The reason still travels in the summary.
    return { ok: true, published: 0, summary: `nothing to publish — ${batch.disclose}` }
  }

  const titleOf = (id: string): string => deps.lookupBoard(id)?.title ?? id
  const decision = await deps.confirmBatch({
    title: `Publish ${batch.findings.length} finding${batch.findings.length === 1 ? '' : 's'} to “${target.title}”`,
    items: batch.findings.map((f) => ({
      label: findingLabel(f, titleOf),
      body: f.note
    }))
  })

  const approved = batch.findings.filter((_, i) => decision.decisions[i]?.approved === true)
  if (approved.length === 0) {
    // 🔒 Gate the WRITE, not the no-op (S3 round-2 `[warning]`): declining every row touches
    // nothing, so it is a successful "no thanks", never an error.
    return { ok: true, published: 0, summary: `no findings approved — nothing written` }
  }

  // 🔒 Re-derive AFTER the human's decision, not before it. The modal may have been open for
  // minutes; the destination board can be gone and its lanes can have changed underneath.
  const stillThere = deps.lookupBoard(boardId)
  if (!stillThere || stillThere.type !== 'kanban') {
    return {
      ok: false,
      published: 0,
      summary: `board ${boardId} was removed while the confirmation was open — nothing written`
    }
  }
  const lanes = deps.lanesOf(boardId)
  const laneFor = (f: Finding): string => {
    const wanted = opts?.lane ?? laneForSeverity(f.severity)
    if (lanes.includes(wanted)) return wanted
    // A board with custom columns may have neither `review` nor `backlog`. Landing on its FIRST
    // lane keeps the finding rather than dropping it, and the summary says the routing changed.
    return lanes.includes(DEFAULT_LANE) ? DEFAULT_LANE : (lanes[0] ?? DEFAULT_LANE)
  }
  const rerouted = approved.filter(
    (f) => laneFor(f) !== (opts?.lane ?? laneForSeverity(f.severity))
  ).length

  const ops = approved.map((f) => cardFor(f, deps.newCardId(), laneFor(f), titleOf))
  const ack = await deps.send({ type: 'patchKanban', id: boardId, ops })
  if (!ack.ok) {
    return { ok: false, published: 0, summary: `write refused: ${ack.error}` }
  }

  const declined = batch.findings.length - approved.length
  const notes = [`published ${approved.length} card${approved.length === 1 ? '' : 's'}`]
  if (declined > 0) notes.push(`${declined} declined`)
  if (rerouted > 0) notes.push(`${rerouted} routed to an existing lane instead`)
  notes.push(batch.disclose)
  return { ok: true, published: approved.length, summary: notes.join(' · ') }
}
