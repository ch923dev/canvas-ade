import { it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChecklistCard } from './ChecklistCard'

const el = {
  id: 'c1',
  kind: 'checklist' as const,
  x: 10,
  y: 10,
  w: 220,
  h: 120,
  title: 'List',
  items: [{ id: 'i1', label: 'a', done: false }]
}

it('starts a drag when the header (e.g. the count badge) is pressed', () => {
  const onDragStart = vi.fn()
  render(
    <ChecklistCard
      element={el}
      interactive
      onDragStart={onDragStart}
      onToggle={() => {}}
      onChangeTitle={() => {}}
      onChangeItem={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
    />
  )
  // The done/total count span is part of the header but is NOT currentTarget —
  // the old `e.target === e.currentTarget` guard wrongly excluded it.
  fireEvent.pointerDown(screen.getByText('0/1'))
  expect(onDragStart).toHaveBeenCalledTimes(1)
})
