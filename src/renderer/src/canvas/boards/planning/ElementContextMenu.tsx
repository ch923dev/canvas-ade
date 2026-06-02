/**
 * Right-click context menu for the Planning whiteboard selection (W3). The single
 * action surface for duplicate/lock/group/align/distribute/delete. Rendered through a
 * portal to document.body at fixed (clientX, clientY) so it escapes the well's
 * overflow:hidden and the canvas transform. Closes on outside-pointerdown, Escape, an
 * action click, or any camera move. While open it registers a token in the preview
 * store's menu-open Set so an overlapping Browser board's native WebContentsView
 * detaches to a snapshot (the PREV-C ref-counted pattern; the always-on-top native
 * layer would otherwise paint over this HTML menu).
 */
import { useEffect, useId, type ReactElement, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useOnViewportChange } from '@xyflow/react'
import { usePreviewStore } from '../../../store/previewStore'
import { Icon, type AlignIconName } from '../../Icon'
import type { AlignEdge, DistributeAxis } from './align'

export interface MenuSelectionState {
  count: number
  allLocked: boolean
  grouped: boolean
  canGroup: boolean
}

export interface ElementContextMenuProps {
  x: number
  y: number
  sel: MenuSelectionState
  onDuplicate: () => void
  onToggleLock: () => void
  onGroup: () => void
  onUngroup: () => void
  onAlign: (edge: AlignEdge) => void
  onDistribute: (axis: DistributeAxis) => void
  onDelete: () => void
  onClose: () => void
}

const ALIGN_ITEMS: ReadonlyArray<{ edge: AlignEdge; icon: AlignIconName; label: string }> = [
  { edge: 'left', icon: 'align-left', label: 'Left' },
  { edge: 'centerX', icon: 'align-center-x', label: 'Center' },
  { edge: 'right', icon: 'align-right', label: 'Right' },
  { edge: 'top', icon: 'align-top', label: 'Top' },
  { edge: 'centerY', icon: 'align-center-y', label: 'Middle' },
  { edge: 'bottom', icon: 'align-bottom', label: 'Bottom' }
]

export function ElementContextMenu(props: ElementContextMenuProps): ReactElement {
  const { x, y, sel, onClose } = props
  const token = useId()
  // PREV-C ref-counted menu-open Set: register on open so an overlapping Browser
  // board's native view detaches to its (clippable) snapshot while the menu is up.
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  useEffect(() => {
    setMenuOpen(token, true)
    return () => setMenuOpen(token, false)
  }, [token, setMenuOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement | null
      if (!el?.closest('.pl-ctx-menu')) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  useOnViewportChange({ onChange: onClose })

  const run = (fn: () => void) => (): void => {
    fn()
    onClose()
  }

  return createPortal(
    <div
      className="pl-ctx-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 10000,
        minWidth: 184,
        padding: 4,
        background: 'var(--surface-raised, var(--surface))',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-inner)',
        boxShadow: 'var(--shadow-pop, 0 8px 28px rgba(0,0,0,0.35))',
        font: 'var(--t-body, 13px system-ui)',
        color: 'var(--text)'
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuRow label="Duplicate" hint="Ctrl+D" onClick={run(props.onDuplicate)} />
      <MenuRow
        label={sel.allLocked ? 'Unlock' : 'Lock'}
        hint="Ctrl+L"
        onClick={run(props.onToggleLock)}
      />
      {sel.canGroup && <MenuRow label="Group" hint="Ctrl+G" onClick={run(props.onGroup)} />}
      {sel.grouped && (
        <MenuRow label="Ungroup" hint="Ctrl+Shift+G" onClick={run(props.onUngroup)} />
      )}
      {sel.count >= 2 && (
        <>
          <Sep />
          <div className="t-meta" style={{ padding: '4px 8px 2px', color: 'var(--text-faint)' }}>
            Align
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(6, 1fr)',
              gap: 1,
              padding: '0 4px 2px'
            }}
          >
            {ALIGN_ITEMS.map((a) => (
              <button
                key={a.edge}
                type="button"
                title={a.label}
                onClick={run(() => props.onAlign(a.edge))}
                style={iconBtnStyle}
              >
                <Icon name={a.icon} size={14} />
              </button>
            ))}
          </div>
        </>
      )}
      {sel.count >= 3 && (
        <div style={{ display: 'flex', gap: 4, padding: '2px 4px 4px' }}>
          <MenuRow label="Distribute H" onClick={run(() => props.onDistribute('h'))} />
          <MenuRow label="Distribute V" onClick={run(() => props.onDistribute('v'))} />
        </div>
      )}
      <Sep />
      <MenuRow
        label="Delete"
        hint="Del"
        danger
        disabled={sel.allLocked}
        onClick={run(props.onDelete)}
      />
    </div>,
    document.body
  )
}

const iconBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 26,
  border: 'none',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 4,
  cursor: 'pointer'
}

function Sep(): ReactElement {
  return <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
}

function MenuRow({
  label,
  hint,
  onClick,
  danger,
  disabled
}: {
  label: string
  hint?: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        gap: 16,
        padding: '5px 8px',
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        borderRadius: 4,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        color: danger ? 'var(--danger, #e5484d)' : 'var(--text)'
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--inset)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span>{label}</span>
      {hint && (
        <span className="t-meta" style={{ color: 'var(--text-faint)' }}>
          {hint}
        </span>
      )}
    </button>
  )
}
