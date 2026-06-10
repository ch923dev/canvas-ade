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

/** Load lifecycle as the URL bar should display it. `crashed` = the preview's
 *  renderer process died (D2-C) — recovery is the explicit Reload CTA. */
export type PreviewStatus = 'idle' | 'connecting' | 'connected' | 'load-failed' | 'crashed'

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
  /**
   * The board's renderer was FREED (over-cap eviction / full-view teardown), not
   * just detached for motion/LOD (D2-C). Both render the same snapshot, but an
   * evicted board's page state is gone and interaction is dead until a live slot
   * frees — the "paused" badge tells the user why. Set by closeBoard, cleared on
   * (re)attach.
   */
  evicted: boolean
  /**
   * Monotonic "please (re)load" counter, bumped by `requestReload` (push-to-preview).
   * The board's durable `url` can be pushed UNCHANGED (same dev-server URL), which the
   * reconcile diff-skip (Bug #44) would otherwise swallow → the native view stays on a
   * stale Chromium error page. Reconcile re-navigates when `url` OR this nonce changed,
   * so an explicit push always reloads and can recover a `load-failed` board.
   */
  reloadNonce: number
}

export const DEFAULT_RUNTIME: PreviewRuntime = {
  snapshot: null,
  status: 'idle',
  liveUrl: null,
  canGoBack: false,
  canGoForward: false,
  live: false,
  error: null,
  evicted: false,
  reloadNonce: 0
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
  /**
   * A board's ⋯ overflow menu (or a comparable HTML popover that drops over a device
   * stage) is open. Like a node gesture, an HTML popover portaled to <body> still can't
   * sit above a native `WebContentsView` — the menu renders UNDER the live preview that
   * its rect overlaps (the menu-occluded-by-preview bug). While set, the layer detaches
   * live views to their (z-ordered, clippable) HTML snapshot so the menu is visible, and
   * reattaches on close — the same path `nodeGesture` drives.
   *
   * Derived from `openMenus`: true while ANY popover is open. Multiple popovers can be
   * registered at once (a board ⋯ menu + the Tidy picker), so a single boolean is wrong —
   * the first to close would clear the flag and reattach live views UNDER a still-open
   * second popover (occluded by the always-above native layer). PREV-C.
   */
  openMenus: Set<string>
  menuOpen: boolean
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
  /**
   * Bump a board's `reloadNonce` (create-if-absent) to force a (re)load on the next
   * reconcile even when the board's `url` is unchanged — the push-to-preview signal.
   */
  requestReload: (id: string) => void
  /** Mark a node drag/resize gesture as started/ended (drives detach/reattach). */
  setNodeGesture: (active: boolean) => void
  /** Mark a board ⋯ menu / device-overlapping popover as open/closed BY TOKEN (one stable
   *  token per popover instance) so one closing can't reattach live views under another
   *  still-open popover (PREV-C). `menuOpen` stays true while ANY token is registered. */
  setMenuOpen: (token: string, active: boolean) => void
}

export const usePreviewStore = create<PreviewState>((set) => ({
  byId: {},
  nodeGesture: false,
  openMenus: new Set<string>(),
  menuOpen: false,
  patch: (id, patch) =>
    set((s) => ({
      byId: { ...s.byId, [id]: { ...DEFAULT_RUNTIME, ...s.byId[id], ...patch } }
    })),
  patchIfPresent: (id, patch) =>
    set((s) => (id in s.byId ? { byId: { ...s.byId, [id]: { ...s.byId[id], ...patch } } } : s)),
  clear: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s
      const next = { ...s.byId }
      delete next[id]
      return { byId: next }
    }),
  requestReload: (id) =>
    set((s) => {
      const cur = s.byId[id] ?? DEFAULT_RUNTIME
      return { byId: { ...s.byId, [id]: { ...cur, reloadNonce: cur.reloadNonce + 1 } } }
    }),
  setNodeGesture: (active) => set((s) => (s.nodeGesture === active ? s : { nodeGesture: active })),
  setMenuOpen: (token, active) =>
    set((s) => {
      // Ref-count popovers by token; menuOpen = any open. Skip the open-already / closed-
      // already cases so a redundant call doesn't emit a new state (PREV-C).
      if (active ? s.openMenus.has(token) : !s.openMenus.has(token)) return s
      const openMenus = new Set(s.openMenus)
      if (active) openMenus.add(token)
      else openMenus.delete(token)
      return { openMenus, menuOpen: openMenus.size > 0 }
    })
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
