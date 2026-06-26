import { describe, it, expect } from 'vitest'
import { isScrolledUp, unreadSince, formatUnread } from './terminalJump'

describe('isScrolledUp', () => {
  it('is true when the viewport top is above the tail', () => {
    expect(isScrolledUp(5, 10)).toBe(true)
    expect(isScrolledUp(0, 1)).toBe(true)
  })
  it('is false at the tail', () => {
    expect(isScrolledUp(10, 10)).toBe(false)
    expect(isScrolledUp(0, 0)).toBe(false)
  })
  it('is false when the viewport is below the tail (defensive — should not happen)', () => {
    expect(isScrolledUp(12, 10)).toBe(false)
  })
})

describe('unreadSince', () => {
  it('counts lines appended since the anchored tail', () => {
    expect(unreadSince(40, 10)).toBe(30)
    expect(unreadSince(11, 10)).toBe(1)
  })
  it('is zero at the anchor', () => {
    expect(unreadSince(10, 10)).toBe(0)
  })
  it('floors at zero when the buffer shrank below the anchor', () => {
    expect(unreadSince(5, 10)).toBe(0)
  })
})

describe('formatUnread', () => {
  it('is empty for zero or negative', () => {
    expect(formatUnread(0)).toBe('')
    expect(formatUnread(-3)).toBe('')
  })
  it('renders the plain count under the cap', () => {
    expect(formatUnread(1)).toBe('1')
    expect(formatUnread(7)).toBe('7')
    expect(formatUnread(99)).toBe('99')
  })
  it('caps with a trailing plus above the cap', () => {
    expect(formatUnread(100)).toBe('99+')
    expect(formatUnread(5000)).toBe('99+')
  })
  it('honours a custom cap', () => {
    expect(formatUnread(12, 9)).toBe('9+')
    expect(formatUnread(9, 9)).toBe('9')
  })
})
