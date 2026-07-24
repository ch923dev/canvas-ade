/**
 * DfGraph → DiagramSpec adapter (diagram Phase 5, Card 1) — pure + render-time ONLY. The Data-Flow
 * board's graph is EPHEMERAL (re-derived from the live capture each render); this mapping feeds it
 * into the shared spec renderer without ever touching persistence, boardPatch, or undo. The produced
 * spec is never serialized and never leaves the render path.
 *
 * Mapping (per the approved Phase-5 design artifact, signed off 2026-07-24):
 *  - kinds: page → 'actor' · endpoint → 'service' · entity/shape → 'data' (shape adds status:'muted')
 *  - edges: call → 'flow' · returns → 'data' · rel → 'dependency'+label ·
 *           lineage → 'dependency'+status:'active'+label (the accent-tinted dash)
 *  - diff:  added → status:'active' (●) · changed → status:'warn' (!) — diff wins over 'muted'
 *  - entity fields → SpecNode.rows (id-like members accent the type cell); moreFields folds into a
 *    trailing '+N more' row (both capped by SPEC_MAX_ROWS)
 *  - ids: Df ids ('page:https://…', 'GET /a/{b}') are NOT spec slugs — every id is slugified and
 *    de-duped deterministically; `fromSlug` maps a hit-tested slug back to the Df id for focus.
 *  - caps: nodes/edges truncate to the spec caps (SPEC_MAX_NODES/EDGES); edges referencing a
 *    truncated node are dropped. `truncated` reports what was cut so the board can surface it.
 */
import type { DfGraph, DfNode, GraphDiff } from './dataFlowGraph'
import type { DiagramSpec, SpecEdge, SpecNode, SpecNodeRow, SpecStatus } from './diagramSpec'
import { SPEC_ID_MAX, SPEC_MAX_EDGES, SPEC_MAX_NODES, SPEC_MAX_ROWS } from './diagramSpec'

export interface DfSpecResult {
  spec: DiagramSpec
  /** Df node id → spec slug (focus in). */
  toSlug: Map<string, string>
  /** Spec slug → Df node id (hit-test out). */
  fromSlug: Map<string, string>
  /** Nodes/edges cut by the spec caps (0/0 in any sane capture). */
  truncated: { nodes: number; edges: number }
}

/** Deterministic slug for a Df id: squash the non-slug runs, trim, cap, de-dupe by '-N' suffix. */
function slugify(raw: string, taken: Set<string>): string {
  let s = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (s.length === 0) s = 'n'
  if (s.length > SPEC_ID_MAX) s = s.slice(0, SPEC_ID_MAX)
  if (!taken.has(s)) {
    taken.add(s)
    return s
  }
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const candidate = s.slice(0, SPEC_ID_MAX - suffix.length) + suffix
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

function nodeStatus(n: DfNode, diff: GraphDiff): SpecStatus | undefined {
  if (diff.added.has(n.id)) return 'active'
  if (diff.changed.has(n.id)) return 'warn'
  if (n.kind === 'shape') return 'muted'
  return undefined
}

function nodeRows(n: DfNode): SpecNodeRow[] | undefined {
  if (!n.fields || n.fields.length === 0) return undefined
  const rows: SpecNodeRow[] = n.fields
    .slice(0, n.moreFields ? SPEC_MAX_ROWS - 1 : SPEC_MAX_ROWS)
    .map((f) => ({ left: f.key, right: f.type, ...(f.idLike ? { accent: true } : {}) }))
  if (n.moreFields) rows.push({ left: `+${n.moreFields} more` })
  return rows
}

function nodeDetail(n: DfNode): string | undefined {
  if (n.kind === 'endpoint') {
    return n.method ? (n.sub ? `${n.method} · ${n.sub}` : n.method) : n.sub
  }
  if (n.kind === 'entity' || n.kind === 'shape') {
    return n.sub ? `${n.kind} · ${n.sub}` : n.kind
  }
  return undefined // page — the host label carries it
}

/** Build the render-time spec + the two-way id maps from a derived Df graph and its diff. */
export function dfGraphToSpec(graph: DfGraph, diff: GraphDiff): DfSpecResult {
  const toSlug = new Map<string, string>()
  const fromSlug = new Map<string, string>()
  const taken = new Set<string>()

  const dfNodes = graph.nodes.slice(0, SPEC_MAX_NODES)
  const nodes: SpecNode[] = dfNodes.map((n) => {
    const slug = slugify(n.id, taken)
    toSlug.set(n.id, slug)
    fromSlug.set(slug, n.id)
    const status = nodeStatus(n, diff)
    const rows = nodeRows(n)
    const detail = nodeDetail(n)
    return {
      id: slug,
      label: n.label,
      kind: n.kind === 'page' ? 'actor' : n.kind === 'endpoint' ? 'service' : 'data',
      ...(status ? { status } : {}),
      ...(detail ? { detail } : {}),
      ...(rows ? { rows } : {})
    }
  })

  const edgeTaken = new Set<string>()
  const edges: SpecEdge[] = []
  let droppedEdges = 0
  for (const e of graph.edges) {
    const from = toSlug.get(e.from)
    const to = toSlug.get(e.to)
    if (!from || !to) {
      droppedEdges++ // endpoint truncated away by the node cap
      continue
    }
    if (edges.length >= SPEC_MAX_EDGES) {
      droppedEdges++
      continue
    }
    edges.push({
      id: slugify(e.id, edgeTaken),
      from,
      to,
      kind: e.kind === 'call' ? 'flow' : e.kind === 'returns' ? 'data' : 'dependency',
      ...(e.kind === 'lineage' ? { status: 'active' as const } : {}),
      ...(e.label ? { label: e.label } : {})
    })
  }

  return {
    spec: { version: 1, direction: 'right', nodes, edges },
    toSlug,
    fromSlug,
    truncated: { nodes: graph.nodes.length - dfNodes.length, edges: droppedEdges }
  }
}
