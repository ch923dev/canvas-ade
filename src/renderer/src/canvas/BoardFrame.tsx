/**
 * Shared board chrome shell (port of design-reference/boards.jsx `BoardFrame`).
 * One shell for all three board types — only the type glyph + content slot vary
 * (DESIGN.md §6). Renders two ways: the full chrome (title bar + content) and the
 * zoomed-out LOD card (glyph + tag + title + status dot). Purely presentational;
 * the canvas (React Flow node) owns position / drag / resize / selection state.
 */
import type { MouseEvent, ReactNode, ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BoardType } from '../lib/boardSchema'
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
  onClick
}: {
  name: IconName
  title: string
  active?: boolean
  danger?: boolean
  size?: number
  onClick?: (e: MouseEvent) => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  const color = active
    ? 'var(--accent)'
    : danger && hover
      ? 'var(--err)'
      : hover
        ? 'var(--text-2)'
        : 'var(--text-3)'
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Stop the title-bar drag from starting when a control is pressed.
      onMouseDown={(e) => e.stopPropagation()}
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
        transition: 'color .1s, background .1s'
      }}
    >
      <Icon name={name} size={size} />
    </button>
  )
}

/** ⋯ overflow popover: Full view · Duplicate · Delete (DESIGN §6.1). */
export function BoardMenu({
  onFull,
  onDuplicate,
  onDelete
}: {
  onFull?: (e: MouseEvent) => void
  onDuplicate?: () => void
  onDelete?: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)

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

  const openMenu = (e: MouseEvent): void => {
    e.stopPropagation()
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
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
      <IconBtn name="more" title="More" active={open} onClick={openMenu} />
      {open &&
        createPortal(
          <div
            className="board-menu"
            role="menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {onFull && item('Full view', false, onFull)}
            {onDuplicate && item('Duplicate', false, () => onDuplicate())}
            {onDelete && item('Delete', true, () => onDelete())}
          </div>,
          document.body
        )}
    </div>
  )
}

export interface BoardFrameProps {
  type: BoardType
  title: string
  selected?: boolean
  hovered?: boolean
  dimmed?: boolean
  /** Render the zoomed-out LOD card instead of full chrome. */
  lod?: boolean
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
  children?: ReactNode
}

export function BoardFrame({
  type,
  title,
  selected = false,
  hovered = false,
  dimmed = false,
  lod = false,
  running = false,
  status,
  actions,
  contentBg = 'var(--surface)',
  onFull,
  onDuplicate,
  onDelete,
  children
}: BoardFrameProps): ReactElement {
  if (lod) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'var(--r-board)',
          background: 'var(--surface-raised)',
          border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
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
              fontSize: 9,
              letterSpacing: '0.08em',
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
        border: `1px solid ${
          selected ? 'var(--accent)' : hovered ? 'var(--border)' : 'var(--border-subtle)'
        }`,
        boxShadow: selected
          ? '0 0 0 1.5px var(--accent), var(--shadow-board)'
          : 'var(--shadow-board)',
        opacity: dimmed ? 0.55 : 1,
        display: 'flex',
        flexDirection: 'column',
        transition: 'opacity .15s, border-color .1s'
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
        {/* The type glyph itself carries status: tinted to the status colour (green
            running / red failed / neutral idle), so no separate persistent status dot
            or uppercase type tag is needed — the glyph + title already say the type. */}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
          {actions}
          {onFull && <IconBtn name="maximize" title="Full view" size={14} onClick={onFull} />}
          {(onFull || onDuplicate || onDelete) && (
            <BoardMenu onFull={onFull} onDuplicate={onDuplicate} onDelete={onDelete} />
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: contentBg }}>
        {children}
      </div>
    </div>
  )
}
