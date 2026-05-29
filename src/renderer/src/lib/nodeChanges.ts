/**
 * Pure mapping of React Flow NodeChange[] → store intents, so Canvas.onNodesChange
 * is a thin apply loop and the translation rules are unit-tested. Mirrors the prior
 * inline logic: position→move, (resizing) dimensions→resize, select→select/deselect,
 * remove→remove. `select:false` yields a deselect intent the caller can fold.
 */
import type { Node, NodeChange } from '@xyflow/react'

export type Intent =
  | { kind: 'move'; id: string; x: number; y: number }
  | { kind: 'resize'; id: string; w: number; h: number }
  | { kind: 'select'; id: string }
  | { kind: 'deselect'; id: string }
  | { kind: 'remove'; id: string }

export function nodeChangesToIntents<T extends Node>(changes: NodeChange<T>[]): Intent[] {
  const out: Intent[] = []
  for (const c of changes) {
    if (c.type === 'position' && c.position) {
      out.push({ kind: 'move', id: c.id, x: c.position.x, y: c.position.y })
    } else if (c.type === 'dimensions' && c.dimensions && c.resizing) {
      out.push({ kind: 'resize', id: c.id, w: c.dimensions.width, h: c.dimensions.height })
    } else if (c.type === 'select') {
      out.push(c.selected ? { kind: 'select', id: c.id } : { kind: 'deselect', id: c.id })
    } else if (c.type === 'remove') {
      out.push({ kind: 'remove', id: c.id })
    }
  }
  return out
}
