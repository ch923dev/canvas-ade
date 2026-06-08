// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FreeText } from './FreeText'
import type { TextElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const element = { id: 'x1', kind: 'text', x: 0, y: 0, text: '' } as unknown as TextElement

function renderText(interactive: boolean, onDelete = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <FreeText
      element={element}
      interactive={interactive}
      onDragStart={() => {}}
      onChangeText={() => {}}
      onDelete={onDelete}
    />
  )
  return onDelete
}

it('deletes an empty text element on Backspace while interactive', () => {
  const onDelete = renderText(true)
  fireEvent.keyDown(screen.getByPlaceholderText('Text…'), { key: 'Backspace' })
  expect(onDelete).toHaveBeenCalledWith('x1')
})

it('does NOT delete on Backspace when non-interactive (draw tool active) — TEXT-1', () => {
  const onDelete = renderText(false)
  fireEvent.keyDown(screen.getByPlaceholderText('Text…'), { key: 'Backspace' })
  expect(onDelete).not.toHaveBeenCalled()
})

it('area text (width set) applies a fixed width + wraps', () => {
  const el = {
    id: 'a',
    kind: 'text',
    x: 0,
    y: 0,
    text: 'wrap me',
    width: 180
  } as unknown as TextElement
  render(
    <FreeText
      element={el}
      interactive
      onDragStart={() => {}}
      onChangeText={() => {}}
      onDelete={() => {}}
    />
  )
  const ta = screen.getByPlaceholderText('Text…') as HTMLTextAreaElement
  expect(ta.style.width).toBe('180px')
  expect(ta.style.whiteSpace).toBe('pre-wrap')
})

it('fires onEditingChange(true) on focus and (false) on blur', () => {
  const onEditingChange = vi.fn()
  const el = { id: 'a', kind: 'text', x: 0, y: 0, text: 'x' } as unknown as TextElement
  render(
    <FreeText
      element={el}
      interactive
      onDragStart={() => {}}
      onChangeText={() => {}}
      onDelete={() => {}}
      onEditingChange={onEditingChange}
    />
  )
  const ta = screen.getByPlaceholderText('Text…')
  fireEvent.focus(ta)
  expect(onEditingChange).toHaveBeenCalledWith('a', true)
  fireEvent.blur(ta)
  expect(onEditingChange).toHaveBeenCalledWith('a', false)
})

it('BUG-037: document pointer listeners do not fire onDelete when FreeText unmounts during a grip drag', () => {
  const onDelete = vi.fn()
  const { unmount } = render(
    <FreeText
      element={element}
      interactive={true}
      onDragStart={() => {}}
      onChangeText={() => {}}
      onDelete={onDelete}
    />
  )

  // Simulate grip pointerdown — this registers the three doc listeners
  const grip = document.querySelector('.pl-text-grip')!
  fireEvent.pointerDown(grip, { clientX: 10, clientY: 10, pointerId: 1 })

  // Simulate unmount during drag (e.g. component deleted via keyboard while grip held)
  unmount()

  // A stale pointerup on document must NOT call onDelete after unmount: the
  // listeners should have been aborted/removed as part of unmount cleanup (BUG-037).
  fireEvent.pointerUp(document)
  expect(onDelete).not.toHaveBeenCalled()
})
