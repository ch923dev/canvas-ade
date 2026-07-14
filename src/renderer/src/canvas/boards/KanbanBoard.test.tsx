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
  it('adds a card via the create-mode modal (Add card commits ONE new card in one step) (#346)', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('Add card to Backlog'))
    // The create modal opens (empty draft) rather than a bare inline input.
    expect(screen.getByTestId('kanban-card-modal')).toBeTruthy()
    const input = screen.getByTestId('kbm-title') as HTMLInputElement
    expect(input.value).toBe('') // empty draft
    fireEvent.change(input, { target: { value: '  Fourth  ' } })
    // Seed a description too — proves the whole draft commits as one card / one undo step.
    fireEvent.change(screen.getByTestId('kbm-desc'), { target: { value: 'body' } })
    fireEvent.click(screen.getByTestId('kbm-add'))
    const backlog = boardOf().cards.filter((c) => c.columnId === 'backlog')
    expect(backlog.map((c) => c.title)).toEqual(['One', 'Fourth'])
    expect(backlog[1].description).toBe('body')
    expect(useCanvasStore.getState().past).toHaveLength(1) // one undoable step
    expect(screen.queryByTestId('kanban-card-modal')).toBeNull() // closes after Add
  })

  it('create modal pre-picks the target column and honours a column change (#346)', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByLabelText('Add card to Review'))
    const status = screen.getByTestId('kbm-status') as HTMLSelectElement
    expect(status.value).toBe('review') // pre-selected to the clicked column
    // Re-file to Backlog before adding.
    fireEvent.change(status, { target: { value: 'backlog' } })
    fireEvent.change(screen.getByTestId('kbm-title'), { target: { value: 'Moved' } })
    fireEvent.click(screen.getByTestId('kbm-add'))
    const created = boardOf().cards.find((c) => c.title === 'Moved')
    expect(created?.columnId).toBe('backlog')
  })

  it('create modal refuses a blank title (no card, no undo step) (#346)', () => {
    seed()
    render(<Harness />)
    const before = boardOf().cards.length
    fireEvent.click(screen.getByLabelText('Add card to Backlog'))
    fireEvent.change(screen.getByTestId('kbm-title'), { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('kbm-add'))
    expect(boardOf().cards.length).toBe(before) // nothing added
    expect(useCanvasStore.getState().past).toHaveLength(0)
    expect(screen.getByTestId('kanban-card-modal')).toBeTruthy() // stays open
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

  it('resyncs a blanked title on blur — blank is a store no-op, the field must not stay empty', () => {
    seed()
    render(<Harness />)
    fireEvent.click(screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement)
    const input = screen.getByTestId('kbm-title') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(boardOf().cards.find((c) => c.id === 'c1')?.title).toBe('One') // store keeps the real title
    expect((screen.getByTestId('kbm-title') as HTMLInputElement).value).toBe('One') // input resynced
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

  it('paints an attachment-count indicator on the card face (#346)', () => {
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
        {
          id: 'c1',
          columnId: 'backlog',
          title: 'One',
          attachments: [
            { assetId: 'assets/a.png', name: 'a.png', kind: 'image' },
            { assetId: 'assets/b.pdf', name: 'b.pdf', kind: 'file' }
          ]
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
    render(<Harness />)
    expect(screen.getByLabelText('2 attachments')).toBeTruthy()
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
    // + Add file & line opens the pick-file-lines modal (path/lines are chosen there, not typed)
    fireEvent.click(screen.getByTestId('kbm-ref-add'))
    expect(screen.getByTestId('pick-file-lines')).toBeTruthy()
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

  it('renders ref rows (basename + line badge) and removes one via ×', () => {
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
        {
          id: 'c1',
          columnId: 'backlog',
          title: 'One',
          fileRefs: [{ path: 'src/a.ts', line: 19, endLine: 21 }, { path: 'b.ts' }]
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
    render(<Harness />)
    fireEvent.click(screen.getByText('One').closest('[data-testid="kb-card"]') as HTMLElement)
    expect(screen.getByText('L19–21')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy() // basename shown
    fireEvent.click(screen.getAllByLabelText('Remove file reference')[0])
    expect(boardOf().cards.find((c) => c.id === 'c1')?.fileRefs).toEqual([{ path: 'b.ts' }])
  })

  it('clicking a ref path opens the picker to edit it', () => {
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
        { id: 'c1', columnId: 'backlog', title: 'One', fileRefs: [{ path: 'src/a.ts', line: 5 }] }
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
    fireEvent.click(screen.getByTitle('Edit this reference'))
    expect(screen.getByTestId('pick-file-lines')).toBeTruthy()
  })
})

describe('KanbanBoard — column axis (v19)', () => {
  // The axis is chosen ONCE in the New Kanban creation dialog — there is no in-board toggle. A
  // Flow board shows nothing; a Category board captions its label read-only.
  it('a Flow board shows no axis caption and no toggle', () => {
    seed() // no columnAxis ⇒ flow
    render(<Harness />)
    expect(screen.queryByTestId('kb-axis-cap')).toBeNull()
    expect(screen.queryByTestId('kb-axis-flow')).toBeNull()
    expect(screen.queryByTestId('kb-axis-category')).toBeNull()
  })

  it('a Category board captions its axis label read-only (no toggle)', () => {
    const board: KanbanBoardData = {
      id: 'k1',
      type: 'kanban',
      x: 0,
      y: 0,
      w: 900,
      h: 520,
      title: 'Plan',
      columnAxis: 'category',
      axisLabel: 'Phase',
      columns: [{ id: 'backlog', title: 'Backlog' }],
      cards: []
    }
    useCanvasStore.setState({
      boards: [board],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
    render(<Harness />)
    expect(within(screen.getByTestId('kb-axis-cap')).getByText('Phase')).toBeTruthy()
    expect(screen.queryByTestId('kb-axis-category')).toBeNull()
  })

  it('an empty Category board prompts to add the first lane (opens the add-column input)', () => {
    const board: KanbanBoardData = {
      id: 'k1',
      type: 'kanban',
      x: 0,
      y: 0,
      w: 900,
      h: 520,
      title: 'Plan',
      columnAxis: 'category',
      axisLabel: 'Phase',
      columns: [],
      cards: []
    }
    useCanvasStore.setState({
      boards: [board],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
    render(<Harness />)
    const add = screen.getByTestId('kb-add-first-lane')
    expect(add.textContent).toContain('Phase')
    fireEvent.click(add)
    expect(screen.getByLabelText('New column title')).toBeTruthy()
  })

  it('the modal column-field label reflects the axis (category → the axis label, not "Status")', () => {
    const board: KanbanBoardData = {
      id: 'k1',
      type: 'kanban',
      x: 0,
      y: 0,
      w: 900,
      h: 520,
      title: 'Plan',
      columnAxis: 'category',
      axisLabel: 'Phase',
      columns: [{ id: 'backlog', title: 'Backlog' }],
      cards: [{ id: 'c1', columnId: 'backlog', title: 'One' }]
    }
    useCanvasStore.setState({
      boards: [board],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'One' }))
    expect(screen.getByLabelText('Phase')).toBeTruthy() // the column <select>, labelled by the axis
    expect(screen.queryByText('Status')).toBeNull()
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

describe('KanbanBoard — creation gate (place-first New Kanban dialog)', () => {
  it('shows the dialog while the board is configPending; Cancel releases it', () => {
    seed()
    useCanvasStore.setState({ configPendingId: 'k1' })
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Create Flow board' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useCanvasStore.getState().configPendingId).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create Flow board' })).toBeNull()
  })

  it('renders no dialog for a board that is not configPending', () => {
    seed()
    useCanvasStore.setState({ configPendingId: null })
    render(<Harness />)
    expect(screen.queryByRole('button', { name: 'Create Flow board' })).toBeNull()
  })
})
