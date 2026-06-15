/**
 * Shared modal primitive (design-audit D1-B, finding A7). One scrim/portal/Esc/focus
 * implementation for ConfirmModal / RecapConsentModal / SettingsModal — replaces the three
 * hand-rolled copies and their hardcoded scrims (0.5 / .45 / .4 black) with the `--scrim`
 * token. FullViewModal is deliberately NOT on this primitive: its 0.66 scrim is a full-bleed
 * workspace overlay, intentionally heavier than a modal (approved 2026-06-10).
 *
 * Focus contract (A7): on mount, focus moves to `initialFocusRef` or the first enabled
 * focusable in the card; Tab/Shift+Tab wrap inside the card; on unmount, focus returns to
 * the element focused before the modal opened.
 *
 * Esc contract: a bubble-phase window listener, NEVER capture — the full-view Esc listener
 * in useCanvasKeybindings captures on window and must keep beating xterm, and it yields to a
 * `[data-confirm-active]` gate (BUG-005) so Esc reaches this listener to deny a pending
 * dangerous MCP confirm first. `confirmGate` marks the scrim with that attribute.
 */
import {
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

/** Enabled, tabbable controls — the trap edges and the initial-focus fallback. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Pass-through attrs for the scrim/card divs. The handlers Modal itself owns (the scrim's
 *  pointerdown dismiss, the card's Tab trap) AND `style` are omitted so nothing a caller
 *  passes is silently swallowed by Modal's own attributes — `cardStyle` is the one supported
 *  style override; the scrim's chrome is fully Modal-owned. */
type DivProps = Omit<HTMLAttributes<HTMLDivElement>, 'onPointerDown' | 'onKeyDown' | 'style'> & {
  [key: `data-${string}`]: string | undefined
}

export interface ModalProps {
  /** Accessible dialog name (`aria-label`). */
  label: string
  /** Called on Esc and on a scrim pointerdown. No-op while `closeDisabled`. */
  onClose: () => void
  /** Busy lock: blocks Esc + scrim close and shows a wait cursor (BUG-007(5)). */
  closeDisabled?: boolean
  /** Stacking order of the scrim — each call site keeps its established layer. */
  zIndex: number
  /**
   * Marks the scrim `[data-confirm-active]` so the full-view capture-phase Esc listener
   * yields this Esc to the modal (fail-closed deny of a pending MCP confirm, BUG-005).
   * Only ConfirmModal sets this.
   */
  confirmGate?: boolean
  /** Wins over the first-focusable default for initial focus. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Extra attributes for the scrim div (test ids). */
  scrimProps?: DivProps
  /** Extra attributes for the dialog card div (test ids). */
  cardProps?: DivProps
  /** Merged over the default card chrome (width/padding/layout per call site). */
  cardStyle?: CSSProperties
  children: ReactNode
}

export function Modal({
  label,
  onClose,
  closeDisabled = false,
  zIndex,
  confirmGate = false,
  initialFocusRef,
  scrimProps,
  cardProps,
  cardStyle,
  children
}: ModalProps): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null)

  // A7: initial focus on mount, restore on unmount. Mount-only — the queue-advancing
  // ConfirmModal keeps one mounted Modal across requests and must not re-steal focus.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const card = cardRef.current
    const target = initialFocusRef?.current ?? card?.querySelector<HTMLElement>(FOCUSABLE) ?? card
    target?.focus()
    return () => {
      // The opener can be gone by close time (e.g. a board was deleted) — only restore to
      // a node still in the document.
      if (previous && previous.isConnected) previous.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design (see above)
  }, [])

  // Esc closes (bubble phase — see the header contract). Registered ONCE, reading the live
  // props through refs: with `[onClose, closeDisabled]` deps the listener is removed +
  // re-added on every parent re-render, and the canvas keybindings' window listener
  // (registered earlier, also Esc) triggers a SYNCHRONOUS useSyncExternalStore commit
  // mid-dispatch — the DOM skips a listener removed during dispatch, so a real OS Esc never
  // reached a deps-churned listener (caught by modal.e2e.ts; invisible to jsdom tests).
  const onCloseRef = useRef(onClose)
  const closeDisabledRef = useRef(closeDisabled)
  useEffect(() => {
    onCloseRef.current = onClose
    closeDisabledRef.current = closeDisabled
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || closeDisabledRef.current) return
      e.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A7: keep Tab inside the card, wrapping at both edges.
  const onTrapTab = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    const card = cardRef.current
    if (!card) return
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) {
      e.preventDefault()
      card.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey) {
      if (active === first || !card.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else if (active === last || !card.contains(active)) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      {...scrimProps}
      {...(confirmGate ? { 'data-confirm-active': '' } : {})}
      onPointerDown={() => {
        if (!closeDisabled) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--scrim)',
        cursor: closeDisabled ? 'wait' : 'default'
      }}
    >
      <div
        {...cardProps}
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onTrapTab}
        style={{
          background: 'var(--surface-raised)',
          color: 'var(--text)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-ctl)',
          boxShadow: 'var(--shadow-pop)',
          fontFamily: 'var(--ui)',
          ...cardStyle
        }}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
