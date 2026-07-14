/**
 * NewKanbanDialog — jsdom tier. Pins the place-first creation contract against the real store:
 * Flow keeps the seeded template (no board patch), Category re-shapes the board to empty + stamps
 * columnAxis/axisLabel, and Cancel changes nothing. The visual pixels are a manual/e2e concern.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { NewKanbanDialog } from './NewKanbanDialog'
import { useCanvasStore } from '../../store/canvasStore'
import type { KanbanBoard as KanbanBoardData } from '../../lib/boardSchema'

afterEach(cleanup)

/** A freshly-created Kanban carries the flow template (the state the dialog opens over). */
function seedTemplateBoard(): KanbanBoardData {
  const board: KanbanBoardData = {
    id: 'k1',
    type: 'kanban',
    x: 0,
    y: 0,
    w: 1000,
    h: 520,
    title: 'Kanban',
    columns: [
      { id: 'backlog', title: 'Backlog' },
      { id: 'in-progress', title: 'In Progress' },
      { id: 'review', title: 'Review' },
      { id: 'done', title: 'Done' }
    ],
    cards: []
  }
  useCanvasStore.setState({
    boards: [board],
    past: [],
    future: [],
    selectedId: null,
    selectedIds: []
  })
  return board
}

function boardOf(): KanbanBoardData {
  return useCanvasStore.getState().boards.find((b) => b.id === 'k1') as KanbanBoardData
}

describe('NewKanbanDialog', () => {
  it('defaults to Flow and hides the axis-name field', () => {
    const board = seedTemplateBoard()
    render(<NewKanbanDialog board={board} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'Flow' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText('Category axis name')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create Flow board' })).toBeTruthy()
  })

  it('Create Flow keeps the template unchanged and closes (no board patch)', () => {
    const board = seedTemplateBoard()
    const onClose = vi.fn()
    render(<NewKanbanDialog board={board} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Flow board' }))
    expect(onClose).toHaveBeenCalledOnce()
    const after = boardOf()
    expect(after.columnAxis).toBeUndefined() // absent ⇒ flow
    expect(after.columns.map((c) => c.title)).toEqual(['Backlog', 'In Progress', 'Review', 'Done'])
  })

  it('picking Category reveals the name field and re-labels the primary button', () => {
    const board = seedTemplateBoard()
    render(<NewKanbanDialog board={board} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Category' }))
    expect(screen.getByLabelText('Category axis name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create Category board' })).toBeTruthy()
  })

  it('Create Category empties the template and stamps columnAxis + a trimmed axisLabel', () => {
    const board = seedTemplateBoard()
    const onClose = vi.fn()
    render(<NewKanbanDialog board={board} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Category' }))
    fireEvent.change(screen.getByLabelText('Category axis name'), {
      target: { value: '  Phase  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Category board' }))
    const after = boardOf()
    expect(after.columnAxis).toBe('category')
    expect(after.axisLabel).toBe('Phase')
    expect(after.columns).toEqual([]) // starts empty — user defines their own lanes
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('Category with a blank name leaves axisLabel absent (modal falls back to "Category")', () => {
    const board = seedTemplateBoard()
    render(<NewKanbanDialog board={board} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Category' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Category board' }))
    const after = boardOf()
    expect(after.columnAxis).toBe('category')
    expect(after.axisLabel).toBeUndefined()
    expect(after.columns).toEqual([])
  })

  it('Cancel changes nothing and closes', () => {
    const board = seedTemplateBoard()
    const onClose = vi.fn()
    render(<NewKanbanDialog board={board} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Category' })) // even after switching axis…
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    const after = boardOf()
    expect(after.columnAxis).toBeUndefined() // …Cancel commits none of it
    expect(after.columns).toHaveLength(4)
  })
})
