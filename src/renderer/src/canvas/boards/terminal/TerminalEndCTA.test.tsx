import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TerminalEndCTA } from './TerminalEndCTA'

// globals: false → auto-cleanup isn't registered; unmount between tests explicitly.
afterEach(cleanup)

const handlers = (): {
  onRestart: () => void
  onResume: () => void
  onConfigure: () => void
} => ({ onRestart: vi.fn(), onResume: vi.fn(), onConfigure: vi.fn() })

describe('TerminalEndCTA (TERM-04)', () => {
  it('exited: shows "{identity} exited" + Restart, and Resume only when resumable', () => {
    const h = handlers()
    const { rerender } = render(
      <TerminalEndCTA failed={false} identity="claude" canResume={false} {...h} />
    )
    expect(screen.getByText('claude exited')).toBeTruthy()
    expect(screen.getByText('Restart')).toBeTruthy()
    expect(screen.queryByText('Resume')).toBeNull() // no session id → no Resume

    rerender(<TerminalEndCTA failed={false} identity="claude" canResume={true} {...h} />)
    expect(screen.getByText('Resume')).toBeTruthy()
  })

  it('exited: Restart and Resume fire their handlers', () => {
    const h = handlers()
    render(<TerminalEndCTA failed={false} identity="claude" canResume={true} {...h} />)
    fireEvent.click(screen.getByText('Restart'))
    fireEvent.click(screen.getByText('Resume'))
    expect(h.onRestart).toHaveBeenCalledOnce()
    expect(h.onResume).toHaveBeenCalledOnce()
    expect(h.onConfigure).not.toHaveBeenCalled()
  })

  it('spawn-failed: shows "Couldn\'t start {identity}" + Retry + Configure (no Resume)', () => {
    const h = handlers()
    render(<TerminalEndCTA failed={true} identity="pwsh" canResume={true} {...h} />)
    expect(screen.getByText("Couldn't start pwsh")).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
    expect(screen.getByText('Configure')).toBeTruthy()
    expect(screen.queryByText('Resume')).toBeNull() // resume is not offered on a failed spawn
  })

  it('spawn-failed: Retry restarts, Configure opens config', () => {
    const h = handlers()
    render(<TerminalEndCTA failed={true} identity="pwsh" canResume={false} {...h} />)
    fireEvent.click(screen.getByText('Retry'))
    fireEvent.click(screen.getByText('Configure'))
    expect(h.onRestart).toHaveBeenCalledOnce()
    expect(h.onConfigure).toHaveBeenCalledOnce()
    expect(h.onResume).not.toHaveBeenCalled()
  })
})
