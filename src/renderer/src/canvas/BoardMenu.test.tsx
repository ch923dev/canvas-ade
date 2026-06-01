import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BoardFrame, BoardMenu } from './BoardFrame'
import { BoardFullViewContext } from './fullViewContext'

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

describe('BoardFrame full-chrome title bar', () => {
  it('renders the §6 uppercase type tag (e.g. TERMINAL) in the title bar', () => {
    render(<BoardFrame type="terminal" title="agent" />)
    expect(screen.getByText('TERMINAL')).toBeTruthy()
  })

  it('labels the maximize control "Full view" when not in full view', () => {
    render(<BoardFrame type="terminal" title="agent" onFull={() => {}} />)
    expect(screen.getByTitle('Full view')).toBeTruthy()
  })

  it('turns the maximize control into "Exit full view (Esc)" when fullView is true', () => {
    render(<BoardFrame type="terminal" title="agent" fullView onFull={() => {}} />)
    expect(screen.getByTitle('Exit full view (Esc)')).toBeTruthy()
  })

  // Runtime wiring: BoardNode wraps every board's subtree in this provider so the
  // per-type boards (which never forward a fullView prop to their own BoardFrame) still
  // get the exit affordance lit when their board is the one shown in the modal. The
  // explicit prop stays the override; context is the ambient source from BoardNode.
  it('lights the exit affordance from BoardFullViewContext (no fullView prop)', () => {
    render(
      <BoardFullViewContext.Provider value={true}>
        <BoardFrame type="browser" title="preview" onFull={() => {}} />
      </BoardFullViewContext.Provider>
    )
    expect(screen.getByTitle('Exit full view (Esc)')).toBeTruthy()
  })

  it('keeps "Full view" when the context is false (board not in the modal)', () => {
    render(
      <BoardFullViewContext.Provider value={false}>
        <BoardFrame type="browser" title="preview" onFull={() => {}} />
      </BoardFullViewContext.Provider>
    )
    expect(screen.getByTitle('Full view')).toBeTruthy()
  })
})
