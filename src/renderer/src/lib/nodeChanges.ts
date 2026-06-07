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

/**
 * Fold a frame's select/deselect/remove intents onto the current board multi-selection.
 * RF emits `select:false` for the previously-selected on a plain click and `select:true` per
 * member on a marquee/Ctrl-click gesture, so applying the deltas to the live set yields the
 * correct single OR multi selection. `remove` ALSO drops the id — a keyboard multi-delete
 * removes every selected node, and pruning the gone id here stops it being written back into
 * `selectedIds` as a ghost. `move`/`resize` don't touch selection (the caller applies those
 * side effects separately). Pure: the caller passes the PRE-mutation `selectedIds` snapshot
 * (board removal mutates the store's selection mid-loop) and writes the result via setSelection.
 * `changed` mirrors the prior inline fold — true whenever any selection-affecting intent is
 * present — so a no-op re-select still re-commits (harmless; setSelection dedups).
 */
export function foldSelectionIntents(
  current: readonly string[],
  intents: Intent[]
): { ids: string[]; changed: boolean } {
  const set = new Set(current)
  let changed = false
  for (const intent of intents) {
    if (intent.kind === 'select') {
      set.add(intent.id)
      changed = true
    } else if (intent.kind === 'deselect' || intent.kind === 'remove') {
      set.delete(intent.id)
      changed = true
    }
  }
  return { ids: [...set], changed }
}
