// @vitest-environment jsdom
/**
 * NotificationBell (audit PR2) — badge count/tier/clamp, panel rows, row-click Focus routing,
 * and the "Mark all as read" unification proof: one click clears BOTH unread halves (bell items
 * AND every attentionStore mark — the canvas rings / Jarvis badge feed). Real stores throughout;
 * the Menu shell portals into document.body so queries run document-wide.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { NotificationBell } from './NotificationBell'
import { useNotificationCenterStore } from '../store/notificationCenterStore'
import { useAttentionStore } from '../store/attentionStore'
import { useCanvasStore } from '../store/canvasStore'
import { useToastStore } from '../store/toastStore'
import type { AttentionKind } from '../store/attentionStore'

function seedItem(over: Partial<Parameters<typeof addItem>[0]> = {}): void {
  addItem({
    boardId: 'b1',
    boardTitle: 'Builder',
    kind: 'done',
    message: 'Builder finished',
    at: Date.now(),
    ...over
  })
}
function addItem(item: {
  boardId: string
  boardTitle: string
  kind: AttentionKind
  message: string
  detail?: string
  at: number
}): void {
  useNotificationCenterStore.getState().add(item)
}

function seedBoard(id: string, title: string): void {
  useCanvasStore.setState({
    boards: [
      ...useCanvasStore.getState().boards,
      { id, title, type: 'planning', x: 0, y: 0, w: 100, h: 100 }
    ] as never
  })
}

const bell = (): HTMLElement => document.querySelector('[data-test=notification-bell]')!
const badge = (): HTMLElement | null => document.querySelector('[data-test=notification-badge]')
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll('[data-test=nb-row]'))
const markAll = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-test=nb-markall]')

beforeEach(() => {
  useNotificationCenterStore.setState({ items: [] })
  useAttentionStore.setState({ byId: {} })
  useToastStore.getState().clearToasts()
  useCanvasStore.setState({
    boards: [] as never,
    selectedId: null,
    selectedIds: [],
    pendingFocusId: null
  } as never)
})

afterEach(() => {
  cleanup()
})

describe('badge', () => {
  it('is absent at zero unread', () => {
    render(<NotificationBell />)
    expect(badge()).toBeNull()
    expect(bell().getAttribute('aria-label')).toBe('Notifications')
  })

  it('counts unread, carries the tier, and announces the count', () => {
    act(() => {
      seedItem({ at: 1 })
      seedItem({ at: 2, kind: 'needs-input' })
    })
    render(<NotificationBell />)
    expect(badge()!.textContent).toBe('2')
    expect(badge()!.getAttribute('data-tier')).toBe('warn')
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread')
  })

  it('any unread error wins the err tier; clamps at 99+', () => {
    act(() => {
      for (let i = 0; i < 120; i++) seedItem({ at: i })
      seedItem({ at: 999, kind: 'error' })
    })
    render(<NotificationBell />)
    // Store cap is 100 items, all unread → clamp text.
    expect(badge()!.textContent).toBe('99+')
    expect(badge()!.getAttribute('data-tier')).toBe('err')
  })
})

describe('panel', () => {
  it('opens on click with rows newest-first; empty state when no history', () => {
    render(<NotificationBell />)
    fireEvent.click(bell())
    expect(document.querySelector('.nb-empty')).not.toBeNull()
    expect(markAll()!.disabled).toBe(true)
    fireEvent.click(bell()) // re-click toggles closed
    expect(document.querySelector('.nb-menu')).toBeNull()
  })

  it('lists rows newest-first with kind dot, board title and unread flag', () => {
    act(() => {
      seedItem({ at: 1000, message: 'Builder finished' })
      seedItem({
        at: 2000,
        boardId: 'b2',
        boardTitle: 'Scout',
        kind: 'error',
        message: 'Scout hit an error'
      })
    })
    render(<NotificationBell />)
    fireEvent.click(bell())
    expect(rows().map((r) => r.querySelector('.nb-msg')!.textContent)).toEqual([
      'Scout hit an error',
      'Builder finished'
    ])
    expect(rows()[0].querySelector('.nb-dot')!.getAttribute('data-kind')).toBe('error')
    expect(rows()[0].querySelector('.nb-board')!.textContent).toBe('Scout')
    expect(rows()[0].getAttribute('data-read')).toBe('false')
  })

  it('row click focuses the board (pendingFocusId + selection), reads the row, closes the panel', () => {
    seedBoard('b1', 'Builder')
    act(() => seedItem({ at: 1 }))
    render(<NotificationBell />)
    fireEvent.click(bell())
    fireEvent.click(rows()[0])
    const s = useCanvasStore.getState() as never as {
      pendingFocusId: string | null
      selectedIds: string[]
    }
    expect(s.pendingFocusId).toBe('b1')
    expect(s.selectedIds).toEqual(['b1'])
    expect(useNotificationCenterStore.getState().items[0].read).toBe(true)
    expect(document.querySelector('.nb-menu')).toBeNull()
  })

  it('a deleted-board row surfaces the stale-focus toast instead of silently no-oping', () => {
    act(() => seedItem({ at: 1, boardId: 'ghost', boardTitle: 'Gone' }))
    render(<NotificationBell />)
    fireEvent.click(bell())
    fireEvent.click(rows()[0])
    expect(useToastStore.getState().toasts.some((t) => t.id === 'notify-stale-focus')).toBe(true)
    expect(
      (useCanvasStore.getState() as never as { pendingFocusId: string | null }).pendingFocusId
    ).toBeNull()
  })
})

describe('Mark all as read — the ONE unread model', () => {
  it('clears the bell count AND every attention mark in one click', () => {
    act(() => {
      seedItem({ at: 1, boardId: 'b1' })
      seedItem({ at: 2, boardId: 'b2', kind: 'error' })
      useAttentionStore.getState().setAttention('b1', 'done')
      useAttentionStore.getState().setAttention('b2', 'error')
    })
    render(<NotificationBell />)
    fireEvent.click(bell())
    fireEvent.click(markAll()!)
    expect(useNotificationCenterStore.getState().items.every((n) => n.read)).toBe(true)
    expect(useAttentionStore.getState().byId).toEqual({})
    expect(badge()).toBeNull()
    expect(markAll()!.disabled).toBe(true)
  })
})
