import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { NoteCard } from './NoteCard'
import type { NoteElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const note = {
  id: 'n1', kind: 'note', x: 0, y: 0, w: 160, h: 120, text: '', tint: 'yellow'
} as unknown as NoteElement

function renderNote(interactive: boolean, onDelete = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <NoteCard
      note={note} interactive={interactive}
      onDragStart={() => {}} onChangeText={() => {}} onDelete={onDelete}
    />
  )
  return onDelete
}

it('deletes an empty note on Backspace while interactive (select tool)', () => {
  const onDelete = renderNote(true)
  fireEvent.keyDown(screen.getByPlaceholderText('Note…'), { key: 'Backspace' })
  expect(onDelete).toHaveBeenCalledWith('n1')
})

it('does NOT delete on Backspace when non-interactive (draw tool active) — NOTE-1', () => {
  const onDelete = renderNote(false)
  fireEvent.keyDown(screen.getByPlaceholderText('Note…'), { key: 'Backspace' })
  expect(onDelete).not.toHaveBeenCalled()
})
