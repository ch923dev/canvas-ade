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

export interface BoardNet {
  records: NetRecord[] // insertion-ordered (deltas upsert by requestId)
  ws: WsRecord[]
  dropped: number
  open: boolean
  dock: NetDock
  selected?: string // selected requestId (drives the details pane)
}

const EMPTY: BoardNet = { records: [], ws: [], dropped: 0, open: false, dock: 'bottom' }

interface OsrNetworkState {
  byBoard: Record<string, BoardNet>
  /** Apply a MAIN batch (replay replaces; delta upserts by requestId; cleared empties). */
  apply: (id: string, msg: OsrNetMessage) => void
  setOpen: (id: string, open: boolean) => void
  setDock: (id: string, dock: NetDock) => void
  select: (id: string, requestId?: string) => void
  /** Drop a board's state (unmount). */
  clearBoard: (id: string) => void
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
          dropped: msg.dropped ?? 0
        }
      } else if (msg.kind === 'cleared') {
        next = { ...cur, records: [], ws: [], dropped: 0, selected: undefined }
      } else {
        next = {
          ...cur,
          records: upsert(cur.records, msg.records ?? []),
          ws: upsert(cur.ws, msg.ws ?? []),
          dropped: msg.dropped ?? cur.dropped
        }
      }
      return { byBoard: { ...s.byBoard, [id]: next } }
    }),

  setOpen: (id, open) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), open } } })),

  setDock: (id, dock) =>
    set((s) => ({ byBoard: { ...s.byBoard, [id]: { ...(s.byBoard[id] ?? EMPTY), dock } } })),

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
