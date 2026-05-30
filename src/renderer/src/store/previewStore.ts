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
  /**
   * A node-level gesture (board drag or resize) is in progress. Native
   * `WebContentsView`s can't be clipped and paint above all HTML, so during a node
   * drag/resize the BrowserPreviewLayer detaches every live view to its HTML
   * snapshot (which DOES respect z-order/clipping) and reattaches on gesture end —
   * the same motion path the camera uses, but driven by React Flow's node-drag /
   * NodeResizer callbacks (which never move the camera). Without this, dragging a
   * board over a live Browser board leaves the native view painting over it.
   */
  nodeGesture: boolean
  /** Shallow-merge a runtime patch for one board (creates the entry if absent). */
  patch: (id: string, patch: Partial<PreviewRuntime>) => void
  /**
   * Shallow-merge a runtime patch ONLY for a board that already has an entry — a
   * no-op when the id is absent. Used by the main-driven lifecycle-event handlers
   * (did-navigate / did-fail-load) so an event that arrives AFTER the board was
   * deleted (clearRuntime already ran) can't resurrect a cleared, never-cleaned-up
   * orphan entry via the create-if-absent `patch` (Bug #32).
   */
  patchIfPresent: (id: string, patch: Partial<PreviewRuntime>) => void
  /** Drop a board's runtime state (on board removal). */
  clear: (id: string) => void
  /** Mark a node drag/resize gesture as started/ended (drives detach/reattach). */
  setNodeGesture: (active: boolean) => void
}

export const usePreviewStore = create<PreviewState>((set) => ({
  byId: {},
  nodeGesture: false,
  patch: (id, patch) =>
    set((s) => ({
      byId: { ...s.byId, [id]: { ...DEFAULT_RUNTIME, ...s.byId[id], ...patch } }
    })),
  patchIfPresent: (id, patch) =>
    set((s) =>
      id in s.byId ? { byId: { ...s.byId, [id]: { ...s.byId[id], ...patch } } } : s
    ),
  clear: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s
      const next = { ...s.byId }
      delete next[id]
      return { byId: next }
    }),
  setNodeGesture: (active) => set((s) => (s.nodeGesture === active ? s : { nodeGesture: active }))
}))

/** Read one board's runtime state, falling back to the idle default. */
export function selectRuntime(id: string): (s: PreviewState) => PreviewRuntime {
  return (s: PreviewState): PreviewRuntime => s.byId[id] ?? DEFAULT_RUNTIME
}

/** Count of boards with a native view currently attached (the DiagOverlay metric). */
export function selectLiveCount(s: PreviewState): number {
  let n = 0
  for (const r of Object.values(s.byId)) if (r.live) n++
  return n
}
