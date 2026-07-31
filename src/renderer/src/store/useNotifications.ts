import { useEffect } from 'react'
import { useAttentionStore, type AttentionKind } from './attentionStore'
import { useCanvasStore } from './canvasStore'
import { showToast } from './toastStore'

/**
 * Desktop notifications (renderer side). Subscribes to MAIN's agent-lifecycle pushes:
 *  - `notify:lifecycle` → an in-app toast (with a Focus action that pans to the board) + the
 *    board's unseen-attention mark (P2 — the on-canvas ring/badge via attentionStore).
 *  - `notify:focusBoard` → the user clicked the OS notification: pan + select the board.
 *
 * Focus reuses the existing `pendingFocusId` intent (a Canvas effect consumes it → camera-fit +
 * dim) plus `selectBoard`, so no new store machinery. Attention is "unseen" state: selecting a
 * board (any path — click, focus action, OS-notification click) clears its mark via the
 * canvasStore subscription below. Guarded for non-electron test/smoke renders (window.api
 * absent); the effect returns the disposers.
 */
const TOAST: Record<
  AttentionKind,
  { verb: string; kind: 'ok' | 'info' | 'error'; sticky: boolean }
> = {
  done: { verb: 'finished', kind: 'ok', sticky: false },
  'needs-input': { verb: 'needs your input', kind: 'info', sticky: false },
  // P4 — sticky like `error`: a blocked worker is not going to un-block itself, so a toast that
  // auto-dismisses would let the whole reason for surfacing it scroll past unread.
  blocked: { verb: 'is blocked', kind: 'info', sticky: true },
  error: { verb: 'hit an error', kind: 'error', sticky: true }
}

/**
 * P4 — which mark a lifecycle push lands. The optional `attention` override lets MAIN distinguish
 * `blocked` from `needs-input` on the canvas WITHOUT widening the notifications-config vocabulary
 * the OS/toast gate speaks. Any off-vocabulary override is ignored in favour of the event itself —
 * the safe direction, since the event is always a value this renderer can render.
 */
const ATTENTION_KINDS: ReadonlySet<string> = new Set([
  'done',
  'needs-input',
  'blocked',
  'error'
] satisfies AttentionKind[])
function markFor(event: AttentionKind, override: string | undefined): AttentionKind {
  return override !== undefined && ATTENTION_KINDS.has(override)
    ? (override as AttentionKind)
    : event
}

/** Busy-aware eviction (project:bgLifecycle): copy per sweep-push kind. The warning is the one
 *  the user can still act on, so it stays sticky until dismissed or superseded by the close. */
const BG_TOAST: Record<'warned' | 'closed' | 'evicted', (name: string) => string> = {
  warned: (name) =>
    `${name} is idle in the background — closing in ~2 min. Switch back to keep it.`,
  closed: (name) => `Background project ${name} was closed after staying idle.`,
  evicted: (name) => `Background project ${name} was closed to free memory.`
}

export function useNotifications(): void {
  useEffect(() => {
    const api = window.api?.notify
    if (!api) return

    const focus = (boardId: string): void => {
      // Stale-target guard (audit P2-5): a Focus click on a board that no longer exists on this
      // canvas (deleted, or another project's id replayed from the tray backlog) used to silently
      // no-op — pendingFocusId was set, the consumer bailed, and a phantom id sat in selectedIds.
      // Surface it, and drop the ghost attention mark so it stops counting as unseen.
      const exists = useCanvasStore.getState().boards.some((b) => b.id === boardId)
      if (!exists) {
        useAttentionStore.getState().clearAttention(boardId)
        showToast({
          id: 'notify-stale-focus',
          message: 'That board is no longer on this canvas',
          kind: 'info'
        })
        return
      }
      useCanvasStore.setState({ pendingFocusId: boardId })
      useCanvasStore.getState().selectBoard(boardId)
    }

    const handleLifecycle = ({
      boardId,
      event,
      attention,
      detail
    }: Parameters<Parameters<typeof api.onLifecycle>[0]>[0]): void => {
      const mark = markFor(event, attention)
      useAttentionStore.getState().setAttention(boardId, mark)
      const board = useCanvasStore.getState().boards.find((b) => b.id === boardId)
      const name = board?.title?.trim() || 'Agent'
      const spec = TOAST[mark]
      // P4: `detail` carries MAIN's composed reason (`silent 11m`, `failing check`). Appended, not
      // substituted — the reason has to reach the surface or it does not exist, and the toast is
      // the only place it appears for a board the human is not looking at.
      const reason = typeof detail === 'string' && detail.trim().length > 0 ? ` — ${detail}` : ''
      showToast({
        // Keyed per (board, mark) — audit P1-2a: a re-fire updates the row in place (countdown
        // restarts on the message change) instead of appending without bound; sticky occupancy is
        // bounded by live boards, not event count.
        id: `lifecycle:${boardId}:${mark}`,
        message: `${name} ${spec.verb}${reason}`,
        kind: spec.kind,
        sticky: spec.sticky,
        action: { label: 'Focus', run: () => focus(boardId) }
      })
    }

    // Listeners FIRST, drain second — the pull-not-push half of the dead-window fix (audit P2-3):
    // installing the listener before asking for the backlog means nothing can land in the gap.
    const offLifecycle = api.onLifecycle(handleLifecycle)
    const offFocus = api.onFocusBoard(({ boardId }) => focus(boardId))

    // Replay the backlog quieter than live: every lifecycle item lands its attention mark (the
    // durable on-canvas signal — the point of the replay), but the toast channel gets ONE
    // aggregate line, not N stale ones. A queued focus intent (OS-notification click that reopened
    // the window) goes through the same self-checking focus().
    void api
      .drain?.()
      .then((items) => {
        if (!items || items.length === 0) return
        const boards = new Set<string>()
        for (const item of items) {
          if (item.t === 'lifecycle') {
            const mark = markFor(item.payload.event, item.payload.attention)
            useAttentionStore.getState().setAttention(item.payload.boardId, mark)
            boards.add(item.payload.boardId)
          }
        }
        if (boards.size > 0) {
          const one = boards.size === 1 ? [...boards][0] : null
          showToast({
            id: 'notify-replay',
            message:
              boards.size === 1
                ? '1 agent reported while the window was closed'
                : `${boards.size} agents reported while the window was closed`,
            kind: 'info',
            ...(one ? { action: { label: 'Focus', run: () => focus(one) } } : {})
          })
        }
        for (const item of items) if (item.t === 'focus') focus(item.boardId)
      })
      .catch(() => {
        /* drain is best-effort — a missing bridge (older preload) must not break the hook */
      })

    // Background-session lifecycle (busy-aware eviction): the MAIN sweep warns before an idle
    // close and reports every auto-close — keyed per dir+kind so a repeat replaces in place,
    // and the close supersedes its own warning toast (same dir key family).
    const offBg = window.api?.project?.onBgLifecycle
      ? window.api.project.onBgLifecycle(({ kind, dir, name }) => {
          showToast({
            id: `bg-lifecycle:${dir}`,
            message: BG_TOAST[kind](name),
            kind: 'info',
            sticky: kind === 'warned'
          })
        })
      : (): void => {}

    // Attention is unseen-state: selecting a board (click, marquee, focus action, OS click —
    // they all land in `selectedIds`) means the user saw it → drop its mark. clearAttention
    // no-ops without a state change when the board carries none, so this per-change loop is
    // render-cheap.
    const offSelect = useCanvasStore.subscribe((s) => {
      const { byId, clearAttention } = useAttentionStore.getState()
      for (const id of s.selectedIds) if (byId[id]) clearAttention(id)
    })

    return () => {
      offLifecycle()
      offFocus()
      offBg()
      offSelect()
    }
  }, [])
}
