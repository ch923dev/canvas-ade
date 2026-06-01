import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FreeText } from './FreeText'
import type { TextElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const element = { id: 'x1', kind: 'text', x: 0, y: 0, text: '' } as unknown as TextElement

function renderText(interactive: boolean, onDelete = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <FreeText
      element={element} interactive={interactive}
      onDragStart={() => {}} onChangeText={() => {}} onDelete={onDelete}
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
