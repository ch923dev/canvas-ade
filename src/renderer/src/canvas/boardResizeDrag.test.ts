/**
 * Board-resize drag registry (T1a′): BoardNode's NodeResizer marks a handle-drag in
 * progress; the terminal's resize settler subscribes and holds its PTY resize until
 * release. Module-level state, so each test uses fresh board ids.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  beginBoardResizeDrag,
  endBoardResizeDrag,
  isBoardResizeDragging,
  onBoardResizeDrag
} from './boardResizeDrag'

describe('boardResizeDrag (NodeResizer drag → terminal settler hold)', () => {
  it('begin/end flips the snapshot and notifies subscribers in order', () => {
    const cb = vi.fn()
    const off = onBoardResizeDrag('b1', cb)
    expect(isBoardResizeDragging('b1')).toBe(false)
    beginBoardResizeDrag('b1')
    expect(isBoardResizeDragging('b1')).toBe(true)
    endBoardResizeDrag('b1')
    expect(isBoardResizeDragging('b1')).toBe(false)
    expect(cb.mock.calls).toEqual([[true], [false]])
    off()
  })

  it('redundant begin/end are no-ops — the unmount guard after a real end fires nothing', () => {
    const cb = vi.fn()
    const off = onBoardResizeDrag('b2', cb)
    beginBoardResizeDrag('b2')
    beginBoardResizeDrag('b2') // NodeResizer double-fire
    endBoardResizeDrag('b2')
    endBoardResizeDrag('b2') // BoardNode unmount cleanup after a completed drag
    expect(cb.mock.calls).toEqual([[true], [false]])
    off()
  })

  it('end without begin is a no-op (unmount of a board never dragged)', () => {
    const cb = vi.fn()
    const off = onBoardResizeDrag('b3', cb)
    endBoardResizeDrag('b3')
    expect(cb).not.toHaveBeenCalled()
    off()
  })

  it('subscribers are per-board; unsubscribe stops delivery', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = onBoardResizeDrag('b4', a)
    const offB = onBoardResizeDrag('b5', b)
    beginBoardResizeDrag('b4')
    expect(a).toHaveBeenCalledWith(true)
    expect(b).not.toHaveBeenCalled()
    offA()
    endBoardResizeDrag('b4')
    expect(a).toHaveBeenCalledTimes(1)
    offB()
  })

  it('a subscriber arriving mid-drag reads the snapshot true (remount-mid-drag case)', () => {
    beginBoardResizeDrag('b6')
    expect(isBoardResizeDragging('b6')).toBe(true) // useTerminalSpawn's mount-time seed
    const cb = vi.fn()
    const off = onBoardResizeDrag('b6', cb)
    endBoardResizeDrag('b6')
    expect(cb).toHaveBeenCalledWith(false)
    off()
  })
})
