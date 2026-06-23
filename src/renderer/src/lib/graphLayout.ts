/**
 * Layered graph layout (JD-4) — a small, vendored layered placement for the Data-Flow board, in the
 * "vendored, no heavy deps" doctrine (perfect-freehand / Mermaid / the custom virtualizer precedent;
 * dagre was scoped but is overkill for a focused subgraph that lays out as page→endpoint→entity
 * columns — the mock-b/c visual contract). Pure + deterministic + unit-tested.
 *
 * Columns by node kind: page (0) → endpoint (1) → entity/shape (2). Within a column, nodes stack
 * top-to-bottom by build order, spaced by each node's estimated height (header + capped field rows).
 */
import type { DfGraph, DfNode, DfNodeKind } from './dataFlowGraph'

export interface PositionedNode extends DfNode {
  x: number
  y: number
  w: number
  h: number
}
export interface GraphLayout {
  nodes: PositionedNode[]
  byId: Map<string, PositionedNode>
  width: number
  height: number
}

const COL_X: Record<'page' | 'endpoint' | 'entity', number> = {
  page: 16,
  endpoint: 250,
  entity: 560
}
const NODE_W: Record<DfNodeKind, number> = { page: 150, endpoint: 188, entity: 170, shape: 170 }
const HEADER_H = 24
const FIELD_H = 15
const PAD_V = 8
const ROW_GAP = 18
const TOP = 16

type Col = 'page' | 'endpoint' | 'entity'
function colOf(kind: DfNodeKind): Col {
  return kind === 'page' ? 'page' : kind === 'endpoint' ? 'endpoint' : 'entity'
}

/** Estimated rendered height of a node = header + (capped) field rows + a "+N more" row + padding. */
export function nodeHeight(n: DfNode): number {
  const rows = (n.fields?.length ?? 0) + (n.moreFields ? 1 : 0)
  return HEADER_H + rows * FIELD_H + PAD_V
}

/** Place the graph into columns. Returns positioned nodes + the total content size (for the board). */
export function layoutGraph(graph: DfGraph): GraphLayout {
  const cursors: Record<Col, number> = { page: TOP, endpoint: TOP, entity: TOP }
  const nodes: PositionedNode[] = []
  const byId = new Map<string, PositionedNode>()
  for (const n of graph.nodes) {
    const col = colOf(n.kind)
    const h = nodeHeight(n)
    const placed: PositionedNode = {
      ...n,
      x: COL_X[col],
      y: cursors[col],
      w: NODE_W[n.kind],
      h
    }
    cursors[col] = placed.y + h + ROW_GAP
    nodes.push(placed)
    byId.set(n.id, placed)
  }
  const width = COL_X.entity + NODE_W.entity + 24
  const height = Math.max(TOP, cursors.page, cursors.endpoint, cursors.entity) - ROW_GAP + TOP
  return { nodes, byId, width, height }
}

/** A simple right-anchor → left-anchor bezier path between two placed nodes (the edge ink). */
export function edgePath(from: PositionedNode, to: PositionedNode): string {
  // anchor on the facing edges (source right-mid → target left-mid), with a horizontal control offset
  const sx = from.x + from.w
  const sy = from.y + Math.min(from.h / 2, HEADER_H / 2 + 6)
  const tx = to.x
  const ty = to.y + Math.min(to.h / 2, HEADER_H / 2 + 6)
  const dx = Math.max(24, Math.abs(tx - sx) * 0.5)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}
