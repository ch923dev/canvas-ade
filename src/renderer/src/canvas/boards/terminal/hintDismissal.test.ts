// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TERMINAL_HINT_KEY,
  dismissHint,
  isHintDismissed,
  resetHintSessionFallbackForTest,
  subscribeHint
} from './hintDismissal'

beforeEach(() => {
  window.localStorage.removeItem(TERMINAL_HINT_KEY)
  resetHintSessionFallbackForTest() // the quota test below sets the in-memory fallback
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('terminalHint sticky dismissal (D2-B, app-wide forever)', () => {
  it('starts not-dismissed; dismiss flips it and persists the sticky key', () => {
    expect(isHintDismissed()).toBe(false)
    dismissHint()
    expect(isHintDismissed()).toBe(true)
    expect(window.localStorage.getItem(TERMINAL_HINT_KEY)).toBe('1')
  })

  it('reads localStorage lazily — clearing the key un-dismisses without a reload', () => {
    dismissHint()
    window.localStorage.removeItem(TERMINAL_HINT_KEY) // the e2e-harness reset path
    expect(isHintDismissed()).toBe(false)
  })

  it('still hides for the session when the sticky write fails (quota path)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    dismissHint()
    expect(isHintDismissed()).toBe(true) // in-memory fallback — × must not be a no-op
    expect(window.localStorage.getItem(TERMINAL_HINT_KEY)).toBeNull() // nothing persisted
  })

  it('notifies subscribers on dismiss; unsubscribe stops notifications', () => {
    const fn = vi.fn()
    const off = subscribeHint(fn)
    dismissHint()
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    dismissHint()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
