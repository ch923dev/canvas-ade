// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useRef, type ReactElement } from 'react'
import { Menu } from './Menu'
import { clampMenuToViewport } from './menuPlacement'

// `globals: false` in vitest.config → RTL auto-cleanup isn't registered; clean up by hand.
afterEach(cleanup)

const VP = { vw: 1000, vh: 600 }
const size = (width: number, height: number): { width: number; height: number } => ({
  width,
  height
})

describe('clampMenuToViewport — unified clamp (D1-C)', () => {
  it('point anchor: opens at the pointer when it fits', () => {
    const p = clampMenuToViewport(
      { point: { x: 100, y: 100 }, align: 'right', gap: 4 },
      size(180, 200),
      VP.vw,
      VP.vh
    )
    expect(p).toMatchObject({ top: 100, left: 100 })
  })

  it('point anchor: flips left of the pointer near the right edge', () => {
    const p = clampMenuToViewport(
      { point: { x: 950, y: 100 }, align: 'right', gap: 4 },
      size(180, 200),
      VP.vw,
      VP.vh
    )
    expect(p.left).toBe(950 - 180)
  })

  it('point anchor: flips above the pointer near the bottom edge', () => {
    const p = clampMenuToViewport(
      { point: { x: 100, y: 550 }, align: 'right', gap: 4 },
      size(180, 200),
      VP.vw,
      VP.vh
    )
    expect(p.top).toBe(550 - 200)
  })

  it('point anchor: clamps to padding when flipping would still overflow', () => {
    const p = clampMenuToViewport(
      { point: { x: 5, y: 5 }, align: 'right', gap: 4 },
      size(180, 200),
      VP.vw,
      VP.vh
    )
    expect(p.top).toBe(8)
    expect(p.left).toBe(8)
  })

  it('trigger anchor: right-aligns under the trigger', () => {
    const trigger = { top: 40, left: 700, right: 760, bottom: 64 }
    const p = clampMenuToViewport({ trigger, align: 'right', gap: 4 }, size(180, 200), VP.vw, VP.vh)
    expect(p).toMatchObject({ top: 64 + 4, left: 760 - 180 })
  })

  it('trigger anchor: left-aligns when asked', () => {
    const trigger = { top: 40, left: 20, right: 80, bottom: 64 }
    const p = clampMenuToViewport({ trigger, align: 'left', gap: 6 }, size(220, 200), VP.vw, VP.vh)
    expect(p).toMatchObject({ top: 64 + 6, left: 20 })
  })

  it('trigger anchor: flips above the trigger on bottom overflow', () => {
    const trigger = { top: 500, left: 700, right: 760, bottom: 524 }
    const p = clampMenuToViewport({ trigger, align: 'right', gap: 4 }, size(180, 200), VP.vw, VP.vh)
    expect(p.top).toBe(500 - 200 - 4)
  })

  it('trigger anchor: pins inside the viewport when neither side fits', () => {
    const trigger = { top: 90, left: 700, right: 760, bottom: 114 }
    const p = clampMenuToViewport({ trigger, align: 'right', gap: 4 }, size(180, 580), VP.vw, VP.vh)
    expect(p.top).toBe(VP.vh - 580 - 8) // pinned to the bottom-fit position, inside padding
  })

  it('caps maxHeight to the space below the final top (D0-4 scroll cap)', () => {
    const p = clampMenuToViewport(
      { point: { x: 100, y: 100 }, align: 'right', gap: 4 },
      size(180, 200),
      VP.vw,
      VP.vh
    )
    expect(p.maxHeight).toBe(VP.vh - 100 - 8)
  })
})

function Harness({
  onClose,
  withTrigger = false,
  autoFocus
}: {
  onClose: () => void
  withTrigger?: boolean
  autoFocus?: boolean
}): ReactElement {
  const triggerRef = useRef<HTMLDivElement>(null)
  return (
    <div>
      <button data-testid="outside">outside</button>
      <div ref={triggerRef}>
        <button data-testid="trigger">trigger</button>
      </div>
      <Menu
        anchor={withTrigger ? triggerRef : { x: 20, y: 20 }}
        onClose={onClose}
        label="Test menu"
        autoFocus={autoFocus}
      >
        <button role="menuitem" data-testid="i1">
          One
        </button>
        <button role="menuitem" data-testid="i2">
          Two
        </button>
        <button role="menuitem" disabled data-testid="i3">
          Disabled
        </button>
        <button role="menuitem" data-testid="i4">
          Four
        </button>
      </Menu>
    </div>
  )
}

describe('Menu shell', () => {
  it('portals a role=menu container with menuitem children to <body>', () => {
    const { container } = render(<Harness onClose={() => {}} />)
    const menu = screen.getByRole('menu')
    expect(menu.getAttribute('aria-label')).toBe('Test menu')
    expect(container.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
  })

  it('focuses the first menuitem on open (autoFocus default)', () => {
    render(<Harness onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByTestId('i1'))
  })

  it('keeps exactly one item tabbable (roving tabindex), skipping disabled items', () => {
    render(<Harness onClose={() => {}} />)
    expect(screen.getByTestId('i1').tabIndex).toBe(0)
    expect(screen.getByTestId('i2').tabIndex).toBe(-1)
    expect(screen.getByTestId('i4').tabIndex).toBe(-1)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('i2'))
    expect(screen.getByTestId('i1').tabIndex).toBe(-1)
    expect(screen.getByTestId('i2').tabIndex).toBe(0)
  })

  it('menuitemradio rows join the roving focus order (selection menus, e.g. Backdrop)', () => {
    render(
      <Menu anchor={{ x: 20, y: 20 }} onClose={() => {}} label="Radio menu">
        <button role="menuitemradio" aria-checked="true" data-testid="r1">
          A
        </button>
        <button role="menuitemradio" aria-checked="false" data-testid="r2">
          B
        </button>
      </Menu>
    )
    expect(document.activeElement).toBe(screen.getByTestId('r1'))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('r2'))
    expect(screen.getByTestId('r2').tabIndex).toBe(0)
    expect(screen.getByTestId('r1').tabIndex).toBe(-1)
  })

  it('ArrowDown/ArrowUp wrap and skip disabled items', () => {
    render(<Harness onClose={() => {}} />)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // i1 → i2
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // i2 → i4 (i3 disabled)
    expect(document.activeElement).toBe(screen.getByTestId('i4'))
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // wrap → i1
    expect(document.activeElement).toBe(screen.getByTestId('i1'))
    fireEvent.keyDown(menu, { key: 'ArrowUp' }) // wrap back → i4
    expect(document.activeElement).toBe(screen.getByTestId('i4'))
  })

  it('Home/End jump to the first/last enabled item', () => {
    render(<Harness onClose={() => {}} />)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByTestId('i4'))
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByTestId('i1'))
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Tab (ARIA menu pattern: Tab leaves the menu)', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on an outside pointerdown but NOT on an inside one', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.pointerDown(screen.getByTestId('i2'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('excludes the trigger from outside-close so its click can toggle (BUG-045 class)', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} withTrigger />)
    fireEvent.pointerDown(screen.getByTestId('trigger'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on window resize (the canvas can pan/zoom under an anchored menu)', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent(window, new Event('resize'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  // Regression (groups.e2e.ts:150): dismissal listeners must be MOUNT-STABLE. Callers
  // pass inline onClose closures, so dep-driven re-subscription would remove the window
  // keydown listener on every owner re-render — including synchronously MID-DISPATCH
  // (an earlier window listener flushes a zustand→useSyncExternalStore re-render), and a
  // listener removed mid-dispatch never fires: Escape silently stopped closing menus.
  it('does not re-subscribe its window listeners when onClose changes identity', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const { rerender } = render(<Harness onClose={vi.fn()} />)
    const keydownAdds = (): number => addSpy.mock.calls.filter((c) => c[0] === 'keydown').length
    const mounted = keydownAdds()
    rerender(<Harness onClose={vi.fn()} />) // new inline-closure identity, same menu
    expect(keydownAdds()).toBe(mounted)
    // ...and the LATEST onClose is still the one invoked.
    const onClose = vi.fn()
    rerender(<Harness onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    addSpy.mockRestore()
  })

  it('restores focus to the pre-open element when the close leaves focus dangling', async () => {
    const outside = render(
      <button data-testid="owner" autoFocus>
        owner
      </button>
    )
    const owner = screen.getByTestId('owner')
    owner.focus()
    expect(document.activeElement).toBe(owner)
    const menu = render(<Harness onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByTestId('i1'))
    menu.unmount() // focus is now dangling (menu DOM removed)
    // The restore is deferred one macrotask (focus() mid-commit can be a silent no-op
    // on transiently-unfocusable targets, e.g. xterm's helper textarea).
    await waitFor(() => expect(document.activeElement).toBe(owner))
    outside.unmount()
  })
})
