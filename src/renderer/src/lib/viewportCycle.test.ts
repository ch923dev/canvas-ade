import { describe, it, expect } from 'vitest'
import { nextViewport } from './viewportCycle'

describe('nextViewport', () => {
  it('cycles mobile → tablet → desktop → mobile', () => {
    expect(nextViewport('mobile')).toBe('tablet')
    expect(nextViewport('tablet')).toBe('desktop')
    expect(nextViewport('desktop')).toBe('mobile')
  })
})
