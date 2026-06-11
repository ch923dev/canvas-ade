import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChecklistCard } from './ChecklistCard'

afterEach(cleanup)

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

it('A10: the item toggle is announced as a checkbox (role + aria-checked) and toggles on click', () => {
  const onToggle = vi.fn()
  render(
    <ChecklistCard
      element={{ ...el, items: [{ id: 'i1', label: 'a', done: true }] }}
      interactive
      onDragStart={() => {}}
      onToggle={onToggle}
      onChangeTitle={() => {}}
      onChangeItem={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
    />
  )
  const box = screen.getByRole('checkbox', { name: 'a' })
  expect(box.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(box)
  expect(onToggle).toHaveBeenCalledWith('c1', 'i1')
})
