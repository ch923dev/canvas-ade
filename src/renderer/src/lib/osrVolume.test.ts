import { describe, it, expect } from 'vitest'
import { volumeIcon } from './osrVolume'

describe('volumeIcon', () => {
  it('shows volume-x when muted (regardless of level)', () => {
    expect(volumeIcon({ muted: true, volume: 1 })).toBe('volume-x')
    expect(volumeIcon({ muted: true, volume: 0.7 })).toBe('volume-x')
  })
  it('shows volume-x at zero level', () => {
    expect(volumeIcon({ muted: false, volume: 0 })).toBe('volume-x')
  })
  it('shows volume-low below half', () => {
    expect(volumeIcon({ muted: false, volume: 0.1 })).toBe('volume-low')
    expect(volumeIcon({ muted: false, volume: 0.49 })).toBe('volume-low')
  })
  it('shows full volume at half and above', () => {
    expect(volumeIcon({ muted: false, volume: 0.5 })).toBe('volume')
    expect(volumeIcon({ muted: false, volume: 1 })).toBe('volume')
  })
})
