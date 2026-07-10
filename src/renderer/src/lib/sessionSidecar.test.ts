import { describe, it, expect } from 'vitest'
import { reconcileSession } from './sessionSidecar'

// M1: the sidecar validator. Pins the reviewer-caught contract — a parseable-but-invalid sidecar
// must NEVER override the doc's inline value with junk; each field is validated independently and a
// failing field is dropped (→ the load falls back to the inline canvas.json value).
describe('reconcileSession (M1 sidecar validation)', () => {
  it('passes a valid viewport + background through', () => {
    const s = reconcileSession({
      viewport: { x: 10, y: -20, zoom: 1.5 },
      background: { kind: 'scene', scene: 'blossom-river', dim: 0.3, saturation: 1 }
    })
    expect(s.viewport).toEqual({ x: 10, y: -20, zoom: 1.5 })
    expect(s.background?.kind).toBe('scene')
    expect((s.background as { scene?: string }).scene).toBe('blossom-river')
  })

  it('DROPS an invalid viewport (zoom<=0 / non-finite / non-object)', () => {
    expect(reconcileSession({ viewport: { x: 0, y: 0, zoom: 0 } }).viewport).toBeUndefined()
    expect(reconcileSession({ viewport: { x: NaN, y: 0, zoom: 1 } }).viewport).toBeUndefined()
    expect(reconcileSession({ viewport: 'nope' }).viewport).toBeUndefined()
  })

  it('DEGRADES an invalid background (file without assetId → none), never emits a broken ref', () => {
    expect(reconcileSession({ background: { kind: 'file' } }).background?.kind).toBe('none')
  })

  it('a non-object / empty sidecar yields {} (→ full inline fallback)', () => {
    expect(reconcileSession(null)).toEqual({})
    expect(reconcileSession('x')).toEqual({})
    expect(reconcileSession(42)).toEqual({})
    expect(reconcileSession({})).toEqual({})
  })

  it('validates each field independently — a bad viewport does not sink a good background', () => {
    const s = reconcileSession({
      viewport: { x: 0, y: 0, zoom: -1 }, // invalid → dropped
      background: { kind: 'scene', scene: 'aurora' } // valid → kept
    })
    expect(s.viewport).toBeUndefined()
    expect(s.background?.kind).toBe('scene')
  })
})
