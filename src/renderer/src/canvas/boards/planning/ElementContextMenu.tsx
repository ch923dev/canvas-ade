/**
 * Right-click context menu for Planning whiteboard elements (W3). PURELY
 * presentational: the board builds `entries` + element mutations; this renders them
 * into a `document.body` portal positioned at the pointer's RAW screen coords
 * (clientX/clientY — never mapped through `toBoard`, so the camera-transform
 * coordinate trap can't bite), clamped to the viewport, and closing on
 * Escape / outside-pointerdown. Calm one-accent styling via existing tokens.
 *
 * Known minor limitation: a Browser board's native WebContentsView elsewhere on the
 * canvas paints above this HTML menu if it opens directly over one (rare, transient);
 * fully solving it would touch previewStore (out of this branch's zone).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../Icon'

export interface MenuActionEntry {
  kind: 'action'
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

export interface MenuIconRowEntry {
  kind: 'iconRow'
  id: string
  label: string
  disabled?: boolean
  buttons: { id: string; title: string; icon: string; onSelect: () => void }[]
}

export type MenuEntry = MenuActionEntry | MenuIconRowEntry

interface Props {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}

const MENU_W = 184

export function ElementContextMenu({ x, y, entries, onClose }: Props): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Clamp to the viewport after first layout (flip up/left near an edge).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = x + r.width > window.innerWidth ? Math.max(4, x - r.width) : x
    const ny = y + r.height > window.innerHeight ? Math.max(4, y - r.height) : y
    setPos({ x: nx, y: ny })
  }, [x, y, entries.length])

  // Escape + outside-pointerdown close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  const pick = (fn: () => void): void => {
    fn()
    onClose()
  }

  return createPortal(
    <div
      ref={ref}
      data-w3-menu
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: MENU_W,
        zIndex: 9999,
        padding: 4,
        background: 'var(--surface-raised, var(--surface))',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-inner)',
        boxShadow: 'var(--shadow-pop, 0 6px 24px rgba(0,0,0,0.35))',
        font: 'inherit'
      }}
    >
      {entries.map((entry) =>
        entry.kind === 'action' ? (
          <button
            key={entry.id}
            data-testid={`w3-menu-${entry.id}`}
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => !entry.disabled && pick(entry.onSelect)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '6px 8px',
              border: 'none',
              borderRadius: 'var(--r-inner)',
              background: 'transparent',
              color: entry.disabled
                ? 'var(--text-faint)'
                : entry.danger
                  ? 'var(--danger, #e5484d)'
                  : 'var(--text)',
              cursor: entry.disabled ? 'default' : 'pointer',
              font: 'inherit'
            }}
          >
            {entry.label}
          </button>
        ) : (
          <div
            key={entry.id}
            data-w3-menu-row={entry.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              opacity: entry.disabled ? 0.4 : 1
            }}
          >
            <span style={{ color: 'var(--text-faint)', fontSize: 11, minWidth: 56 }}>
              {entry.label}
            </span>
            {entry.buttons.map((b) => (
              <button
                key={b.id}
                data-testid={`w3-menu-${entry.id}-${b.id}`}
                title={b.title}
                disabled={entry.disabled}
                onClick={() => !entry.disabled && pick(b.onSelect)}
                style={{
                  display: 'inline-flex',
                  padding: 3,
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--r-inner)',
                  background: 'var(--inset)',
                  cursor: entry.disabled ? 'default' : 'pointer'
                }}
              >
                <Icon name={b.icon as IconName} size={13} />
              </button>
            ))}
          </div>
        )
      )}
    </div>,
    document.body
  )
}
