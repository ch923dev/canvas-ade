/**
 * KanbanBoard P4.2 human interaction — jsdom tier. Pins the component contract against the real
 * store: inline add/rename/delete a card, HTML5 drag a card between columns, and column authoring
 * (add/rename/delete-with-reflow + soft WIP). Every edit lands through `updateBoard` as one undoable
 * step. The full-app slivers (React Flow drag interplay, actual pointer DnD) live in the e2e spec.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { KanbanBoard } from './KanbanBoard'
import { useCanvasStore } from '../../store/canvasStore'
import type { KanbanBoard as KanbanBoardData } from '../../lib/boardSchema'

afterEach(cleanup)

/** Seed one deterministic kanban board (fixed ids) with clean undo rails. */
function seed(): void {
  const board: KanbanBoardData = {
    id: 'k1',
    type: 'kanban',
    x: 0,
    y: 0,
    w: 900,
    h: 520,
    title: 'Plan',
    columns: [
      { id: 'backlog', title: 'Backlog' },
      { id: 'progress', title: 'In Progress', wip: 2 },
      { id: 'review', title: 'Review' }
    ],
    cards: [
      { id: 'c1', columnId: 'backlog', title: 'One' },
      { id: 'c2', columnId: 'progress', title: 'Two' },
      { id: 'c3', columnId: 'progress', title: 'Three' }
    ]
  }
  useCanvasStore.setState({
    boards: [board],
    past: [],
    future: [],
    selectedId: null,
    selectedIds: []
  })
}

function boardOf(): KanbanBoardData {
  return useCanvasStore.getState().boards.find((b) => b.id === 'k1') as KanbanBoardData
}

/** Wrapper that re-feeds the live board from the store (as BoardNode does) so edits reflect. */
function Harness(): ReactElement {
  const board = useCanvasStore((s) => s.boards.find((b) => b.id === 'k1') as KanbanBoardData)
  return <KanbanBoard board={board} selected hovered={false} dimmed={false} />
}

function fakeDT(): { setData: (k: string, v: string) => void; getData: (k: string) => string } {
  const store: Record<string, string> = {}
  return {
    setData: (k, v) => {
      store[k] = v
    },
    getData: (k) => store[k] ?? ''
  }
}

function columnEl(title: string): HTMLElement {
  return screen.getByText(title).closest('.kb-col') as HTMLElement
}

describe('KanbanBoard — read render', () => {
  it('paints columns, counts, and the at-limit WIP badge in the warn state', () => {
    seed()
    render(<Harness />)
    expect(screen.getByText('Backlog')).toBeTruthy()
    expect(screen.getByText('One')).toBeTruthy()
    const badge = screen.getByText('WIP 2/2') // In Progress: 2 cards, limit 2 → at limit
    expect(badge.className).toContain('kb-wip-full')
  })
})

describe('KanbanBoard — card interaction', () => {
  it('adds a card via the inline input (Enter commits to the store)', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('Add card to Backlog'))
    const input = screen.getByLabelText('New card in Backlog') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  Fourth  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const backlog = boardOf().cards.filter((c) => c.columnId === 'backlog')
    expect(backlog.map((c) => c.title)).toEqual(['One', 'Fourth'])
    expect(useCanvasStore.getState().past).toHaveLength(1) // one undoable step
  })

  it('renames a card via double-click → Enter', () => {
    seed()
    render(<Harness />)
    fireEvent.doubleClick(screen.getByText('One'))
    const input = screen.getByLabelText('Card title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'One!' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(boardOf().cards.find((c) => c.id === 'c1')?.title).toBe('One!')
  })

  it('Escape cancels a rename (no store write)', () => {
    seed()
    render(<Harness />)
    fireEvent.doubleClick(screen.getByText('Two'))
    const input = screen.getByLabelText('Card title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(boardOf().cards.find((c) => c.id === 'c2')?.title).toBe('Two')
    expect(useCanvasStore.getState().past).toHaveLength(0)
  })

  it('deletes a card via its × button', () => {
    seed()
    render(<Harness />)
    const card = screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement
    fireEvent.click(within(card).getByLabelText('Delete card'))
    expect(boardOf().cards.some((c) => c.id === 'c1')).toBe(false)
  })

  it('drags a card between columns (HTML5 drop re-parents + tail-appends)', () => {
    seed()
    render(<Harness />)
    const dt = fakeDT()
    const card = screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement
    fireEvent.dragStart(card, { dataTransfer: dt })
    // Drop onto a descendant of the Review column → bubbles to the column's onDrop.
    fireEvent.drop(screen.getByLabelText('Add card to Review'), { dataTransfer: dt })
    const c1 = boardOf().cards.find((c) => c.id === 'c1')
    expect(c1?.columnId).toBe('review')
    // moved card sits at the array tail (bottom of its new column)
    expect(boardOf().cards[boardOf().cards.length - 1].id).toBe('c1')
  })
})

describe('KanbanBoard — column authoring', () => {
  it('adds a column via the inline input', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('Add column'))
    const input = screen.getByLabelText('New column title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Done' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(boardOf().columns.map((c) => c.title)).toEqual([
      'Backlog',
      'In Progress',
      'Review',
      'Done'
    ])
  })

  it('renames a column via double-click', () => {
    seed()
    render(<Harness />)
    fireEvent.doubleClick(screen.getByText('Backlog'))
    const input = screen.getByLabelText('Column title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Todo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(boardOf().columns.find((c) => c.id === 'backlog')?.title).toBe('Todo')
  })

  it('deletes a column and reflows its cards to the neighbour', () => {
    seed()
    render(<Harness />)
    // delete In Progress (holds c2,c3) → they reflow to the lane that slides into place (Review)
    fireEvent.click(screen.getByLabelText('Delete column In Progress'))
    expect(boardOf().columns.map((c) => c.id)).toEqual(['backlog', 'review'])
    const reflowed = boardOf().cards.filter((c) => c.columnId === 'review')
    expect(reflowed.map((c) => c.id).sort()).toEqual(['c2', 'c3'])
  })

  it('sets a WIP limit and paints the badge warn when the count reaches it', () => {
    seed()
    render(<Harness />)
    // Backlog has 1 card and no limit → set limit 1 → at limit → warn badge.
    fireEvent.click(within(columnEl('Backlog')).getByLabelText('Set WIP limit'))
    const input = screen.getByLabelText('WIP limit') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(boardOf().columns.find((c) => c.id === 'backlog')?.wip).toBe(1)
    const badge = within(columnEl('Backlog')).getByText('WIP 1/1')
    expect(badge.className).toContain('kb-wip-full')
  })

  it('clears a WIP limit when the input is emptied', () => {
    seed()
    render(<Harness />)
    fireEvent.doubleClick(screen.getByText('WIP 2/2'))
    const input = screen.getByLabelText('WIP limit') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(boardOf().columns.find((c) => c.id === 'progress')?.wip).toBeUndefined()
  })
})
