// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  SPEC_STATUS_GLYPHS,
  SPEC_KIND_PATHS,
  specStatusStyle,
  specKindSilhouette,
  specEdgeStyle
} from './specTheme'
import { SPEC_STATUSES, SPEC_NODE_KINDS } from '../../../lib/diagramSpec'

// jsdom has no tokens on :root, so every token() read resolves to its fallback — the same values
// tokens.css pins (the diagramTheme.test.ts convention).
const ACCENT = '#4f8cff'

describe('specStatusStyle — single-accent, glyph-paired contract', () => {
  it('reserves the accent for active ONLY (border + glyph ink)', () => {
    const active = specStatusStyle('active')
    expect(active.border).toBe(ACCENT)
    expect(active.glyphColor).toBe(ACCENT)
    for (const s of SPEC_STATUSES) {
      if (s === 'active') continue
      const st = specStatusStyle(s)
      expect(st.border).not.toBe(ACCENT)
      expect(st.fill).not.toBe(ACCENT)
    }
  })

  it('pairs every coloured status with a glyph (B1: never colour alone)', () => {
    for (const s of SPEC_STATUSES) {
      const st = specStatusStyle(s)
      if (s === 'neutral') {
        expect(st.glyph).toBe('') // no colour claim ⇒ nothing to disambiguate
      } else {
        expect(st.glyph).toBe(SPEC_STATUS_GLYPHS[s])
        expect(st.glyph.length).toBeGreaterThan(0)
      }
    }
  })

  it('mirrors the Phase-0 Mermaid wash + half-strength-border recipe (one palette, two engines)', () => {
    expect(specStatusStyle('done')).toMatchObject({
      fill: 'rgba(62, 207, 142, 0.14)',
      border: 'rgba(62, 207, 142, 0.5)'
    })
    expect(specStatusStyle('warn')).toMatchObject({
      fill: 'rgba(232, 179, 57, 0.12)',
      border: 'rgba(232, 179, 57, 0.5)'
    })
    expect(specStatusStyle('error')).toMatchObject({
      fill: 'rgba(242, 84, 91, 0.14)',
      border: 'rgba(242, 84, 91, 0.55)'
    })
  })

  it('renders muted as the neutral card at 0.55 opacity; everything else fully opaque', () => {
    const muted = specStatusStyle('muted')
    expect(muted.opacity).toBe(0.55)
    expect(muted.fill).toBe('#1a1a1d')
    for (const s of SPEC_STATUSES) {
      if (s !== 'muted') expect(specStatusStyle(s).opacity).toBe(1)
    }
  })

  it('defaults an absent status to neutral (raised surface, plain border, no glyph)', () => {
    expect(specStatusStyle(undefined)).toEqual(specStatusStyle('neutral'))
    expect(specStatusStyle('neutral').fill).toBe('#1a1a1d')
  })
})

describe('specKindSilhouette + SPEC_KIND_PATHS', () => {
  it('gives decision/actor/note their quiet silhouettes; every other kind stays the base rect', () => {
    expect(specKindSilhouette('decision')).toBe('decision')
    expect(specKindSilhouette('actor')).toBe('actor')
    expect(specKindSilhouette('note')).toBe('note')
    for (const k of ['step', 'data', 'service', 'artifact'] as const) {
      expect(specKindSilhouette(k)).toBe('rect')
    }
    expect(specKindSilhouette(undefined)).toBe('rect')
  })

  it('has a mark for every kind except note (its dashed silhouette IS the mark)', () => {
    for (const k of SPEC_NODE_KINDS) {
      expect(Array.isArray(SPEC_KIND_PATHS[k])).toBe(true)
      if (k === 'note') expect(SPEC_KIND_PATHS[k]).toHaveLength(0)
      else expect(SPEC_KIND_PATHS[k].length).toBeGreaterThan(0)
    }
  })
})

describe('specEdgeStyle', () => {
  it('maps edge kinds to line styles (flow solid · dependency dashed · data dotted)', () => {
    expect(specEdgeStyle({})).toMatchObject({ dasharray: '', animated: false })
    expect(specEdgeStyle({ kind: 'flow' }).dasharray).toBe('')
    expect(specEdgeStyle({ kind: 'dependency' }).dasharray).toBe('3 4')
    expect(specEdgeStyle({ kind: 'data' }).dasharray).toBe('1.5 3.5')
  })

  it('animated wins: accent stroke + the Phase-0 6/5 dash, regardless of kind/status', () => {
    const st = specEdgeStyle({ kind: 'dependency', status: 'done', animated: true })
    expect(st).toEqual({ stroke: ACCENT, dasharray: '6 5', animated: true })
  })

  it('tints a status edge at half strength; neutral/muted stay on border-strong ink', () => {
    expect(specEdgeStyle({ status: 'done' }).stroke).toBe('rgba(62, 207, 142, 0.5)')
    expect(specEdgeStyle({ status: 'error' }).stroke).toBe('rgba(242, 84, 91, 0.5)')
    const neutralInk = 'rgba(255,255,255,0.16)'
    expect(specEdgeStyle({}).stroke).toBe(neutralInk)
    expect(specEdgeStyle({ status: 'neutral' }).stroke).toBe(neutralInk)
    expect(specEdgeStyle({ status: 'muted' }).stroke).toBe(neutralInk)
  })
})
