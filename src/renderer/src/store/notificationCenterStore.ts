import { create } from 'zustand'
import type { AttentionKind } from './attentionStore'

/**
 * Session-only notification history behind the chrome bell (notification center). Every lifecycle
 * event `useNotifications` ingests also lands here as an item; the bell badge counts UNREAD items
 * and the panel lists them newest-first. Ephemeral by decision (audit follow-up P3-15): never
 * serialized, cleared on project switch (board ids are project-scoped), capped at MAX_ITEMS
 * drop-oldest. `boardTitle` is captured at receipt — a later rename does not rewrite history, and
 * a deleted board's items stay legible.
 *
 * Read model: this store is one of the two halves of the app's unified unread state (the other is
 * attentionStore's per-board mark). All four sync rules live in `useNotifications`: ingest writes
 * both; selecting a board reads its items; "Mark all as read" clears both; project switch clears
 * here. Mutations keep the attentionStore conditional-set discipline — return the SAME state
 * object when nothing changes, so subscribers (badge, Jarvis, MCP mirror) don't churn.
 */
export interface NotificationItem {
  /** Unique per session: receipt clock + a monotonic tiebreak (two events in the same ms). */
  id: string
  boardId: string
  /** Board title at receipt time (see header — deliberately not a live join). */
  boardTitle: string
  kind: AttentionKind
  message: string
  detail?: string
  /** MAIN's clock for replayed backlog items, renderer receipt clock for live ones. */
  at: number
  read: boolean
}

export const MAX_ITEMS = 100

export type BadgeTier = 'err' | 'warn' | 'accent'

interface NotificationCenterState {
  /** Newest-first (descending `at`; insertion order breaks ties). */
  items: NotificationItem[]
  add: (item: Omit<NotificationItem, 'id' | 'read'>) => void
  /** Batch ingest (the dead-window drain replay) — one state write for N items. */
  addMany: (items: Omit<NotificationItem, 'id' | 'read'>[]) => void
  markRead: (id: string) => void
  /** The user saw the board itself (selection) — its items stop counting as unread. */
  markBoardRead: (boardId: string) => void
  markAllRead: () => void
  clear: () => void
}

let seq = 0

/** Insert newest-first by `at` (a replayed backlog item may arrive AFTER a newer live one), cap. */
function insert(list: NotificationItem[], item: NotificationItem): NotificationItem[] {
  let i = 0
  while (i < list.length && list[i].at > item.at) i++
  return [...list.slice(0, i), item, ...list.slice(i)].slice(0, MAX_ITEMS)
}

export const useNotificationCenterStore = create<NotificationCenterState>()((set, get) => ({
  items: [],
  add: (item) => {
    set((s) => ({ items: insert(s.items, { ...item, id: `${item.at}-${seq++}`, read: false }) }))
  },
  addMany: (items) => {
    if (items.length === 0) return
    set((s) => {
      let next = s.items
      for (const item of items)
        next = insert(next, { ...item, id: `${item.at}-${seq++}`, read: false })
      return { items: next }
    })
  },
  markRead: (id) => {
    if (!get().items.some((n) => n.id === id && !n.read)) return
    set((s) => ({ items: s.items.map((n) => (n.id === id ? { ...n, read: true } : n)) }))
  },
  markBoardRead: (boardId) => {
    if (!get().items.some((n) => n.boardId === boardId && !n.read)) return
    set((s) => ({
      items: s.items.map((n) => (n.boardId === boardId && !n.read ? { ...n, read: true } : n))
    }))
  },
  markAllRead: () => {
    if (!get().items.some((n) => !n.read)) return
    set((s) => ({ items: s.items.map((n) => (n.read ? n : { ...n, read: true })) }))
  },
  clear: () => {
    if (get().items.length === 0) return
    set({ items: [] })
  }
}))

export function selectUnreadCount(items: NotificationItem[]): number {
  let n = 0
  for (const item of items) if (!item.read) n++
  return n
}

/** Badge colour = the most urgent unread kind; null hides the badge (nothing unread). */
export function selectBadgeTier(items: NotificationItem[]): BadgeTier | null {
  let tier: BadgeTier | null = null
  for (const item of items) {
    if (item.read) continue
    if (item.kind === 'error') return 'err'
    if (item.kind === 'needs-input' || item.kind === 'blocked') tier = 'warn'
    else if (tier === null) tier = 'accent'
  }
  return tier
}
