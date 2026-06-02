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
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-inner)',
        boxShadow: 'var(--shadow-pop)',
        font: 'inherit'
      }}
    >
      <style>{MENU_CSS}</style>
      {entries.map((entry) =>
        entry.kind === 'action' ? (
          <button
            key={entry.id}
            data-testid={`w3-menu-${entry.id}`}
            role="menuitem"
            className={`w3-mi${entry.danger ? ' danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => !entry.disabled && pick(entry.onSelect)}
          >
            {entry.label}
          </button>
        ) : (
          <div
            key={entry.id}
            className="w3-row"
            data-w3-menu-row={entry.id}
            data-disabled={entry.disabled ? '' : undefined}
          >
            <span className="w3-row-label">{entry.label}</span>
            <span className="w3-row-btns">
              {entry.buttons.map((b) => (
                <button
                  key={b.id}
                  data-testid={`w3-menu-${entry.id}-${b.id}`}
                  className="w3-ib"
                  title={b.title}
                  disabled={entry.disabled}
                  onClick={() => !entry.disabled && pick(b.onSelect)}
                >
                  <Icon name={b.icon as IconName} size={14} />
                </button>
              ))}
            </span>
          </div>
        )
      )}
    </div>,
    document.body
  )
}

// Scoped to [data-w3-menu] so it can't leak. Higher-contrast than the first cut: a
// visible border, hover feedback on every control, and — critically — an explicit
// `color` on the icon buttons so the stroke="currentColor" glyphs actually render
// (they were near-invisible dark-on-dark before).
const MENU_CSS = `
[data-w3-menu] .w3-mi {
  display: block; width: 100%; text-align: left;
  padding: 6px 8px; border: none; border-radius: var(--r-ctl);
  background: transparent; color: var(--text); font: inherit; cursor: pointer;
}
[data-w3-menu] .w3-mi:hover:not(:disabled) { background: var(--surface-raised); }
[data-w3-menu] .w3-mi.danger { color: var(--err); }
[data-w3-menu] .w3-mi.danger:hover:not(:disabled) { background: rgba(242, 84, 91, 0.12); }
[data-w3-menu] .w3-mi:disabled { color: var(--text-faint); cursor: default; }
[data-w3-menu] .w3-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; }
[data-w3-menu] .w3-row-label { color: var(--text-2); font-size: 12px; min-width: 60px; }
[data-w3-menu] .w3-row[data-disabled] .w3-row-label { color: var(--text-faint); }
[data-w3-menu] .w3-row-btns { display: inline-flex; gap: 4px; }
[data-w3-menu] .w3-ib {
  display: inline-flex; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--r-ctl); background: var(--surface-raised);
  color: var(--text-2); cursor: pointer;
}
[data-w3-menu] .w3-ib:hover:not(:disabled) {
  background: var(--accent-wash); color: var(--text); border-color: var(--accent);
}
[data-w3-menu] .w3-ib:disabled { color: var(--text-faint); opacity: 0.5; cursor: default; }
`
