// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { NoteCard } from './NoteCard'
import type { NoteElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const note = {
  id: 'n1',
  kind: 'note',
  x: 0,
  y: 0,
  w: 160,
  h: 120,
  text: '',
  tint: 'yellow'
} as unknown as NoteElement

function renderNote(interactive: boolean, onDelete = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <NoteCard
      note={note}
      interactive={interactive}
      onDragStart={() => {}}
      onChangeText={() => {}}
      onDelete={onDelete}
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

it('BUG-037: document pointer listeners do not fire onDelete when NoteCard unmounts during a grip drag', () => {
  const onDelete = vi.fn()
  const { unmount } = render(
    <NoteCard
      note={note}
      interactive={true}
      onDragStart={() => {}}
      onChangeText={() => {}}
      onDelete={onDelete}
    />
  )

  // Simulate grip pointerdown — this registers the three doc listeners
  const grip = screen.getByPlaceholderText('Note…').closest('.pl-note-grip')!
  fireEvent.pointerDown(grip, { clientX: 10, clientY: 10, pointerId: 1 })

  // Simulate unmount during drag (e.g. component deleted via keyboard while grip held)
  unmount()

  // A stale pointerup on document must NOT call onDelete after unmount: the
  // listeners should have been aborted/removed as part of unmount cleanup (BUG-037).
  fireEvent.pointerUp(document)
  expect(onDelete).not.toHaveBeenCalled()
})

// ── D3-A hover tint swatches ────────────────────────────────────────────────────

function renderWithTint(
  interactive: boolean,
  over: Partial<NoteElement> = {},
  onDragStart = vi.fn()
): ReturnType<typeof vi.fn> {
  const onSetTint = vi.fn()
  render(
    <NoteCard
      note={{ ...note, ...over } as NoteElement}
      interactive={interactive}
      onDragStart={onDragStart}
      onChangeText={() => {}}
      onDelete={() => {}}
      onSetTint={onSetTint}
    />
  )
  return onSetTint
}

it('renders the hover swatch pill on an interactive unlocked note; a dot click sets that tint', () => {
  const onSetTint = renderWithTint(true)
  fireEvent.click(screen.getByTestId('pl-tint-blue'))
  expect(onSetTint).toHaveBeenCalledWith('n1', 'blue')
})

it('marks only the current tint dot', () => {
  renderWithTint(true) // tint: yellow
  expect(screen.getByTestId('pl-tint-yellow').hasAttribute('data-current')).toBe(true)
  expect(screen.getByTestId('pl-tint-blue').hasAttribute('data-current')).toBe(false)
})

it('renders no swatch pill on a locked note', () => {
  renderWithTint(true, { locked: true })
  expect(screen.queryByTestId('pl-tint-blue')).toBeNull()
})

it('renders no swatch pill while a draw tool is active (non-interactive)', () => {
  renderWithTint(false)
  expect(screen.queryByTestId('pl-tint-blue')).toBeNull()
})

it('a pointerdown on a swatch dot never starts a grip drag', () => {
  const onDragStart = vi.fn()
  renderWithTint(true, {}, onDragStart)
  fireEvent.pointerDown(screen.getByTestId('pl-tint-blue'), {
    clientX: 5,
    clientY: 5,
    pointerId: 1
  })
  expect(onDragStart).not.toHaveBeenCalled()
})

// ── PLAN-05 width-resize handle ──────────────────────────────────────────────────

function renderForResize(
  over: Partial<NoteElement> = {},
  props: { selected?: boolean; interactive?: boolean } = {}
): { onResize: ReturnType<typeof vi.fn>; onEditStart: ReturnType<typeof vi.fn> } {
  const onResize = vi.fn()
  const onEditStart = vi.fn()
  render(
    <NoteCard
      note={{ ...note, w: 160, ...over } as NoteElement}
      interactive={props.interactive ?? true}
      selected={props.selected ?? true}
      onDragStart={() => {}}
      onChangeText={() => {}}
      onDelete={() => {}}
      onEditStart={onEditStart}
      onResize={onResize}
    />
  )
  return { onResize, onEditStart }
}

it('PLAN-05: shows the width handle on a selected, interactive, unlocked note', () => {
  renderForResize()
  expect(screen.getByTestId('pl-width-resize')).toBeTruthy()
})

it('PLAN-05: hides the handle when not selected / not interactive / locked', () => {
  renderForResize({}, { selected: false })
  expect(screen.queryByTestId('pl-width-resize')).toBeNull()
  cleanup()
  renderForResize({}, { interactive: false })
  expect(screen.queryByTestId('pl-width-resize')).toBeNull()
  cleanup()
  renderForResize({ locked: true })
  expect(screen.queryByTestId('pl-width-resize')).toBeNull()
})

it('PLAN-05: a past-threshold drag arms ONE checkpoint and commits the new width', () => {
  const { onResize, onEditStart } = renderForResize()
  const handle = screen.getByTestId('pl-width-resize')
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 0, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 150, clientY: 0, pointerId: 1 }) // dx 50 > 4
  fireEvent.pointerMove(handle, { clientX: 130, clientY: 0, pointerId: 1 }) // dx 30
  fireEvent.pointerUp(handle, { clientX: 130, clientY: 0, pointerId: 1 })
  expect(onEditStart).toHaveBeenCalledTimes(1) // one undo step for the whole drag
  expect(onResize).toHaveBeenLastCalledWith('n1', 190) // 160 + 30 (scale 1 in jsdom)
})

it('PLAN-05: a sub-threshold jiggle commits nothing (no phantom undo step)', () => {
  const { onResize, onEditStart } = renderForResize()
  const handle = screen.getByTestId('pl-width-resize')
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 0, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 102, clientY: 0, pointerId: 1 }) // dx 2 <= 4
  fireEvent.pointerUp(handle, { clientX: 102, clientY: 0, pointerId: 1 })
  expect(onEditStart).not.toHaveBeenCalled()
  expect(onResize).not.toHaveBeenCalled()
})

it('PLAN-05: a handle press never starts a card grip drag', () => {
  const onResize = vi.fn()
  render(
    <NoteCard
      note={{ ...note, w: 160 } as NoteElement}
      interactive
      selected
      onDragStart={vi.fn()}
      onChangeText={() => {}}
      onDelete={() => {}}
      onResize={onResize}
    />
  )
  // stopPropagation in the handle keeps the press off the card's drag/select path.
  fireEvent.pointerDown(screen.getByTestId('pl-width-resize'), {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1
  })
  expect(onResize).not.toHaveBeenCalled() // a press with no move commits nothing
})
