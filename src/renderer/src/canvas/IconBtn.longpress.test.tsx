// @vitest-environment jsdom
/**
 * Regression test for BUG-034: IconBtn long-press timer not cancelled on unmount.
 *
 * When an IconBtn with an onLongPress handler is unmounted while the long-press timer
 * is in flight, the timer must be cancelled so the callback does not fire after the
 * component is gone.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { IconBtn } from './BoardFrame'

afterEach(cleanup)

describe('IconBtn — long-press timer cleanup on unmount (BUG-034)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT fire onLongPress when the component unmounts before the timer expires', () => {
    const onLongPress = vi.fn()

    const { getByTitle, unmount } = render(
      <IconBtn name="maximize" title="test-btn" onLongPress={onLongPress} longPressMs={500} />
    )

    const btn = getByTitle('test-btn')

    // Arm the long-press timer (pointer down)
    fireEvent.mouseDown(btn)

    // Unmount the component before the 500ms timer fires
    unmount()

    // Advance past the long-press threshold — the timer should have been cancelled
    act(() => {
      vi.advanceTimersByTime(600)
    })

    // BUG-034: without the fix, onLongPress fires here because the timer wasn't cleared
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('still fires onLongPress normally when the component stays mounted', () => {
    const onLongPress = vi.fn()

    const { getByTitle } = render(
      <IconBtn name="maximize" title="test-btn" onLongPress={onLongPress} longPressMs={500} />
    )

    const btn = getByTitle('test-btn')

    // Arm the timer
    fireEvent.mouseDown(btn)

    // Let it fire
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(onLongPress).toHaveBeenCalledTimes(1)
  })
})

describe('IconBtn — long-press + contextmenu dedupe (BUG-030)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires the action only once when a long-press is immediately followed by the native contextmenu event', () => {
    const onAction = vi.fn()

    const { getByTitle } = render(
      <IconBtn
        name="maximize"
        title="test-btn"
        onLongPress={onAction}
        onContextMenu={onAction}
        longPressMs={500}
      />
    )

    const btn = getByTitle('test-btn')

    // Touch long-press: pointer down arms the timer, which fires onLongPress at 500ms...
    fireEvent.mouseDown(btn)
    act(() => {
      vi.advanceTimersByTime(600)
    })

    // ...then the browser also dispatches the native contextmenu event for the same gesture.
    fireEvent.contextMenu(btn)

    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('still fires the action via plain right-click (no preceding long-press)', () => {
    const onAction = vi.fn()

    const { getByTitle } = render(
      <IconBtn name="maximize" title="test-btn" onLongPress={onAction} onContextMenu={onAction} />
    )

    const btn = getByTitle('test-btn')

    fireEvent.contextMenu(btn)

    expect(onAction).toHaveBeenCalledTimes(1)
  })
})
