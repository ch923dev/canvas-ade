import { describe, it, expect } from 'vitest'
import { planAutoConnect, backoffTicks } from './autoConnect'

describe('planAutoConnect', () => {
  it('idles when already connected (never clobbers a working preview)', () => {
    expect(planAutoConnect({ status: 'connected', hasUrl: true, hasSource: true })).toEqual({
      kind: 'idle'
    })
  })

  it('reloads a load-failed board that has a url', () => {
    expect(planAutoConnect({ status: 'load-failed', hasUrl: true, hasSource: false })).toEqual({
      kind: 'reload'
    })
  })

  it('detects when a linked board has no usable url yet', () => {
    expect(planAutoConnect({ status: 'idle', hasUrl: false, hasSource: true })).toEqual({
      kind: 'detect'
    })
    // load-failed + no url + linked → still discover the url
    expect(planAutoConnect({ status: 'load-failed', hasUrl: false, hasSource: true })).toEqual({
      kind: 'detect'
    })
  })

  it('idles a fresh/connecting board so a legitimate in-flight load is not interrupted', () => {
    expect(planAutoConnect({ status: 'idle', hasUrl: true, hasSource: false })).toEqual({
      kind: 'idle'
    })
    expect(planAutoConnect({ status: 'connecting', hasUrl: true, hasSource: true })).toEqual({
      kind: 'idle'
    })
  })

  it('idles when nothing can be done (no url, no source)', () => {
    expect(planAutoConnect({ status: 'load-failed', hasUrl: false, hasSource: false })).toEqual({
      kind: 'idle'
    })
  })

  it('idles a crashed board — recovery is the explicit Reload CTA, never an auto-loop (D2-C)', () => {
    // A page that crashes its renderer deterministically (OOM, GPU bug) would
    // otherwise relaunch-crash forever on the backoff ramp.
    expect(planAutoConnect({ status: 'crashed', hasUrl: true, hasSource: true })).toEqual({
      kind: 'idle'
    })
    expect(planAutoConnect({ status: 'crashed', hasUrl: false, hasSource: true })).toEqual({
      kind: 'idle'
    })
  })
})

describe('backoffTicks', () => {
  it('ramps 1 → 2 → 4 and caps at 4 (base tick = 1s)', () => {
    expect(backoffTicks(1)).toBe(1)
    expect(backoffTicks(2)).toBe(2)
    expect(backoffTicks(3)).toBe(4)
    expect(backoffTicks(4)).toBe(4)
    expect(backoffTicks(10)).toBe(4)
  })
})
