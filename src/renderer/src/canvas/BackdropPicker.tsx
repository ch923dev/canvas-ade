/**
 * Backdrop picker — camera-cluster popover (docs/canvas-backdrop/spec.md §3).
 * Sibling of the Tidy picker, rendered through the shared <Menu> shell (D1-C):
 * body portal + viewport clamp, Esc/outside/resize close, and the ADR 0002
 * detach-live-previews-while-open token come free.
 *
 * The controls themselves (source rows · scene gallery · dim/saturation/grid) live in
 * BackdropControls, shared with the inline Settings › Project › Appearance surface. This file is
 * just the toolbar trigger + the <Menu> wrapper. The caps are re-exported so existing importers
 * (BackdropPicker.test, projectStore doc-comment refs) keep their import path.
 */
import { useRef, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { Menu } from './Menu'
import { Icon } from './Icon'
import { BackdropControls, IMAGE_CAP_BYTES, VIDEO_CAP_BYTES } from './BackdropControls'

export { IMAGE_CAP_BYTES, VIDEO_CAP_BYTES }

export function BackdropPicker({
  menuZIndex
}: {
  /** Raise the picker's floating Menu above a host layer (default 250). The toolbar leaves it
   *  undefined; a settings-modal host would set it to paint over the modal. */
  menuZIndex?: number
} = {}): ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const enabled = (useCanvasStore((s) => s.background)?.kind ?? 'none') !== 'none'

  return (
    <div ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="ca-t-ctl bd-trigger"
        title="Backdrop"
        data-active={open || enabled ? '' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="wallpaper" />
      </button>
      {open && (
        <Menu
          anchor={triggerRef}
          align="right"
          gap={6}
          label="Backdrop"
          className="bd-menu"
          onClose={() => setOpen(false)}
          style={menuZIndex != null ? { zIndex: menuZIndex } : undefined}
        >
          <div className="bd-head">Backdrop</div>
          <BackdropControls />
        </Menu>
      )}
    </div>
  )
}
