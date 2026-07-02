// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { COLLAPSE_KEY_PREFIX, readCollapsePref, writeCollapsePref } from './collapsePrefs'

afterEach(() => window.localStorage.clear())

describe('collapsePrefs', () => {
  it('returns null when nothing is persisted (caller falls back to defaultOpen)', () => {
    expect(readCollapsePref('terminal.appearance')).toBeNull()
  })

  it('round-trips open and closed', () => {
    writeCollapsePref('terminal.appearance', false)
    expect(readCollapsePref('terminal.appearance')).toBe(false)
    writeCollapsePref('terminal.appearance', true)
    expect(readCollapsePref('terminal.appearance')).toBe(true)
  })

  it('keys are namespaced under the sweepable prefix', () => {
    writeCollapsePref('browser.developer', false)
    expect(window.localStorage.getItem(`${COLLAPSE_KEY_PREFIX}browser.developer`)).toBe('0')
  })

  it('ignores garbage values (reads as never-toggled)', () => {
    window.localStorage.setItem(`${COLLAPSE_KEY_PREFIX}file.view`, 'maybe')
    expect(readCollapsePref('file.view')).toBeNull()
  })

  it('reads lazily — clearing the key restores the default without a reload', () => {
    writeCollapsePref('command.status', false)
    expect(readCollapsePref('command.status')).toBe(false)
    window.localStorage.removeItem(`${COLLAPSE_KEY_PREFIX}command.status`) // e2e reset path
    expect(readCollapsePref('command.status')).toBeNull()
  })
})
