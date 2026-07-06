// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useRef, type ReactElement } from 'react'
import { Modal } from './Modal'

afterEach(cleanup)

const noop = (): void => {}

describe('Modal (shared primitive, design-audit D1-B)', () => {
  it('portals a dialog to <body> with aria-modal + the given label', () => {
    render(
      <div data-testid="app-root">
        <Modal label="Test dialog" onClose={noop} zIndex={500}>
          <p>hello</p>
        </Modal>
      </div>
    )
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Portaled: the dialog must NOT be inside the in-tree wrapper.
    expect(screen.getByTestId('app-root').contains(dialog)).toBe(false)
    expect(dialog.textContent).toContain('hello')
  })

  it('uses the --scrim token (no hardcoded rgba) and the given zIndex on the scrim', () => {
    render(
      <Modal label="T" onClose={noop} zIndex={777} scrimProps={{ 'data-testid': 'scrim' }}>
        <p>x</p>
      </Modal>
    )
    const scrim = screen.getByTestId('scrim')
    expect(scrim.style.background).toBe('var(--scrim)')
    expect(scrim.style.zIndex).toBe('777')
  })

  it('closes on a scrim pointerdown, but not on a pointerdown inside the card', () => {
    const onClose = vi.fn()
    render(
      <Modal label="T" onClose={onClose} zIndex={1} scrimProps={{ 'data-testid': 'scrim' }}>
        <button>inside</button>
      </Modal>
    )
    fireEvent.pointerDown(screen.getByText('inside'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByTestId('scrim'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape via a bubble-phase window listener', () => {
    const onClose = vi.fn()
    render(
      <Modal label="T" onClose={onClose} zIndex={1}>
        <button>b</button>
      </Modal>
    )
    // Dispatch from a child node so capture-then-bubble ordering is exercised honestly
    // (the full-view Esc listener in useCanvasKeybindings captures on window and must be
    // able to beat this listener — see EscFullViewConfirm.integration.test).
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closeDisabled blocks Esc + scrim close and shows a wait cursor (busy lock)', () => {
    const onClose = vi.fn()
    render(
      <Modal
        label="T"
        onClose={onClose}
        zIndex={1}
        closeDisabled
        scrimProps={{ 'data-testid': 'scrim' }}
      >
        <button>b</button>
      </Modal>
    )
    const scrim = screen.getByTestId('scrim')
    expect(scrim.style.cursor).toBe('wait')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.pointerDown(scrim)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('scrimClose={false} makes a scrim pointerdown INERT while Esc still closes', () => {
    const onClose = vi.fn()
    render(
      <Modal
        label="T"
        onClose={onClose}
        zIndex={1}
        scrimClose={false}
        scrimProps={{ 'data-testid': 'scrim' }}
      >
        <button>b</button>
      </Modal>
    )
    // Click-outside does nothing...
    fireEvent.pointerDown(screen.getByTestId('scrim'))
    expect(onClose).not.toHaveBeenCalled()
    // ...but the keyboard escape path is untouched (ConfirmModal keeps its Esc deny).
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('idle scrim cursor is default (BUG-007(5) contract carried over from SettingsModal)', () => {
    render(
      <Modal label="T" onClose={noop} zIndex={1} scrimProps={{ 'data-testid': 'scrim' }}>
        <button>b</button>
      </Modal>
    )
    expect(screen.getByTestId('scrim').style.cursor).toBe('default')
  })

  it('confirmGate marks the scrim with data-confirm-active (BUG-005 Esc-priority signal)', () => {
    const { rerender } = render(
      <Modal label="T" onClose={noop} zIndex={1} confirmGate>
        <button>b</button>
      </Modal>
    )
    expect(document.querySelector('[data-confirm-active]')).not.toBeNull()
    rerender(
      <Modal label="T" onClose={noop} zIndex={1}>
        <button>b</button>
      </Modal>
    )
    expect(document.querySelector('[data-confirm-active]')).toBeNull()
  })

  it('focuses the first focusable element on mount (A7 initial focus)', () => {
    render(
      <Modal label="T" onClose={noop} zIndex={1}>
        <button>first</button>
        <button>second</button>
      </Modal>
    )
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('initialFocusRef wins over the first focusable', () => {
    function Harness(): ReactElement {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <Modal label="T" onClose={noop} zIndex={1} initialFocusRef={ref}>
          <button>first</button>
          <button ref={ref}>second</button>
        </Modal>
      )
    }
    render(<Harness />)
    expect(document.activeElement).toBe(screen.getByText('second'))
  })

  it('restores focus to the previously-focused element on unmount (A7 focus restore)', () => {
    render(<button data-testid="opener">open</button>)
    screen.getByTestId('opener').focus()
    expect(document.activeElement).toBe(screen.getByTestId('opener'))

    const { unmount } = render(
      <Modal label="T" onClose={noop} zIndex={1}>
        <button>inside</button>
      </Modal>
    )
    expect(document.activeElement).toBe(screen.getByText('inside'))
    unmount()
    expect(document.activeElement).toBe(screen.getByTestId('opener'))
  })

  it('traps Tab: wraps last → first and Shift+Tab first → last (A7 focus trap)', () => {
    render(
      <Modal label="T" onClose={noop} zIndex={1}>
        <button>first</button>
        <button>last</button>
      </Modal>
    )
    const first = screen.getByText('first')
    const last = screen.getByText('last')

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('skips disabled controls when computing the trap edges', () => {
    render(
      <Modal label="T" onClose={noop} zIndex={1}>
        <button disabled>disabled-first</button>
        <button>real-first</button>
        <button>real-last</button>
        <button disabled>disabled-last</button>
      </Modal>
    )
    // Initial focus lands on the first ENABLED control.
    expect(document.activeElement).toBe(screen.getByText('real-first'))
    const realLast = screen.getByText('real-last')
    realLast.focus()
    fireEvent.keyDown(realLast, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('real-first'))
  })
})
