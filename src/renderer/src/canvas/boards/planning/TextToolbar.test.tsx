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
    const { getByLabelText } = render(<TextToolbar element={el()} onPatch={() => {}} />)
    for (const f of ['sans', 'mono', 'serif']) expect(getByLabelText(`font ${f}`)).toBeTruthy()
    for (const s of ['S', 'M', 'L', 'XL']) expect(getByLabelText(`size ${s}`)).toBeTruthy()
    for (const a of ['left', 'center', 'right']) expect(getByLabelText(`align ${a}`)).toBeTruthy()
    expect(getByLabelText('bold')).toBeTruthy()
    for (const c of ['default', 'muted', 'faint', 'accent'])
      expect(getByLabelText(`color ${c}`)).toBeTruthy()
  })

  it('reflects the active token via aria-pressed (defaults applied)', () => {
    const { getByLabelText } = render(
      <TextToolbar element={el({ fontSize: 'L' })} onPatch={() => {}} />
    )
    expect(getByLabelText('size L').getAttribute('aria-pressed')).toBe('true')
    expect(getByLabelText('size M').getAttribute('aria-pressed')).toBe('false')
    expect(getByLabelText('font sans').getAttribute('aria-pressed')).toBe('true')
  })

  it('emits a patch when a different token is clicked', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ fontSize: 'M' })} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('size L'))
    expect(onPatch).toHaveBeenCalledWith({ fontSize: 'L' })
  })

  it('does NOT emit when the already-active token is clicked (no phantom undo step)', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ fontSize: 'M' })} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('size M'))
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('bold toggles on from its current value', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ bold: false })} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('bold'))
    expect(onPatch).toHaveBeenCalledWith({ bold: true })
  })

  it('bold toggles off when already bold', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(
      <TextToolbar element={el({ bold: true })} onPatch={onPatch} />
    )
    fireEvent.click(getByLabelText('bold'))
    expect(onPatch).toHaveBeenCalledWith({ bold: false })
  })

  it('bold defaults to not-pressed when the element has no bold field', () => {
    const { getByLabelText } = render(<TextToolbar element={el()} onPatch={() => {}} />)
    expect(getByLabelText('bold').getAttribute('aria-pressed')).toBe('false')
  })

  it('sits above the element, flipping below when within 40px of the top edge', () => {
    const above = render(<TextToolbar element={el({ y: 200 })} onPatch={() => {}} />)
    expect((above.container.querySelector('.pl-text-toolbar') as HTMLElement).style.top).toBe(
      '160px'
    )
    above.unmount()
    const below = render(<TextToolbar element={el({ y: 10 })} onPatch={() => {}} />)
    expect((below.container.querySelector('.pl-text-toolbar') as HTMLElement).style.top).toBe(
      '38px'
    )
  })
})
