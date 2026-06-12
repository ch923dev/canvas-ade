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

  it('every listed scene round-trips through getScene (the picker/drift-guard seam)', () => {
    const all = listScenes()
    expect(all.length).toBeGreaterThanOrEqual(1)
    for (const s of all) expect(getScene(s.id)).toBe(s)
  })

  it('unknown ids resolve to undefined (render-time degrade, never a parse rejection)', () => {
    expect(getScene('not-shipped-yet')).toBeUndefined()
  })
})
