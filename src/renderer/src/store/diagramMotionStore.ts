/**
 * Diagram-motion preference (diagram-viz Phase 2, M7) — the APP-SETTING half of the composed
 * motion gate: effective motion = !prefers-reduced-motion ∧ setting !== 'off'. An interface
 * preference, NOT canvas.json scene state (the wayfindingStore/scene-session split precedent):
 * localStorage-backed, per machine, all projects. 'auto' (default) follows the OS reduced-motion
 * signal; 'off' forces the fully-static Phase-1 render regardless of OS state.
 */
import { create } from 'zustand'

/** localStorage key (per machine, all projects) — `ca.` prefix per hintDismissal. */
export const DIAGRAM_MOTION_KEY = 'ca.diagram.motion'

export type DiagramMotionSetting = 'auto' | 'off'

function readSticky(): DiagramMotionSetting {
  try {
    return window.localStorage.getItem(DIAGRAM_MOTION_KEY) === 'off' ? 'off' : 'auto'
  } catch {
    return 'auto' // storage unavailable → default; never throw
  }
}

function writeSticky(setting: DiagramMotionSetting): void {
  try {
    window.localStorage.setItem(DIAGRAM_MOTION_KEY, setting)
  } catch {
    // Write failed — the in-session store state still carries the choice.
  }
}

interface DiagramMotionState {
  setting: DiagramMotionSetting
  setSetting: (setting: DiagramMotionSetting) => void
}

export const useDiagramMotionStore = create<DiagramMotionState>((set) => ({
  setting: readSticky(),
  // Identity-skip so a same-value set never notifies (and never re-writes storage).
  setSetting: (setting) =>
    set((s) => {
      if (s.setting === setting) return s
      writeSticky(setting)
      return { setting }
    })
}))
