// @vitest-environment jsdom
/**
 * Inspector primitives — the P5 a11y contracts: radiogroup roving tabindex + arrow-key
 * selection (InspectorSegmented / InspectorSwatches share inspectorRadioGroupKeyDown),
 * the slider's visible value readout, and progressbar semantics.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  InspectorProgress,
  InspectorSegmented,
  InspectorSlider,
  InspectorSwatches
} from './primitives'

afterEach(cleanup)

const OPTS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' }
] as const

describe('InspectorSegmented (radio pattern)', () => {
  it('the checked radio is the single tab stop', () => {
    render(<InspectorSegmented value="b" options={OPTS} onChange={() => {}} ariaLabel="Pick" />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1])
  })

  it('ArrowRight selects and focuses the next radio; wraps at the end', () => {
    const onChange = vi.fn()
    render(<InspectorSegmented value="c" options={OPTS} onChange={onChange} ariaLabel="Pick" />)
    const radios = screen.getAllByRole('radio')
    radios[2].focus()
    fireEvent.keyDown(radios[2], { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('a')
    expect(document.activeElement).toBe(radios[0])
  })

  it('ArrowLeft moves backwards', () => {
    const onChange = vi.fn()
    render(<InspectorSegmented value="b" options={OPTS} onChange={onChange} ariaLabel="Pick" />)
    const radios = screen.getAllByRole('radio')
    radios[1].focus()
    fireEvent.keyDown(radios[1], { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('a mixed selection (value not among options) keeps the first radio tabbable', () => {
    render(
      <InspectorSegmented
        value={'nope' as 'a'}
        options={OPTS}
        onChange={() => {}}
        ariaLabel="Pick"
      />
    )
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1])
  })
})

describe('InspectorSwatches (radio pattern)', () => {
  const SWATCHES = [
    { id: 'x', fill: 'var(--surface)', title: 'X', current: false },
    { id: 'y', fill: 'var(--surface)', title: 'Y', current: true }
  ]
  it('arrow keys pick the neighbouring swatch', () => {
    const onPick = vi.fn()
    render(<InspectorSwatches swatches={SWATCHES} onPick={onPick} ariaLabel="Tint" />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0])
    radios[1].focus()
    fireEvent.keyDown(radios[1], { key: 'ArrowRight' })
    expect(onPick).toHaveBeenCalledWith('x')
  })
})

describe('InspectorSlider readout / InspectorProgress semantics', () => {
  it('valueLabel renders the visible aria-hidden readout', () => {
    const { container } = render(
      <InspectorSlider value={0.6} onChange={() => {}} ariaLabel="Volume" valueLabel="60%" />
    )
    const val = container.querySelector('.ca-inspector-slider-val')
    expect(val?.textContent).toBe('60%')
    expect(val?.getAttribute('aria-hidden')).toBe('true')
  })

  it('progress exposes progressbar role + valuenow', () => {
    render(<InspectorProgress value={0.42} ariaLabel="Batch progress" />)
    const bar = screen.getByRole('progressbar', { name: 'Batch progress' })
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
  })
})
