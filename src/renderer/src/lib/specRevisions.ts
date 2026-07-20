/**
 * Spec revision capture (v22, diagram-viz Phase 2 B4) — a PURE elements[]→elements[] transform
 * applied at the boardPatch choke point (every planning `elements` write flows through
 * `applyBoardPatch`, tracked and untracked alike). When an incoming patch REPLACES an expanse
 * diagram's spec, the displaced spec is appended to the element's `revisions` (oldest→newest,
 * capped — oldest roll off), so the card header can scrub history read-only.
 *
 * Content-compared (JSON), not identity-compared: writers routinely mint fresh objects for
 * unchanged specs (a same-array map), and an equal-content swap must not mint a phantom revision.
 * Undo/redo restores whole board snapshots WITHOUT going through applyBoardPatch, so history
 * replay never double-captures.
 */
import { DIAGRAM_REVISION_CAP, type DiagramRevision, type PlanningElement } from './boardSchema'

/**
 * Returns `next` with revision captures applied — or `next` UNCHANGED (same ref) when no spec was
 * displaced. `author` is 'agent' for every capture today: the only live spec writers are MCP
 * applies; the Phase-4 user editor will thread 'user' through explicitly.
 */
export function withSpecRevisions(
  prev: readonly PlanningElement[],
  next: readonly PlanningElement[],
  ts: number,
  author: DiagramRevision['author'] = 'agent'
): PlanningElement[] {
  let captured = false
  const out = next.map((el) => {
    if (el.kind !== 'diagram' || el.engine !== 'expanse' || el.spec === undefined) return el
    const before = prev.find((p) => p.id === el.id)
    if (
      before === undefined ||
      before.kind !== 'diagram' ||
      before.engine !== 'expanse' ||
      before.spec === undefined
    ) {
      return el
    }
    if (JSON.stringify(before.spec) === JSON.stringify(el.spec)) return el
    captured = true
    const revisions = [
      ...(before.revisions ?? []),
      { spec: before.spec, ts, author } satisfies DiagramRevision
    ].slice(-DIAGRAM_REVISION_CAP)
    return { ...el, revisions }
  })
  return captured ? out : (next as PlanningElement[])
}
