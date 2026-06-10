/**
 * Right-click context menu for Planning whiteboard elements (W3) — also reused as the
 * terminal well's context menu (TerminalBoard). PURELY presentational: the board builds
 * `entries` + element mutations; this renders them through the shared <Menu> shell
 * (D1-C) positioned at the pointer's RAW screen coords (clientX/clientY — never mapped
 * through `toBoard`, so the camera-transform coordinate trap can't bite). The shell
 * supplies the body portal, the unified viewport clamp (flip up/left near an edge),
 * Escape / outside-pointerdown / resize close, menuitem roving tabindex + arrow-key
 * navigation, and the ADR 0002 detach-live-previews-while-open signal — which closes
 * this menu's old known limitation (a live Browser board's native view elsewhere on the
 * canvas used to paint above it).
 */
import { type ReactElement } from 'react'
import { Icon, type IconName } from '../../Icon'
import { Menu } from '../../Menu'

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

export interface MenuSwatchRowEntry {
  kind: 'swatchRow'
  id: string
  label: string
  disabled?: boolean
  swatches: {
    id: string
    title: string
    /** Swatch face colour (the tint's note fill). */
    fill: string
    /** 1px swatch border (the tint's note edge). */
    edge: string
    /** True when every targeted note already carries this tint (accent ring). */
    current?: boolean
    onSelect: () => void
  }[]
}

export type MenuEntry = MenuActionEntry | MenuIconRowEntry | MenuSwatchRowEntry

interface Props {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}

const MENU_W = 184

export function ElementContextMenu({ x, y, entries, onClose }: Props): ReactElement {
  const pick = (fn: () => void): void => {
    fn()
    onClose()
  }

  return (
    <Menu
      anchor={{ x, y }}
      onClose={onClose}
      label="Element actions"
      className="w3-menu"
      reclampKey={entries.length}
      style={{
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
        ) : entry.kind === 'swatchRow' ? (
          <div
            key={entry.id}
            className="w3-row"
            data-w3-menu-row={entry.id}
            data-disabled={entry.disabled ? '' : undefined}
          >
            <span className="w3-row-label">{entry.label}</span>
            <span className="w3-row-btns">
              {entry.swatches.map((s) => (
                <button
                  key={s.id}
                  data-testid={`w3-menu-${entry.id}-${s.id}`}
                  data-current={s.current ? '' : undefined}
                  role="menuitem"
                  className="w3-swatch"
                  title={s.current ? `${s.title} (current)` : s.title}
                  aria-label={s.current ? `${s.title} (current)` : s.title}
                  disabled={entry.disabled}
                  style={{ background: s.fill, border: `1px solid ${s.edge}` }}
                  onClick={() => !entry.disabled && pick(s.onSelect)}
                />
              ))}
            </span>
          </div>
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
                  role="menuitem"
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
    </Menu>
  )
}

// Scoped to .w3-menu so it can't leak. Higher-contrast than the first cut: a
// visible border, hover feedback on every control, and — critically — an explicit
// `color` on the icon buttons so the stroke="currentColor" glyphs actually render
// (they were near-invisible dark-on-dark before).
const MENU_CSS = `
.w3-menu .w3-mi {
  display: block; width: 100%; text-align: left;
  padding: 6px 8px; border: none; border-radius: var(--r-ctl);
  background: transparent; color: var(--text); font: inherit; cursor: pointer;
}
.w3-menu .w3-mi:hover:not(:disabled) { background: var(--surface-raised); }
.w3-menu .w3-mi:focus-visible { outline: none; box-shadow: 0 0 0 1.5px var(--accent); }
.w3-menu .w3-mi.danger { color: var(--err); }
.w3-menu .w3-mi.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--err) 12%, transparent); }
.w3-menu .w3-mi:disabled { color: var(--text-faint); cursor: default; }
.w3-menu .w3-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; }
.w3-menu .w3-row-label { color: var(--text-2); font-size: 12px; min-width: 60px; }
.w3-menu .w3-row[data-disabled] .w3-row-label { color: var(--text-faint); }
.w3-menu .w3-row-btns { display: inline-flex; gap: 4px; }
.w3-menu .w3-ib {
  display: inline-flex; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--r-ctl); background: var(--surface-raised);
  color: var(--text-2); cursor: pointer;
}
.w3-menu .w3-ib:hover:not(:disabled) {
  background: var(--accent-wash); color: var(--text); border-color: var(--accent);
}
.w3-menu .w3-ib:focus-visible { outline: none; box-shadow: 0 0 0 1.5px var(--accent); }
.w3-menu .w3-ib:disabled { color: var(--text-faint); opacity: 0.5; cursor: default; }
.w3-menu .w3-swatch {
  width: 16px; height: 16px; padding: 0;
  border-radius: var(--r-ctl); cursor: pointer;
}
.w3-menu .w3-swatch[data-current] { box-shadow: 0 0 0 1.5px var(--accent); }
.w3-menu .w3-swatch:hover:not(:disabled),
.w3-menu .w3-swatch:focus-visible { outline: none; box-shadow: 0 0 0 1.5px var(--accent); }
.w3-menu .w3-swatch:disabled { opacity: 0.5; cursor: default; }
`
