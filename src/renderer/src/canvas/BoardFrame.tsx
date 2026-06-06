/**
 * Shared board chrome shell (port of design-reference/boards.jsx `BoardFrame`).
 * One shell for all three board types — only the type glyph + content slot vary
 * (DESIGN.md §6). Renders two ways: the full chrome (title bar + content) and the
 * zoomed-out LOD card (glyph + tag + title + status dot). Purely presentational;
 * the canvas (React Flow node) owns position / drag / resize / selection state.
 */
import type { MouseEvent, ReactNode, ReactElement } from 'react'
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BoardType } from '../lib/boardSchema'
import { prefersReducedMotion } from '../lib/motion'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { BoardFullViewContext } from './fullViewContext'
import { Icon, type IconName } from './Icon'
import { TypeGlyph } from './TypeGlyph'

const TYPE_TAG: Record<BoardType, string> = {
  terminal: 'TERMINAL',
  browser: 'BROWSER',
  planning: 'PLANNING'
}

/** Status indicator: a coloured dot (`--ok` pulses) + optional mono label. */
export interface BoardStatus {
  /** A CSS colour token string, e.g. `'var(--ok)'`. */
  dot: string
  label?: string
}

/** 24×24 icon button used in the title-bar action slot. */
export function IconBtn({
  name,
  title,
  active = false,
  danger = false,
  size = 15,
  sw,
  restColor = 'var(--text-3)',
  onClick,
  onLongPress,
  longPressMs = 500,
  onContextMenu,
  onPointerDown
}: {
  name: IconName
  title: string
  active?: boolean
  danger?: boolean
  size?: number
  /** Stroke width override for the glyph (sparse glyphs like ⋯ need more ink to read). */
  sw?: number
  /** Resting (non-hover, non-active) icon colour. Default `--text-3`; the ⋯ overflow
   *  trigger uses `--text-2` so it isn't near-invisible at rest. */
  restColor?: string
  onClick?: (e: MouseEvent) => void
  /** Press-to-drag start (M2 connector handle): fires on pointer-down, before any
   *  click/long-press timing, so a press-drag-release that ends off the button still
   *  begins the gesture. Receives the down event (already stop-propagated from the drag). */
  onPointerDown?: (e: MouseEvent) => void
  /** Press-and-hold handler. When the pointer is held ≥`longPressMs`, this fires and the
   *  subsequent click (the release) is suppressed so `onClick` does NOT also run. */
  onLongPress?: () => void
  longPressMs?: number
  /** Right-click (context-menu) handler — an accessible, no-timing alternative to
   *  `onLongPress`. Suppresses the native context menu when set. */
  onContextMenu?: () => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  // Long-press: a timer armed on pointer-down fires onLongPress; `heldRef` then gates the
  // trailing click so a hold never doubles as a tap. Cleared on up/leave (= a short tap).
  const heldRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const clearTimer = (): void => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  // Cancel the long-press timer when the component unmounts (BUG-034): if the board is
  // removed while the 500ms timer is in flight, the callback must not fire on the dead tree.
  useEffect(() => () => clearTimer(), [])
  const handlePointerDown = (): void => {
    if (!onLongPress) return
    heldRef.current = false
    timerRef.current = window.setTimeout(() => {
      heldRef.current = true
      onLongPress()
    }, longPressMs)
  }
  const handleClick = (e: MouseEvent): void => {
    clearTimer()
    if (heldRef.current) {
      // A long-press already fired — swallow the release click.
      heldRef.current = false
      return
    }
    onClick?.(e)
  }
  const color = active
    ? 'var(--accent)'
    : danger && hover
      ? 'var(--err)'
      : hover
        ? 'var(--text-2)'
        : restColor
  return (
    <button
      title={title}
      onClick={handleClick}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              clearTimer()
              onContextMenu()
            }
          : undefined
      }
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        clearTimer() // pointer left the button before the hold fired → cancel
      }}
      // Accent ring on keyboard focus so the title-bar controls are visible to keyboard
      // users (matches the §6 board select-ring treatment).
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      // Stop the title-bar drag from starting when a control is pressed; also arm/disarm
      // the long-press timer on press/release.
      onMouseDown={(e) => {
        e.stopPropagation()
        handlePointerDown()
        onPointerDown?.(e)
      }}
      onMouseUp={clearTimer}
      style={{
        width: 24,
        height: 24,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 'var(--r-ctl)',
        border: '1px solid transparent',
        cursor: 'pointer',
        background: hover ? 'var(--surface-overlay)' : 'transparent',
        color,
        outline: 'none',
        boxShadow: focus ? '0 0 0 1.5px var(--accent)' : 'none',
        transition: 'color .1s, background .1s'
      }}
    >
      <Icon name={name} size={size} sw={sw} />
    </button>
  )
}

/** ⋯ overflow popover: Full view · Duplicate · Add/Remove group · Delete (DESIGN §6.1; S6). */
export function BoardMenu({
  boardId,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup
}: {
  /** This board's id — used to compute eligible groups (not already a member) + membership. */
  boardId?: string
  onFull?: (e: MouseEvent) => void
  onDuplicate?: () => void
  onDelete?: () => void
  /** S6: add this board to a group (the absorb re-pack). One item per eligible group. */
  onAddToGroup?: (groupId: string) => void
  /** S6: remove this board from every group it belongs to. Shown only when it is in one. */
  onRemoveFromGroup?: () => void
}): ReactElement {
  // S6: read groups live so the eligible-list / membership reflect the current state.
  const groups = useCanvasStore((s) => s.groups)
  const eligibleGroups =
    boardId && onAddToGroup ? groups.filter((g) => !g.boardIds.includes(boardId)) : []
  const inAnyGroup = !!boardId && groups.some((g) => g.boardIds.includes(boardId))
  const [open, setOpen] = useState(false)
  // Start off-screen; the layout effect below measures the real menu and clamps it
  // into the viewport before paint (bug 14 — no flash at the stale corner).
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // A native preview `WebContentsView` paints above ALL HTML — even this body-portaled
  // popover — so a menu dropping over a live Browser board's device stage renders under
  // it. Signal the preview layer to detach live views to their HTML snapshot while open,
  // then reattach on close (mirrors the node-gesture detach path). ADR 0002.
  const menuToken = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)
  useEffect(() => {
    setMenuOpen(menuToken, open)
    if (open) return () => setMenuOpen(menuToken, false)
  }, [open, setMenuOpen, menuToken])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    // Close on any outside pointerdown or Escape.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    // Reposition on scroll/resize while open (the canvas can pan under it).
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Position once the popover has mounted: right-align to the trigger, then clamp into
  // the viewport (left ≥ 8, right ≤ innerWidth − 8) and flip above the trigger if it
  // would overflow the bottom edge (bug 14 — was anchored by `right` with no clamp/flip).
  useLayoutEffect(() => {
    if (!open) return
    const t = triggerRef.current?.getBoundingClientRect()
    const m = menuRef.current?.getBoundingClientRect()
    if (!t || !m) return
    const PAD = 8
    let left = Math.min(t.right - m.width, window.innerWidth - m.width - PAD)
    left = Math.max(PAD, left)
    let top = t.bottom + 4
    if (top + m.height > window.innerHeight - PAD) {
      const flipped = t.top - m.height - 4
      top = flipped >= PAD ? flipped : Math.max(PAD, window.innerHeight - m.height - PAD)
    }
    setPos({ top, left })
  }, [open])

  const openMenu = (e: MouseEvent): void => {
    e.stopPropagation()
    setOpen((v) => !v)
  }

  const item = (label: string, danger: boolean, fn?: (e: MouseEvent) => void): ReactElement => (
    <button
      className="board-menu-item"
      data-danger={danger || undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        setOpen(false)
        fn?.(e)
      }}
    >
      {label}
    </button>
  )

  return (
    <div ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {/* The ⋯ dots are a near-inkless glyph; bump stroke + use a brighter rest colour so
          the overflow affordance is actually visible at rest (not only when clicked). */}
      <IconBtn
        name="more"
        title="More"
        active={open}
        size={16}
        sw={2.6}
        restColor="var(--text-2)"
        onClick={openMenu}
      />
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="board-menu"
            role="menu"
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {onFull && item('Full view', false, onFull)}
            {onDuplicate && item('Duplicate', false, () => onDuplicate())}
            {/* S6: one "Add to {name}" row per group this board is NOT already in. */}
            {onAddToGroup &&
              eligibleGroups.map((g) => (
                <span key={g.id} style={{ display: 'contents' }}>
                  {item(`Add to ${g.name}`, false, () => onAddToGroup(g.id))}
                </span>
              ))}
            {/* S6: remove from every group the board belongs to (shown only when in one). */}
            {onRemoveFromGroup && inAnyGroup && item('Remove from group', false, onRemoveFromGroup)}
            {onDelete && item('Delete', true, () => onDelete())}
          </div>,
          document.body
        )}
    </div>
  )
}

export interface BoardFrameProps {
  type: BoardType
  /** This board's id — threaded to the ⋯ menu for the S6 add/remove-group items. */
  boardId?: string
  title: string
  selected?: boolean
  hovered?: boolean
  dimmed?: boolean
  /** Render the zoomed-out LOD card instead of full chrome. */
  lod?: boolean
  /** This board is the one shown in the full-view modal → the maximize control
   *  flips to the EXIT affordance (restore glyph + "Exit full view (Esc)"). */
  fullView?: boolean
  running?: boolean
  status?: BoardStatus | null
  /** Per-type action controls shown left of maximize/⋯ in the title bar. */
  actions?: ReactNode
  /** Content-well background; `--inset` for Terminal, `--surface` otherwise. */
  contentBg?: string
  /** Provided only when the board is focusable → renders the maximize button. */
  onFull?: (e: MouseEvent) => void
  /** ⋯ menu → Duplicate. When provided alongside onFull/onDelete, the ⋯ button shows. */
  onDuplicate?: () => void
  /** ⋯ menu → Delete (danger). */
  onDelete?: () => void
  /** S6 ⋯ menu → add this board to a group (the absorb re-pack). */
  onAddToGroup?: (groupId: string) => void
  /** S6 ⋯ menu → remove this board from every group it belongs to. */
  onRemoveFromGroup?: () => void
  /** M2: begin a connector drag from this board (renders the title-bar connector handle). */
  onStartConnect?: () => void
  children?: ReactNode
}

export function BoardFrame({
  type,
  boardId,
  title,
  selected = false,
  hovered = false,
  dimmed = false,
  lod = false,
  fullView = false,
  running = false,
  status,
  actions,
  contentBg = 'var(--surface)',
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onStartConnect,
  children
}: BoardFrameProps): ReactElement {
  // Effective full-view: the explicit prop wins; otherwise read the ambient flag
  // BoardNode provides around this board's subtree (the per-type boards don't all
  // forward a prop). This is what lights the exit affordance at runtime.
  const ctxFullView = useContext(BoardFullViewContext)
  const isFullView = fullView || ctxFullView
  if (lod) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'var(--r-board)',
          background: 'var(--surface-raised)',
          // §6 selected = accent ring (box-shadow) only; border stays neutral.
          border: '1px solid var(--border-subtle)',
          boxShadow: selected
            ? '0 0 0 1.5px var(--accent), var(--shadow-board)'
            : 'var(--shadow-board)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 22px',
          opacity: dimmed ? 0.55 : 1,
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            color: 'var(--text-2)',
            flex: 'none',
            transform: 'scale(1.6)',
            transformOrigin: 'left center'
          }}
        >
          <TypeGlyph type={type} running={running} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              // §3 micro role — 10px is the on-canvas minimum (was 9px, below it).
              fontSize: 'var(--fs-micro)',
              letterSpacing: 'var(--tr-micro)',
              fontWeight: 'var(--fw-micro)',
              color: 'var(--text-faint)',
              fontFamily: 'var(--mono)'
            }}
          >
            {TYPE_TAG[type]}
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 2
            }}
          >
            {title}
          </div>
        </div>
        {status && (
          <span
            className={status.dot === 'var(--ok)' ? 'ca-pulse' : ''}
            style={{ width: 9, height: 9, borderRadius: 999, background: status.dot, flex: 'none' }}
          />
        )}
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'var(--r-board)',
        background: contentBg,
        overflow: 'hidden',
        // §6 selected = the 1.5px --accent ring (box-shadow) is the ONLY accent edge
        // treatment; the 1px border stays neutral (hover→--border else --border-subtle).
        border: `1px solid ${hovered ? 'var(--border)' : 'var(--border-subtle)'}`,
        boxShadow: selected
          ? '0 0 0 1.5px var(--accent), var(--shadow-board)'
          : 'var(--shadow-board)',
        opacity: dimmed ? 0.55 : 1,
        display: 'flex',
        flexDirection: 'column',
        // §9: board select ring animates 120ms ease-out (the ring is the box-shadow).
        // An inline transition can't be suppressed by the CSS reduced-motion @media, so
        // drop the box-shadow segment here when reduced motion is requested.
        transition: prefersReducedMotion()
          ? 'opacity .15s, border-color .1s'
          : 'opacity .15s, border-color .1s, box-shadow .12s ease-out'
      }}
    >
      {running && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            overflow: 'hidden',
            zIndex: 3
          }}
        >
          <div className="ca-progress-bar" />
        </div>
      )}

      {/* Title bar = the React Flow drag handle (see BoardNode `dragHandle`). */}
      <div
        className="board-titlebar"
        style={{
          height: 'var(--titlebar-h)',
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 10px',
          cursor: 'grab',
          background: selected ? 'var(--accent-wash)' : 'var(--surface-raised)',
          borderBottom: '1px solid var(--border-subtle)'
        }}
      >
        {/* The type glyph carries status: tinted to the status colour (green running /
            red failed / neutral idle). */}
        <span
          className={status?.dot === 'var(--ok)' && running ? 'ca-pulse' : ''}
          style={{
            color: status ? status.dot : selected ? 'var(--text-2)' : 'var(--text-3)',
            display: 'inline-flex',
            flex: 'none',
            transition: 'color .12s'
          }}
        >
          <TypeGlyph type={type} running={running} />
        </span>
        {/* Shrinkable middle (type tag + title + status label + per-type actions):
            collapses BEFORE the universal maximize/⋯ controls so the ⋯ trigger never
            clips off the title bar's right edge on a narrow board (bug 13). overflow:hidden
            keeps the tag + an overlong per-type cluster from pushing out / painting over
            the pinned controls. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden'
          }}
        >
          {/* §6 mandates a 10px micro type tag (TERMINAL/BROWSER/PLANNING) left of the
              title. Inside the shrinkable middle (the title collapses first) so a narrow
              board clips the tag rather than overflowing the pinned controls (menu-chrome). */}
          <span
            style={{
              fontSize: 'var(--fs-micro)',
              letterSpacing: 'var(--tr-micro)',
              fontWeight: 'var(--fw-micro)',
              color: 'var(--text-3)',
              fontFamily: 'var(--mono)',
              flex: 'none'
            }}
          >
            {TYPE_TAG[type]}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: selected ? 'var(--text)' : 'var(--text-2)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
              minWidth: 0
            }}
          >
            {title}
          </span>
          {/* Status label is on-demand: only while hovered or selected, kept calm at
              rest (the glyph colour carries the at-a-glance signal). */}
          {status?.label && (hovered || selected) && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--text-3)',
                whiteSpace: 'nowrap',
                flex: 'none'
              }}
            >
              {status.label}
            </span>
          )}
          {actions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
              {actions}
            </div>
          )}
        </div>
        {/* Universal controls, pinned at the far right — always visible & clickable. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
          {/* M2 connector handle — press-drag to draw an orchestration cable to another
              board. Pointer-down begins the gesture (Canvas tracks the rubber-band + drop
              target); hidden in full view (no canvas to drop onto). */}
          {onStartConnect && !isFullView && (
            <IconBtn
              name="connector"
              title="Draw a connector to another board"
              size={14}
              onPointerDown={() => onStartConnect()}
            />
          )}
          {/* In full view this same toggle is the EXIT affordance (USER DECISION
              2026-06-01: no separate top band) — restore glyph + an Esc-hinting title.
              onFull already toggles full view off. */}
          {onFull && (
            <IconBtn
              name={isFullView ? 'minimize' : 'maximize'}
              title={isFullView ? 'Exit full view (Esc)' : 'Full view'}
              size={14}
              onClick={onFull}
            />
          )}
          {(onFull || onDuplicate || onDelete || onAddToGroup || onRemoveFromGroup) && (
            <BoardMenu
              boardId={boardId}
              onFull={onFull}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onAddToGroup={onAddToGroup}
              onRemoveFromGroup={onRemoveFromGroup}
            />
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: contentBg }}>
        {children}
      </div>
    </div>
  )
}
