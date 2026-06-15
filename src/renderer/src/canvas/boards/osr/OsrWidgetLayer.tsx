import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useOsrWidgetStore } from '../../../store/osrWidgetStore'
import { pageRectToFrame, placePopupTop, clampPopupLeft } from '../../../lib/osrWidgets'
import type { OsrPopupEvent } from '../../../../../preload'
import { OsrJsDialog } from './OsrJsDialog'
import { OsrSelectOverlay } from './OsrSelectOverlay'
import { OsrDatePicker } from './OsrDatePicker'
import { OsrColorPicker } from './OsrColorPicker'

/**
 * OS-3 Phase 4 (4B + 4E) — the per-board overlay layer mounted inside `.bb-frame` (over the host
 * `<canvas>`). Reads `osrWidgetStore` for this board's open JS dialog / native popup and draws the
 * right chrome — a modal (alert/confirm/prompt) or a positioned `<select>`/date/color overlay. A
 * full-frame wrapper intercepts input so the overlay is modal: a dialog is button-only; a popup
 * dismisses on click-away. The wrapper is a normal DOM node, so it clips/rounds with the frame (the
 * occlusion fix) — no native view. Renders nothing (no interception) when neither is open.
 *
 * `pageW`/`pageH` are the active preset's logical size — the page-coordinate space the popup rects
 * arrive in (same as `useOffscreenInput`); the overlay maps them into the measured frame box.
 */
export function OsrWidgetLayer({
  boardId,
  pageW,
  pageH
}: {
  boardId: string
  pageW: number
  pageH: number
}): ReactElement | null {
  const dialog = useOsrWidgetStore((s) => s.dialog[boardId] ?? null)
  const popup = useOsrWidgetStore((s) => s.popup[boardId] ?? null)
  const setDialog = useOsrWidgetStore((s) => s.setDialog)
  const setPopup = useOsrWidgetStore((s) => s.setPopup)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState({ w: 0, h: 0 })

  // Measure the frame box (unscaled layout px — clientWidth ignores the RF camera transform) so the
  // popup can be placed in frame-local coords. Re-measure whenever something opens.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (el) setFrame({ w: el.clientWidth, h: el.clientHeight })
  }, [dialog, popup])

  if (!dialog && !popup) return null

  const respondDialog = (accept: boolean, promptText?: string): void => {
    void window.api.respondOsrDialog(boardId, accept, promptText)
    setDialog(boardId, null)
  }
  const commitPopup = (value: string): void => {
    void window.api.commitOsrPopup(boardId, value)
    setPopup(boardId, null)
  }
  const dismissPopup = (): void => {
    void window.api.dismissOsrPopup(boardId)
    setPopup(boardId, null)
  }

  return (
    <div
      ref={wrapRef}
      className={'bb-osr-layer' + (dialog ? ' bb-osr-layer-modal' : '')}
      // Click-away on a popup dismisses it (a real select closes on outside-click). A dialog is
      // modal — clicks on the scrim do nothing (use the buttons).
      onPointerDown={(e) => {
        if (popup && e.target === wrapRef.current) dismissPopup()
      }}
    >
      {dialog && <OsrJsDialog dialog={dialog} onRespond={respondDialog} />}
      {popup && frame.w > 0 && (
        <PositionedPopup
          popup={popup}
          pageW={pageW}
          pageH={pageH}
          frameW={frame.w}
          frameH={frame.h}
        >
          {popup.kind === 'select' && (
            <OsrSelectOverlay
              options={popup.options ?? []}
              value={popup.value}
              onCommit={commitPopup}
              onDismiss={dismissPopup}
            />
          )}
          {popup.kind === 'date' && (
            <OsrDatePicker value={popup.value} onCommit={commitPopup} onDismiss={dismissPopup} />
          )}
          {popup.kind === 'color' && (
            <OsrColorPicker value={popup.value} onCommit={commitPopup} onDismiss={dismissPopup} />
          )}
        </PositionedPopup>
      )}
    </div>
  )
}

/** Position a popup over the widget's page rect: anchored below by default, flipped above / clamped
 *  to stay inside the frame. Measures the popup after first render, so it starts invisible for one
 *  layout pass (pre-paint, no flash). `minWidth` keeps a `<select>` dropdown ≥ the field width. */
function PositionedPopup({
  popup,
  pageW,
  pageH,
  frameW,
  frameH,
  children
}: {
  popup: OsrPopupEvent
  pageW: number
  pageH: number
  frameW: number
  frameH: number
  children: ReactNode
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const a = pageRectToFrame(popup.rect, pageW, pageH, frameW, frameH)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      left: clampPopupLeft(a.x, el.offsetWidth, frameW),
      top: placePopupTop(a.y, a.y + a.h, el.offsetHeight, frameH)
    })
  }, [a.x, a.y, a.w, a.h, frameW, frameH])

  return (
    <div
      ref={ref}
      className="bb-osr-popup-pos"
      style={{
        left: pos ? pos.left : a.x,
        top: pos ? pos.top : a.y + a.h,
        minWidth: a.w,
        opacity: pos ? 1 : 0
      }}
    >
      {children}
    </div>
  )
}
