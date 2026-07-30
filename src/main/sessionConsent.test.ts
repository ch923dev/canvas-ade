/**
 * sessionConsent — the base-P5 consent registry: the Q4 eligibility chain (re-derived per act),
 * grant/revoke lifecycle, launch-evidence gating, and the fail-closed defaults. `code-reviewer`
 * and `explorer` are the catalog's session-consentable packs; `builder` is the write-capable
 * control that must be refused everywhere; `planner` is read-only but declares `per-write`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeConsents,
  consentOfferFor,
  grantSessionConsent,
  isDispatchConsented,
  onConsentChange,
  registerConsentWorker,
  resetSessionConsent,
  revokeSessionConsent
} from './sessionConsent'

afterEach(() => resetSessionConsent())

const READ_LAUNCH = 'claude --model opus --permission-mode plan'

describe('eligibility (the Q4 chain, structural)', () => {
  it('a read-only session-consented pack with read-only launch evidence is offerable', () => {
    registerConsentWorker('run1', 'w1', 'code-reviewer', READ_LAUNCH)
    const offer = consentOfferFor('w1')
    expect(offer).toEqual({
      runId: 'run1',
      roleId: 'code-reviewer',
      roleName: 'Code reviewer',
      workerCount: 1
    })
  })

  it('a WRITE-capable pack is never offerable — Q4, refused structurally', () => {
    registerConsentWorker('run1', 'w1', 'builder', 'claude --dangerously-skip-permissions')
    expect(consentOfferFor('w1')).toBeNull()
    expect(isDispatchConsented('w1')).toBe(false)
  })

  it('a read-only pack whose policy is per-write (planner) is never offerable', () => {
    registerConsentWorker('run1', 'w1', 'planner', READ_LAUNCH)
    expect(consentOfferFor('w1')).toBeNull()
  })

  it('an edited launch that no longer PROVES read-only kills eligibility (PR #381 lesson)', () => {
    registerConsentWorker('run1', 'w1', 'code-reviewer', 'claude --dangerously-skip-permissions')
    expect(consentOfferFor('w1')).toBeNull()
    registerConsentWorker('run1', 'w2', 'code-reviewer', 'claude') // no read-only evidence at all
    expect(consentOfferFor('w2')).toBeNull()
  })

  it('an unknown role registers ineligible, an unregistered board answers nothing', () => {
    registerConsentWorker('run1', 'w1', 'no-such-pack', READ_LAUNCH)
    expect(consentOfferFor('w1')).toBeNull()
    expect(isDispatchConsented('w-unregistered')).toBe(false)
    expect(consentOfferFor('w-unregistered')).toBeNull()
  })

  it('workerCount counts only this run+role’s ELIGIBLE workers', () => {
    registerConsentWorker('run1', 'w1', 'code-reviewer', READ_LAUNCH)
    registerConsentWorker('run1', 'w2', 'code-reviewer', READ_LAUNCH)
    registerConsentWorker('run1', 'w3', 'code-reviewer', 'claude') // ineligible
    registerConsentWorker('run2', 'x1', 'code-reviewer', READ_LAUNCH) // another run
    registerConsentWorker('run1', 'e1', 'explorer', READ_LAUNCH) // another role
    expect(consentOfferFor('w1')?.workerCount).toBe(2)
  })
})

describe('grant → check → revoke lifecycle', () => {
  it('grant makes ONLY that run+role’s eligible workers consented; revoke ends it next act', () => {
    registerConsentWorker('run1', 'w1', 'code-reviewer', READ_LAUNCH)
    registerConsentWorker('run1', 'e1', 'explorer', READ_LAUNCH)
    const offer = consentOfferFor('w1')!
    expect(grantSessionConsent(offer, 123)).toBe(true)
    expect(isDispatchConsented('w1')).toBe(true)
    expect(isDispatchConsented('e1')).toBe(false) // different role — its own grant needed
    expect(activeConsents('run1')).toEqual([
      { runId: 'run1', roleId: 'code-reviewer', roleName: 'Code reviewer', grantedAt: 123 }
    ])
    // An active grant suppresses the offer (the gate skips, it doesn't re-offer).
    expect(consentOfferFor('w1')).toBeNull()
    expect(revokeSessionConsent('run1', 'code-reviewer')).toBe(true)
    expect(isDispatchConsented('w1')).toBe(false)
    expect(activeConsents('run1')).toEqual([])
    expect(revokeSessionConsent('run1', 'code-reviewer')).toBe(false) // idempotent
  })

  it('a forged/stale offer for a write-capable role records NOTHING', () => {
    registerConsentWorker('run1', 'w1', 'builder', READ_LAUNCH)
    expect(
      grantSessionConsent({ runId: 'run1', roleId: 'builder', roleName: 'x', workerCount: 1 })
    ).toBe(false)
    expect(isDispatchConsented('w1')).toBe(false)
  })

  it('grant/revoke notify listeners with the runId; unsubscribe stops them', () => {
    registerConsentWorker('run1', 'w1', 'code-reviewer', READ_LAUNCH)
    const seen: string[] = []
    const off = onConsentChange((runId) => seen.push(runId))
    grantSessionConsent(consentOfferFor('w1')!)
    revokeSessionConsent('run1', 'code-reviewer')
    expect(seen).toEqual(['run1', 'run1'])
    off()
    registerConsentWorker('run1', 'w1', 'code-reviewer', READ_LAUNCH)
    grantSessionConsent(consentOfferFor('w1')!)
    expect(seen).toEqual(['run1', 'run1'])
  })

  it('reset clears everything (the app-restart / test seam — consents never survive)', () => {
    registerConsentWorker('run1', 'w1', 'code-reviewer', READ_LAUNCH)
    grantSessionConsent(consentOfferFor('w1')!)
    resetSessionConsent()
    expect(isDispatchConsented('w1')).toBe(false)
    expect(activeConsents('run1')).toEqual([])
  })
})
