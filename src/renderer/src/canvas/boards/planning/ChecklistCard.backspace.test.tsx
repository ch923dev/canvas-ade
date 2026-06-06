// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChecklistCard } from './ChecklistCard'
import type { ChecklistElement, ChecklistItem } from '../../../lib/boardSchema'

afterEach(cleanup)

function makeEl(items: ChecklistItem[]): ChecklistElement {
  return {
    id: 'c1',
    kind: 'checklist',
    x: 10,
    y: 10,
    w: 220,
    h: 120,
    title: 'List',
    items
  }
}

// The card is a controlled component: the parent (store) owns `items`. To mirror
// the real flow, `onRemoveItem` re-renders the card with the item gone, exactly
// like the Zustand commit does.
function renderControlled(initial: ChecklistItem[]): {
  inputs: () => HTMLInputElement[]
  onRemoveItem: ReturnType<typeof vi.fn>
} {
  let items = initial
  const onRemoveItem = vi.fn((_elId: string, itemId: string) => {
    items = items.filter((i) => i.id !== itemId)
    rerender()
  })
  const view = render(
    <ChecklistCard
      element={makeEl(items)}
      interactive
      onDragStart={() => {}}
      onToggle={() => {}}
      onChangeTitle={() => {}}
      onChangeItem={() => {}}
      onAddItem={() => {}}
      onRemoveItem={onRemoveItem}
    />
  )
  const rerender = (): void => {
    view.rerender(
      <ChecklistCard
        element={makeEl(items)}
        interactive
        onDragStart={() => {}}
        onToggle={() => {}}
        onChangeTitle={() => {}}
        onChangeItem={() => {}}
        onAddItem={() => {}}
        onRemoveItem={onRemoveItem}
      />
    )
  }
  return {
    inputs: () => screen.getAllByPlaceholderText('Item…') as HTMLInputElement[],
    onRemoveItem
  }
}

it('Backspace on an empty MIDDLE item removes it and focuses the NEXT row — BUG-014', () => {
  const { inputs, onRemoveItem } = renderControlled([
    { id: 'i1', label: 'a', done: false },
    { id: 'i2', label: '', done: false },
    { id: 'i3', label: 'c', done: false }
  ])
  const middle = inputs()[1]
  middle.focus()
  fireEvent.keyDown(middle, { key: 'Backspace' })
  expect(onRemoveItem).toHaveBeenCalledWith('c1', 'i2')
  // After removal the rows are [i1='a', i3='c']; focus must land on what was the
  // next item (i3, label 'c'), NOT document.body.
  const after = inputs()
  expect(after).toHaveLength(2)
  expect(document.activeElement).toBe(after[1])
  expect((document.activeElement as HTMLInputElement).value).toBe('c')
})

it('Backspace on the empty LAST item removes it and focuses the PREVIOUS row — BUG-014', () => {
  const { inputs, onRemoveItem } = renderControlled([
    { id: 'i1', label: 'a', done: false },
    { id: 'i2', label: '', done: false }
  ])
  const last = inputs()[1]
  last.focus()
  fireEvent.keyDown(last, { key: 'Backspace' })
  expect(onRemoveItem).toHaveBeenCalledWith('c1', 'i2')
  const after = inputs()
  expect(after).toHaveLength(1)
  expect(document.activeElement).toBe(after[0])
  expect((document.activeElement as HTMLInputElement).value).toBe('a')
})
