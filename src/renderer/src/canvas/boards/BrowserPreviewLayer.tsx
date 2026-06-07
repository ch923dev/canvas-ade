/**
 * Browser PreviewManager (Phase 2.2) — thin shell. Mounted ONCE inside `<ReactFlow>`
 * (Canvas.tsx); the imperative engine lives in `usePreviewManager` (this returns null,
 * a native `WebContentsView` driver has no JSX). See `usePreviewManager.ts` for the
 * full contract (camera sync, motion/LOD snapshots, full-view binding, ADR 0002).
 */
import type { ReactElement } from 'react'
import { usePreviewManager, type LayerProps } from './usePreviewManager'
import { useBrowserAutoConnect } from './useBrowserAutoConnect'

export function BrowserPreviewLayer(props: LayerProps): ReactElement | null {
  usePreviewManager(props)
  useBrowserAutoConnect()
  return null
}
