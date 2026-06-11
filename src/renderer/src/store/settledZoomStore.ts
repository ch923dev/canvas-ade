/**
 * Settled camera zoom — the zoom AFTER the camera has been at rest for the settle
 * debounce. Published ONLY by useZoomSettle (never per gesture frame), so consumers
 * that care about at-rest zoom — the terminal WebGL renderer policy — re-render
 * once per settle instead of once per camera frame. Distinct from
 * `canvasStore.viewport`, which mirrors EVERY camera frame for autosave.
 *
 * Ephemeral session state: never serialized (scene/session split, CLAUDE.md).
 */
import { create } from 'zustand'

interface SettledZoomState {
  /** Last settled camera zoom (1 until the first settle is published). */
  zoom: number
  setSettledZoom: (zoom: number) => void
}

export const useSettledZoomStore = create<SettledZoomState>((set) => ({
  zoom: 1,
  // Identity-skip so re-publishing the same zoom (pan-only settles) never notifies.
  setSettledZoom: (zoom) => set((s) => (s.zoom === zoom ? s : { zoom }))
}))
