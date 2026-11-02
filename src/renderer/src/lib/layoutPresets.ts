/**
 * Layout-preset registry — the FancyZones-style picker's source of truth (pure data).
 *
 * Two kinds:
 * - `tidy` — routes through the shared tidy engine (`store/spatialTidy.runTidy`): `roles`
 *   (role-aware stage; may resize flexible boards, D7), `fit` (groups as units, fit the pane,
 *   positions only), and the legacy reposition-only packers (`smart`).
 * - `tile` — RESIZE-to-fill, window-manager style. Routes through `tileLayout` + a pane-aspect
 *   area in the store.
 *
 * `zones` are illustrative fractional rects (0..1) used ONLY to draw each preset's thumbnail in
 * the picker — the real layout adapts to the live board count. Keeping them here means the
 * picker UI and the dispatch logic share one ordered list.
 */
import type { TileTemplate } from './tileLayout'
import type { TidyCommandMode } from '../../../shared/tidyContract'

/** The modes a `tidy` preset can run — every tidy_canvas mode except `tile` (its own kind). */
export type PresetTidyMode = Exclude<TidyCommandMode, 'tile'>

/** A fractional zone (0..1 of the thumbnail) drawn in the picker. */
export interface PresetZone {
  x: number
  y: number
  w: number
  h: number
}

export type LayoutPreset =
  | {
      id: string
      kind: 'tidy'
      tidyMode: PresetTidyMode
      label: string
      hint: string
      zones: PresetZone[]
    }
  | {
      id: string
      kind: 'tile'
      template: TileTemplate
      label: string
      hint: string
      zones: PresetZone[]
    }

/**
 * Ordered presets shown in the picker (spatial D8 a, DESIGN W6): **By role** first — the `t` key
 * runs it as the IMPLICIT default (a unit of plain shells keeps its sizes) — then **Fit to
 * screen**, then Smart. Labels + hints are SPEC C8's, verbatim.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'roles',
    kind: 'tidy',
    tidyMode: 'roles',
    label: 'By role',
    hint: 'Lead / browser gets the big slot; linked boards sit beside it',
    // One large hero zone + a stacked rail (W6).
    zones: [
      { x: 0.06, y: 0.08, w: 0.58, h: 0.84 },
      { x: 0.68, y: 0.08, w: 0.26, h: 0.26 },
      { x: 0.68, y: 0.37, w: 0.26, h: 0.26 },
      { x: 0.68, y: 0.66, w: 0.26, h: 0.26 }
    ]
  },
  {
    id: 'fit',
    kind: 'tidy',
    tidyMode: 'fit',
    label: 'Fit to screen',
    hint: 'Keep groups together, fit the window',
    // Small clusters separated by wider gaps — the group-as-unit idea (W2).
    zones: [
      { x: 0.06, y: 0.1, w: 0.17, h: 0.34 },
      { x: 0.25, y: 0.1, w: 0.17, h: 0.34 },
      { x: 0.6, y: 0.1, w: 0.17, h: 0.34 },
      { x: 0.06, y: 0.56, w: 0.17, h: 0.34 },
      { x: 0.25, y: 0.56, w: 0.17, h: 0.34 },
      { x: 0.6, y: 0.56, w: 0.34, h: 0.34 }
    ]
  },
  {
    id: 'smart',
    kind: 'tidy',
    tidyMode: 'smart',
    label: 'Smart',
    hint: 'Group previews with their terminal',
    zones: [
      { x: 0.06, y: 0.08, w: 0.26, h: 0.34 },
      { x: 0.37, y: 0.08, w: 0.26, h: 0.34 },
      { x: 0.68, y: 0.08, w: 0.26, h: 0.34 },
      { x: 0.2, y: 0.5, w: 0.26, h: 0.34 },
      { x: 0.54, y: 0.5, w: 0.26, h: 0.34 }
    ]
  },
  {
    id: 'cols-2',
    kind: 'tile',
    template: 'cols-2',
    label: '2 columns',
    hint: 'Two equal columns, fill the view',
    zones: [
      { x: 0.06, y: 0.08, w: 0.42, h: 0.84 },
      { x: 0.52, y: 0.08, w: 0.42, h: 0.84 }
    ]
  },
  {
    id: 'cols-3',
    kind: 'tile',
    template: 'cols-3',
    label: '3 columns',
    hint: 'Three equal columns, fill the view',
    zones: [
      { x: 0.06, y: 0.08, w: 0.27, h: 0.84 },
      { x: 0.37, y: 0.08, w: 0.26, h: 0.84 },
      { x: 0.67, y: 0.08, w: 0.27, h: 0.84 }
    ]
  },
  {
    id: 'cols-4',
    kind: 'tile',
    template: 'cols-4',
    label: '4 columns',
    hint: 'Four equal columns, fill the view',
    zones: [
      { x: 0.06, y: 0.08, w: 0.19, h: 0.84 },
      { x: 0.29, y: 0.08, w: 0.19, h: 0.84 },
      { x: 0.52, y: 0.08, w: 0.19, h: 0.84 },
      { x: 0.75, y: 0.08, w: 0.19, h: 0.84 }
    ]
  },
  {
    id: 'main-sidebar',
    kind: 'tile',
    template: 'main-sidebar',
    label: 'Main + sidebar',
    hint: 'One large board + a stacked rail',
    zones: [
      { x: 0.06, y: 0.08, w: 0.55, h: 0.84 },
      { x: 0.65, y: 0.08, w: 0.29, h: 0.26 },
      { x: 0.65, y: 0.37, w: 0.29, h: 0.26 },
      { x: 0.65, y: 0.66, w: 0.29, h: 0.26 }
    ]
  },
  {
    id: 'grid',
    kind: 'tile',
    template: 'grid',
    label: 'Grid',
    hint: 'Even grid cells, fill the view',
    zones: [
      { x: 0.06, y: 0.08, w: 0.42, h: 0.4 },
      { x: 0.52, y: 0.08, w: 0.42, h: 0.4 },
      { x: 0.06, y: 0.52, w: 0.42, h: 0.4 },
      { x: 0.52, y: 0.52, w: 0.42, h: 0.4 }
    ]
  }
]
