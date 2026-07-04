/**
 * Appearance detail pane — the `appearance` tile. Reuses the existing `BackdropPicker` (wallpaper /
 * scene / dim / saturation / grid), the same control the canvas toolbar uses — no rebuilt
 * duplicate. The picker is a trigger + floating `Menu`; the Menu portals to `document.body` at its
 * own z-index (default 250), which is BELOW this modal (300), so we raise it above the panel via
 * `menuZIndex` (the additive prop added for exactly this settings-context reuse).
 */
import { type ReactElement } from 'react'
import { BackdropPicker } from '../../BackdropPicker'
import { pane } from '../paneStyles'

/** Above the Settings modal card (zIndex 300) so the picker's popover paints over the panel. */
const BACKDROP_MENU_Z = 360

export function AppearancePane(): ReactElement {
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
    </div>
  )
}
