/**
 * DiagramSpec EDITOR mutations (diagram Phase 4 — the focus-mode editor). Pure builders that turn a
 * direct-manipulation gesture (drag a node, re-route an edge, drop a palette node, edit a label) into
 * a FRESH spec, expressed on top of the Phase-3 {@link applySpecOps} apply semantics so the editor
 * and the agent-facing MCP path share ONE mutation model. A LEAF sibling of {@link ./specOps} /
 * {@link ./diagramSpec} — no React, no imports beyond them — so it is exhaustively unit-testable.
 *
 * Contract: every builder is pure (input untouched) and TOTAL — a gesture against a stale id is a
 * no-op that returns the input unchanged (the DiagramCard render can lag a spec edit by a frame).
 * The caller (DiagramEditor) re-validates the result with {@link isValidSpec} before committing, so
 * a mutation can never persist a spec that would fail the boardSchema contract. Field caps are
 * enforced at the INPUT layer (maxLength on the editors) — these builders pass text through, they
 * never silently truncate.
 */
import {
  assertDiagramSpec,
  SPEC_ID_MAX,
  type DiagramSpec,
  type SpecEdge,
  type SpecNode
} from './diagramSpec'
import { applySpecOps } from './specOps'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const failThrow = (msg: string): never => {
  throw new Error(msg)
}

/**
 * True when `spec` passes the full DiagramSpec contract (shape + caps + closed enums + referential
 * integrity — the exact `assertDiagramSpec` the boardSchema/MCP paths run). The editor guards every
 * commit with this: a builder result that somehow violates the contract is dropped, never persisted.
 */
export function isValidSpec(spec: DiagramSpec): boolean {
  try {
    assertDiagramSpec(spec, failThrow, isRecord, isFiniteNum)
    return true
  } catch {
    return false
  }
}

/** The editable subset of a node's fields (position, text, and the closed vocab selectors). */
export type NodePatch = Partial<
  Pick<SpecNode, 'label' | 'detail' | 'kind' | 'status' | 'icon' | 'pos'>
>

function nodeById(spec: DiagramSpec, id: string): SpecNode | undefined {
  return spec.nodes.find((n) => n.id === id)
}

/**
 * Merge a partial patch into an existing node and upsert it. Optional fields present-but-empty
 * (`detail: ''`, `icon: ''`, `pos: undefined`) are DROPPED — the way you clear a secondary line or
 * unpin a node. A patch against a missing node id is a no-op (returns the input spec).
 */
export function editNode(spec: DiagramSpec, id: string, patch: NodePatch): DiagramSpec {
  const cur = nodeById(spec, id)
  if (!cur) return spec
  const next: SpecNode = { ...cur }
  if (patch.label !== undefined) next.label = patch.label
  if ('detail' in patch) {
    if (patch.detail) next.detail = patch.detail
    else delete next.detail
  }
  if (patch.kind !== undefined) next.kind = patch.kind
  if (patch.status !== undefined) next.status = patch.status
  if ('icon' in patch) {
    if (patch.icon) next.icon = patch.icon
    else delete next.icon
  }
  if ('pos' in patch) {
    if (patch.pos) next.pos = patch.pos
    else delete next.pos
  }
  return applySpecOps(spec, [{ op: 'upsertNode', node: next }])
}

/** Pin a node at a board-local position (the drag gesture) — leaves ELK auto-layout ownership. */
export function setNodePos(
  spec: DiagramSpec,
  id: string,
  pos: { x: number; y: number }
): DiagramSpec {
  return editNode(spec, id, { pos })
}

/** Unpin a node (drop `pos`) — returns it to ELK auto-layout ownership. */
export function unpinNode(spec: DiagramSpec, id: string): DiagramSpec {
  return editNode(spec, id, { pos: undefined })
}

/**
 * Re-route an edge's endpoint(s) to different node id(s) — the reconnect gesture. Only the ends you
 * pass change; a missing edge id is a no-op. Referential validity (both endpoints resolve, no
 * self-dangle) is judged by {@link isValidSpec} at the commit boundary; the editor only ever offers
 * existing node ids as reconnect targets, so a dangling result cannot arise from the UI.
 */
export function rerouteEdge(
  spec: DiagramSpec,
  edgeId: string,
  ends: { from?: string; to?: string }
): DiagramSpec {
  const cur = spec.edges.find((e) => e.id === edgeId)
  if (!cur) return spec
  const next: SpecEdge = {
    ...cur,
    ...(ends.from !== undefined ? { from: ends.from } : {}),
    ...(ends.to !== undefined ? { to: ends.to } : {})
  }
  return applySpecOps(spec, [{ op: 'upsertEdge', edge: next }])
}

/** Drop a new node (palette). The caller supplies a unique id (see {@link uniqueSpecId}). */
export function addNode(spec: DiagramSpec, node: SpecNode): DiagramSpec {
  return applySpecOps(spec, [{ op: 'upsertNode', node }])
}

/** Add a new edge (drawing a connection in the editor). */
export function addEdge(spec: DiagramSpec, edge: SpecEdge): DiagramSpec {
  return applySpecOps(spec, [{ op: 'upsertEdge', edge }])
}

/** Remove a node — edges touching it cascade away (the applySpecOps `removeNode` semantics). */
export function removeNode(spec: DiagramSpec, id: string): DiagramSpec {
  return applySpecOps(spec, [{ op: 'removeNode', id }])
}

/** Remove an edge. */
export function removeEdge(spec: DiagramSpec, id: string): DiagramSpec {
  return applySpecOps(spec, [{ op: 'removeEdge', id }])
}

/**
 * A slug id unique within `existing` — `base` sanitized to the spec id charset, with a numeric
 * suffix on collision. Used when the palette drops a node or the editor draws a fresh edge, so a new
 * element never duplicates an id (which `assertDiagramSpec` rejects). Never exceeds {@link SPEC_ID_MAX}.
 */
export function uniqueSpecId(base: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  // Sanitize to [A-Za-z0-9._-], trim separator runs, leave room for a "-NN" suffix.
  const root =
    base
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, SPEC_ID_MAX - 6) || 'node'
  if (!used.has(root)) return root
  let i = 2
  while (used.has(`${root}-${i}`)) i++
  return `${root}-${i}`
}
