/**
 * Browser viewport control — the title-bar segmented (Mobile · Tablet + a desktop-size dropdown)
 * that sets `board.viewport`. Extracted verbatim from BrowserBoard.tsx (P1, to keep the board file
 * under the max-lines ratchet AND to share the VP label/segment maps with the BrowserInspector, which
 * surfaces the same viewport control as labelled rows). Presentation-only — `onChange` is the board's
 * exact `setViewport`. Candidate B: wider desktop presets collapse into the dropdown so the on-board
 * control stays calm; the Inspector shows them as an explicit size segment instead.
 */
import { useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { BrowserViewport } from '../../../lib/boardSchema'
import { VIEWPORT_PRESETS } from '../../../lib/browserLayout'
import { Icon } from '../../Icon'
import { Menu } from '../../Menu'

// The two device-class segments shown as icons; the wider desktop sizes collapse into the
// DESKTOP_TIER dropdown so the control stays calm and scales to future presets (Candidate B).
export const DEVICE_SEGMENTS: readonly BrowserViewport[] = ['mobile', 'tablet']
export const DESKTOP_TIER: readonly BrowserViewport[] = ['desktop', 'qhd', 'uhd']
export const VP_ICON: Record<BrowserViewport, 'mobile' | 'tablet' | 'desktop'> = {
  mobile: 'mobile',
  tablet: 'tablet',
  // The desktop tier shares one monitor glyph — the dropdown's text labels disambiguate the sizes.
  desktop: 'desktop',
  qhd: 'desktop',
  uhd: 'desktop'
}
export const VP_LABEL: Record<BrowserViewport, string> = {
  mobile: 'Mobile',
  tablet: 'Tablet',
  desktop: 'Desktop',
  qhd: '1440p',
  uhd: '4K'
}

/** Shared segment chrome — mirrors the original VpToggle box so every segment lines up. */
function segStyle(active: boolean): CSSProperties {
  return {
    height: 22,
    padding: '0 8px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    background: active ? 'var(--accent-wash)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-3)',
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'var(--ui)'
  }
}

/** One device-class segment (icon; active also shows the label). */
function VpToggle({
  vp,
  active,
  onClick
}: {
  vp: BrowserViewport
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      title={VP_LABEL[vp]}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      style={segStyle(active)}
    >
      <Icon name={VP_ICON[vp]} size={13} />
      {active && <span>{VP_LABEL[vp]}</span>}
    </button>
  )
}

/** The desktop-size dropdown segment: a monitor glyph + (when a desktop size is active) its
 *  label, plus a chevron. Clicking opens the shared Menu shell listing Desktop / 1440p / 4K with
 *  their CSS box dims and a check on the current size. Accent-active whenever a tier size is live. */
function DesktopTierControl({
  value,
  onChange
}: {
  value: BrowserViewport
  onChange: (vp: BrowserViewport) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const active = DESKTOP_TIER.includes(value)
  return (
    <span ref={anchorRef} style={{ display: 'inline-flex' }}>
      <button
        title="Desktop size"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.stopPropagation()}
        style={segStyle(active)}
      >
        <Icon name="desktop" size={13} />
        {active && <span>{VP_LABEL[value]}</span>}
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <Menu
          anchor={anchorRef}
          align="right"
          label="Desktop size"
          className="board-menu"
          onClose={() => setOpen(false)}
        >
          {DESKTOP_TIER.map((vp) => {
            const p = VIEWPORT_PRESETS[vp]
            const on = vp === value
            return (
              <button
                key={vp}
                className="board-menu-item"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  setOpen(false)
                  onChange(vp)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 14,
                  color: on ? 'var(--accent)' : undefined
                }}
              >
                <span>{VP_LABEL[vp]}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: on ? 'var(--accent)' : 'var(--text-3)'
                    }}
                  >
                    {p.w}×{p.h}
                  </span>
                  {on ? <Icon name="check" size={12} /> : <span style={{ width: 12 }} />}
                </span>
              </button>
            )
          })}
        </Menu>
      )}
    </span>
  )
}

/** Viewport segmented control (title-bar actions slot): Mobile · Tablet icons + the
 *  desktop-size dropdown (Candidate B). */
export function ViewportControl({
  value,
  onChange
}: {
  value: BrowserViewport
  onChange: (vp: BrowserViewport) => void
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        padding: 2,
        marginRight: 2,
        background: 'var(--inset)',
        borderRadius: 6,
        border: '1px solid var(--border-subtle)'
      }}
    >
      {DEVICE_SEGMENTS.map((vp) => (
        <VpToggle key={vp} vp={vp} active={vp === value} onClick={() => onChange(vp)} />
      ))}
      <DesktopTierControl value={value} onChange={onChange} />
    </div>
  )
}
