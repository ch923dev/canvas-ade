import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readEntitlement,
  writeEntitlement,
  clearEntitlement,
  freeEntitlement,
  isFresh,
  type Entitlement
} from './entitlementCache'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'entitlement-test-'))
})

describe('entitlementCache', () => {
  it('returns the free default when no cache exists', () => {
    expect(readEntitlement(dir)).toEqual(freeEntitlement())
  })

  it('write → read round-trips a pro/active entitlement', () => {
    const ent: Entitlement = { plan: 'pro', status: 'active', currentPeriodEnd: 123, checkedAt: 50 }
    writeEntitlement(dir, ent)
    expect(readEntitlement(dir)).toEqual(ent)
  })

  it('repairs unknown plan/status and invalid numbers to safe defaults', () => {
    writeFileSync(
      join(dir, 'entitlement.json'),
      JSON.stringify({ plan: 'enterprise', status: 'weird', currentPeriodEnd: 'x', checkedAt: -1 }),
      'utf8'
    )
    expect(readEntitlement(dir)).toEqual(freeEntitlement())
  })

  it('returns the free default for a corrupt file rather than throwing', () => {
    writeFileSync(join(dir, 'entitlement.json'), '{ not json', 'utf8')
    expect(readEntitlement(dir)).toEqual(freeEntitlement())
  })

  it('clearEntitlement resets the cache to the free default', () => {
    writeEntitlement(dir, { plan: 'pro', status: 'active', currentPeriodEnd: 1, checkedAt: 1 })
    clearEntitlement(dir)
    expect(readEntitlement(dir)).toEqual(freeEntitlement())
  })

  describe('isFresh', () => {
    const ent: Entitlement = {
      plan: 'pro',
      status: 'active',
      currentPeriodEnd: null,
      checkedAt: 1000
    }
    it('is false for a never-checked cache (checkedAt 0)', () => {
      expect(isFresh(freeEntitlement(), 10_000, 5000)).toBe(false)
    })
    it('is true within the TTL', () => {
      expect(isFresh(ent, 10_000, 5000)).toBe(true) // 5000 - 1000 = 4000 < 10000
    })
    it('is false past the TTL', () => {
      expect(isFresh(ent, 1_000, 5000)).toBe(false) // 4000 >= 1000
    })
  })
})
