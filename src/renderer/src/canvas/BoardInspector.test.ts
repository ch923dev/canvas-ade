import { describe, expect, it } from 'vitest'
import { inspectorEligible, inspectorRevealed } from './boardInspectorReveal'

describe('inspectorEligible — the Inspector has content only for one board at a usable zoom', () => {
  it('is true for exactly one selected board at zoom ≥ 0.4', () => {
    expect(inspectorEligible(1, 1)).toBe(true)
    expect(inspectorEligible(1, 0.4)).toBe(true)
  })

  it('is false for zero or multi selection (no single retarget / no mixed-state in P0)', () => {
    expect(inspectorEligible(0, 1)).toBe(false)
    expect(inspectorEligible(2, 1)).toBe(false)
  })

  it('is false below the LOD threshold — the on-board board itself degrades there', () => {
    expect(inspectorEligible(1, 0.39)).toBe(false)
    expect(inspectorEligible(1, 0.1)).toBe(false)
  })
})

describe('inspectorRevealed — given content, reveal on proximity or focus (never selection alone in P0)', () => {
  it('stays hidden when eligible but neither in the edge zone nor focused', () => {
    expect(inspectorRevealed(true, false, false)).toBe(false)
  })

  it('reveals on right-edge proximity OR focus-within once eligible', () => {
    expect(inspectorRevealed(true, true, false)).toBe(true)
    expect(inspectorRevealed(true, false, true)).toBe(true)
  })

  it('never reveals without content, regardless of zone/focus', () => {
    expect(inspectorRevealed(false, true, true)).toBe(false)
  })
})
