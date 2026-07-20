/**
 * Appearance detail pane — the `appearance` tile. Reuses the existing `BackdropPicker` (wallpaper /
 * scene / dim / saturation / grid), the same control the canvas toolbar uses — no rebuilt
 * duplicate. The picker is a trigger + floating `Menu`; the Menu portals to `document.body` at its
 * own z-index (default 250), which is BELOW this modal (300), so we raise it above the panel via
 * `menuZIndex` (the additive prop added for exactly this settings-context reuse).
 *
 * Diagram motion (Phase 2, M7): the app-setting half of the composed gate — effective motion =
 * !prefers-reduced-motion ∧ this switch. Immediate-apply (localStorage-backed store); OS
 * reduced-motion always wins regardless of the switch.
 */
import { type ReactElement } from 'react'
import { BackdropPicker } from '../../BackdropPicker'
import { useDiagramMotionStore } from '../../../store/diagramMotionStore'
import { pane } from '../paneStyles'

/** Above the Settings modal card (zIndex 300) so the picker's popover paints over the panel. */
const BACKDROP_MENU_Z = 360

export function AppearancePane(): ReactElement {
  const setting = useDiagramMotionStore((s) => s.setting)
  const setSetting = useDiagramMotionStore((s) => s.setSetting)
  const motionOn = setting !== 'off'
  return (
    <div style={pane.section}>
      <div style={pane.setrow} data-test="appearance-backdrop-row">
        <div style={{ flex: 1 }}>
          <div style={pane.rowTitle}>Wallpaper &amp; grid</div>
          <div style={pane.rowSub}>
            A screen-fixed backdrop behind the canvas — none, your own image/video, or a bundled
            scene — plus dim, saturation, and the dot/line grid.
          </div>
        </div>
        <BackdropPicker menuZIndex={BACKDROP_MENU_Z} />
      </div>
      <p style={pane.hint}>The backdrop is saved per project.</p>

      <div style={pane.setrow} data-test="appearance-diagram-motion-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.rowTitle}>Diagram motion</div>
          <div style={pane.rowSub}>
            Entrance, layout-morph, flow and status animations on diagram cards. Off renders them
            fully static; the OS reduced-motion preference always wins.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={motionOn}
          aria-label="Diagram motion"
          onClick={() => setSetting(motionOn ? 'off' : 'auto')}
          data-test="settings-diagram-motion"
          style={{
            ...pane.toggle,
            cursor: 'pointer',
            background: motionOn ? 'var(--accent)' : 'var(--border-strong)'
          }}
        >
          <span style={{ ...pane.toggleKnob, left: motionOn ? 17 : 2 }} />
        </button>
      </div>
    </div>
  )
}
