import { describe, it, expect } from 'vitest'
import { widthFromDrag, NOTE_MIN_W, CHECKLIST_MIN_W } from './widthResize'

describe('widthFromDrag', () => {
  it('adds the board-local delta (screen dx ÷ boardScale) to the start width', () => {
    // zoom 2 → 100 screen px is 50 board-local px
    expect(widthFromDrag(156, 100, 2, NOTE_MIN_W)).toBe(206)
    // zoom 0.5 → 50 screen px is 100 board-local px
    expect(widthFromDrag(240, 50, 0.5, CHECKLIST_MIN_W)).toBe(340)
  })

  it('shrinks on a negative delta', () => {
    expect(widthFromDrag(200, -40, 1, NOTE_MIN_W)).toBe(160)
  })

  it('clamps at the minimum width', () => {
    expect(widthFromDrag(156, -1000, 1, NOTE_MIN_W)).toBe(NOTE_MIN_W)
    expect(widthFromDrag(240, -1000, 1, CHECKLIST_MIN_W)).toBe(CHECKLIST_MIN_W)
  })

  it('treats a non-finite / non-positive boardScale as 1:1 (never NaN/Infinity)', () => {
    expect(widthFromDrag(156, 20, 0, NOTE_MIN_W)).toBe(176)
    expect(widthFromDrag(156, 20, NaN, NOTE_MIN_W)).toBe(176)
    expect(widthFromDrag(156, 20, -3, NOTE_MIN_W)).toBe(176)
  })

  it('rounds to whole px', () => {
    expect(widthFromDrag(156, 33, 3, NOTE_MIN_W)).toBe(167) // 156 + 11
  })
})
