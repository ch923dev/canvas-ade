/**
 * Browser preview manager (OS-3) — a thin shell mounted ONCE inside `<ReactFlow>`
 * (Canvas.tsx). Browser boards render their live page OFFSCREEN and paint it into a DOM
 * `<canvas>` (the occlusion fix — a clipping/z-ordering DOM node, ADR 0002 resolution);
 * this layer drives the cross-board liveness (paint-gating off-screen renderers + the
 * MAX_LIVE existence cap) and the engine-agnostic auto-connect. It has no JSX of its own.
 */
import type { RefObject } from 'react'
import { useBrowserAutoConnect } from './useBrowserAutoConnect'
import { useOffscreenLiveness } from './useOffscreenLiveness'

export interface LayerProps {
  /** The canvas pane element — useOffscreenLiveness resolves on-screen device rects against it. */
  paneRef: RefObject<HTMLDivElement | null>
  /** The PORTAL full-viewed board id (or null) — forced alive+painting regardless of its
   *  canvas-node visibility so the modal never shows a blank/frozen frame. */
  fullViewId: string | null
}

export function BrowserPreviewLayer({ paneRef, fullViewId }: LayerProps): null {
  // Auto-connect (reconnect-on-refused + auto-push-detected-port) only steers board.url; it
  // never touches a preview surface, so it runs unconditionally.
  useBrowserAutoConnect()
  // OS-3 Phase 2 (2A/2B): freeze off-screen / below-LOD offscreen paint pumps (the CPU win)
  // and enforce the MAX_LIVE existence cap. `useOnViewportChange` lives here only (the native
  // camera-sync manager that used to share that single-slot field was deleted in 5C).
  useOffscreenLiveness(paneRef, fullViewId)
  return null
}
