// @vitest-environment jsdom
/**
 * F4: the Session block's fault-only hook-health line. Healthy (null) renders NOTHING — the
 * signed-off wireframe's zero-added-chrome rule — and each fault renders its exact copy.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, configure } from '@testing-library/react'
import { TerminalInspector, type TerminalInspectorProps } from './TerminalInspector'

configure({ testIdAttribute: 'data-test' })
afterEach(cleanup)

const props = (over: Partial<TerminalInspectorProps> = {}): TerminalInspectorProps => ({
  running: false,
  interruptSent: false,
  onInterrupt: vi.fn(),
  font: 13,
  defaultFont: 13,
  onDecFont: vi.fn(),
  onIncFont: vi.fn(),
  decFontDisabled: false,
  incFontDisabled: false,
  onResetFont: vi.fn(),
  canResume: false,
  onRestart: vi.fn(),
  onResume: vi.fn(),
  onNew: vi.fn(),
  recapShown: false,
  onToggleRecap: vi.fn(),
  onFind: vi.fn(),
  health: null,
  onConfigure: vi.fn(),
  onPushPreview: vi.fn(),
  onChooseTarget: vi.fn(),
  ...over
})

describe('TerminalInspector — hook-health line', () => {
  it('healthy renders no line at all (zero added chrome)', () => {
    render(<TerminalInspector {...props()} />)
    expect(screen.queryByTestId('inspector-hook-health')).toBeNull()
  })

  it.each([
    ['runner', 'Session capture off — Node.js not found on PATH'],
    ['hook', 'Session capture off — hook not installed'],
    ['no-capture', "Capture didn't record this session"]
  ] as const)('fault %s renders its exact copy', (fault, copy) => {
    render(<TerminalInspector {...props({ health: fault })} />)
    const line = screen.getByTestId('inspector-hook-health')
    expect(line.textContent).toBe(copy)
    expect(line.getAttribute('data-fault')).toBe(fault)
  })
})
