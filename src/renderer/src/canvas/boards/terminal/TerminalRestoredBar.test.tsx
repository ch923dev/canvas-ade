import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalRestoredBar } from './TerminalRestoredBar'

// globals: false → auto-cleanup isn't registered; unmount between tests explicitly.
afterEach(cleanup)

describe('TerminalRestoredBar (S3)', () => {
  it('always offers Start; Resume only when the board carries a resumable agent session', () => {
    const onStart = vi.fn()
    const onResume = vi.fn()
    const { rerender } = render(<TerminalRestoredBar identity="claude" onStart={onStart} />)
    expect(screen.getByText('Session restored — read-only')).toBeTruthy()
    expect(screen.getByText('Start claude')).toBeTruthy()
    expect(screen.queryByText('Resume')).toBeNull() // no session id → screen restore only

    rerender(
      <TerminalRestoredBar identity="claude" onStart={onStart} canResume onResume={onResume} />
    )
    expect(screen.getByText('Resume')).toBeTruthy()
  })

  it('does not render Resume when canResume is true but no onResume is provided', () => {
    render(<TerminalRestoredBar identity="claude" onStart={vi.fn()} canResume />)
    expect(screen.queryByText('Resume')).toBeNull()
  })

  it('Start and Resume fire their handlers independently', () => {
    const onStart = vi.fn()
    const onResume = vi.fn()
    render(
      <TerminalRestoredBar identity="claude" onStart={onStart} canResume onResume={onResume} />
    )
    fireEvent.click(screen.getByText('Resume'))
    expect(onResume).toHaveBeenCalledOnce()
    expect(onStart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Start claude'))
    expect(onStart).toHaveBeenCalledOnce()
  })
})
