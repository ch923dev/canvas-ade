import type { DiagramSpec, SpecEdge, SpecGroup, SpecNode } from './diagramSpec'

/**
 * Semantic DiagramSpec differ + lint (diagram Phase 3 — the confirm-gate half of MCP contract v2).
 * Turns "agent proposes this spec" into the human-readable rows the write-time confirm modal
 * renders (Option B, user-signed design 2026-07-21): `+` added / `~` changed / `−` removed, one
 * row per node/edge/group/meta change — never raw JSON. A LEAF sibling of {@link ./diagramSpec}
 * (imported by MAIN's planning gates AND unit-testable in isolation); comparison is FIELD-BY-FIELD
 * (key-order-immune), so a batch that nets to zero rows is a true no-op the gate can reject.
 *
 * `lintSpec` is the non-blocking companion: warnings for shapes agents commonly emit wrong
 * (B5 — disconnected nodes, duplicate/self-loop edges, empty groups). Lint NEVER rejects —
 * validation (`assertDiagramSpec`) rejects; lint informs the human on the confirm body.
 */

export interface SpecDiffRow {
  sig: '+' | '~' | '−'
  text: string
}

export interface SpecDiffSection {
  /** Section heading (Added / Changed / Removed — or Nodes / Edges / Groups for a full emit). */
  title: string
  rows: SpecDiffRow[]
}

export interface SpecDiff {
  sections: SpecDiffSection[]
  added: number
  changed: number
  removed: number
}

const NODE_FIELDS = ['label', 'detail', 'kind', 'status', 'icon', 'group'] as const
const EDGE_FIELDS = ['from', 'to', 'label', 'kind', 'status', 'animated'] as const
const GROUP_FIELDS = ['label', 'collapsed', 'status'] as const

/** One node's describe line — mirrors the signed mock: `node deploy "Deploy to prod" (step · neutral)`. */
export function describeNode(n: SpecNode): string {
  return `node ${n.id} "${n.label}" (${n.kind ?? 'step'} · ${n.status ?? 'neutral'})${
    n.group !== undefined ? ` · group ${n.group}` : ''
  }`
}

export function describeEdge(e: SpecEdge): string {
  const label = e.label !== undefined ? ` "${e.label}"` : ''
  return `edge ${e.id} (${e.from} → ${e.to}, ${e.kind ?? 'flow'}${e.animated ? ' · animated' : ''})${label}`
}

export function describeGroup(g: SpecGroup): string {
  return `group ${g.id} "${g.label}"${g.collapsed ? ' · collapsed' : ''}`
}

/** Render one field value for a change row (`active → done`); undefined reads as its default/none. */
function fieldVal(v: unknown): string {
  if (v === undefined) return '(none)'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** Field-by-field change row, or null when every compared field (incl. pos/href) is identical. */
function changeRow<T extends { id: string }>(
  what: 'node' | 'edge' | 'group',
  prev: T,
  next: T,
  fields: readonly (keyof T & string)[]
): SpecDiffRow | null {
  const parts: string[] = []
  for (const f of fields) {
    const a = prev[f]
    const b = next[f]
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      parts.push(`${f} ${fieldVal(a)} → ${fieldVal(b)}`)
    }
  }
  // Structured node extras (pos pin / href) — one summary token each, not a value dump.
  if (what === 'node') {
    const a = prev as unknown as SpecNode
    const b = next as unknown as SpecNode
    if (JSON.stringify(a.pos) !== JSON.stringify(b.pos)) {
      parts.push(b.pos ? 'pos pinned' : 'pos unpinned')
    }
    if (JSON.stringify(a.href) !== JSON.stringify(b.href)) {
      parts.push(b.href ? `href ${b.href.file}` : 'href removed')
    }
  }
  if (parts.length === 0) return null
  return { sig: '~', text: `${what} ${next.id} · ${parts.join(', ')}` }
}

function diffNamespace<T extends { id: string }>(
  what: 'node' | 'edge' | 'group',
  prev: readonly T[],
  next: readonly T[],
  fields: readonly (keyof T & string)[],
  describe: (item: T) => string
): { added: SpecDiffRow[]; changed: SpecDiffRow[]; removed: SpecDiffRow[] } {
  const prevById = new Map(prev.map((x) => [x.id, x]))
  const nextById = new Map(next.map((x) => [x.id, x]))
  const added: SpecDiffRow[] = []
  const changed: SpecDiffRow[] = []
  const removed: SpecDiffRow[] = []
  for (const item of next) {
    const before = prevById.get(item.id)
    if (!before) {
      added.push({ sig: '+', text: describe(item) })
    } else {
      const row = changeRow(what, before, item, fields)
      if (row) changed.push(row)
    }
  }
  for (const item of prev) {
    if (!nextById.has(item.id)) removed.push({ sig: '−', text: describe(item) })
  }
  return { added, changed, removed }
}

/**
 * Diff two specs into confirm-body sections. `prev = null` is the EMIT case (a brand-new spec):
 * everything is an addition, grouped by namespace (Nodes / Edges / Groups) so the human reviews
 * the full content — nothing hidden (ADR 0003). With a `prev`, rows group by change direction
 * (Added / Changed / Removed) and empty sections are omitted — a 1-op confirm is 1 row.
 */
export function diffSpecs(prev: DiagramSpec | null, next: DiagramSpec): SpecDiff {
  if (prev === null) {
    const sections: SpecDiffSection[] = []
    const nodeRows = next.nodes.map((n) => ({ sig: '+' as const, text: describeNode(n) }))
    const edgeRows = next.edges.map((e) => ({ sig: '+' as const, text: describeEdge(e) }))
    const groupRows = (next.groups ?? []).map((g) => ({
      sig: '+' as const,
      text: describeGroup(g)
    }))
    if (nodeRows.length > 0) sections.push({ title: 'Nodes', rows: nodeRows })
    if (edgeRows.length > 0) sections.push({ title: 'Edges', rows: edgeRows })
    if (groupRows.length > 0) sections.push({ title: 'Groups', rows: groupRows })
    return {
      sections,
      added: nodeRows.length + edgeRows.length + groupRows.length,
      changed: 0,
      removed: 0
    }
  }

  const nodes = diffNamespace('node', prev.nodes, next.nodes, NODE_FIELDS, describeNode)
  const edges = diffNamespace('edge', prev.edges, next.edges, EDGE_FIELDS, describeEdge)
  const groups = diffNamespace(
    'group',
    prev.groups ?? [],
    next.groups ?? [],
    GROUP_FIELDS,
    describeGroup
  )

  // Meta (title / direction / theme) changes read as `~` rows in the Changed section.
  const metaRows: SpecDiffRow[] = []
  for (const f of ['title', 'direction', 'theme'] as const) {
    if (prev[f] !== next[f]) {
      metaRows.push({ sig: '~', text: `diagram ${f} ${fieldVal(prev[f])} → ${fieldVal(next[f])}` })
    }
  }

  const addedRows = [...nodes.added, ...edges.added, ...groups.added]
  const changedRows = [...metaRows, ...nodes.changed, ...edges.changed, ...groups.changed]
  const removedRows = [...nodes.removed, ...edges.removed, ...groups.removed]
  const sections: SpecDiffSection[] = []
  if (addedRows.length > 0) sections.push({ title: 'Added', rows: addedRows })
  if (changedRows.length > 0) sections.push({ title: 'Changed', rows: changedRows })
  if (removedRows.length > 0) sections.push({ title: 'Removed', rows: removedRows })
  return {
    sections,
    added: addedRows.length,
    changed: changedRows.length,
    removed: removedRows.length
  }
}

/**
 * Non-blocking lint over the PROPOSED spec (B5) — plain sentences for the confirm body's warning
 * chips. Rules target the shapes agents commonly emit wrong; a warned spec still applies on
 * approve (the agent may be mid-build — e.g. connecting a node in its next batch).
 */
export function lintSpec(spec: DiagramSpec): string[] {
  const warnings: string[] = []

  // Disconnected nodes — only meaningful once the diagram HAS edges (a pure node inventory is a
  // legitimate early shape), and `note` nodes legitimately float (annotations).
  if (spec.edges.length > 0) {
    const touched = new Set<string>()
    for (const e of spec.edges) {
      touched.add(e.from)
      touched.add(e.to)
    }
    for (const n of spec.nodes) {
      if (n.kind === 'note') continue
      if (!touched.has(n.id)) {
        warnings.push(`Node "${n.label}" (${n.id}) is disconnected — no edges reach it.`)
      }
    }
  }

  // Duplicate edges (same from→to pair) — usually an id typo that appended instead of upserting.
  const pairs = new Map<string, number>()
  for (const e of spec.edges) {
    const key = `${e.from}→${e.to}`
    pairs.set(key, (pairs.get(key) ?? 0) + 1)
  }
  for (const [pair, count] of pairs) {
    if (count > 1) warnings.push(`${count} parallel edges ${pair} — duplicate connection?`)
  }

  // Self-loops — nearly always an endpoint typo in agent-emitted flow diagrams.
  for (const e of spec.edges) {
    if (e.from === e.to) warnings.push(`Edge ${e.id} loops ${e.from} onto itself.`)
  }

  // Empty groups — a group no node references renders as a bare label strip.
  const used = new Set(spec.nodes.map((n) => n.group).filter((g): g is string => g !== undefined))
  for (const g of spec.groups ?? []) {
    if (!used.has(g.id)) warnings.push(`Group "${g.label}" (${g.id}) has no member nodes.`)
  }

  return warnings
}
