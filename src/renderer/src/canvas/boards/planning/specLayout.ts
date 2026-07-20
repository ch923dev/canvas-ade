/**
 * DiagramSpec layout (Phase 1) — pure, deterministic helpers around the ELK layered engine:
 * size estimation (spec → node boxes), the spec → ELK-graph mapping, and the ELK-result → flat
 * positioned-layout mapping the static renderer consumes. The ASYNC part (the elkjs Web Worker)
 * lives in `specElk.ts`; everything here is synchronous and unit-tested, mirroring the
 * `graphLayout.ts` discipline (estimate heights, position boxes, bezier the facing edges).
 */
import type { DiagramSpec, SpecNode } from '../../../lib/diagramSpec'
import { specKindSilhouette } from './specTheme'

/** Node box widths per silhouette (the approved mock's proportions). */
const NODE_W = 168
const ACTOR_W = 120
const NOTE_W = 200
/** Single-line node height: 7+16+7 padding+header + 2px border (the mock's box). */
const NODE_H = 32
/** The secondary mono `detail` line adds one 14px row + 3px gap. */
const DETAIL_H = 17
/** Group padding: label clearance on top, breathing room around children. */
export const GROUP_PAD = { top: 22, side: 14, bottom: 14 }

export interface SpecNodeBox {
  w: number
  h: number
}

/** Estimated rendered box of a node (deterministic — no DOM measurement). */
export function specNodeBox(node: Pick<SpecNode, 'kind' | 'detail'>): SpecNodeBox {
  const sil = specKindSilhouette(node.kind)
  const w = sil === 'actor' ? ACTOR_W : sil === 'note' ? NOTE_W : NODE_W
  const h = NODE_H + (node.detail ? DETAIL_H : 0)
  return { w, h }
}

export interface PositionedSpecNode {
  id: string
  x: number
  y: number
  w: number
  h: number
}
export interface PositionedSpecGroup {
  id: string
  x: number
  y: number
  w: number
  h: number
}
export interface SpecLayoutResult {
  nodes: PositionedSpecNode[]
  byId: Map<string, PositionedSpecNode>
  groups: PositionedSpecGroup[]
  /** Total content extent (board-local px) — the renderer fits this into the card. */
  width: number
  height: number
}

/** The subset of the ELK JSON graph shape we emit/consume (elkjs types stay out of the pure
 *  module so tests never load the 1.4 MB engine). */
export interface ElkGraphIn {
  id: string
  layoutOptions: Record<string, string>
  children: ElkNodeIn[]
  edges: { id: string; sources: string[]; targets: string[] }[]
}
export interface ElkNodeIn {
  id: string
  width?: number
  height?: number
  layoutOptions?: Record<string, string>
  children?: ElkNodeIn[]
}
export interface ElkNodeOut {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  children?: ElkNodeOut[]
}

/**
 * spec → ELK layered graph. Groups become compound nodes (their members as children — ELK's
 * native cluster handling, the reason it was chosen over dagre). Edge routes are NOT consumed:
 * the renderer draws its own facing-edge beziers from the final boxes (the DataFlowGraphView
 * pattern), so only node/group coordinates matter downstream.
 */
export function specToElkGraph(spec: DiagramSpec): ElkGraphIn {
  const groups = spec.groups ?? []
  const grouped = new Map<string, ElkNodeIn[]>(groups.map((g) => [g.id, []]))
  const roots: ElkNodeIn[] = []
  for (const n of spec.nodes) {
    const box = specNodeBox(n)
    const el: ElkNodeIn = { id: `n:${n.id}`, width: box.w, height: box.h }
    const bucket = n.group !== undefined ? grouped.get(n.group) : undefined
    if (bucket) bucket.push(el)
    else roots.push(el)
  }
  for (const g of groups) {
    roots.push({
      id: `g:${g.id}`,
      children: grouped.get(g.id),
      layoutOptions: {
        'elk.padding': `[top=${GROUP_PAD.top},left=${GROUP_PAD.side},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.side}]`
      }
    })
  }
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': spec.direction === 'down' ? 'DOWN' : 'RIGHT',
      // Without this, an edge that crosses a group boundary (grouped node → root node) is IGNORED
      // for layering — the target lands in layer 0 and the edge sweeps backwards across the graph.
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      // Calm-density spacing: enough air to read, no poster-spread (design contract).
      'elk.spacing.nodeNode': '24',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.edgeNode': '16',
      'elk.padding': '[top=16,left=16,bottom=16,right=16]'
    },
    children: roots,
    edges: spec.edges.map((e) => ({
      id: `e:${e.id}`,
      sources: [`n:${e.from}`],
      targets: [`n:${e.to}`]
    }))
  }
}

/**
 * ELK result → flat positioned layout. Child coordinates are relative to their compound parent —
 * flattened to absolute here. User-pinned `pos` overrides the engine for that node AFTER layout
 * (auto-layout owns everything else; the pin simply wins — Phase-4 drag persists through this).
 */
export function elkResultToLayout(spec: DiagramSpec, root: ElkNodeOut): SpecLayoutResult {
  const nodes: PositionedSpecNode[] = []
  const groups: PositionedSpecGroup[] = []
  const byId = new Map<string, PositionedSpecNode>()
  const pinned = new Map(spec.nodes.filter((n) => n.pos).map((n) => [n.id, n.pos!]))

  const walk = (el: ElkNodeOut, ox: number, oy: number): void => {
    for (const c of el.children ?? []) {
      const x = ox + (c.x ?? 0)
      const y = oy + (c.y ?? 0)
      if (c.id.startsWith('g:')) {
        groups.push({ id: c.id.slice(2), x, y, w: c.width ?? 0, h: c.height ?? 0 })
        walk(c, x, y)
      } else if (c.id.startsWith('n:')) {
        const id = c.id.slice(2)
        const pin = pinned.get(id)
        const placed: PositionedSpecNode = {
          id,
          x: pin ? pin.x : x,
          y: pin ? pin.y : y,
          w: c.width ?? NODE_W,
          h: c.height ?? NODE_H
        }
        nodes.push(placed)
        byId.set(id, placed)
      }
    }
  }
  walk(root, 0, 0)

  let width = 0
  let height = 0
  for (const b of [...nodes, ...groups]) {
    width = Math.max(width, b.x + b.w)
    height = Math.max(height, b.y + b.h)
  }
  return { nodes, byId, groups, width: width + 16, height: height + 16 }
}

/**
 * Edge-label anchor: the midpoint of the SAME facing anchors `specEdgePath` uses, so the label
 * sits on the curve for both directions even when the two boxes differ in size.
 */
export function specEdgeLabelPoint(
  from: PositionedSpecNode,
  to: PositionedSpecNode,
  direction: DiagramSpec['direction']
): { x: number; y: number } {
  if (direction === 'down') {
    return {
      x: (from.x + from.w / 2 + to.x + to.w / 2) / 2,
      y: (from.y + from.h + to.y) / 2
    }
  }
  return {
    x: (from.x + from.w + to.x) / 2,
    y: (from.y + from.h / 2 + to.y + to.h / 2) / 2
  }
}

/**
 * Facing-edge bezier between two placed boxes (the `graphLayout.edgePath` recipe, axis-aware):
 * direction 'right' anchors right-mid → left-mid; 'down' anchors bottom-mid → top-mid.
 */
export function specEdgePath(
  from: PositionedSpecNode,
  to: PositionedSpecNode,
  direction: DiagramSpec['direction']
): string {
  if (direction === 'down') {
    const sx = from.x + from.w / 2
    const sy = from.y + from.h
    const tx = to.x + to.w / 2
    const ty = to.y
    const dy = Math.max(18, Math.abs(ty - sy) * 0.5)
    return `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`
  }
  const sx = from.x + from.w
  const sy = from.y + from.h / 2
  const tx = to.x
  const ty = to.y + to.h / 2
  const dx = Math.max(24, Math.abs(tx - sx) * 0.5)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}

/** What a focus click landed on — nodes win over their group (paint order), null = empty canvas. */
export type SpecHit = { kind: 'node' | 'group'; id: string } | null

/**
 * Viewport-point → layout-element hit-test (M3 focus / M4 collapse-toggle clicks). The renderer is
 * pointer-inert, so DiagramCard resolves clicks itself by inverting the render transform chain:
 * card pan/zoom (translate+scale about the viewport centre) then the fit-scale (contain, about the
 * content centre — flex centring puts the content centre AT the viewport centre, so both invert
 * against the same point). `point` is viewport-local board px (client px ÷ the camera screen scale).
 */
export function specHitTest(
  point: { x: number; y: number },
  view: { w: number; h: number },
  pan: { x: number; y: number },
  zoom: number,
  layout: SpecLayoutResult
): SpecHit {
  if (view.w <= 0 || view.h <= 0 || layout.width <= 0 || layout.height <= 0) return null
  const fit = Math.min(view.w / layout.width, view.h / layout.height)
  const s = zoom * fit
  if (!(s > 0)) return null
  const lx = layout.width / 2 + (point.x - view.w / 2 - pan.x) / s
  const ly = layout.height / 2 + (point.y - view.h / 2 - pan.y) / s
  // Topmost first: nodes paint above groups; later siblings paint above earlier ones.
  for (let i = layout.nodes.length - 1; i >= 0; i--) {
    const n = layout.nodes[i]
    if (lx >= n.x && lx <= n.x + n.w && ly >= n.y && ly <= n.y + n.h) {
      return { kind: 'node', id: n.id }
    }
  }
  for (let i = layout.groups.length - 1; i >= 0; i--) {
    const g = layout.groups[i]
    if (lx >= g.x && lx <= g.x + g.w && ly >= g.y && ly <= g.y + g.h) {
      return { kind: 'group', id: g.id }
    }
  }
  return null
}
