/**
 * notifyDedupe.ts — the delivery-level dedupe (audit P2-2). Pure, fake-clock driven. The
 * producer-shaped cases (hook-vs-idle double, commandFeed re-block, tray per-session done) live in
 * lifecycleNotifications.test.ts where they run through the real `deliver`; THIS file pins the
 * window/keying mechanics in isolation.
 */
import { describe, it, expect } from 'vitest'
import { createDeliverDedupe, dedupeKey, DELIVER_DEDUPE_MS } from './notifyDedupe'

describe('dedupeKey', () => {
  it('is the full signal identity — boardId|event|attention|detail', () => {
    expect(dedupeKey({ boardId: 'b', event: 'needs-input' })).toBe('b|needs-input||')
    expect(
      dedupeKey({ boardId: 'b', event: 'needs-input', attention: 'blocked', detail: 'silent 11m' })
    ).toBe('b|needs-input|blocked|silent 11m')
  })

  it('a new detail is a NEW key (the legitimate commandFeed re-block must fire)', () => {
    const a = dedupeKey({
      boardId: 'b',
      event: 'needs-input',
      attention: 'blocked',
      detail: 'silent 11m'
    })
    const c = dedupeKey({
      boardId: 'b',
      event: 'needs-input',
      attention: 'blocked',
      detail: 'failing check'
    })
    expect(a).not.toBe(c)
  })

  it('distinct boards never collide (tray done events key per session id)', () => {
    expect(dedupeKey({ boardId: 'a', event: 'done' })).not.toBe(
      dedupeKey({ boardId: 'b', event: 'done' })
    )
  })
})

describe('createDeliverDedupe', () => {
  it('admits the first sighting, suppresses inside the window, re-admits after it', () => {
    let t = 1000
    const d = createDeliverDedupe({ windowMs: 10_000, now: () => t })
    expect(d.admit('k')).toBe(true)
    t += 9_999
    expect(d.admit('k')).toBe(false)
    // The suppressed attempt does NOT refresh the window — it re-opens 10s after the DELIVERY.
    t += 1 // = delivery + 10_000
    expect(d.admit('k')).toBe(true)
  })

  it('distinct keys never suppress each other', () => {
    const d = createDeliverDedupe({ windowMs: 10_000, now: () => 0 })
    expect(d.admit('a')).toBe(true)
    expect(d.admit('b')).toBe(true)
  })

  it('reset() forgets everything (the e2e clean-slate seam)', () => {
    const d = createDeliverDedupe({ windowMs: 10_000, now: () => 0 })
    d.admit('k')
    d.reset()
    expect(d.admit('k')).toBe(true)
  })

  it('prunes expired entries past the size trigger without changing behavior', () => {
    let t = 0
    const d = createDeliverDedupe({ windowMs: 10_000, now: () => t })
    for (let i = 0; i < 250; i++) d.admit(`k${i}`)
    t += 20_000 // everything expired
    // The 251st admit prunes; live-window behavior is unchanged afterwards.
    expect(d.admit('fresh')).toBe(true)
    expect(d.admit('fresh')).toBe(false)
    expect(d.admit('k0')).toBe(true) // expired → re-admitted
  })

  it('default window is DELIVER_DEDUPE_MS (spans the idle monitor dwell)', () => {
    expect(DELIVER_DEDUPE_MS).toBe(10_000)
  })
})
