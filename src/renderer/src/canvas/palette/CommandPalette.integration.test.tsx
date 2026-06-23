// @vitest-environment jsdom
/**
 * CommandPalette integration (D4-A): rendering from a seeded store, type-to-filter,
 * keyboard navigation (combobox + aria-activedescendant), run semantics (close first,
 * verb one macrotask later), the `?` shortcuts view, and the `data-palette-open` Esc-layer
 * marker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, configure } from '@testing-library/react'

// The app's e2e hooks use `data-test` (toast-island, restart-resume, …) — point
// testing-library's byTestId at the same attribute instead of double-tagging nodes.
configure({ testIdAttribute: 'data-test' })
import { CommandPalette, type CommandPaletteProps } from './CommandPalette'
import { useCanvasStore } from '../../store/canvasStore'
import type { Board } from '../../lib/boardSchema'

afterEach(cleanup)

const BOARDS: Board[] = [
  {
    id: 't1',
    type: 'terminal',
    x: 0,
    y: 0,
    w: 400,
    h: 300,
    title: 'agent-1',
    agentSessionId: 's1'
  },
  { id: 'p1', type: 'planning', x: 500, y: 0, w: 400, h: 300, title: 'sprint plan', elements: [] }
]

function verbsMock(): CommandPaletteProps['verbs'] {
  return {
    newBoard: vi.fn(),
    goToBoard: vi.fn(),
    renameBoard: vi.fn(),
    duplicateBoard: vi.fn(),
    deleteBoard: vi.fn(),
    openFullView: vi.fn(),
    restartTerminal: vi.fn(),
    exportPlanning: vi.fn(),
    groupSelection: vi.fn(),
    focusGroup: vi.fn(),
    ungroup: vi.fn(),
    connectSelectedBoards: vi.fn(),
    disconnectSelectedBoards: vi.fn(),
    openCommandBoard: vi.fn(),
    viewAuditLog: vi.fn(),
    enableOrchestration: vi.fn(),
    disableOrchestration: vi.fn(),
    syncAgentCLIs: vi.fn(),
    goToExecutingTasks: vi.fn(),
    tidy: vi.fn(),
    fitAll: vi.fn(),
    resetZoom: vi.fn(),
    toggleMinimap: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn()
  }
}

beforeEach(() => {
  vi.useRealTimers()
  useCanvasStore.setState({
    boards: BOARDS,
    groups: [{ id: 'g1', name: 'feature-x', boardIds: ['t1', 'p1'] }],
    selectedIds: [],
    selectedId: null,
    past: [],
    future: []
  })
})

function open(over: Partial<CommandPaletteProps> = {}): {
  verbs: CommandPaletteProps['verbs']
  onClose: ReturnType<typeof vi.fn>
} {
  const verbs = over.verbs ?? verbsMock()
  const onClose = vi.fn()
  render(
    <CommandPalette
      initialView={over.initialView ?? 'commands'}
      verbs={verbs}
      onClose={over.onClose ?? onClose}
    />
  )
  return { verbs, onClose }
}

const input = (): HTMLInputElement => screen.getByTestId('palette-input') as HTMLInputElement

describe('command view', () => {
  it('renders grouped rows from the store: creates, gotos, groups, canvas, help', () => {
    open()
    expect(screen.getByTestId('palette-row-new-terminal')).toBeTruthy()
    expect(screen.getByTestId('palette-row-goto-t1').textContent).toContain('agent-1')
    expect(screen.getByTestId('palette-row-focus-group-g1').textContent).toContain('feature-x')
    expect(screen.getByTestId('palette-row-tidy')).toBeTruthy()
    expect(screen.getByTestId('palette-row-shortcuts')).toBeTruthy()
    // No selection → no selected-board section; empty rails → no undo/redo.
    expect(screen.queryByTestId('palette-row-rename-board')).toBeNull()
    expect(screen.queryByTestId('palette-row-undo')).toBeNull()
  })

  it('selected-board rows appear for a single selection (terminal: resume gated on session id)', () => {
    useCanvasStore.setState({ selectedIds: ['t1'], selectedId: 't1' })
    open()
    expect(screen.getByTestId('palette-row-rename-board')).toBeTruthy()
    expect(screen.getByTestId('palette-row-restart-resume')).toBeTruthy()
    expect(screen.queryByTestId('palette-row-export-png')).toBeNull()
  })

  it('focuses the search input on mount and filters as you type', () => {
    open()
    expect(document.activeElement).toBe(input())
    fireEvent.change(input(), { target: { value: 'tidy' } })
    expect(screen.getByTestId('palette-row-tidy')).toBeTruthy()
    expect(screen.queryByTestId('palette-row-new-terminal')).toBeNull()
  })

  it('shows the empty state on a no-match query', () => {
    open()
    fireEvent.change(input(), { target: { value: 'zzzzzz' } })
    expect(screen.getByText('No matching commands')).toBeTruthy()
  })

  it('ArrowDown/Up move the active row with wrap + aria-activedescendant tracks it', () => {
    open()
    const first = screen.getByTestId('palette-row-new-terminal')
    expect(first.hasAttribute('data-active')).toBe(true)
    expect(input().getAttribute('aria-activedescendant')).toBe(first.id)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const second = screen.getByTestId('palette-row-new-browser')
    expect(second.hasAttribute('data-active')).toBe(true)
    expect(input().getAttribute('aria-activedescendant')).toBe(second.id)
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' }) // wraps to the last row (shortcuts)
    expect(screen.getByTestId('palette-row-shortcuts').hasAttribute('data-active')).toBe(true)
  })

  it('Enter closes FIRST, then runs the active verb one macrotask later', async () => {
    vi.useFakeTimers()
    const { verbs, onClose } = open()
    fireEvent.change(input(), { target: { value: 'new planning' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(verbs.newBoard).not.toHaveBeenCalled() // deferred past the close
    await act(() => vi.runAllTimersAsync())
    expect(verbs.newBoard).toHaveBeenCalledWith('planning')
    vi.useRealTimers()
  })

  it('click runs a row; pointerdown does not steal input focus', async () => {
    vi.useFakeTimers()
    const { verbs, onClose } = open()
    const row = screen.getByTestId('palette-row-fit')
    fireEvent.pointerDown(row)
    expect(document.activeElement).toBe(input())
    fireEvent.click(row)
    expect(onClose).toHaveBeenCalled()
    await act(() => vi.runAllTimersAsync())
    expect(verbs.fitAll).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('marks the scrim data-palette-open for the full-view Esc layer', () => {
    open()
    expect(document.querySelector('[data-palette-open]')).toBeTruthy()
  })
})

describe('shortcuts view', () => {
  it('"Keyboard shortcuts" switches the view in place (no close)', () => {
    const { onClose } = open()
    fireEvent.change(input(), { target: { value: 'keyboard shortcuts' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
    // Both the sheet title and the SHORTCUT_ROWS palette row carry this text.
    expect(screen.getAllByText('Keyboard shortcuts').length).toBeGreaterThan(0)
    expect(screen.getByText('Newline without submitting')).toBeTruthy()
  })

  it('? opens straight to the sheet; filter narrows rows; back returns to commands', () => {
    open({ initialView: 'shortcuts' })
    expect(screen.getByText('Fit all boards')).toBeTruthy()
    // Review r1 (ARIA): the read-only sheet has no option children, so neither the
    // combobox nor the listbox role may be present in this view.
    expect(input().getAttribute('role')).toBeNull()
    expect(input().getAttribute('aria-controls')).toBeNull()
    expect(screen.getByTestId('palette-list').getAttribute('role')).toBeNull()
    fireEvent.change(input(), { target: { value: 'nudge' } })
    expect(screen.getByText('Nudge selected elements')).toBeTruthy()
    expect(screen.queryByText('Fit all boards')).toBeNull()
    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.keyDown(input(), { key: 'Backspace' }) // empty query → back to commands
    expect(screen.getByTestId('palette-row-new-terminal')).toBeTruthy()
  })
})
