import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BoardMenu } from './BoardFrame'

describe('BoardMenu', () => {
  it('fires Duplicate even though the outside-close listens on pointerdown', () => {
    const onDuplicate = vi.fn()
    render(<BoardMenu onDuplicate={onDuplicate} onDelete={() => {}} onFull={() => {}} />)
    // Open the menu.
    fireEvent.click(screen.getByTitle('More'))
    const dup = screen.getByText('Duplicate')
    // Real interaction order: pointerdown (would close via the document listener)
    // THEN click. With the bug the menu unmounts on pointerdown and the click is lost.
    fireEvent.pointerDown(dup)
    fireEvent.click(dup)
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })
})
