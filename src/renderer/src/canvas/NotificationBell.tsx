import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  selectBadgeTier,
  selectUnreadCount,
  useNotificationCenterStore,
  type NotificationItem
} from '../store/notificationCenterStore'
import { useAttentionStore } from '../store/attentionStore'
import { focusBoardFromNotification } from '../store/useNotifications'
import { relAge } from '../lib/recapFormat'
import { isE2E } from '../smoke/e2eRegistry'
import { registerChromeOverlayCloser } from '../smoke/chromeOverlayGate'
import { Menu } from './Menu'
import { ToolBtn } from './ToolBtn'

/**
 * The camera-cluster notification bell (PR2 of the notifications audit; design = the signed-off
 * mock). Trigger = a standard ToolBtn with the unread-count badge (.jtab-badge recipe in the
 * UpdateBadgeDot corner-anchor idiom); panel = the shared Menu shell listing the session history
 * newest-first. Whole row = Focus (which selects → sync rule 2 reads the board's rows and clears
 * its ring); the footer's "Mark all as read" clears BOTH unread halves — bell items and every
 * on-canvas attention ring / Jarvis badge (the ONE unread model the user chose).
 *
 * Owns its own store subscriptions (AppChrome's memo contract: chrome children subscribe for
 * themselves so the memoized parent never re-renders on store churn).
 */
export function NotificationBell(): ReactElement {
  const [open, setOpen] = useState(false)
  // Row ages are computed against the clock AT OPEN (impure-in-render lint; a live ticker isn't
  // worth a re-render loop — relAge is coarse and the panel is short-lived).
  const [openedAt, setOpenedAt] = useState(0)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const items = useNotificationCenterStore((s) => s.items)
  const unread = selectUnreadCount(items)
  const tier = selectBadgeTier(items)

  // e2e isolation seam: reset() must be able to close a left-open panel (an open Menu owns
  // window-level capture listeners — a leaked one steals the next spec's Escape). Same
  // registration AppChrome uses; production builds register nothing.
  useEffect(() => {
    if (!isE2E()) return
    return registerChromeOverlayCloser(() => setOpen(false))
  }, [])

  const focusRow = (item: NotificationItem): void => {
    useNotificationCenterStore.getState().markRead(item.id)
    setOpen(false)
    focusBoardFromNotification(item.boardId)
  }

  const markAll = (): void => {
    // The ONE unread model: the user asserted they saw everything — bell rows read, every
    // canvas ring / Jarvis badge dropped, `canvas://attention` republished as settled.
    useNotificationCenterStore.getState().markAllRead()
    useAttentionStore.getState().clearAll()
  }

  return (
    <span ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <ToolBtn
        name="bell"
        title="Notifications"
        active={open}
        expanded={open}
        onClick={() => {
          setOpenedAt(Date.now())
          setOpen((v) => !v)
        }}
        dataTest="notification-bell"
        ariaLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      />
      {unread > 0 && tier !== null && (
        <span className="nb-badge" data-tier={tier} data-test="notification-badge">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      {open && (
        <Menu
          anchor={triggerRef}
          align="right"
          gap={6}
          onClose={() => setOpen(false)}
          label="Notifications"
          className="nb-menu"
          reclampKey={items.length}
        >
          <div className="nb-head">Notifications</div>
          {items.length === 0 ? (
            <div className="nb-empty">
              <div className="nb-empty-t">No notifications yet</div>
              <div className="nb-empty-s">
                Agent activity — done, needs input, blocked, errors — shows up here.
              </div>
            </div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                role="menuitem"
                className="nb-row"
                data-read={item.read}
                data-test="nb-row"
                onClick={() => focusRow(item)}
              >
                <span className="nb-dot" data-kind={item.kind} aria-hidden="true" />
                <span className="nb-main">
                  <span className="nb-msg">{item.message}</span>
                  <span className="nb-meta">
                    <span className="nb-board">{item.boardTitle}</span>
                    <span>{relAge(openedAt - item.at)}</span>
                  </span>
                </span>
                <span className="nb-unreaddot" aria-hidden="true" />
              </button>
            ))
          )}
          <div className="nb-divider" aria-hidden="true" />
          <button
            role="menuitem"
            className="nb-markall"
            data-test="nb-markall"
            disabled={unread === 0}
            onClick={markAll}
          >
            Mark all as read
          </button>
        </Menu>
      )}
    </span>
  )
}
