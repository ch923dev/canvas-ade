/**
 * Shared popover-menu shell (D1-C). One implementation of the popover discipline every
 * menu in the app used to hand-roll: body portal, measure-then-clamp into the viewport,
 * Escape / outside-pointerdown / resize dismissal, `menuitem` roving tabindex + arrow-key
 * navigation, focus restore on close, and — critically — detaching live Browser previews
 * while open (a native WebContentsView paints above ALL HTML, so any popover dropping
 * over a live device stage would render under it; ADR 0002, token-keyed per PREV-C).
 *
 * Purely a shell: callers render their own items — any element carrying
 * `role="menuitem"` joins the roving focus order (disabled items are skipped) — and keep
 * their own item styling. The container stops pointer/mouse/click propagation so canvas
 * gestures (React Flow drag, planning pointer tools) never see menu interactions.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../store/previewStore'
import { clampMenuToViewport, type AnchorInput, type MenuPlacement } from './menuPlacement'

/** Point anchor (context menus, opened at the pointer) or trigger anchor (dropdowns,
 *  opened under a trigger element — pass the ref that wraps the trigger; pointerdowns
 *  inside it are excluded from outside-close so the trigger's own click can toggle). */
export type MenuAnchor = { x: number; y: number } | RefObject<HTMLElement | null>

export interface MenuProps {
  anchor: MenuAnchor
  /** Trigger-anchored horizontal alignment (default 'right' — right edges line up). */
  align?: 'left' | 'right'
  /** Trigger-anchored vertical gap below/above the trigger (default 4). */
  gap?: number
  onClose: () => void
  /** Accessible name for the menu. */
  label?: string
  className?: string
  /** Merged into the shell's container styles. The shell's positioning (position/top/
   *  left/maxHeight/overflowY) always wins — typed out so a caller can't silently break
   *  the viewport clamp; zIndex IS caller-overridable (default 250). */
  style?: Omit<CSSProperties, 'position' | 'top' | 'left'>
  /** Re-run the measure+clamp when this changes (async content, e.g. a recents list). */
  reclampKey?: unknown
  /** Move focus to the first menuitem on open (default true; closing restores focus). */
  autoFocus?: boolean
  children: ReactNode
}

function isRefAnchor(a: MenuAnchor): a is RefObject<HTMLElement | null> {
  return 'current' in a
}

export function Menu({
  anchor,
  align = 'right',
  gap = 4,
  onClose,
  label,
  className,
  style,
  reclampKey,
  autoFocus = true,
  children
}: MenuProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  // Start off-screen; the layout effect measures the real menu and clamps it into the
  // viewport before paint (no flash at a stale corner).
  const [pos, setPos] = useState<MenuPlacement>({ top: -9999, left: -9999, maxHeight: 0 })

  // ADR 0002: signal the preview layer to detach live native views to their HTML
  // snapshot while this menu is open, then reattach on close. Token-keyed so closing
  // one popover can't reattach views under another still-open one (PREV-C).
  const token = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)
  useEffect(() => {
    setMenuOpen(token, true)
    return () => setMenuOpen(token, false)
  }, [token, setMenuOpen])

  // Focus restore: capture what was focused when the menu opened; put it back on close
  // when the close left focus dangling (on <body> / inside the removed menu). A close
  // caused by clicking a focusable target keeps that target's focus.
  const prevFocusRef = useRef<Element | null>(document.activeElement)
  useEffect(() => {
    const menuEl = ref.current
    const prev = prevFocusRef.current
    return () => {
      const active = document.activeElement
      const dangling = !active || active === document.body || (menuEl?.contains(active) ?? false)
      if (!dangling || !(prev instanceof HTMLElement)) return
      // Deferred one tick: this cleanup runs mid-commit, where the previous element can
      // be transiently unfocusable (xterm's helper textarea after a terminal-board
      // re-render) — focus() on such an element is a SILENT no-op (no event, focus stays
      // on <body>). Re-check on the next macrotask that nothing else claimed focus.
      window.setTimeout(() => {
        const a = document.activeElement
        if ((!a || a === document.body) && prev.isConnected) prev.focus()
      }, 0)
    }
  }, [])

  const point = isRefAnchor(anchor) ? null : anchor

  // Measure + clamp before paint; re-runs when the anchor moves or content changes.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Reset before measuring — re-clamping with a previously-applied cap would compound.
    el.style.maxHeight = ''
    const m = el.getBoundingClientRect()
    const input: AnchorInput = point
      ? { point, align, gap }
      : (() => {
          const t = (anchor as RefObject<HTMLElement | null>).current?.getBoundingClientRect()
          return t
            ? {
                trigger: { top: t.top, left: t.left, right: t.right, bottom: t.bottom },
                align,
                gap
              }
            : { align, gap }
        })()
    const next = clampMenuToViewport(
      input,
      { width: m.width, height: m.height },
      window.innerWidth,
      window.innerHeight
    )
    // Point anchors arrive as fresh object literals each render — bail on no-ops so the
    // effect can depend on them without a setState→render loop.
    setPos((p) =>
      p.top === next.top && p.left === next.left && p.maxHeight === next.maxHeight ? p : next
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- point?.x/y are the value deps for literal anchors
  }, [point?.x, point?.y, anchor, align, gap, reclampKey])

  // Dismissal: Escape, outside pointerdown, resize (the canvas can pan/zoom under an
  // anchored menu). Pointerdown listens in the CAPTURE phase with a contains() check, so
  // a stopPropagation anywhere in the app can't strand an open menu; the trigger element
  // is excluded so its own click handler can toggle the menu closed (BUG-045 class).
  //
  // MOUNT-STABLE on purpose — the handlers read `onClose`/`anchor` through refs instead
  // of effect deps. Callers pass inline closures, so dep-driven re-subscription would
  // remove the listener whenever the owner re-renders — including SYNCHRONOUSLY in the
  // middle of the very keydown being handled: an earlier window listener (e.g.
  // useCanvasKeybindings' Escape→clearSelection) writes the zustand store, and React's
  // useSyncExternalStore flushes that re-render mid-dispatch. A listener removed
  // mid-dispatch never fires (DOM spec), so the Escape that should close the menu was
  // silently swallowed (caught by groups.e2e.ts:150 on the GroupContextMenu migration;
  // the old per-menu copies dodged it only because they listened on `document`, which
  // bubbles before `window`).
  const onCloseRef = useRef(onClose)
  const anchorRef = useRef(anchor)
  useEffect(() => {
    onCloseRef.current = onClose
    anchorRef.current = anchor
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      const a = anchorRef.current
      if (isRefAnchor(a) && a.current?.contains(t)) return
      onCloseRef.current()
    }
    const close = (): void => onCloseRef.current()
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', close)
    }
  }, [])

  /** Enabled menuitems in DOM order — the roving focus ring. */
  const items = (): HTMLElement[] =>
    ref.current
      ? Array.from(ref.current.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
          (el) => !(el as HTMLElement & { disabled?: boolean }).disabled
        )
      : []

  const setRoving = (active: HTMLElement | null): void => {
    const list = items()
    for (const el of list) el.tabIndex = el === active ? 0 : -1
  }

  // Roving tabindex: keep exactly one item tabbable. Runs every commit (items can be
  // dynamic — disabled state, async lists) and keeps the current stop if still present.
  useLayoutEffect(() => {
    const list = items()
    if (list.length === 0) return
    setRoving(list.find((el) => el.tabIndex === 0) ?? list[0])
  })

  // Initial focus → first item (once, on open). :focus-visible heuristics keep the ring
  // calm for mouse-opened menus while keyboard users see where they are.
  useEffect(() => {
    if (autoFocus) items()[0]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const list = items()
    if (list.length === 0) return
    const idx = list.indexOf(document.activeElement as HTMLElement)
    let next = -1
    // ArrowLeft/Right intentionally alias Up/Down (a deliberate APG deviation): no menu
    // here has submenus — the keys ←/→ are reserved for in the spec — and the Tidy preset
    // picker is a 2-D thumbnail grid where horizontal arrows are the natural walk. One
    // shell, one behavior; revisit if submenus ever land.
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight')
      next = idx < 0 ? 0 : (idx + 1) % list.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
      next = idx < 0 ? list.length - 1 : (idx - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    else if (e.key === 'Tab') {
      // ARIA menu pattern: Tab leaves (closes) the menu rather than walking its items.
      e.preventDefault()
      onClose()
      return
    }
    if (next >= 0) {
      e.preventDefault()
      e.stopPropagation()
      list[next].focus()
      setRoving(list[next])
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={className}
      style={{
        zIndex: 250, // above the fullview-scrim (200); callers may override via `style`
        ...style,
        // Shell positioning LAST so a caller's style can never break the viewport clamp
        // (top/left are also typed out of the style prop).
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        maxHeight: pos.maxHeight || undefined,
        overflowY: 'auto'
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const t = e.target as HTMLElement
        if (t.getAttribute('role') === 'menuitem') setRoving(t)
      }}
    >
      {children}
    </div>,
    document.body
  )
}
