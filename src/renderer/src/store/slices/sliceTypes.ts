/**
 * Shared DI types for Zustand store slices.
 *
 * The store shape stays ONE `create<CanvasState>(...)` initialiser. A "slice" is a
 * factory that receives the real Zustand `set`/`get` plus a `SliceDeps` bag of
 * store-owned helpers, and returns a `Pick<CanvasState, ...>` that is spread into the
 * single store definition.
 *
 * CRITICAL — history ownership contract:
 *   `trackedChange` + the `lastRecorded` rail it closes over stay OWNED by canvasStore.
 *   Slices receive `trackedChange` by reference and NEVER copy, re-implement, or move it.
 *   Slices that record history MUST pass `reflectPresent: false` (or the appropriate flag
 *   for the operation); they do NOT touch `lastRecorded` directly — that is canvasStore's
 *   internal concern.
 */
import type { StoreApi } from 'zustand'
import type { CanvasState } from '../canvasStore'
import type { Board, Connector, NamedGroup } from '../../lib/boardSchema'

export type SetCanvasState = StoreApi<CanvasState>['setState']
export type GetCanvasState = StoreApi<CanvasState>['getState']

/**
 * Function type matching `trackedChange` in canvasStore (owned there, injected here by
 * reference). The closure over `lastRecorded` stays in canvasStore — slices MUST NOT
 * copy or re-implement this function.
 */
export type TrackedChange = (
  s: CanvasState,
  next: { boards?: Board[]; connectors?: Connector[]; groups?: NamedGroup[] } | null,
  opts: {
    selection?: { selectedId: string | null; selectedIds: string[] }
    reflectPresent: boolean
  }
) => Partial<CanvasState> | CanvasState

/**
 * Dependencies injected from canvasStore into each slice factory.
 *
 * `trackedChange` + the `lastRecorded` rail it closes over stay OWNED by canvasStore;
 * slices receive `trackedChange` by reference and NEVER copy it. Slices that record
 * history MUST pass `reflectPresent: false` (unless they are bulk-layout ops that
 * intentionally accept the coalescing behaviour of `true`).
 */
export interface SliceDeps {
  trackedChange: TrackedChange
  newId: () => string
}
