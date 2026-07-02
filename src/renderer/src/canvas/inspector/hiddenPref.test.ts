// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { INSPECTOR_HIDDEN_KEY, readHiddenPref, writeHiddenPref } from './hiddenPref'

afterEach(() => window.localStorage.clear())

describe('hiddenPref (P5-8)', () => {
  it('defaults to shown when nothing is persisted', () => {
    expect(readHiddenPref()).toBe(false)
  })

  it('round-trips hide and retrieve', () => {
    writeHiddenPref(true)
    expect(readHiddenPref()).toBe(true)
    expect(window.localStorage.getItem(INSPECTOR_HIDDEN_KEY)).toBe('1')

    writeHiddenPref(false)
    expect(readHiddenPref()).toBe(false)
    // Retrieve REMOVES the key (the pristine default, not a '0') — keeps the e2e sweep and a
    // fresh install indistinguishable.
    expect(window.localStorage.getItem(INSPECTOR_HIDDEN_KEY)).toBeNull()
  })

  it('ignores junk values (treated as shown)', () => {
    window.localStorage.setItem(INSPECTOR_HIDDEN_KEY, 'yes')
    expect(readHiddenPref()).toBe(false)
  })
})
