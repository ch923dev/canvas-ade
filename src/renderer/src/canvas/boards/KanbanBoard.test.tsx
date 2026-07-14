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

  it('renames a card via the detail modal title field (blur commits)', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement)
    const input = screen.getByTestId('kbm-title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'One!' } })
    fireEvent.blur(input)
    expect(boardOf().cards.find((c) => c.id === 'c1')?.title).toBe('One!')
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

describe('KanbanBoard — card detail (v19)', () => {
  /** Seed one card carrying the v19 detail fields (no WIP, so digit assertions stay unambiguous). */
  function seedDetail(): void {
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
        { id: 'review', title: 'Review' }
      ],
      cards: [
        {
          id: 'c1',
          columnId: 'backlog',
          title: 'One',
          tags: ['feature', 'schema'],
          description: 'a body',
          fileRefs: [{ path: 'a.ts' }, { path: 'b.ts', line: 4 }]
        }
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

  it('paints tag chips + description + fileref-count indicators on the card face', () => {
    seedDetail()
    render(<Harness />)
    expect(screen.getByText('feature')).toBeTruthy()
    expect(screen.getByText('schema')).toBeTruthy()
    expect(screen.getByLabelText('Has a description')).toBeTruthy()
    expect(screen.getByLabelText('2 file references')).toBeTruthy()
  })

  it('opens the detail modal on a card-body click and edits the description', () => {
    seed()
    render(<Harness />)
    const card = screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement
    fireEvent.click(card) // body click (not the title) opens the modal
    expect(screen.getByTestId('kanban-card-modal')).toBeTruthy()
    const desc = screen.getByTestId('kbm-desc') as HTMLTextAreaElement
    fireEvent.change(desc, { target: { value: 'Wrote a description' } })
    fireEvent.blur(desc)
    expect(boardOf().cards.find((c) => c.id === 'c1')?.description).toBe('Wrote a description')
    expect(useCanvasStore.getState().past).toHaveLength(1) // one undoable step
  })

  it('opens the modal from the title button (keyboard/SR-accessible trigger)', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'One' })) // the title <button>
    expect(screen.getByTestId('kanban-card-modal')).toBeTruthy()
  })

  it('adds a tag and a file ref from the modal', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement)
    // add a tag
    const tagInput = screen.getByTestId('kbm-tag-input') as HTMLInputElement
    fireEvent.change(tagInput, { target: { value: 'urgent' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(boardOf().cards.find((c) => c.id === 'c1')?.tags).toEqual(['urgent'])
    // add a file ref
    fireEvent.click(screen.getByTestId('kbm-ref-add'))
    const pathInput = screen.getByLabelText('File path') as HTMLInputElement
    fireEvent.change(pathInput, { target: { value: 'src/x.ts' } })
    fireEvent.blur(pathInput)
    expect(boardOf().cards.find((c) => c.id === 'c1')?.fileRefs).toEqual([{ path: 'src/x.ts' }])
  })

  it('opens a file ref via openFileRef and closes the modal', () => {
    const calls: Array<[string, number | undefined, number | undefined]> = []
    useCanvasStore.setState({
      openFileRef: ((p: string, l?: number, e?: number) => {
        calls.push([p, l, e])
        return 'fb1'
      }) as never
    })
    const board: KanbanBoardData = {
      id: 'k1',
      type: 'kanban',
      x: 0,
      y: 0,
      w: 900,
      h: 520,
      title: 'Plan',
      columns: [{ id: 'backlog', title: 'Backlog' }],
      cards: [
        { id: 'c1', columnId: 'backlog', title: 'One', fileRefs: [{ path: 'a.ts', line: 9 }] }
      ]
    }
    useCanvasStore.setState({
      boards: [board],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
    render(<Harness />)
    fireEvent.click(screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement)
    fireEvent.click(screen.getByLabelText('Open file at line'))
    expect(calls).toEqual([['a.ts', 9, undefined]])
    expect(screen.queryByTestId('kanban-card-modal')).toBeNull() // modal closed to reveal the file
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
