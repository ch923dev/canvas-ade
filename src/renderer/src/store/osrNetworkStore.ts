/**
 * Ephemeral per-board state for the DevTools Network inspector (renderer mirror of the MAIN ring
 * buffer). MAIN captures always-on into a bounded buffer; `useOsrNetwork` subscribes ONLY while the
 * panel is open and funnels `preview:osrNet` batches here (replay once, then coalesced deltas). The
 * `OsrNetworkPanel` reads `byBoard[id]`. Pure session state — never serialized (heeds FIND-011:
 * cleared on board unmount by the hook).
 */
import { create } from 'zustand'
import type { NetRecord, WsRecord, OsrNetMessage } from '../../../preload'

export type NetDock = 'bottom' | 'right'
/** Which inspector tab is showing. Network = requests; Assets = static resources (derived from the
 *  same capture); Downloads = files the page saved (from the widget store's download stream). */
export type NetTab = 'network' | 'assets' | 'downloads'

export interface BoardNet {
  records: NetRecord[] // insertion-ordered (deltas upsert by requestId)
  ws: WsRecord[]
  dropped: number
  open: boolean
  dock: NetDock
  tab: NetTab
  preserve: boolean // mirrors MAIN's flag (seeded from the replay snapshot)
  selected?: string // selected requestId (drives the details pane)
  // Drag-resized panel size as a FRACTION (0..1) of the stage cross-axis, kept per dock since
  // bottom resizes height and right resizes width independently. Undefined ⇒ the CSS default.
  size?: { bottom?: number; right?: number }
}

const EMPTY: BoardNet = {
  records: [],
  ws: [],
  dropped: 0,
  open: false,
  dock: 'bottom',
  tab: 'network',
  preserve: false
}

interface OsrNetworkState {
  byBoard: Record<string, BoardNet>
  /** Apply a MAIN batch (replay replaces; delta upserts by requestId; cleared empties). */
  apply: (id: string, msg: OsrNetMessage) => void
  setOpen: (id: string, open: boolean) => void
  setDock: (id: string, dock: NetDock) => void
  setTab: (id: string, tab: NetTab) => void
  /** Persist (for the session) the drag-resized panel fraction for the active dock. */
  setSize: (id: string, dock: NetDock, frac: number) => void
  setPreserve: (id: string, preserve: boolean) => void
  select: (id: string, requestId?: string) => void
  /** Drop a board's state (unmount). */
  clearBoard: (id: string) => void
}

// Renderer-side caps MIRRORING MAIN's ring buffer (previewOsrNetwork.ts MAX_RECORDS / MAX_SOCKETS):
// MAIN drops oldest beyond these, but deltas only carry NEW/updated rows — never "evict these old
// ones" — so without a matching cap here the renderer's mirror grows unbounded on a chatty page while
// the panel is open. Tail-cap after each upsert (newest are appended last → keep the most recent).
const MAX_RECORDS = 1000
const MAX_SOCKETS = 32

/** Keep only the last `max` entries (drop-oldest), mirroring MAIN's ring eviction. Exported for the
 *  unit test that guards the bound. */
export function capTail<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list
}

/** Upsert `incoming` into `list` by requestId — replace in place if present, else append. */
function upsert<T extends { requestId: string }>(list: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return list
  const next = list.slice()
  const idx = new Map(next.map((r, i) => [r.requestId, i]))
  for (const rec of incoming) {
    const at = idx.get(rec.requestId)
    if (at === undefined) {
      idx.set(rec.requestId, next.length)
      next.push(rec)
    } else {
      next[at] = rec
    }
  }
  return next
}

export const useOsrNetworkStore = create<OsrNetworkState>((set) => ({
  byBoard: {},

  apply: (id, msg) =>
    set((s) => {
      const cur = s.byBoard[id] ?? EMPTY
      let next: BoardNet
      if (msg.kind === 'replay') {
        next = {
          ...cur,
          records: msg.records ?? [],
          ws: msg.ws ?? [],
          dropped: msg.dropped ?? 0,
          preserve: msg.preserve ?? cur.preserve // seed the checkbox from MAIN's real flag
        }
      } else if (msg.kind === 'cleared') {
        next = { ...cur, records: [], ws: [], dropped: 0, selected: undefined }
      } else {
        next = {
          ...cur,
          records: capTail(upsert(cur.records, msg.records ?? []), MAX_RECORDS),
          ws: capTail(upsert(cur.ws, msg.ws ?? []), MAX_SOCKETS),
          dropped: msg.dropped ?? cur.dropped
        }
      }
      return { byBoard: { ...s.byBoard, [id]: next } }
    }),

  setOpen: (id, open) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), open } } })),

  setDock: (id, dock) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), dock } } })),

  setTab: (id, tab) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), tab } } })),

  setSize: (id, dock, frac) =>
    set((s) => {
      const cur = s.byBoard[id] ?? EMPTY
      return {
        byBoard: { ...s.byBoard, [id]: { ...cur, size: { ...cur.size, [dock]: frac } } }
      }
    }),

  setPreserve: (id, preserve) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), preserve } } })),

  select: (id, requestId) =>
    set((s) => ({
      byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), selected: requestId } }
    })),

  clearBoard: (id) =>
    set((s) => {
      if (!(id in s.byBoard)) return s
      const byBoard = { ...s.byBoard }
      delete byBoard[id]
      return { byBoard }
    })
}))
