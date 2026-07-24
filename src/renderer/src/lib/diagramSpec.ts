/**
 * DiagramSpec (v21, diagram-viz Phase 1) — the structured diagram model behind
 * `DiagramElement.engine:'expanse'`. The spec is CANONICAL for an expanse diagram (the way `source`
 * is for Mermaid): typed nodes/edges/groups with a CLOSED status/kind vocabulary, so agents write
 * MEANING (`status:'done'`) and the host owns every colour/shape (specTheme.ts). All strings render
 * as React text nodes only — the structured spec is the security upgrade over raw markup (REVIEW §2).
 *
 * Lives beside kanbanSchema.ts under the same split doctrine: a LEAF module (no runtime import back
 * into boardSchema.ts — the `fail`/guard primitives arrive injected), types re-exported through
 * `./boardSchema` for consumers. Caps are exported so the Phase-3 MCP MAIN validation reuses the
 * same numbers (one source of truth for the 16 KB confirm-reviewability premise).
 */

/** Structural caps (REVIEW §3.1/§3.3). Enforced in {@link assertDiagramSpec}. */
export const SPEC_MAX_NODES = 200
export const SPEC_MAX_EDGES = 400
export const SPEC_MAX_GROUPS = 50
export const SPEC_ID_MAX = 64
export const SPEC_LABEL_MAX = 200
export const SPEC_DETAIL_MAX = 300
export const SPEC_EDGE_LABEL_MAX = 120
export const SPEC_TITLE_MAX = 200
export const SPEC_ICON_MAX = 64
export const SPEC_HREF_FILE_MAX = 256
export const SPEC_THEME_MAX = 64
export const SPEC_MAX_ROWS = 12
export const SPEC_ROW_TEXT_MAX = 80

/** Closed status vocabulary → colour+glyph via specTheme.ts. Mirrors DIAGRAM_STATUS_CLASSES
 *  (the Phase-0 Mermaid `:::done` set) plus the explicit 'neutral' default. */
export const SPEC_STATUSES = ['neutral', 'active', 'done', 'error', 'warn', 'muted'] as const
export type SpecStatus = (typeof SPEC_STATUSES)[number]

/** Closed node-kind vocabulary → icon + silhouette via specTheme.ts. */
export const SPEC_NODE_KINDS = [
  'step',
  'decision',
  'data',
  'service',
  'artifact',
  'actor',
  'note'
] as const
export type SpecNodeKind = (typeof SPEC_NODE_KINDS)[number]

/** Closed edge-kind vocabulary → line style (flow solid · data dotted · dependency dashed). */
export const SPEC_EDGE_KINDS = ['flow', 'data', 'dependency'] as const
export type SpecEdgeKind = (typeof SPEC_EDGE_KINDS)[number]

/** One member row of a rowed node (Phase 5 — the Data-Flow entity-field surface): a left/right
 *  mono pair (`key` / `type label`), `accent` inking the right cell in the id accent. */
export interface SpecNodeRow {
  /** Left cell, ≤ 80 ch. Rendered as a text node. */
  left: string
  /** Right cell (right-aligned), ≤ 80 ch. */
  right?: string
  /** Right cell renders in the accent ink (id-like member). */
  accent?: boolean
}

export interface SpecNode {
  /** Slug (`[A-Za-z0-9._-]`, ≤ 64) — THE incremental-update key (Phase-3 specOps upsert by id). */
  id: string
  /** Primary label, ≤ 200 ch. Rendered as a text node. */
  label: string
  /** Secondary mono line, ≤ 300 ch. Absent ⇒ single-line node. */
  detail?: string
  /** Member rows under the header (≤ 12) — the entity/record surface (Phase 5, Data-Flow unify). */
  rows?: SpecNodeRow[]
  /** Shape/icon selector. Absent ⇒ 'step'. */
  kind?: SpecNodeKind
  /** Colour+glyph selector. Absent ⇒ 'neutral'. */
  status?: SpecStatus
  /** Name into the HOST icon registry (Icon.tsx); unknown ⇒ no icon (registry discipline, ADR 0006). */
  icon?: string
  /** Owning {@link SpecGroup} id. A dangling ref is REJECTED (unlike kanban's drop-on-read: a spec
   *  arrives atomically from one author, so a dangling ref is an authoring bug worth surfacing). */
  group?: string
  /** User-pinned position (board-local px). Absent ⇒ auto-layout owns it. */
  pos?: { x: number; y: number }
  /** Click-to-open file pointer (host-gated; rendering ignores it in Phase 1 — persisted for later). */
  href?: { file: string; line?: number }
}

export interface SpecEdge {
  /** Slug id, unique within edges (same charset as node ids). */
  id: string
  /** Source node id. Dangling ⇒ rejected. */
  from: string
  /** Target node id. Dangling ⇒ rejected. */
  to: string
  /** Edge label, ≤ 120 ch. */
  label?: string
  /** Line style. Absent ⇒ 'flow'. */
  kind?: SpecEdgeKind
  /** Colour selector (edge stroke). Absent ⇒ neutral ink. */
  status?: SpecStatus
  /** Marching-dash flow animation (accent). Honours reduced-motion at render. */
  animated?: boolean
}

export interface SpecGroup {
  /** Slug id, unique within groups. */
  id: string
  /** Cluster label, ≤ 200 ch. */
  label: string
  /** Collapsed clusters render as a single chip (Phase 2 interaction; persisted from day one). */
  collapsed?: boolean
  /** Colour selector for the cluster chrome. */
  status?: SpecStatus
}

/** The canonical structured diagram model (engine 'expanse'). `version` is the SPEC's own literal
 *  version (independent of the document SCHEMA_VERSION — a future spec v2 migrates inside the
 *  element, not the whole doc). */
export interface DiagramSpec {
  version: 1
  title?: string
  /** Layout main axis (ELK direction RIGHT / DOWN). */
  direction: 'right' | 'down'
  /** Theme preset name (specTheme.SPEC_THEME_PRESETS), ≤ 64 ch. Deliberately an OPEN string —
   *  unlike status/kind, a theme is presentation-only: an unknown name renders as the default
   *  (`calm`) with nothing lost, and the value round-trips for a newer app that knows it. */
  theme?: string
  nodes: SpecNode[]
  edges: SpecEdge[]
  groups?: SpecGroup[]
}

/** Cap on `DiagramElement.revisions` (v22, B4) — oldest entries roll off past this. */
export const DIAGRAM_REVISION_CAP = 20

/** One prior spec of an expanse diagram (v22, B4): the snapshot that was REPLACED, when, by whom
 *  ('user' is reserved for the Phase-4 editor — every live capture today is agent-authored). */
export interface DiagramRevision {
  spec: DiagramSpec
  /** Capture time (ms epoch). */
  ts: number
  author: 'agent' | 'user'
}

/** Deep-validate a `DiagramElement.revisions` list (v22) — same injected-guard contract as
 *  {@link assertDiagramSpec}; every entry's spec validates exactly like the live one. */
export function assertDiagramRevisions(
  revisions: unknown,
  fail: (msg: string) => never,
  isRecord: (v: unknown) => v is Record<string, unknown>,
  isFiniteNum: (v: unknown) => v is number
): void {
  if (!Array.isArray(revisions)) fail('diagram element revisions is not an array')
  if (revisions.length > DIAGRAM_REVISION_CAP) fail('diagram element exceeds the revision cap')
  for (const r of revisions as unknown[]) {
    if (!isRecord(r)) fail('diagram revision is not an object')
    assertDiagramSpec(r.spec, fail, isRecord, isFiniteNum)
    if (!isFiniteNum(r.ts)) fail('diagram revision ts is not a finite number')
    if (r.author !== 'agent' && r.author !== 'user') {
      fail('diagram revision author is not "agent" or "user"')
    }
  }
}

/** Slug charset for every spec id — stable, diffable, safe to interpolate into DOM ids/keys. */
const ID_RE = /^[A-Za-z0-9._-]+$/

function isOneOf<T extends string>(v: unknown, set: readonly T[]): v is T {
  return typeof v === 'string' && (set as readonly string[]).includes(v)
}

/**
 * Deep-validate a DiagramSpec (shape + caps + closed enums + referential integrity); throws via the
 * injected `fail` on any mismatch. Same injected-guard contract as `assertKanbanContent` /
 * `assertTerminalContent` so `boardSchema.ts` calls it without a runtime cycle. Validation summary:
 * ids are capped slugs, unique per namespace (nodes / edges / groups); edge endpoints and node
 * `group` refs must resolve (dangling ⇒ fail); enums are closed (an unknown status/kind fails the
 * doc — the floor-bump contract: a NEWER vocabulary is a NEWER schema, not a silent coerce).
 */
export function assertDiagramSpec(
  spec: unknown,
  fail: (msg: string) => never,
  isRecord: (v: unknown) => v is Record<string, unknown>,
  isFiniteNum: (v: unknown) => v is number
): void {
  if (!isRecord(spec)) fail('diagram spec is not an object')
  if (spec.version !== 1) fail(`diagram spec has unsupported version ${String(spec.version)}`)
  if (spec.title !== undefined) {
    if (typeof spec.title !== 'string' || spec.title.length > SPEC_TITLE_MAX) {
      fail('diagram spec title is not a string within the cap')
    }
  }
  if (spec.direction !== 'right' && spec.direction !== 'down') {
    fail('diagram spec direction is not "right" or "down"')
  }
  if (
    spec.theme !== undefined &&
    (typeof spec.theme !== 'string' ||
      spec.theme.length === 0 ||
      spec.theme.length > SPEC_THEME_MAX)
  ) {
    fail('diagram spec theme is not a non-empty string within the cap')
  }

  const id = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > SPEC_ID_MAX || !ID_RE.test(v)) {
      fail(`diagram spec ${what} id is not a slug within the cap`)
    }
    return v
  }
  const optCapped = (v: unknown, cap: number, what: string): void => {
    if (v !== undefined && (typeof v !== 'string' || v.length > cap)) {
      fail(`diagram spec ${what} is not a string within the cap`)
    }
  }
  const optStatus = (v: unknown, what: string): void => {
    if (v !== undefined && !isOneOf(v, SPEC_STATUSES)) {
      fail(`diagram spec ${what} status is not in the closed vocabulary`)
    }
  }

  // groups first — node.group refs resolve against them
  const groupIds = new Set<string>()
  if (spec.groups !== undefined) {
    if (!Array.isArray(spec.groups)) fail('diagram spec groups is not an array')
    if (spec.groups.length > SPEC_MAX_GROUPS) fail('diagram spec exceeds the group cap')
    for (const g of spec.groups as unknown[]) {
      if (!isRecord(g)) fail('diagram spec group is not an object')
      const gid = id(g.id, 'group')
      if (groupIds.has(gid)) fail(`diagram spec has a duplicate group id "${gid}"`)
      groupIds.add(gid)
      if (typeof g.label !== 'string' || g.label.length === 0 || g.label.length > SPEC_LABEL_MAX) {
        fail('diagram spec group label is not a non-empty string within the cap')
      }
      if (g.collapsed !== undefined && typeof g.collapsed !== 'boolean') {
        fail('diagram spec group collapsed is not a boolean')
      }
      optStatus(g.status, 'group')
    }
  }

  if (!Array.isArray(spec.nodes)) fail('diagram spec nodes is not an array')
  if (spec.nodes.length > SPEC_MAX_NODES) fail('diagram spec exceeds the node cap')
  const nodeIds = new Set<string>()
  for (const n of spec.nodes as unknown[]) {
    if (!isRecord(n)) fail('diagram spec node is not an object')
    const nid = id(n.id, 'node')
    if (nodeIds.has(nid)) fail(`diagram spec has a duplicate node id "${nid}"`)
    nodeIds.add(nid)
    if (typeof n.label !== 'string' || n.label.length === 0 || n.label.length > SPEC_LABEL_MAX) {
      fail('diagram spec node label is not a non-empty string within the cap')
    }
    optCapped(n.detail, SPEC_DETAIL_MAX, 'node detail')
    if (n.rows !== undefined) {
      if (!Array.isArray(n.rows)) fail('diagram spec node rows is not an array')
      if (n.rows.length > SPEC_MAX_ROWS) fail('diagram spec node exceeds the row cap')
      for (const r of n.rows as unknown[]) {
        if (!isRecord(r)) fail('diagram spec node row is not an object')
        if (
          typeof r.left !== 'string' ||
          r.left.length === 0 ||
          r.left.length > SPEC_ROW_TEXT_MAX
        ) {
          fail('diagram spec node row left is not a non-empty string within the cap')
        }
        optCapped(r.right, SPEC_ROW_TEXT_MAX, 'node row right')
        if (r.accent !== undefined && typeof r.accent !== 'boolean') {
          fail('diagram spec node row accent is not a boolean')
        }
      }
    }
    if (n.kind !== undefined && !isOneOf(n.kind, SPEC_NODE_KINDS)) {
      fail('diagram spec node kind is not in the closed vocabulary')
    }
    optStatus(n.status, 'node')
    optCapped(n.icon, SPEC_ICON_MAX, 'node icon')
    if (n.group !== undefined) {
      const gref = id(n.group, 'node group ref')
      if (!groupIds.has(gref)) fail(`diagram spec node "${nid}" references unknown group "${gref}"`)
    }
    if (n.pos !== undefined) {
      if (!isRecord(n.pos) || !isFiniteNum(n.pos.x) || !isFiniteNum(n.pos.y)) {
        fail('diagram spec node pos is not {x, y} finite numbers')
      }
    }
    if (n.href !== undefined) {
      if (!isRecord(n.href)) fail('diagram spec node href is not an object')
      if (
        typeof n.href.file !== 'string' ||
        n.href.file.length === 0 ||
        n.href.file.length > SPEC_HREF_FILE_MAX
      ) {
        fail('diagram spec node href file is not a non-empty string within the cap')
      }
      if (
        n.href.line !== undefined &&
        (!isFiniteNum(n.href.line) || n.href.line <= 0 || !Number.isInteger(n.href.line))
      ) {
        fail('diagram spec node href line is not a positive integer')
      }
    }
  }

  if (!Array.isArray(spec.edges)) fail('diagram spec edges is not an array')
  if (spec.edges.length > SPEC_MAX_EDGES) fail('diagram spec exceeds the edge cap')
  const edgeIds = new Set<string>()
  for (const e of spec.edges as unknown[]) {
    if (!isRecord(e)) fail('diagram spec edge is not an object')
    const eid = id(e.id, 'edge')
    if (edgeIds.has(eid)) fail(`diagram spec has a duplicate edge id "${eid}"`)
    edgeIds.add(eid)
    for (const end of ['from', 'to'] as const) {
      const ref = id(e[end], `edge ${end}`)
      if (!nodeIds.has(ref))
        fail(`diagram spec edge "${eid}" ${end} references unknown node "${ref}"`)
    }
    optCapped(e.label, SPEC_EDGE_LABEL_MAX, 'edge label')
    if (e.kind !== undefined && !isOneOf(e.kind, SPEC_EDGE_KINDS)) {
      fail('diagram spec edge kind is not in the closed vocabulary')
    }
    optStatus(e.status, 'edge')
    if (e.animated !== undefined && typeof e.animated !== 'boolean') {
      fail('diagram spec edge animated is not a boolean')
    }
  }
}
