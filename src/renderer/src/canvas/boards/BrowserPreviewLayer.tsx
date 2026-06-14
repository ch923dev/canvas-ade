/**
 * Browser PreviewManager (Phase 2.2) — thin shell. Mounted ONCE inside `<ReactFlow>`
 * (Canvas.tsx); the imperative engine lives in `usePreviewManager` (this returns null,
 * a native `WebContentsView` driver has no JSX). See `usePreviewManager.ts` for the
 * full contract (camera sync, motion/LOD snapshots, full-view binding, ADR 0002).
 */
import type { ReactElement } from 'react'
import { usePreviewManager, type LayerProps } from './usePreviewManager'
import { useBrowserAutoConnect } from './useBrowserAutoConnect'

// SPIKE (feat/preview-offscreen-spike): VITE_PREVIEW_OSR=1 disables the native
// WebContentsView path entirely — BrowserBoard renders previews via an offscreen-fed
// <canvas> instead. A clean A/B: with the flag on, NO native views are ever created.
const OSR_PREVIEW = import.meta.env.VITE_PREVIEW_OSR === '1'

export function BrowserPreviewLayer(props: LayerProps): ReactElement | null {
  if (OSR_PREVIEW) return null
  return <NativePreviewLayer {...props} />
}

/** The shipping native-preview engine (camera sync, motion/LOD snapshots, ADR 0002). */
function NativePreviewLayer(props: LayerProps): null {
  usePreviewManager(props)
  useBrowserAutoConnect()
  return null
}
