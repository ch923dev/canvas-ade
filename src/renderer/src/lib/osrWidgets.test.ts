import { describe, it, expect } from 'vitest'
import {
  pageRectToFrame,
  placePopupTop,
  clampPopupLeft,
  monthGrid,
  monthLabel,
  parseIsoDate,
  isoDate,
  hsvToHex,
  hexToHsv,
  normalizeHex
} from './osrWidgets'

describe('pageRectToFrame', () => {
  it('scales a page rect proportionally into the frame box', () => {
    // page 1280×800, frame 640×400 → exactly half.
    const r = pageRectToFrame({ x: 100, y: 200, width: 50, height: 20 }, 1280, 800, 640, 400)
    expect(r).toEqual({ x: 50, y: 100, w: 25, h: 10 })
  })
  it('returns a zero rect for a not-yet-laid-out page (divide-by-zero guard)', () => {
    expect(pageRectToFrame({ x: 10, y: 10, width: 5, height: 5 }, 0, 0, 100, 100)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0
    })
  })
})

describe('placePopupTop', () => {
  it('places below the widget when it fits', () => {
    expect(placePopupTop(20, 40, 100, 400)).toBe(42) // anchorBottom 40 + gap 2
  })
  it('flips above the widget when there is no room below', () => {
    // anchorBottom 380 + 2 + 100 = 482 > 400 → above: anchorTop 360 - 2 - 100 = 258
    expect(placePopupTop(360, 380, 100, 400)).toBe(258)
  })
  it('pins inside the frame when the popup is taller than the frame', () => {
    expect(placePopupTop(380, 395, 500, 400)).toBe(0)
  })
})

describe('clampPopupLeft', () => {
  it('keeps the popup inside the right edge', () => {
    expect(clampPopupLeft(560, 160, 640)).toBe(480) // 640 - 160
  })
  it('never goes negative', () => {
    expect(clampPopupLeft(-30, 160, 640)).toBe(0)
  })
  it('pins to 0 when wider than the frame', () => {
    expect(clampPopupLeft(50, 800, 640)).toBe(0)
  })
})

describe('monthGrid', () => {
  it('always returns 42 cells', () => {
    expect(monthGrid(2026, 5)).toHaveLength(42)
  })
  it('marks June 2026 with a Monday 1st and Sunday-first leading day', () => {
    const cells = monthGrid(2026, 5) // June 2026: 1st is a Monday
    // cell[0] = Sunday May 31 (leading), cell[1] = June 1
    expect(cells[0]).toEqual({ day: 31, iso: '2026-05-31', inMonth: false })
    expect(cells[1]).toEqual({ day: 1, iso: '2026-06-01', inMonth: true })
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30) // June has 30 days
  })
  it('handles a leap February', () => {
    const cells = monthGrid(2024, 1) // Feb 2024 = 29 days
    expect(cells.filter((c) => c.inMonth)).toHaveLength(29)
    expect(cells.some((c) => c.iso === '2024-02-29')).toBe(true)
  })
  it('isoDate / monthLabel format correctly', () => {
    expect(isoDate(2026, 0, 9)).toBe('2026-01-09')
    expect(monthLabel(2026, 5)).toBe('June 2026')
  })
})

describe('parseIsoDate', () => {
  it('parses a valid value', () => {
    expect(parseIsoDate('2026-06-18')).toEqual({ year: 2026, month0: 5, day: 18 })
  })
  it('rejects malformed / out-of-range', () => {
    expect(parseIsoDate('nope')).toBeNull()
    expect(parseIsoDate('2026-13-01')).toBeNull()
    expect(parseIsoDate('2026-06-40')).toBeNull()
  })
})

describe('hsv ↔ hex', () => {
  it('hsvToHex maps the accent blue', () => {
    const hsv = hexToHsv('#4F8CFF')
    expect(hsv).not.toBeNull()
    expect(hsvToHex(hsv!.h, hsv!.s, hsv!.v)).toBe('#4F8CFF')
  })
  it('round-trips primaries', () => {
    for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#000000', '#808080']) {
      const hsv = hexToHsv(hex)!
      expect(hsvToHex(hsv.h, hsv.s, hsv.v)).toBe(hex)
    }
  })
  it('clamps out-of-range hsv', () => {
    expect(hsvToHex(0, -1, 2)).toBe('#FFFFFF') // s clamps 0, v clamps 1 → white
    expect(hsvToHex(720, 0, 0)).toBe('#000000') // hue wraps, v 0 → black
  })
})

describe('normalizeHex', () => {
  it('expands #rgb and uppercases', () => {
    expect(normalizeHex('#4f8')).toBe('#44FF88')
    expect(normalizeHex('4F8CFF')).toBe('#4F8CFF')
  })
  it('rejects junk', () => {
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('rgb(1,2,3)')).toBeNull()
  })
})
