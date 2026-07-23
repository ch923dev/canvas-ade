/**
 * Mermaid flowchart → DiagramSpec importer (the explicit convert action). Maps the PLAIN
 * `{direction, nodes, edges, subgraphs}` snapshot the hidden worker lifted from Mermaid's parse DB
 * (`window.__extractFlowchart` → `diagram:extractFlow`) into a valid engine-'expanse' spec. A PURE
 * leaf module (imports only ./diagramSpec) so it unit-tests without Electron and never entangles
 * the schema layer.
 *
 * Contract: throw an Error with a HUMAN message on anything unconvertible — the caller shows it
 * and leaves the mermaid element untouched. Within that, the mapping is best-effort: a malformed
 * entry is SKIPPED (a partially-imported diagram the user can fix beats an all-or-nothing refusal).
 * The final {@link assertDiagramSpec} pass is the safety net — a mapping bug surfaces as a throw
 * HERE, never as a persisted element the schema later refuses to load.
 */
import {
  assertDiagramSpec,
  SPEC_EDGE_LABEL_MAX,
  SPEC_ID_MAX,
  SPEC_LABEL_MAX,
  SPEC_MAX_EDGES,
  SPEC_MAX_GROUPS,
  SPEC_MAX_NODES,
  type DiagramSpec,
  type SpecEdge,
  type SpecGroup,
  type SpecNode,
  type SpecNodeKind
} from './diagramSpec'

// Injected-guard locals (the assertDiagramSpec contract — boardSchema owns its own copies; this
// module stays a leaf, so it brings its own).
const fail = (msg: string): never => {
  throw new Error(msg)
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Mermaid vertex-shape string → the closed node-kind vocabulary. Anything unlisted (square /
 *  stadium / rounded / undefined / future shapes) stays the default 'step' silhouette — a
 *  lossy-but-safe downgrade, never a rejection. */
const SHAPE_TO_KIND: Record<string, SpecNodeKind> = {
  diamond: 'decision',
  question: 'decision',
  cylinder: 'data',
  database: 'data',
  subroutine: 'service',
  circle: 'artifact',
  doublecircle: 'artifact'
}

/** Keep label text verbatim except C0/C1/DEL control chars (labels render as React text nodes —
 *  a stray ESC/backspace is never meaningful) and the spec's length cap. */
function cleanLabel(raw: unknown, cap: number): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- stripping control chars IS the point here
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, cap)
}

/** Slug an original Mermaid id into the spec charset (`[A-Za-z0-9._-]`, ≤ 64), deduping collisions
 *  within `used` by `_2`, `_3`, … (re-clamped so the suffix never pushes past the cap). Returns
 *  null for an id that slugs to nothing (defensive — Mermaid ids are non-empty). */
function slugFor(raw: string, used: Set<string>): string | null {
  const base = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, SPEC_ID_MAX)
  if (base.length === 0) return null
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let n = 2; ; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, SPEC_ID_MAX - suffix.length) + suffix
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/** Convert an extracted flowchart snapshot into a valid {@link DiagramSpec} (version 1, no
 *  title/theme — the host defaults own presentation). Throws a human-message Error on anything
 *  unconvertible; the returned spec always passes {@link assertDiagramSpec}. */
export function mermaidFlowToSpec(flow: unknown): DiagramSpec {
  if (!isRecord(flow)) throw new Error('flowchart extraction returned no data')
  const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : []
  const rawEdges = Array.isArray(flow.edges) ? flow.edges : []
  const rawSubs = Array.isArray(flow.subgraphs) ? flow.subgraphs : []
  // Cap check BEFORE any mapping work — a pathological diagram fails fast, and the message names
  // the reason rather than surfacing as an opaque validator error at the end.
  if (
    rawNodes.length > SPEC_MAX_NODES ||
    rawEdges.length > SPEC_MAX_EDGES ||
    rawSubs.length > SPEC_MAX_GROUPS
  ) {
    throw new Error('diagram is too large to convert')
  }

  // Original Mermaid id → slug. Edges and subgraph membership resolve through this map, so a
  // slug collision rename stays consistent everywhere the original id was referenced.
  const idMap = new Map<string, string>()
  const usedNodeIds = new Set<string>()
  const nodes: SpecNode[] = []
  for (const raw of rawNodes) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) continue
    if (idMap.has(raw.id)) continue // a re-listed vertex id maps once (first wins)
    const slug = slugFor(raw.id, usedNodeIds)
    if (slug === null) continue
    idMap.set(raw.id, slug)
    const label = cleanLabel(raw.label, SPEC_LABEL_MAX)
    const kind = typeof raw.shape === 'string' ? SHAPE_TO_KIND[raw.shape] : undefined
    const node: SpecNode = { id: slug, label: label.length ? label : slug }
    if (kind !== undefined) node.kind = kind // absent ⇒ 'step' (the spec default)
    nodes.push(node)
  }

  const edges: SpecEdge[] = []
  for (const raw of rawEdges) {
    if (!isRecord(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string') continue
    const from = idMap.get(raw.from)
    const to = idMap.get(raw.to)
    // An endpoint that never made it into the node map (malformed/skipped vertex): drop the edge —
    // emitting a dangling ref would fail the WHOLE conversion at the final validation.
    if (from === undefined || to === undefined) continue
    const edge: SpecEdge = { id: `e${edges.length + 1}`, from, to }
    if (raw.stroke === 'dotted') edge.kind = 'dependency' // absent ⇒ 'flow' (thick/normal alike)
    const label = cleanLabel(raw.label, SPEC_EDGE_LABEL_MAX)
    if (label.length) edge.label = label
    edges.push(edge)
  }

  const usedGroupIds = new Set<string>()
  const groups: SpecGroup[] = []
  const grouped = new Set<string>() // node slugs already claimed — the FIRST subgraph wins
  for (const raw of rawSubs) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) continue
    const slug = slugFor(raw.id, usedGroupIds)
    if (slug === null) continue
    const title = cleanLabel(raw.title, SPEC_LABEL_MAX)
    groups.push({ id: slug, label: title.length ? title : slug })
    if (!Array.isArray(raw.nodes)) continue
    for (const member of raw.nodes) {
      // Membership resolves through the NODE map only: an unknown member id — including a NESTED
      // subgraph id listed as a member of its parent — is ignored (flat groups only).
      const memberSlug = typeof member === 'string' ? idMap.get(member) : undefined
      if (memberSlug === undefined || grouped.has(memberSlug)) continue
      grouped.add(memberSlug)
      const node = nodes.find((n) => n.id === memberSlug)
      if (node) node.group = slug
    }
  }

  const direction = flow.direction === 'LR' || flow.direction === 'RL' ? 'right' : 'down'
  const spec: DiagramSpec = { version: 1, direction, nodes, edges }
  if (groups.length) spec.groups = groups
  // Final gate: the exact validator the schema runs on load. A mapping bug throws HERE — the
  // caller leaves the element untouched — instead of persisting an element the app can't reopen.
  assertDiagramSpec(spec, fail, isRecord, isFiniteNum)
  return spec
}
