import { describe, it, expect, vi } from 'vitest'
import type { RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { MenuEntry } from '../planning/ElementContextMenu'
import { buildTerminalMenuEntries } from './terminalMenu'

/** Disabled flag of an entry by id (separators carry none → undefined). */
function disabledOf(entries: MenuEntry[], id: string): boolean | undefined {
  const e = entries.find((x) => x.id === id)
  return e && e.kind !== 'separator' ? e.disabled : undefined
}

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
  it('produces the well actions (with the grouped Save-output entry) in order', () => {
    const entries = buildTerminalMenuEntries({ ...base, termRef: mkTerm() })
    expect(entries.map((e) => e.id)).toEqual([
      'copy',
      'paste',
      'selectall',
      'clear',
      'sep-save-top',
      'save-output',
      'sep-save-bottom',
      'font-bigger',
      'font-smaller',
      'font-reset'
    ])
  })

  it('flanks "Save output…" with hairline separators (its own group)', () => {
    const entries = buildTerminalMenuEntries({ ...base, termRef: mkTerm() })
    const i = entries.findIndex((e) => e.id === 'save-output')
    const save = entries[i]
    expect(save.kind === 'action' && save.label).toBe('Save output…')
    expect(entries[i - 1].kind).toBe('separator')
    expect(entries[i + 1].kind).toBe('separator')
  })

  it('disables Copy when there is no selection, enables it when there is', () => {
    const off = buildTerminalMenuEntries({ ...base, hasSel: false, termRef: mkTerm() })
    const on = buildTerminalMenuEntries({ ...base, hasSel: true, termRef: mkTerm() })
    expect(disabledOf(off, 'copy')).toBe(true)
    expect(disabledOf(on, 'copy')).toBe(false)
  })

  it('disables Bigger at the max bound and Smaller at the min bound', () => {
    const atMax = buildTerminalMenuEntries({ ...base, effectiveFont: 22, termRef: mkTerm() })
    const atMin = buildTerminalMenuEntries({ ...base, effectiveFont: 8, termRef: mkTerm() })
    expect(disabledOf(atMax, 'font-bigger')).toBe(true)
    expect(disabledOf(atMax, 'font-smaller')).toBe(false)
    expect(disabledOf(atMin, 'font-smaller')).toBe(true)
    expect(disabledOf(atMin, 'font-bigger')).toBe(false)
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
