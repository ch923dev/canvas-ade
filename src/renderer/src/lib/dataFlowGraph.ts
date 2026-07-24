/**
 * Data-Flow graph model (JD-4) — pure: turn the JD-3 inventory/entity model + the JD-4 lineage edges
 * into a navigable node/edge graph for the Data-Flow board, plus the focus-subgraph + idempotent-diff
 * helpers. No React, no layout math (the spec renderer's ELK engine owns placement since Phase 5,
 * via `dfSpecAdapter.ts`), no values — entity fields carry only
 * names + a type LABEL (the inferred model is already value-less, ADR 0010).
 *
 * **Never fabricates edges:** entity→entity edges come ONLY from `model.relationships` (name+type
 * inferred) and id-lineage edges only from the lineage pass — a flat API (no relationships, no shared
 * ids) yields page→endpoint→shape islands and nothing else (the graceful-degradation contract, mock-e).
 */
import type { TemplateGroup } from './routeTemplate'
import type { EntityModel, Entity } from './entityInfer'
import type { InferredField } from './schemaInfer'
import type { LineageEdge } from './lineage'

export type DfNodeKind = 'page' | 'endpoint' | 'entity' | 'shape'
export type DfEdgeKind = 'call' | 'returns' | 'rel' | 'lineage'

export interface DfField {
  key: string
  type: string // a compact type LABEL (e.g. 'uuid', 'string|null', '{ }', 'list') — never a value
  idLike?: boolean // PK / FK / id-typed → renders in the id accent
}
export interface DfNode {
  id: string
  kind: DfNodeKind
  label: string
  method?: string // endpoints
  sub?: string // "63 calls · 34ms" / origin
  fields?: DfField[] // entity/shape members (capped)
  moreFields?: number // count elided past the cap
}
export interface DfEdge {
  id: string
  from: string
  to: string
  kind: DfEdgeKind
  label?: string
}
export interface DfGraph {
  nodes: DfNode[]
  edges: DfEdge[]
}

const FIELD_CAP = 6 // members shown per entity node (keeps a node legible; rest elided)

function singular(s: string): string {
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y'
  if (/s$/i.test(s) && s.length > 1) return s.slice(0, -1)
  return s
}
function pascalSingular(s: string): string {
  const w = singular(s)
  return w ? w[0].toUpperCase() + w.slice(1) : w
}

/** A compact, value-less type label for a field (mirrors DataFlowView's inventory typeLabel). */
function fieldType(f: InferredField): string {
  if (f.children) return '{ }'
  if (f.elem) return f.elem.children ? '[ ]' : `${f.elem.types.join('|') || 'unknown'}[]`
  const base = f.types.join('|') || 'unknown'
  return f.format ? `${base}·${f.format}` : base
}
function isIdField(f: InferredField): boolean {
  return f.format === 'uuid' || /^_?id$/i.test(f.key) || /Id$/.test(f.key) || /_id$/.test(f.key)
}

function entityNode(e: Entity): DfNode {
  const fkKeys = new Set(e.fkFields.map((fk) => fk.via))
  const all: DfField[] = e.fields.map((f) => ({
    key: f.key,
    type: fieldType(f),
    idLike: f.key === e.pk || fkKeys.has(f.key) || isIdField(f)
  }))
  return {
    id: `ent:${e.name}`,
    kind: e.kind === 'entity' ? 'entity' : 'shape',
    label: e.name,
    sub: `${e.fieldKeys.length} field${e.fieldKeys.length === 1 ? '' : 's'}`,
    fields: all.slice(0, FIELD_CAP),
    moreFields: Math.max(0, all.length - FIELD_CAP)
  }
}

/**
 * Build the Data-Flow graph from the inventory groups, the entity model, and the lineage edges.
 * page (per origin) → endpoint (per template) → entity/shape (per inferred entity); entity→entity
 * edges from `model.relationships`; dashed id-lineage edges endpoint→endpoint.
 */
export function buildGraph(
  groups: TemplateGroup[],
  model: EntityModel,
  lineage: LineageEdge[]
): DfGraph {
  const nodes: DfNode[] = []
  const edges: DfEdge[] = []
  const endpointIds = new Set(groups.map((g) => g.key))

  // page nodes — one per distinct origin (the document/navigation host)
  const origins = [...new Set(groups.map((g) => g.tpl.origin).filter(Boolean))]
  const pageId = (origin: string): string => `page:${origin}`
  for (const origin of origins) {
    let host = origin
    try {
      host = new URL(origin).host
    } catch {
      /* keep raw origin */
    }
    // host is the node's IDENTIFIER → it is the primary `label` (renders in the AA-contrast text token);
    // a "PAGE" tag is drawn by the view. (Was: label 'PAGE' + host as faint meta — an a11y miss.)
    nodes.push({ id: pageId(origin), kind: 'page', label: host })
  }

  // endpoint nodes (header-only in the graph; entities carry the fields) + page→endpoint call edges
  for (const g of groups) {
    nodes.push({
      id: g.key,
      kind: 'endpoint',
      label: g.tpl.template,
      method: g.tpl.method,
      sub:
        `${g.calls} call${g.calls === 1 ? '' : 's'}` +
        (g.p50Ms !== undefined ? ` · ${g.p50Ms}ms` : '')
    })
    if (g.tpl.origin) {
      edges.push({ id: `call:${g.key}`, from: pageId(g.tpl.origin), to: g.key, kind: 'call' })
    }
  }

  // entity / shape nodes + endpoint→entity "returns" edges
  for (const e of model.entities) {
    nodes.push(entityNode(e))
    // Dedupe: an endpoint can both produce AND consume an entity (e.g. PUT /users/{id}), so the same
    // key would emit two identical `ret:${key}:${e.name}` edges — React Flow drops the duplicate id.
    for (const key of new Set([...e.producedBy, ...e.consumedBy])) {
      if (endpointIds.has(key)) {
        edges.push({ id: `ret:${key}:${e.name}`, from: key, to: `ent:${e.name}`, kind: 'returns' })
      }
    }
  }

  // entity→entity relationship edges (ONLY from the inferred model — never fabricated)
  for (const r of model.relationships) {
    edges.push({
      id: `rel:${r.from}:${r.to}:${r.via}`,
      from: `ent:${r.from}`,
      to: `ent:${r.to}`,
      kind: 'rel',
      label: r.via
    })
  }

  // id-lineage edges endpoint→endpoint (dashed; from/to are template keys = endpoint node ids)
  for (const l of lineage) {
    if (endpointIds.has(l.fromKey) && endpointIds.has(l.toKey)) {
      edges.push({
        id: `lin:${l.fromKey}:${l.toKey}:${l.idName}`,
        from: l.fromKey,
        to: l.toKey,
        kind: 'lineage',
        label: l.idName
      })
    }
  }

  return { nodes, edges }
}

/**
 * The focus subgraph: the focused node + its direct neighbors (1 hop, both directions). Returns the
 * set of node ids to render BRIGHT — the board dims the rest (never hides them; the "never draw the
 * whole surface" rule via emphasis, not removal). An unknown / empty focus ⇒ every node bright.
 */
export function focusSubgraph(graph: DfGraph, focusId: string | undefined, depth = 1): Set<string> {
  const all = new Set(graph.nodes.map((n) => n.id))
  if (!focusId || !all.has(focusId)) return all
  const adj = new Map<string, Set<string>>()
  for (const n of graph.nodes) adj.set(n.id, new Set())
  for (const e of graph.edges) {
    adj.get(e.from)?.add(e.to)
    adj.get(e.to)?.add(e.from)
  }
  const bright = new Set<string>([focusId])
  let frontier = [focusId]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!bright.has(nb)) {
          bright.add(nb)
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  return bright
}

/** A node's diff signature — id + its field shape — so a re-run flags structural changes, not noise. */
function nodeSig(n: DfNode): string {
  const fields = (n.fields ?? []).map((f) => `${f.key}:${f.type}`).join(',')
  return `${n.kind}|${n.method ?? ''}|${fields}|${n.moreFields ?? 0}`
}

export interface GraphDiff {
  added: Set<string> // node ids new since the baseline
  removed: Set<string> // node ids gone since the baseline
  changed: Set<string> // node ids whose field shape changed
}

/** Idempotent-regenerate diff: what changed between a baseline graph and a freshly-built one. */
export function diffGraphs(prev: DfGraph | undefined, next: DfGraph): GraphDiff {
  const added = new Set<string>()
  const removed = new Set<string>()
  const changed = new Set<string>()
  if (!prev) return { added, removed, changed }
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextById = new Map(next.nodes.map((n) => [n.id, n]))
  for (const n of next.nodes) {
    const before = prevById.get(n.id)
    if (!before) added.add(n.id)
    else if (nodeSig(before) !== nodeSig(n)) changed.add(n.id)
  }
  for (const n of prev.nodes) if (!nextById.has(n.id)) removed.add(n.id)
  return { added, removed, changed }
}

export { pascalSingular }
