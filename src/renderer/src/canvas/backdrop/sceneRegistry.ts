/**
 * Bundled-scene registry — the backdrop's extensibility seam (docs/canvas-backdrop/
 * addendum-presets.md §2). PR 2 registers `blossom-river`; PR 3 adds the voted preset
 * roster — adding a scene is one module under `scenes/` plus one row here, and the
 * picker / palette verbs / drift-guard tests all derive from this list.
 *
 * `background.scene` ids are persisted VERBATIM (boardSchema preserves well-formed
 * unknown ids); resolution happens here at render time, so an id this build does not
 * know degrades to plain void + a toast (forward-compat with newer preset packs)
 * instead of being destroyed at parse time.
 */
import { blossomRiver } from './scenes/blossomRiver'

export interface SceneOpts {
  /** Palette-variant key (background.sceneVariant); unknown ⇒ the scene default. */
  palette?: string
  /** True ⇒ render exactly one static frame and never animate. */
  reducedMotion: boolean
}

/** A running scene instance bound to one canvas. All methods are idempotent. */
export interface SceneHandle {
  /** Begin the ≤30fps rAF loop (no-op when already running / reducedMotion). */
  start(): void
  /** Stop the loop and release frame callbacks (no-op when stopped). */
  stop(): void
  /** Paint one static frame (the reduced-motion / document.hidden still). */
  renderStill(): void
}

export interface SceneDef {
  /** Persisted id (`background.scene`), kebab-case, stable forever. */
  id: string
  /** Picker row / command-palette verb label. */
  label: string
  /** Picker grouping (addendum §3): ambient = subtle, scenic = wallpaper-grade. */
  tier: 'ambient' | 'scenic'
  /** Bind the scene to a canvas; the layer owns calling start/stop/renderStill. */
  create(canvas: HTMLCanvasElement, opts: SceneOpts): SceneHandle
  /** Optional palette variants (background.sceneVariant keys). */
  palettes?: Record<string, Record<string, string>>
  /** Inline SVG/data-URI thumbnail for the gallery picker (PR 3). */
  thumb: string
}

/** Registration order = picker display order within a tier. */
const SCENES: readonly SceneDef[] = [
  // PR 3 adds: drift, current, aurora-night, starfield-nebula, sunset-ocean,
  // snowfall-ridge, rainy-window, city-lights, misty-pines (addendum §3).
  blossomRiver
]

export function listScenes(): readonly SceneDef[] {
  return SCENES
}

export function getScene(id: string): SceneDef | undefined {
  return SCENES.find((s) => s.id === id)
}
