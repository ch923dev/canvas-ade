// src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts
import { describe, it, expect } from 'vitest'
import { correctClientPoint } from './terminalSelection'

const rect = { left: 100, top: 50 }

describe('correctClientPoint', () => {
  it('is the identity at z = 1', () => {
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 1)).toEqual({ x: 160, y: 90 })
  })

  it('doubles the in-element offset at z = 0.5 (zoomed out → screen px are half-size)', () => {
    // offset (60,40) → corrected offset (120,80) → (220,130)
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 0.5)).toEqual({ x: 220, y: 130 })
  })

  it('halves the in-element offset at z = 2 (zoomed in)', () => {
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 2)).toEqual({ x: 130, y: 70 })
  })

  it('guards a zero/invalid zoom (returns the point unchanged)', () => {
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 0)).toEqual({ x: 160, y: 90 })
    expect(correctClientPoint({ x: 160, y: 90 }, rect, NaN)).toEqual({ x: 160, y: 90 })
  })
})
