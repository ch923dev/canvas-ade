import { describe, expect, it } from 'vitest'
import { LAYOUT_PRESETS } from './layoutPresets'
import { TIDY_MODES, TILE_TEMPLATES } from '../../../shared/tidyContract'

describe('LAYOUT_PRESETS — the Tidy picker (spatial D8 a, C8, DESIGN W6)', () => {
  it('By role first (the t-key default), then Fit to screen, then Smart, then the tiles', () => {
    expect(LAYOUT_PRESETS.slice(0, 3).map((p) => [p.id, p.label])).toEqual([
      ['roles', 'By role'],
      ['fit', 'Fit to screen'],
      ['smart', 'Smart']
    ])
    expect(LAYOUT_PRESETS.slice(3).every((p) => p.kind === 'tile')).toBe(true)
  })

  it('the new presets carry the C8 hints verbatim', () => {
    const hint = (id: string): string | undefined => LAYOUT_PRESETS.find((p) => p.id === id)?.hint
    expect(hint('roles')).toBe('Lead / browser gets the big slot; linked boards sit beside it')
    expect(hint('fit')).toBe('Keep groups together, fit the window')
  })

  it('every tidy preset runs a tidy_canvas mode; the tile presets are exactly TILE_TEMPLATES', () => {
    for (const p of LAYOUT_PRESETS) {
      if (p.kind === 'tidy') expect(TIDY_MODES).toContain(p.tidyMode)
    }
    const tiles = LAYOUT_PRESETS.flatMap((p) => (p.kind === 'tile' ? [p.template] : []))
    expect([...tiles].sort()).toEqual([...TILE_TEMPLATES].sort())
  })

  it('ids are unique and every zone is a fractional rect inside the thumbnail', () => {
    expect(new Set(LAYOUT_PRESETS.map((p) => p.id)).size).toBe(LAYOUT_PRESETS.length)
    for (const p of LAYOUT_PRESETS) {
      expect(p.zones.length).toBeGreaterThan(0)
      for (const z of p.zones) {
        expect(z.x).toBeGreaterThanOrEqual(0)
        expect(z.y).toBeGreaterThanOrEqual(0)
        expect(z.x + z.w).toBeLessThanOrEqual(1)
        expect(z.y + z.h).toBeLessThanOrEqual(1)
      }
    }
  })
})
