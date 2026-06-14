import { describe, it, expect } from 'vitest'
import { listScenes, getScene } from './sceneRegistry'

describe('sceneRegistry', () => {
  it('registers blossom-river (PR 2) with a stable id, scenic tier, and a gallery thumb', () => {
    const def = getScene('blossom-river')
    expect(def).toBeDefined()
    expect(def!.label).toBe('Blossom River')
    expect(def!.tier).toBe('scenic')
    expect(def!.thumb.startsWith('data:image/svg+xml,')).toBe(true)
  })

  it('registers the PR 3a ambient pair (drift, current) in the ambient tier', () => {
    for (const id of ['drift', 'current']) {
      const def = getScene(id)
      expect(def, id).toBeDefined()
      expect(def!.tier, id).toBe('ambient')
    }
  })

  it('registers the full PR 3b scenic roster (addendum §3) in the scenic tier', () => {
    for (const id of [
      'aurora-night',
      'starfield-nebula',
      'sunset-ocean',
      'snowfall-ridge',
      'rainy-window',
      'city-lights',
      'misty-pines'
    ]) {
      const def = getScene(id)
      expect(def, id).toBeDefined()
      expect(def!.tier, id).toBe('scenic')
      expect(def!.label.length, id).toBeGreaterThan(0)
    }
  })

  it('every listed scene round-trips through getScene (the picker/drift-guard seam)', () => {
    const all = listScenes()
    expect(all.length).toBeGreaterThanOrEqual(1)
    for (const s of all) expect(getScene(s.id)).toBe(s)
  })

  // S11 drift guard: a new scene that violates the picker/persistence contract fails a
  // unit test instead of shipping a broken row. Every preset must have a stable kebab id,
  // a unique id, a non-empty label, a known tier, a renderable thumb, and a create() fn.
  it('every scene satisfies the registry contract (unique kebab id · label · tier · thumb)', () => {
    const all = listScenes()
    const ids = new Set<string>()
    for (const s of all) {
      expect(s.id, 'kebab id').toMatch(/^[a-z][a-z0-9-]*$/)
      expect(ids.has(s.id), `duplicate id ${s.id}`).toBe(false)
      ids.add(s.id)
      expect(s.label.length, `${s.id} label`).toBeGreaterThan(0)
      expect(['ambient', 'scenic'], `${s.id} tier`).toContain(s.tier)
      expect(s.thumb.startsWith('data:image/svg+xml,'), `${s.id} thumb`).toBe(true)
      expect(typeof s.create, `${s.id} create`).toBe('function')
    }
  })

  it('unknown ids resolve to undefined (render-time degrade, never a parse rejection)', () => {
    expect(getScene('not-shipped-yet')).toBeUndefined()
  })
})
