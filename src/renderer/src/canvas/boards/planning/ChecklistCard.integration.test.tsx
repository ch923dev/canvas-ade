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

it('PLAN-04: the progress bar is announced as a progressbar with value + valuetext', () => {
  render(
    <ChecklistCard
      element={{
        ...el,
        items: [
          { id: 'i1', label: 'a', done: true },
          { id: 'i2', label: 'b', done: false },
          { id: 'i3', label: 'c', done: false }
        ]
      }}
      interactive
      onDragStart={() => {}}
      onToggle={() => {}}
      onChangeTitle={() => {}}
      onChangeItem={() => {}}
      onAddItem={() => {}}
      onRemoveItem={() => {}}
    />
  )
  const bar = screen.getByRole('progressbar', { name: 'Checklist progress' })
  expect(bar.getAttribute('aria-valuenow')).toBe('33') // 1/3 → 33%
  expect(bar.getAttribute('aria-valuemin')).toBe('0')
  expect(bar.getAttribute('aria-valuemax')).toBe('100')
  expect(bar.getAttribute('aria-valuetext')).toBe('1 of 3 done')
})

// ── PLAN-05 width-resize handle ──────────────────────────────────────────────────

const resizeBase = {
  interactive: true,
  onDragStart: () => {},
  onToggle: () => {},
  onChangeTitle: () => {},
  onChangeItem: () => {},
  onAddItem: () => {},
  onRemoveItem: () => {}
}

it('PLAN-05: shows the width handle only when selected + interactive + unlocked', () => {
  const { rerender } = render(
    <ChecklistCard {...resizeBase} element={el} selected onResize={() => {}} />
  )
  expect(screen.getByTestId('pl-width-resize')).toBeTruthy()
  rerender(<ChecklistCard {...resizeBase} element={el} selected={false} onResize={() => {}} />)
  expect(screen.queryByTestId('pl-width-resize')).toBeNull()
  rerender(
    <ChecklistCard {...resizeBase} element={{ ...el, locked: true }} selected onResize={() => {}} />
  )
  expect(screen.queryByTestId('pl-width-resize')).toBeNull()
})

it('PLAN-05: a past-threshold drag commits a new checklist width with one checkpoint', () => {
  const onResize = vi.fn()
  const onEditStart = vi.fn()
  render(
    <ChecklistCard
      {...resizeBase}
      element={{ ...el, w: 220 }}
      selected
      onEditStart={onEditStart}
      onResize={onResize}
    />
  )
  const handle = screen.getByTestId('pl-width-resize')
  fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 40, clientY: 0, pointerId: 1 }) // dx 40 > 4
  fireEvent.pointerUp(handle, { clientX: 40, clientY: 0, pointerId: 1 })
  expect(onEditStart).toHaveBeenCalledTimes(1)
  expect(onResize).toHaveBeenLastCalledWith('c1', 260) // 220 + 40 (scale 1 in jsdom)
})
