import { describe, it, expect } from 'vitest'
import { nextViewport } from './viewportCycle'

describe('nextViewport', () => {
  it('cycles mobile → tablet → desktop → 1440p (qhd) → 4K (uhd) → mobile', () => {
    expect(nextViewport('mobile')).toBe('tablet')
    expect(nextViewport('tablet')).toBe('desktop')
    expect(nextViewport('desktop')).toBe('qhd')
    expect(nextViewport('qhd')).toBe('uhd')
    expect(nextViewport('uhd')).toBe('mobile')
  })
})
