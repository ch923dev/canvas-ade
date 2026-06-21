import { describe, it, expect, vi } from 'vitest'
import type { RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { buildTerminalMenuEntries } from './terminalMenu'

function mkTerm(over: Partial<Terminal> = {}): RefObject<Terminal | null> {
  const term = {
    getSelection: () => '',
    hasSelection: () => false,
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    ...over
  }
  return { current: term as unknown as Terminal }
}

const base = {
  hasSel: false,
  boardId: 'b1',
  effectiveFont: 13,
  minFont: 8,
  maxFont: 22,
  nudgeFont: vi.fn(),
  resetFont: vi.fn()
}

describe('buildTerminalMenuEntries (TERM-07)', () => {
  it('produces the seven well actions in order', () => {
    const entries = buildTerminalMenuEntries({ ...base, termRef: mkTerm() })
    expect(entries.map((e) => e.id)).toEqual([
      'copy',
      'paste',
      'selectall',
      'clear',
      'font-bigger',
      'font-smaller',
      'font-reset'
    ])
  })

  it('disables Copy when there is no selection, enables it when there is', () => {
    const off = buildTerminalMenuEntries({ ...base, hasSel: false, termRef: mkTerm() })
    const on = buildTerminalMenuEntries({ ...base, hasSel: true, termRef: mkTerm() })
    expect(off.find((e) => e.id === 'copy')?.disabled).toBe(true)
    expect(on.find((e) => e.id === 'copy')?.disabled).toBe(false)
  })

  it('disables Bigger at the max bound and Smaller at the min bound', () => {
    const atMax = buildTerminalMenuEntries({ ...base, effectiveFont: 22, termRef: mkTerm() })
    const atMin = buildTerminalMenuEntries({ ...base, effectiveFont: 8, termRef: mkTerm() })
    expect(atMax.find((e) => e.id === 'font-bigger')?.disabled).toBe(true)
    expect(atMax.find((e) => e.id === 'font-smaller')?.disabled).toBe(false)
    expect(atMin.find((e) => e.id === 'font-smaller')?.disabled).toBe(true)
    expect(atMin.find((e) => e.id === 'font-bigger')?.disabled).toBe(false)
  })

  it('Select all / Clear drive the live terminal; font actions call the nudges', () => {
    const selectAll = vi.fn()
    const clear = vi.fn()
    const nudgeFont = vi.fn()
    const resetFont = vi.fn()
    const entries = buildTerminalMenuEntries({
      ...base,
      nudgeFont,
      resetFont,
      termRef: mkTerm({ selectAll, clear })
    })
    const run = (id: string): void => {
      const e = entries.find((x) => x.id === id)
      if (e && e.kind === 'action') e.onSelect()
    }
    run('selectall')
    run('clear')
    run('font-bigger')
    run('font-smaller')
    run('font-reset')
    expect(selectAll).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
    expect(nudgeFont).toHaveBeenCalledWith(1)
    expect(nudgeFont).toHaveBeenCalledWith(-1)
    expect(resetFont).toHaveBeenCalledOnce()
  })
})
