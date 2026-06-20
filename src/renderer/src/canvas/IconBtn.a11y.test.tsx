// @vitest-environment jsdom
/**
 * PLAN-02 (a11y keystone): every icon button must expose an accessible NAME, decorative
 * glyphs must be hidden from AT, and two-state toggles must announce their PRESSED state.
 * Fixing this once on IconBtn covers the planning toolbar, snap/export, the ⋯ menu, the
 * connector handle, full-view, and every other icon button across the app.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { IconBtn } from './BoardFrame'

afterEach(cleanup)

describe('IconBtn — accessible name (PLAN-02)', () => {
  it('defaults aria-label to the title', () => {
    const { getByRole } = render(<IconBtn name="maximize" title="Full view" />)
    expect(getByRole('button', { name: 'Full view' })).toBeTruthy()
  })

  it('lets aria-label override the (terse) title for a fuller name', () => {
    const { getByRole } = render(<IconBtn name="note" title="Note" ariaLabel="Sticky note" />)
    // The fuller label wins as the accessible name; the title stays as the hover tooltip.
    const btn = getByRole('button', { name: 'Sticky note' })
    expect(btn.getAttribute('title')).toBe('Note')
  })
})

describe('IconBtn — pressed state (PLAN-02)', () => {
  it('announces aria-pressed=true for an active toggle', () => {
    const { getByRole } = render(<IconBtn name="magnet" title="Snap" toggle active />)
    expect(getByRole('button').getAttribute('aria-pressed')).toBe('true')
  })

  it('announces aria-pressed=false for an inactive toggle', () => {
    const { getByRole } = render(<IconBtn name="magnet" title="Snap" toggle active={false} />)
    expect(getByRole('button').getAttribute('aria-pressed')).toBe('false')
  })

  it('omits aria-pressed entirely for a plain action button', () => {
    // A non-toggle (Full view, Duplicate, …) must NOT read as a toggle to AT, even when
    // `active` is set for its accent styling.
    const { getByRole } = render(<IconBtn name="maximize" title="Full view" active />)
    expect(getByRole('button').hasAttribute('aria-pressed')).toBe(false)
  })
})

describe('IconBtn — decorative glyph hidden from AT (PLAN-02)', () => {
  it('marks the inner Icon svg aria-hidden and non-focusable', () => {
    const { getByRole } = render(<IconBtn name="trash" title="Delete" />)
    const svg = getByRole('button').querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('focusable')).toBe('false')
  })
})
