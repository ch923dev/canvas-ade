/**
 * Project · Appearance detail pane — the per-project backdrop. Collapsed by default to a single
 * compact row (current backdrop + a Customize disclosure) so the Project tab stays tidy and uniform
 * with the Sessions / Agents rows; the full inline controls (BackdropControls — none · wallpaper ·
 * scenes · dim/saturation/grid) expand in place on demand. Inline, never a popover, so the wide
 * gallery can't overflow the Settings modal. Backdrop is per-project doc state (canvas.json v9),
 * applied live + persisted by the debounced autosave.
 */
import { useState, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { listScenes } from '../../backdrop/sceneRegistry'
import { Icon } from '../../Icon'
import { BackdropControls } from '../../BackdropControls'
import { pane } from '../paneStyles'

/** One-line summary of the active backdrop for the collapsed row. */
function backdropSummary(
  background: ReturnType<typeof useCanvasStore.getState>['background']
): string {
  if (!background || background.kind === 'none') return 'No backdrop'
  if (background.kind === 'file') return 'Custom wallpaper'
  if (background.kind === 'scene') {
    const scene = listScenes().find((s) => s.id === background.scene)
    return scene ? `Scene · ${scene.label}` : 'Scene'
  }
  return 'No backdrop'
}

export function ProjectAppearancePane(): ReactElement {
  const [open, setOpen] = useState(false)
  const background = useCanvasStore((s) => s.background)

  return (
    <div style={pane.section}>
      <div style={pane.setrow} data-test="settings-appearance-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.rowTitle}>Wallpaper &amp; grid</div>
          <div style={pane.rowSub}>{backdropSummary(background)}</div>
        </div>
        <button
          type="button"
          style={pane.syncBtn}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-test="settings-appearance-customize"
        >
          <Icon name={open ? 'check' : 'wallpaper'} size={12} />
          {open ? 'Done' : 'Customize'}
        </button>
      </div>

      {open && (
        <div className="bd-inline">
          <BackdropControls />
        </div>
      )}

      <p style={pane.hint}>The backdrop is saved per project.</p>
    </div>
  )
}
