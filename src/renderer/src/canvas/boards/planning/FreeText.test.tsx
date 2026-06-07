import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FreeText } from './FreeText'
import type { TextElement } from '../../../lib/boardSchema'

const noop = (): void => {}
const base = (over: Partial<TextElement> = {}): TextElement => ({
  id: 't1',
  kind: 'text',
  x: 0,
  y: 0,
  text: 'hi',
  ...over
})

const renderFreeText = (el: TextElement): HTMLTextAreaElement => {
  const { container } = render(
    <FreeText element={el} interactive onDragStart={noop} onChangeText={noop} onDelete={noop} />
  )
  return container.querySelector('textarea') as HTMLTextAreaElement
}

describe('FreeText typography', () => {
  it('renders pre-v6 defaults when the element carries no tokens', () => {
    const ta = renderFreeText(base())
    expect(ta.style.fontSize).toBe('13px')
    expect(ta.style.fontFamily).toBe('var(--ui)')
    expect(ta.style.lineHeight).toBe('18px')
    expect(ta.style.color).toBe('var(--text)')
    expect(ta.style.textAlign).toBe('left')
  })

  it('applies every token', () => {
    const ta = renderFreeText(
      base({ fontFamily: 'mono', fontSize: 'XL', align: 'center', color: 'accent', bold: true })
    )
    expect(ta.style.fontSize).toBe('26px')
    expect(ta.style.lineHeight).toBe('36px')
    expect(ta.style.fontFamily).toBe('var(--term-mono)')
    expect(ta.style.textAlign).toBe('center')
    expect(ta.style.color).toBe('var(--accent)')
    expect(ta.style.fontWeight).toBe('700')
  })
})
