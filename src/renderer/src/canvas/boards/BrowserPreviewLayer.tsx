/**
 * Browser PreviewManager (Phase 2.2) — thin shell. Mounted ONCE inside `<ReactFlow>`
 * (Canvas.tsx); the imperative engine lives in `usePreviewManager` (this returns null,
 * a native `WebContentsView` driver has no JSX). See `usePreviewManager.ts` for the
 * full contract (camera sync, motion/LOD snapshots, full-view binding, ADR 0002).
 */
import type { ReactElement } from 'react'
import { usePreviewManager, type LayerProps } from './usePreviewManager'
import { useBrowserAutoConnect } from './useBrowserAutoConnect'
import { useOffscreenLiveness } from './useOffscreenLiveness'

// OS-3 Phase 5: OSR is the DEFAULT — BrowserBoard renders previews via an offscreen-fed
// <canvas>, and NO native views are ever created. Set VITE_PREVIEW_OSR=0 to fall back to the
// legacy native WebContentsView path (escape hatch; removed in 5C).
const OSR_PREVIEW = import.meta.env.VITE_PREVIEW_OSR !== '0'

export function BrowserPreviewLayer(props: LayerProps): ReactElement | null {
  // Auto-connect (reconnect-on-refused + auto-push-detected-port) is preview-engine-agnostic —
  // it only steers board.url and never touches a native view — so it must run in BOTH the native
  // and OSR paths. Mount it here, ABOVE the OSR early-return, so flipping VITE_PREVIEW_OSR doesn't
  // silently drop it (it previously lived inside NativePreviewLayer, which never mounts in OSR).
  useBrowserAutoConnect()
  // OS-3 Phase 2 (M2 / 2A): in OSR mode the native manager is NOT mounted — mount the offscreen
  // liveness manager instead (freezes off-screen / below-LOD paint pumps; the CPU win). It MUST
  // live in a CONDITIONALLY-RENDERED child, NOT a hook called unconditionally above the return:
  // useOffscreenLiveness calls `useOnViewportChange`, which is a SINGLE-SLOT React Flow store
  // field (last writer wins). Calling it here — a PARENT of NativePreviewLayer, whose effect
  // commits LAST — would CLOBBER the native manager's onEnd in native mode (the #82 camera-sync
  // class; see Canvas.tsx). A child rendered only when the flag is on never registers it while
  // the native path is live, and in OSR mode the native manager isn't mounted, so no clash.
  if (OSR_PREVIEW) return <OffscreenLivenessLayer paneRef={props.paneRef} />
  return <NativePreviewLayer {...props} />
}

/** The shipping native-preview engine (camera sync, motion/LOD snapshots, ADR 0002). */
function NativePreviewLayer(props: LayerProps): null {
  usePreviewManager(props)
  return null
}

/** OSR-only sibling of NativePreviewLayer: drives offscreen-preview liveness (paint-gating +
 *  MAX_LIVE). Mounted ONLY when VITE_PREVIEW_OSR — so its `useOnViewportChange` never coexists
 *  with the native manager's single-slot registration. */
function OffscreenLivenessLayer({ paneRef }: { paneRef: LayerProps['paneRef'] }): null {
  useOffscreenLiveness(paneRef)
  return null
}
