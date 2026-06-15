/**
 * Ephemeral Browser-preview runtime state (Zustand) — Phase 2.2.
 *
 * The offscreen preview pipeline (`useOffscreenPreview`) writes per-board RUNTIME state
 * here from MAIN's `preview:event` stream; the `BrowserBoard` component reads it to render
 * the connecting/connected/load-failed/crashed states and the URL-bar live URL +
 * back/forward affordance.
 *
 * This is deliberately NOT in `canvasStore` / the board schema: load status is transient and
 * must never be persisted to `canvas.json`. The board's durable props (`url`, `viewport`)
 * stay on the board in `canvasStore`.
 */
import { create } from 'zustand'

/** Load lifecycle as the URL bar should display it. `crashed` = the preview's
 *  renderer process died (D2-C) — recovery is the explicit Reload CTA. */
export type PreviewStatus = 'idle' | 'connecting' | 'connected' | 'load-failed' | 'crashed'

/** Per-board runtime preview state. Absent entries default to idle. */
export interface PreviewRuntime {
  status: PreviewStatus
  /** The live URL reported by the page (may differ from the board's edited url). */
  liveUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  /** Last load error description, for the load-failed state. */
  error: string | null
  /**
   * Monotonic "please (re)load" counter, bumped by `requestReload` (push-to-preview).
   * The board's durable `url` can be pushed UNCHANGED (same dev-server URL), which the
   * reconcile diff-skip (Bug #44) would otherwise swallow → the preview stays on a stale
   * Chromium error page. A consumer re-navigates when `url` OR this nonce changed, so an
   * explicit push always reloads and can recover a `load-failed` board.
   */
  reloadNonce: number
}

export const DEFAULT_RUNTIME: PreviewRuntime = {
  status: 'idle',
  liveUrl: null,
  canGoBack: false,
  canGoForward: false,
  error: null,
  reloadNonce: 0
}

interface PreviewState {
  byId: Record<string, PreviewRuntime>
  /** Shallow-merge a runtime patch for one board (creates the entry if absent). */
  patch: (id: string, patch: Partial<PreviewRuntime>) => void
  /**
   * Shallow-merge a runtime patch ONLY for a board that already has an entry — a
   * no-op when the id is absent. Used by the main-driven lifecycle-event handlers
   * (did-navigate / did-fail-load) so an event that arrives AFTER the board was
   * deleted (clear already ran) can't resurrect a cleared, never-cleaned-up
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
}

export const usePreviewStore = create<PreviewState>((set) => ({
  byId: {},
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
    })
}))

/** Read one board's runtime state, falling back to the idle default. */
export function selectRuntime(id: string): (s: PreviewState) => PreviewRuntime {
  return (s: PreviewState): PreviewRuntime => s.byId[id] ?? DEFAULT_RUNTIME
}
