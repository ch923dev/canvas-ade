import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { TextToolbar } from './TextToolbar'
import type { TextElement } from '../../../lib/boardSchema'

const el = (o: Partial<TextElement> = {}): TextElement => ({
  id: 't',
  kind: 'text',
  x: 0,
  y: 0,
  text: 'x',
  ...o
})

afterEach(() => cleanup())

describe('TextToolbar', () => {
  it('renders a button per token (3 family · 4 size · 3 align · bold · 4 color)', () => {
    const { getByLabelText } = render(
      <TextToolbar element={el()} boardW={9999} onPatch={() => {}} />
    )
    for (const f of ['sans', 'mono', 'serif']) expect(getByLabelText(`font ${f}`)).toBeTruthy()
    for (const s of ['S', 'M', 'L', 'XL']) expect(getByLabelText(`size ${s}`)).toBeTruthy()
    for (const a of ['left', 'center', 'right']) expect(getByLabelText(`align ${a}`)).toBeTruthy()
    expect(getByLabelText('bold')).toBeTruthy()
    for (const c of ['default', 'muted', 'faint', 'accent'])
      expect(getByLabelText(`color ${c}`)).toBeTruthy()
  })

  it('reflects the active token via aria-pressed (defaults applied)', () => {
    const { getByLabelText } = render(
      <TextToolbar element={el({ fontSize: 'L' })} boardW={9999} onPatch={() => {}} />
    )
    expect(getByLabelText('size L').getAttribute('aria-pressed')).toBe('true')
    expect(getByLabelText('size M').getAttribute('aria-pressed')).toBe('false')
    expect(getByLabelText('font sans').getAttribute('aria-pressed')).toBe('true')
  })

  it('emits a patch when a different token is clicked', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ fontSize: 'M' })} boardW={9999} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('size L'))
    expect(onPatch).toHaveBeenCalledWith({ fontSize: 'L' })
  })

  it('does NOT emit when the already-active token is clicked (no phantom undo step)', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ fontSize: 'M' })} boardW={9999} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('size M'))
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('bold toggles on from its current value', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ bold: false })} boardW={9999} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('bold'))
    expect(onPatch).toHaveBeenCalledWith({ bold: true })
  })

  it('bold toggles off when already bold', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ bold: true })} boardW={9999} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('bold'))
    expect(onPatch).toHaveBeenCalledWith({ bold: false })
  })

  it('bold defaults to not-pressed when the element has no bold field', () => {
    const { getByLabelText } = render(
      <TextToolbar element={el()} boardW={9999} onPatch={() => {}} />
    )
    expect(getByLabelText('bold').getAttribute('aria-pressed')).toBe('false')
  })

  it('sits above the element, flipping below when within 40px of the top edge', () => {
    const above = render(<TextToolbar element={el({ y: 200 })} boardW={9999} onPatch={() => {}} />)
    expect((above.container.querySelector('.pl-text-toolbar') as HTMLElement).style.top).toBe(
      '160px'
    )
    above.unmount()
    const below = render(<TextToolbar element={el({ y: 10 })} boardW={9999} onPatch={() => {}} />)
    expect((below.container.querySelector('.pl-text-toolbar') as HTMLElement).style.top).toBe(
      '38px'
    )
  })

  const left = (r: ReturnType<typeof render>): string =>
    (r.container.querySelector('.pl-text-toolbar') as HTMLElement).style.left

  it('clamps left so the toolbar stays within the board width (no right-edge clip)', () => {
    // Element near the right edge would push the ~380px bar past the well → pull it left.
    expect(
      left(render(<TextToolbar element={el({ x: 480 })} boardW={516} onPatch={() => {}} />))
    ).toBe(`${516 - 380}px`)
  })

  it('does not shift the toolbar when the element leaves room', () => {
    expect(
      left(render(<TextToolbar element={el({ x: 20 })} boardW={516} onPatch={() => {}} />))
    ).toBe('20px')
  })

  it('never positions the toolbar off the left edge when the board is narrower than the bar', () => {
    expect(
      left(render(<TextToolbar element={el({ x: 300 })} boardW={200} onPatch={() => {}} />))
    ).toBe('0px')
  })

  it('a pointer-down on the toolbar is prevented so the textarea keeps focus (no empty-prune)', () => {
    const r = render(<TextToolbar element={el({})} boardW={9999} onPatch={() => {}} />)
    const bar = r.container.querySelector('.pl-text-toolbar') as HTMLElement
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    bar.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})
