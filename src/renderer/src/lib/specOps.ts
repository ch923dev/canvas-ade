import type { DiagramSpec, SpecEdge, SpecGroup, SpecNode } from './diagramSpec'

/**
 * DiagramSpec incremental ops (diagram Phase 3 — MCP contract v2). The pure apply half of the
 * agent read→update loop: `update_planning_element.specOps` carries an ORDERED batch of these,
 * MAIN applies them against the element's current spec to compute (and diff, and validate) the
 * proposed result for the human confirm, and the renderer re-applies the SAME batch against the
 * LIVE spec at land time (so a slightly stale MAIN mirror can never clobber a fresher element —
 * the checklist `setItems` discipline).
 *
 * A LEAF sibling of {@link ./diagramSpec} — no imports beyond it — so BOTH bundles (MAIN's gate
 * and the renderer's applier) share one apply semantics. Semantics:
 * - upserts replace by slug id, else append (idempotent — re-sending a batch converges);
 * - `removeNode` CASCADES: edges touching the node go with it (the result must pass
 *   `assertDiagramSpec`, which rejects dangling endpoints — a cascade is the only sane meaning);
 * - `removeGroup` cascades by CLEARING members' `group` ref (the nodes stay);
 * - removes of an unknown id are no-ops (idempotent deletes; a batch that nets to NO change is
 *   rejected by the gate, so a typo'd id can't silently "succeed" — the diff shows nothing);
 * - `setMeta` overwrites only the fields present.
 * Ops apply in order; referential validity is judged on the RESULT only (an edge may arrive
 * before the node a later op adds).
 */

export type SpecOp =
  | { op: 'upsertNode'; node: SpecNode }
  | { op: 'removeNode'; id: string }
  | { op: 'upsertEdge'; edge: SpecEdge }
  | { op: 'removeEdge'; id: string }
  | { op: 'upsertGroup'; group: SpecGroup }
  | { op: 'removeGroup'; id: string }
  | { op: 'setMeta'; title?: string; direction?: 'right' | 'down'; theme?: string }

/** Replace-by-id, else append — the shared upsert used by all three namespaces. */
function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const out = list.slice()
  out[i] = item
  return out
}

/**
 * Apply an ordered {@link SpecOp} batch to a spec, returning a FRESH spec (input untouched).
 * Pure and total for well-shaped ops — it never throws; callers judge the RESULT with
 * `assertDiagramSpec` (MAIN pre-confirm, the renderer applier at land time).
 */
export function applySpecOps(spec: DiagramSpec, ops: readonly SpecOp[]): DiagramSpec {
  let nodes: SpecNode[] = spec.nodes.slice()
  let edges: SpecEdge[] = spec.edges.slice()
  let groups: SpecGroup[] = (spec.groups ?? []).slice()
  let meta: Pick<DiagramSpec, 'title' | 'direction' | 'theme'> = {
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    direction: spec.direction,
    ...(spec.theme !== undefined ? { theme: spec.theme } : {})
  }
  for (const op of ops) {
    switch (op.op) {
      case 'upsertNode':
        nodes = upsert(nodes, op.node)
        break
      case 'removeNode':
        nodes = nodes.filter((n) => n.id !== op.id)
        // Cascade: an edge touching a removed node would dangle (assertDiagramSpec rejects it).
        edges = edges.filter((e) => e.from !== op.id && e.to !== op.id)
        break
      case 'upsertEdge':
        edges = upsert(edges, op.edge)
        break
      case 'removeEdge':
        edges = edges.filter((e) => e.id !== op.id)
        break
      case 'upsertGroup':
        groups = upsert(groups, op.group)
        break
      case 'removeGroup':
        groups = groups.filter((g) => g.id !== op.id)
        // Cascade: clear members' ref (a dangling group ref rejects the doc); the nodes stay.
        nodes = nodes.map((n) => {
          if (n.group !== op.id) return n
          const { group: _drop, ...rest } = n
          return rest
        })
        break
      case 'setMeta':
        meta = {
          ...(op.title !== undefined
            ? { title: op.title }
            : meta.title !== undefined
              ? { title: meta.title }
              : {}),
          direction: op.direction ?? meta.direction,
          ...(op.theme !== undefined
            ? { theme: op.theme }
            : meta.theme !== undefined
              ? { theme: meta.theme }
              : {})
        }
        break
    }
  }
  return {
    version: spec.version,
    ...meta,
    nodes,
    edges,
    ...(groups.length > 0 ? { groups } : {})
  }
}
