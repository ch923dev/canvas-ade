/**
 * Ephemeral Browser-preview runtime state (Zustand) — Phase 2.2.
 *
 * The PreviewManager layer (`BrowserPreviewLayer`) owns the native `WebContentsView`
 * lifecycle and writes per-board RUNTIME state here; the `BrowserBoard` component
 * reads it to render the device-frame snapshot fallback, the connecting/connected/
 * load-failed state, and the URL-bar live URL + back/forward affordance.
 *
 * This is deliberately NOT in `canvasStore` / the board schema: snapshots and load
 * status are transient and must never be persisted to `canvas.json`. The board's
 * durable props (`url`, `viewport`) stay on the board in `canvasStore`.
 */
import { create } from 'zustand'

/** Load lifecycle as the URL bar should display it. */
export type PreviewStatus = 'idle' | 'connecting' | 'connected' | 'load-failed'

/** Per-board runtime preview state. Absent entries default to idle/no-snapshot. */
export interface PreviewRuntime {
  /** capturePage data URL shown while detached (motion / LOD / over-cap). */
  snapshot: string | null
  status: PreviewStatus
  /** The live URL reported by the view (may differ from the board's edited url). */
  liveUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  /** A native view is currently attached over this board's device stage. */
  live: boolean
  /** Last load error description, for the load-failed state. */
  error: string | null
}

export const DEFAULT_RUNTIME: PreviewRuntime = {
  snapshot: null,
  status: 'idle',
  liveUrl: null,
  canGoBack: false,
  canGoForward: false,
  live: false,
  error: null
}

interface PreviewState {
  byId: Record<string, PreviewRuntime>
  /** Shallow-merge a runtime patch for one board (creates the entry if absent). */
  patch: (id: string, patch: Partial<PreviewRuntime>) => void
  /** Drop a board's runtime state (on board removal). */
  clear: (id: string) => void
}

export const usePreviewStore = create<PreviewState>((set) => ({
  byId: {},
  patch: (id, patch) =>
    set((s) => ({
      byId: { ...s.byId, [id]: { ...DEFAULT_RUNTIME, ...s.byId[id], ...patch } }
    })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s
      const next = { ...s.byId }
      delete next[id]
      return { byId: next }
    })
}))

/** Read one board's runtime state, falling back to the idle default. */
export function selectRuntime(id: string): (s: PreviewState) => PreviewRuntime {
  return (s: PreviewState): PreviewRuntime => s.byId[id] ?? DEFAULT_RUNTIME
}
