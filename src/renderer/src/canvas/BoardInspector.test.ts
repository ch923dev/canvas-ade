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

describe('inspectorRevealed — v2 reveal-on-select: shown whenever a single board is eligible', () => {
  it('reveals as soon as content is eligible (selecting a board IS the trigger)', () => {
    expect(inspectorRevealed(true)).toBe(true)
  })

  it('stays hidden when there is no eligible single selection', () => {
    expect(inspectorRevealed(false)).toBe(false)
  })
})
