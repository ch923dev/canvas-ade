// @vitest-environment jsdom
/**
 * useNotifications — the renderer half of desktop notifications (audit: zero coverage before the
 * 2026-07-31 audit). Pins the P1-2a keyed toasts, the P2-5 stale-Focus feedback, and the P2-3
 * quiet backlog replay, plus the pre-existing dual write (attention mark + toast) and the
 * selection→clearAttention subscription those fixes ride on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useNotifications } from './useNotifications'
import { useAttentionStore } from './attentionStore'
import { useCanvasStore } from './canvasStore'
import { useNotificationCenterStore } from './notificationCenterStore'
import { useToastStore } from './toastStore'
import type { LifecyclePayload, PendingNotify } from '../../../preload/notifyApi'

type LifecycleCb = (p: LifecyclePayload) => void

const h: {
  lifecycle: LifecycleCb | null
  focusBoard: ((p: { boardId: string }) => void) | null
  drained: PendingNotify[]
} = { lifecycle: null, focusBoard: null, drained: [] }

function installApi(): void {
  window.api = {
    notify: {
      onLifecycle: (cb: LifecycleCb) => {
        h.lifecycle = cb
        return () => {}
      },
      onFocusBoard: (cb: (p: { boardId: string }) => void) => {
        h.focusBoard = cb
        return () => {}
      },
      drain: () => Promise.resolve(h.drained)
    }
  } as never
}

function seedBoard(id: string, title: string): void {
  useCanvasStore.setState({
    boards: [{ id, title, type: 'planning', x: 0, y: 0, w: 100, h: 100 }] as never
  })
}

async function mount(): Promise<void> {
  renderHook(() => useNotifications())
  // Flush the drain microtask chain.
  await act(async () => {})
}

beforeEach(() => {
  h.lifecycle = null
  h.focusBoard = null
  h.drained = []
  installApi()
  useToastStore.getState().clearToasts()
  useAttentionStore.setState({ byId: {} })
  useNotificationCenterStore.setState({ items: [] })
  useCanvasStore.setState({ selectedId: null, selectedIds: [], pendingFocusId: null } as never)
  seedBoard('b1', 'Builder')
})

afterEach(() => {
  cleanup()
})

const toasts = (): ReturnType<typeof useToastStore.getState>['toasts'] =>
  useToastStore.getState().toasts

describe('lifecycle push → dual write', () => {
  it('sets the attention mark AND shows a keyed toast with the board name + verb', async () => {
    await mount()
    act(() => h.lifecycle!({ boardId: 'b1', event: 'done' }))
    expect(useAttentionStore.getState().byId['b1']).toBe('done')
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].id).toBe('lifecycle:b1:done')
    expect(toasts()[0].message).toBe('Builder finished')
  })

  it('a repeat (board, mark) REPLACES the toast in place — no unbounded stacking (P1-2a)', async () => {
    await mount()
    act(() => {
      h.lifecycle!({
        boardId: 'b1',
        event: 'needs-input',
        attention: 'blocked',
        detail: 'silent 3m'
      })
      h.lifecycle!({
        boardId: 'b1',
        event: 'needs-input',
        attention: 'blocked',
        detail: 'silent 11m'
      })
    })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toBe('Builder is blocked — silent 11m')
    expect(toasts()[0].sticky).toBe(true)
  })

  it('distinct marks on one board keep separate keyed rows', async () => {
    await mount()
    act(() => {
      h.lifecycle!({ boardId: 'b1', event: 'done' })
      h.lifecycle!({ boardId: 'b1', event: 'error' })
    })
    expect(toasts().map((t) => t.id)).toEqual(['lifecycle:b1:done', 'lifecycle:b1:error'])
  })
})

describe('Focus action (P2-5 stale-target feedback)', () => {
  it('live board: sets pendingFocusId + selection, no stale toast', async () => {
    await mount()
    act(() => h.lifecycle!({ boardId: 'b1', event: 'done' }))
    act(() => toasts()[0].action!.run())
    const s = useCanvasStore.getState() as never as {
      pendingFocusId: string | null
      selectedIds: string[]
    }
    expect(s.pendingFocusId).toBe('b1')
    expect(s.selectedIds).toEqual(['b1'])
  })

  it('deleted board: info toast + ghost mark cleared + selection untouched', async () => {
    await mount()
    act(() => h.lifecycle!({ boardId: 'b1', event: 'done' }))
    const run = toasts()[0].action!.run
    act(() => {
      useCanvasStore.setState({ boards: [] as never })
    })
    act(() => run())
    const s = useCanvasStore.getState() as never as {
      pendingFocusId: string | null
      selectedIds: string[]
    }
    expect(s.pendingFocusId).toBeNull()
    expect(s.selectedIds).toEqual([])
    expect(useAttentionStore.getState().byId['b1']).toBeUndefined()
    expect(toasts().some((t) => t.id === 'notify-stale-focus')).toBe(true)
  })

  it('the OS-click focusBoard push routes through the same self-checking focus', async () => {
    await mount()
    act(() => h.focusBoard!({ boardId: 'ghost' }))
    expect(toasts().some((t) => t.id === 'notify-stale-focus')).toBe(true)
    expect(
      (useCanvasStore.getState() as never as { pendingFocusId: string | null }).pendingFocusId
    ).toBeNull()
  })
})

describe('backlog replay (P2-3 — quieter than live)', () => {
  it('replays attention marks + ONE aggregate toast, never N stale toasts', async () => {
    seedBoard('b1', 'Builder')
    h.drained = [
      { t: 'lifecycle', at: 1, payload: { boardId: 'b1', event: 'done' } },
      {
        t: 'lifecycle',
        at: 2,
        payload: { boardId: 'b2', event: 'needs-input', attention: 'blocked' }
      },
      {
        t: 'lifecycle',
        at: 3,
        payload: { boardId: 'b2', event: 'needs-input', attention: 'blocked' }
      }
    ]
    await mount()
    expect(useAttentionStore.getState().byId['b1']).toBe('done')
    expect(useAttentionStore.getState().byId['b2']).toBe('blocked')
    const replay = toasts().filter((t) => t.id === 'notify-replay')
    expect(replay).toHaveLength(1)
    expect(replay[0].message).toBe('2 agents reported while the window was closed')
    expect(toasts()).toHaveLength(1)
  })

  it('a single-board backlog gets a Focus action; a queued focus intent replays through focus()', async () => {
    h.drained = [
      { t: 'lifecycle', at: 1, payload: { boardId: 'b1', event: 'done' } },
      { t: 'focus', at: 2, boardId: 'b1' }
    ]
    await mount()
    const replay = toasts().find((t) => t.id === 'notify-replay')!
    expect(replay.message).toBe('1 agent reported while the window was closed')
    expect(replay.action?.label).toBe('Focus')
    expect(
      (useCanvasStore.getState() as never as { pendingFocusId: string | null }).pendingFocusId
    ).toBe('b1')
  })

  it('an empty backlog shows nothing', async () => {
    await mount()
    expect(toasts()).toEqual([])
  })

  it('a missing drain bridge (older preload) breaks nothing', async () => {
    window.api = {
      notify: {
        onLifecycle: (cb: LifecycleCb) => {
          h.lifecycle = cb
          return () => {}
        },
        onFocusBoard: () => () => {}
      }
    } as never
    await mount()
    act(() => h.lifecycle!({ boardId: 'b1', event: 'done' }))
    expect(toasts()).toHaveLength(1)
  })
})

describe('selection clears attention (pre-existing contract the fixes ride on)', () => {
  it('selecting a marked board drops its mark', async () => {
    await mount()
    act(() => h.lifecycle!({ boardId: 'b1', event: 'done' }))
    expect(useAttentionStore.getState().byId['b1']).toBe('done')
    act(() => {
      useCanvasStore.setState({ selectedId: 'b1', selectedIds: ['b1'] } as never)
    })
    expect(useAttentionStore.getState().byId['b1']).toBeUndefined()
  })
})

describe('notification-center wiring (bell PR — the ONE unread model)', () => {
  const items = (): ReturnType<typeof useNotificationCenterStore.getState>['items'] =>
    useNotificationCenterStore.getState().items

  it('a lifecycle push lands an unread history row alongside the toast (sync rule 1)', async () => {
    await mount()
    act(() => h.lifecycle!({ boardId: 'b1', event: 'error', detail: 'exit 1' }))
    expect(items()).toHaveLength(1)
    expect(items()[0]).toMatchObject({
      boardId: 'b1',
      boardTitle: 'Builder',
      kind: 'error',
      message: 'Builder hit an error — exit 1',
      read: false
    })
  })

  it('selecting a board reads its rows AND clears its ring in one gesture (sync rule 2)', async () => {
    await mount()
    act(() => {
      h.lifecycle!({ boardId: 'b1', event: 'done' })
      h.lifecycle!({ boardId: 'b2', event: 'error' })
    })
    act(() => {
      useCanvasStore.setState({ selectedId: 'b1', selectedIds: ['b1'] } as never)
    })
    expect(items().find((n) => n.boardId === 'b1')?.read).toBe(true)
    expect(items().find((n) => n.boardId === 'b2')?.read).toBe(false)
    expect(useAttentionStore.getState().byId['b1']).toBeUndefined()
    expect(useAttentionStore.getState().byId['b2']).toBe('error')
  })

  it('the backlog replay populates history rows (quiet toast, full panel)', async () => {
    h.drained = [
      { t: 'lifecycle', at: 100, payload: { boardId: 'b1', event: 'done' } },
      {
        t: 'lifecycle',
        at: 200,
        payload: { boardId: 'b2', event: 'needs-input', attention: 'blocked', detail: 'silent 4m' }
      }
    ]
    await mount()
    expect(items().map((n) => n.at)).toEqual([200, 100])
    expect(items()[0]).toMatchObject({ boardId: 'b2', kind: 'blocked', read: false })
    // Toast channel stays aggregate-only (asserted in the replay suite above).
  })

  it('a project switch clears the history (sync rule 4 — project-scoped board ids)', async () => {
    await mount()
    act(() => h.lifecycle!({ boardId: 'b1', event: 'done' }))
    expect(items()).toHaveLength(1)
    act(() => {
      useCanvasStore.setState({
        project: { dir: 'D:/other', name: 'other', status: 'open' }
      } as never)
    })
    expect(items()).toEqual([])
  })
})
