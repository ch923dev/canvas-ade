// @vitest-environment jsdom
/**
 * D2-B unsaved-changes guard: an implicit close (Escape / outside pointerdown / ⚙
 * closeSignal) with unsaved edits must NOT silently discard — it arms the confirm row
 * (warn line + Cancel→Discard). Clean closes pass straight through; edits disarm.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { TerminalConfig } from './TerminalConfig'
import { useCanvasStore } from '../../store/canvasStore'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'

afterEach(cleanup)

beforeEach(() => {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  ;(window as unknown as { api: unknown }).api = {
    listShells: vi.fn(async () => [])
  }
})

function seedTerminal(): TerminalBoardData {
  const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
  return useCanvasStore.getState().boards.find((b) => b.id === id) as TerminalBoardData
}

const LAUNCH_PLACEHOLDER = /blank = shell only/

function renderConfig(extra: Partial<Parameters<typeof TerminalConfig>[0]> = {}): {
  onClose: ReturnType<typeof vi.fn>
  rerenderWith: (next: Partial<Parameters<typeof TerminalConfig>[0]>) => void
} {
  const board = seedTerminal()
  const onClose = vi.fn()
  const base = { board, onClose, fontSize: 12, onSetFont: () => {} }
  const { rerender } = render(<TerminalConfig {...base} {...extra} />)
  return {
    onClose,
    rerenderWith: (next) => rerender(<TerminalConfig {...base} {...extra} {...next} />)
  }
}

const launchInput = (): HTMLInputElement =>
  screen.getByPlaceholderText(LAUNCH_PLACEHOLDER) as HTMLInputElement

describe('TerminalConfig unsaved-changes guard', () => {
  it('clean: Escape closes immediately, no confirm row', () => {
    const { onClose } = renderConfig()
    fireEvent.keyDown(launchInput(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('dirty: Escape arms the confirm row instead of closing; Discard then closes', () => {
    const { onClose } = renderConfig()
    fireEvent.change(launchInput(), { target: { value: 'claude' } })
    fireEvent.keyDown(launchInput(), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/Unsaved changes/)
    // Cancel is relabelled Discard while confirming — an explicit discard.
    fireEvent.click(screen.getByText('Discard'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dirty: outside pointerdown arms the confirm row; a second one stays armed', () => {
    const { onClose } = renderConfig()
    fireEvent.change(launchInput(), { target: { value: 'codex' } })
    fireEvent.pointerDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.pointerDown(document.body) // idempotent — no close, no crash
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clean: outside pointerdown closes straight through', () => {
    const { onClose } = renderConfig()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a pointerdown inside the trigger is excluded (the ⚙ click toggles, no double-fire)', () => {
    const trigger = document.createElement('span')
    document.body.appendChild(trigger)
    const { onClose } = renderConfig({ triggerRef: { current: trigger } })
    fireEvent.pointerDown(trigger)
    expect(onClose).not.toHaveBeenCalled()
    document.body.removeChild(trigger)
  })

  it('editing a field disarms the confirm row (keep editing)', () => {
    renderConfig()
    fireEvent.change(launchInput(), { target: { value: 'claude' } })
    fireEvent.keyDown(launchInput(), { key: 'Escape' })
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.change(launchInput(), { target: { value: 'claude --resume' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('second Escape while confirming returns to editing, not discard', () => {
    const { onClose } = renderConfig()
    fireEvent.change(launchInput(), { target: { value: 'claude' } })
    fireEvent.keyDown(launchInput(), { key: 'Escape' })
    fireEvent.keyDown(launchInput(), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closeSignal bump routes through the guard (dirty → confirm; clean → close)', () => {
    const { onClose, rerenderWith } = renderConfig({ closeSignal: 0 })
    fireEvent.change(launchInput(), { target: { value: 'claude' } })
    rerenderWith({ closeSignal: 1 })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.change(launchInput(), { target: { value: '' } }) // back to clean + disarms
    rerenderWith({ closeSignal: 2 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('whitespace-only launch command is not dirty (matches apply normalization)', () => {
    const { onClose } = renderConfig()
    fireEvent.change(launchInput(), { target: { value: '   ' } })
    fireEvent.keyDown(launchInput(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
