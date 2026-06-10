/**
 * D2-A inline board title edit — jsdom tier. Pins the component contract: the
 * double-click / F2 input swap, Enter/blur commit as ONE undoable gesture, Esc
 * cancel, empty/unchanged no-op (no store write, no phantom undo step), and the
 * F2 typing + multi-select guards. The real-input slivers (OS key delivery into
 * the mount-stable window listeners, React Flow drag/dblclick-zoom interplay,
 * xterm non-leak) live in e2e/titleEdit.e2e.ts — jsdom cannot see the
 * mid-dispatch listener-removal class these listeners are hardened against.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BoardFrame } from './BoardFrame'
import { useCanvasStore } from '../store/canvasStore'

afterEach(cleanup)

/** Seed exactly one board titled `agent` with clean undo rails; returns its id. */
function seedBoard(): string {
  useCanvasStore.setState({
    boards: [],
    past: [],
    future: [],
    selectedId: null,
    selectedIds: []
  })
  const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(id, { title: 'agent' })
  // The seeding writes above are setup, not the gesture under test — clear the rails.
  useCanvasStore.setState({ past: [], future: [] })
  return id
}

function titleOf(id: string): string {
  return useCanvasStore.getState().boards.find((b) => b.id === id)?.title ?? ''
}

function pastDepth(): number {
  return useCanvasStore.getState().past.length
}

function openEditor(): HTMLInputElement {
  fireEvent.doubleClick(screen.getByText('agent'))
  return screen.getByLabelText('Board title') as HTMLInputElement
}

describe('BoardTitle — double-click edit', () => {
  it('swaps to an input holding the current title; Enter commits to the store as one undo step', () => {
    const id = seedBoard()
    render(<BoardFrame type="terminal" boardId={id} title="agent" />)
    const input = openEditor()
    expect(input.value).toBe('agent')
    fireEvent.change(input, { target: { value: 'build loop' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(titleOf(id)).toBe('build loop')
    expect(screen.queryByLabelText('Board title')).toBeNull()
    // Exactly one undoable gesture; undo restores the old title.
    expect(pastDepth()).toBe(1)
    useCanvasStore.getState().undo()
    expect(titleOf(id)).toBe('agent')
  })

  it('Esc cancels: editor closes, store untouched, no undo step', () => {
    const id = seedBoard()
    render(<BoardFrame type="terminal" boardId={id} title="agent" />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('Board title')).toBeNull()
    expect(titleOf(id)).toBe('agent')
    expect(pastDepth()).toBe(0)
  })

  it('blur commits (click-away ends the edit like Enter)', () => {
    const id = seedBoard()
    render(<BoardFrame type="terminal" boardId={id} title="agent" />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: 'renamed by blur' } })
    fireEvent.blur(input)
    expect(titleOf(id)).toBe('renamed by blur')
    expect(pastDepth()).toBe(1)
  })

  it('whitespace-only text cancels instead of committing an empty title', () => {
    const id = seedBoard()
    render(<BoardFrame type="terminal" boardId={id} title="agent" />)
    const input = openEditor()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(titleOf(id)).toBe('agent')
    expect(pastDepth()).toBe(0)
  })

  it('unchanged text is a no-op: no store write, no phantom undo step', () => {
    const id = seedBoard()
    render(<BoardFrame type="terminal" boardId={id} title="agent" />)
    const input = openEditor()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(titleOf(id)).toBe('agent')
    expect(pastDepth()).toBe(0)
  })

  it('keystrokes inside the editor never bubble to window (canvas keymap containment)', () => {
    const id = seedBoard()
    render(<BoardFrame type="terminal" boardId={id} title="agent" />)
    const input = openEditor()
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    fireEvent.keyDown(input, { key: 't' }) // bare `t` = the canvas tidy shortcut
    fireEvent.keyDown(input, { key: 'Backspace' }) // RF deleteKeyCode
    window.removeEventListener('keydown', spy)
    expect(spy).not.toHaveBeenCalled()
  })

  it('renders a plain, non-editable span when boardId is absent', () => {
    seedBoard()
    render(<BoardFrame type="terminal" title="agent" />)
    fireEvent.doubleClick(screen.getByText('agent'))
    expect(screen.queryByLabelText('Board title')).toBeNull()
  })
})

describe('BoardTitle — F2', () => {
  it('opens the editor when this board is the single selection', () => {
    const id = seedBoard()
    useCanvasStore.getState().setSelection([id])
    render(<BoardFrame type="terminal" boardId={id} title="agent" selected />)
    fireEvent.keyDown(document.body, { key: 'F2' })
    expect(screen.getByLabelText('Board title')).toBeTruthy()
  })

  it('does nothing when the board is not selected', () => {
    const id = seedBoard()
    render(<BoardFrame type="terminal" boardId={id} title="agent" />)
    fireEvent.keyDown(document.body, { key: 'F2' })
    expect(screen.queryByLabelText('Board title')).toBeNull()
  })

  it('does not hijack F2 while focus is in an input/textarea (xterm helper textarea class)', () => {
    const id = seedBoard()
    useCanvasStore.getState().setSelection([id])
    render(
      <>
        <textarea aria-label="other field" />
        <BoardFrame type="terminal" boardId={id} title="agent" selected />
      </>
    )
    const other = screen.getByLabelText('other field')
    other.focus()
    fireEvent.keyDown(other, { key: 'F2' })
    expect(screen.queryByLabelText('Board title')).toBeNull()
  })

  it('does nothing on a multi-selection (would open an editor on every selected board)', () => {
    const id = seedBoard()
    useCanvasStore.getState().setSelection([id, 'someone-else'])
    render(<BoardFrame type="terminal" boardId={id} title="agent" selected />)
    fireEvent.keyDown(document.body, { key: 'F2' })
    expect(screen.queryByLabelText('Board title')).toBeNull()
  })
})
