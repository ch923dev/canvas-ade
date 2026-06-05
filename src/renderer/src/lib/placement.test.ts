import { describe, it, expect } from 'vitest'
import { normalizeBox, isClickGesture, placementRect } from './placement'
import { MIN_BOARD_SIZE } from './boardSchema'

describe('normalizeBox', () => {
  it('orders corners into a positive-size box (any drag direction)', () => {
    expect(normalizeBox(100, 80, 40, 20)).toEqual({ x: 40, y: 20, w: 60, h: 60 })
    expect(normalizeBox(40, 20, 100, 80)).toEqual({ x: 40, y: 20, w: 60, h: 60 })
  })
  it('normalizes the off-diagonal drag directions too', () => {
    expect(normalizeBox(40, 80, 100, 20)).toEqual({ x: 40, y: 20, w: 60, h: 60 })
    expect(normalizeBox(100, 20, 40, 80)).toEqual({ x: 40, y: 20, w: 60, h: 60 })
  })
})

describe('isClickGesture', () => {
  it('is a click below the 5px threshold on both axes', () => {
    expect(isClickGesture(0, 0)).toBe(true)
    expect(isClickGesture(4, -4)).toBe(true)
  })
  it('is a drag once either axis reaches the threshold', () => {
    expect(isClickGesture(5, 0)).toBe(false)
    expect(isClickGesture(0, -6)).toBe(false)
  })
  it('treats both axes exactly at the threshold as a drag', () => {
    expect(isClickGesture(5, 5)).toBe(false)
  })
})

describe('placementRect', () => {
  it('normalizes two world corners into a board rect', () => {
    expect(placementRect({ x: 300, y: 400 }, { x: 50, y: 100 })).toEqual({
      x: 50,
      y: 100,
      w: 250,
      h: 300
    })
  })
  it('clamps a sub-minimum drag up to MIN_BOARD_SIZE, anchored at the top-left', () => {
    const r = placementRect({ x: 10, y: 10 }, { x: 30, y: 25 })
    expect(r).toEqual({ x: 10, y: 10, w: MIN_BOARD_SIZE.w, h: MIN_BOARD_SIZE.h })
  })
  it('clamps only the sub-minimum axis (wide, short drag keeps its width)', () => {
    expect(placementRect({ x: 0, y: 0 }, { x: 300, y: 50 })).toEqual({ x: 0, y: 0, w: 300, h: 160 })
  })
})
