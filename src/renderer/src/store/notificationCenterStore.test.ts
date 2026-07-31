import { describe, it, expect, beforeEach } from 'vitest'
import {
  useNotificationCenterStore,
  selectUnreadCount,
  selectBadgeTier,
  MAX_ITEMS,
  type NotificationItem
} from './notificationCenterStore'

function seed(over: Partial<Parameters<typeof add>[0]> = {}): void {
  add({
    boardId: 'b1',
    boardTitle: 'Board 1',
    kind: 'done',
    message: 'Agent finished',
    at: 1000,
    ...over
  })
}
function add(item: Omit<NotificationItem, 'id' | 'read'>): void {
  useNotificationCenterStore.getState().add(item)
}
function items(): NotificationItem[] {
  return useNotificationCenterStore.getState().items
}

describe('notificationCenterStore', () => {
  beforeEach(() => {
    useNotificationCenterStore.setState({ items: [] })
  })

  it('add lands an unread item with a unique id', () => {
    seed()
    seed({ at: 1000, message: 'again' })
    expect(items()).toHaveLength(2)
    expect(items().every((n) => !n.read)).toBe(true)
    expect(items()[0].id).not.toBe(items()[1].id)
  })

  it('items order newest-first, including an out-of-order `at` (replay under a live race)', () => {
    seed({ at: 2000, message: 'live-new' })
    seed({ at: 500, message: 'replayed-old' })
    seed({ at: 1500, message: 'live-mid' })
    expect(items().map((n) => n.message)).toEqual(['live-new', 'live-mid', 'replayed-old'])
  })

  it('caps at MAX_ITEMS dropping the OLDEST', () => {
    for (let i = 0; i < MAX_ITEMS + 5; i++) seed({ at: i, message: `m${i}` })
    expect(items()).toHaveLength(MAX_ITEMS)
    // The five oldest (at 0..4) fell off the tail.
    expect(items()[items().length - 1].at).toBe(5)
  })

  it('addMany ingests a batch in one write; empty batch is a no-op (state identity)', () => {
    const before = items()
    useNotificationCenterStore.getState().addMany([])
    expect(items()).toBe(before)
    useNotificationCenterStore.getState().addMany([
      { boardId: 'b1', boardTitle: 'B', kind: 'done', message: 'x', at: 10 },
      { boardId: 'b2', boardTitle: 'C', kind: 'error', message: 'y', at: 20 }
    ])
    expect(items().map((n) => n.at)).toEqual([20, 10])
  })

  it('markRead reads one item; repeat and unknown ids are no-ops (state identity)', () => {
    seed()
    const id = items()[0].id
    useNotificationCenterStore.getState().markRead(id)
    expect(items()[0].read).toBe(true)
    const before = items()
    useNotificationCenterStore.getState().markRead(id)
    useNotificationCenterStore.getState().markRead('nope')
    expect(items()).toBe(before)
  })

  it('markBoardRead reads only that board (the selection sync rule)', () => {
    seed({ boardId: 'b1', at: 1 })
    seed({ boardId: 'b1', at: 2 })
    seed({ boardId: 'b2', at: 3 })
    useNotificationCenterStore.getState().markBoardRead('b1')
    expect(
      items()
        .filter((n) => n.boardId === 'b1')
        .every((n) => n.read)
    ).toBe(true)
    expect(items().find((n) => n.boardId === 'b2')?.read).toBe(false)
  })

  it('markAllRead reads everything; no-op identity when nothing is unread', () => {
    seed({ at: 1 })
    seed({ at: 2, kind: 'error' })
    useNotificationCenterStore.getState().markAllRead()
    expect(items().every((n) => n.read)).toBe(true)
    const before = items()
    useNotificationCenterStore.getState().markAllRead()
    expect(items()).toBe(before)
  })

  it('clear empties (project switch); no-op identity when already empty', () => {
    seed()
    useNotificationCenterStore.getState().clear()
    expect(items()).toEqual([])
    const before = items()
    useNotificationCenterStore.getState().clear()
    expect(items()).toBe(before)
  })

  it('selectUnreadCount counts unread only', () => {
    seed({ at: 1 })
    seed({ at: 2 })
    useNotificationCenterStore.getState().markRead(items()[0].id)
    expect(selectUnreadCount(items())).toBe(1)
  })

  it('selectBadgeTier: err beats warn beats accent; read items never count; null when no unread', () => {
    expect(selectBadgeTier(items())).toBeNull()
    seed({ at: 1, kind: 'done' })
    expect(selectBadgeTier(items())).toBe('accent')
    seed({ at: 2, kind: 'needs-input' })
    expect(selectBadgeTier(items())).toBe('warn')
    seed({ at: 3, kind: 'blocked' })
    expect(selectBadgeTier(items())).toBe('warn')
    seed({ at: 4, kind: 'error' })
    expect(selectBadgeTier(items())).toBe('err')
    useNotificationCenterStore.getState().markAllRead()
    expect(selectBadgeTier(items())).toBeNull()
  })
})
