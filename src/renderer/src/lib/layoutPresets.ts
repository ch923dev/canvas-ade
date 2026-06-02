/**
 * Layout-preset registry — the FancyZones-style picker's source of truth (pure data).
 *
 * Two kinds:
 * - `tidy` — reposition-only, keeps board sizes (semantic `smart` grouping). Routes through
 *   `tidyLayout` in the store.
 * - `tile` — RESIZE-to-fill, window-manager style. Routes through `tileLayout` + a pane-aspect
 *   area in the store.
 *
 * `zones` are illustrative fractional rects (0..1) used ONLY to draw each preset's thumbnail in
 * the picker — the real layout adapts to the live board count. Keeping them here means the
 * picker UI and the dispatch logic share one ordered list.
 */
import type { TidyMode } from './tidyLayout'
import type { TileTemplate } from './tileLayout'

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
      tidyMode: TidyMode
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

/** Ordered presets shown in the picker (Smart first as the semantic "auto"). */
export const LAYOUT_PRESETS: LayoutPreset[] = [
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
