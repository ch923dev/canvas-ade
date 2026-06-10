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

  // BUG-045 regression: while open, a document-level pointerdown listener closes the menu.
  // The trigger must stop the REAL pointerdown (the IconBtn only stops mousedown) or the
  // ordering on a second press is: pointerdown → close → click → toggle(false→true) → the
  // menu instantly reopens and the ⋯ toggle is dead.
  it('BUG-045: clicking the open ⋯ trigger closes the menu (no close-then-reopen)', () => {
    render(<BoardMenu onDuplicate={() => {}} onDelete={() => {}} onFull={() => {}} />)
    const trigger = screen.getByTitle('More')
    // Open (real order: pointerdown then click — closed, so the document closer is inert).
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(document.querySelector('.board-menu')).toBeTruthy()
    // Second press on the now-open trigger: must CLOSE, not close-then-reopen.
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(document.querySelector('.board-menu')).toBeNull()
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

// Migrated from the e2e `board-menu` probe + the item-list / stroke-width parts of
// `menu-chrome`. The probe asserted the popover lists exactly Full view/Duplicate/Delete,
// that Duplicate/Delete fire (the store-count round-trip), and the ⋯ glyph renders with a
// visible stroke. All of that is pure component behavior → it belongs at the jsdom tier.
// What stays in `menu-chrome` (real-instance sliver): the title-bar containment (Bug13)
// and the viewport clamp (Bug14), which need real layout rects (jsdom rects are 0), plus
// the rest-colour check (a CSS-var computed style jsdom does not resolve).
describe('BoardMenu — migrated chrome/menu contracts (from e2e menu probes)', () => {
  it('lists exactly Full view / Duplicate / Delete', () => {
    render(<BoardMenu onDuplicate={() => {}} onDelete={() => {}} onFull={() => {}} />)
    fireEvent.click(screen.getByTitle('More'))
    const labels = [...document.querySelectorAll('.board-menu-item')].map((b) =>
      b.textContent?.trim()
    )
    expect(labels).toEqual(['Full view', 'Duplicate', 'Delete'])
  })

  it('fires Duplicate then Delete exactly once each (store round-trip equivalent)', () => {
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    render(<BoardMenu onDuplicate={onDuplicate} onDelete={onDelete} onFull={() => {}} />)
    fireEvent.click(screen.getByTitle('More'))
    const dup = screen.getByText('Duplicate')
    fireEvent.pointerDown(dup)
    fireEvent.click(dup)
    // The click closed the menu (setOpen(false)); re-open for Delete.
    fireEvent.click(screen.getByTitle('More'))
    const del = screen.getByText('Delete')
    fireEvent.pointerDown(del)
    fireEvent.click(del)
    expect(onDuplicate).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('renders the More (⋯) glyph with a visible stroke width (≥ 2)', () => {
    render(<BoardMenu onDuplicate={() => {}} onDelete={() => {}} onFull={() => {}} />)
    const svg = screen.getByTitle('More').querySelector('svg') as SVGElement
    expect(parseFloat(svg.getAttribute('stroke-width') ?? '0')).toBeGreaterThanOrEqual(2)
  })
})
