import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BoardMenu } from './BoardFrame'

// `globals: false` in vitest.config means RTL's auto-cleanup hook isn't registered,
// so each render would leak its DOM (and portaled body content) into the next test.
afterEach(cleanup)

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

  it('renders the open menu outside the BoardFrame overflow:hidden frame (portaled to body)', () => {
    const { container } = render(
      <div className="bb-frame" style={{ overflow: 'hidden', position: 'absolute', inset: 0 }}>
        <BoardMenu onDuplicate={() => {}} onDelete={() => {}} onFull={() => {}} />
      </div>
    )
    fireEvent.click(screen.getByTitle('More'))
    const menu = document.querySelector('.board-menu') as HTMLElement
    expect(menu).toBeTruthy()
    // The popover must NOT be a descendant of the clipping frame.
    expect(container.querySelector('.board-menu')).toBeNull()
    expect(document.body.contains(menu)).toBe(true)
  })
})
