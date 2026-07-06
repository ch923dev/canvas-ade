import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { showToast } from './toastStore'

/**
 * Desktop notifications (renderer side). Subscribes to MAIN's agent-lifecycle pushes:
 *  - `notify:lifecycle` → an in-app toast (with a Focus action that pans to the board).
 *  - `notify:focusBoard` → the user clicked the OS notification: pan + select the board.
 *
 * Focus reuses the existing `pendingFocusId` intent (a Canvas effect consumes it → camera-fit +
 * dim) plus `selectBoard`, so no new store machinery. Guarded for non-electron test/smoke renders
 * (window.api absent); the effect returns the disposers.
 */
const TOAST: Record<
  'done' | 'needs-input' | 'error',
  { verb: string; kind: 'ok' | 'info' | 'error'; sticky: boolean }
> = {
  done: { verb: 'finished', kind: 'ok', sticky: false },
  'needs-input': { verb: 'needs your input', kind: 'info', sticky: false },
  error: { verb: 'hit an error', kind: 'error', sticky: true }
}

export function useNotifications(): void {
  useEffect(() => {
    const api = window.api?.notify
    if (!api) return

    const focus = (boardId: string): void => {
      useCanvasStore.setState({ pendingFocusId: boardId })
      useCanvasStore.getState().selectBoard(boardId)
    }

    const offLifecycle = api.onLifecycle(({ boardId, event }) => {
      const board = useCanvasStore.getState().boards.find((b) => b.id === boardId)
      const name = board?.title?.trim() || 'Agent'
      const spec = TOAST[event]
      showToast({
        message: `${name} ${spec.verb}`,
        kind: spec.kind,
        sticky: spec.sticky,
        action: { label: 'Focus', run: () => focus(boardId) }
      })
    })
    const offFocus = api.onFocusBoard(({ boardId }) => focus(boardId))

    return () => {
      offLifecycle()
      offFocus()
    }
  }, [])
}
