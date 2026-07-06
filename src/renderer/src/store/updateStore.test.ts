import { describe, it, expect } from 'vitest'
import { selectUpdateBadge, type UpdateStatus } from './updateStore'

const badge = (status: UpdateStatus | null): ReturnType<typeof selectUpdateBadge> =>
  selectUpdateBadge({ status, setStatus: () => {} })

describe('selectUpdateBadge', () => {
  it('is accent for a pending or downloading update (either non-forced tier)', () => {
    expect(badge({ state: 'available', version: '1', tier: 'optional' })).toBe('accent')
    expect(badge({ state: 'available', version: '1', tier: 'recommended' })).toBe('accent')
    expect(badge({ state: 'downloading', percent: 10 })).toBe('accent')
  })

  it('is warn for a mandatory update and ok once downloaded', () => {
    expect(badge({ state: 'mandatory', version: '1' })).toBe('warn')
    expect(badge({ state: 'ready', version: '1' })).toBe('ok')
  })

  it('is null for idle / transient states (nothing to act on)', () => {
    expect(badge(null)).toBeNull()
    expect(badge({ state: 'checking' })).toBeNull()
    expect(badge({ state: 'none' })).toBeNull()
    expect(badge({ state: 'error', message: 'x' })).toBeNull()
  })
})
