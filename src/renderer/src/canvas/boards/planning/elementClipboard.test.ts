/**
 * Unit tests for the in-app element clipboard (Phase 3 — spec §3.B). A tiny ephemeral
 * module-level singleton: set / get / clear / has. The cross-board copy/cut/paste behavior
 * that consumes it is pinned in usePlanningKeyboard.clipboard.integration.test.tsx.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { setClipboard, getClipboard, clearClipboard, hasClipboard } from './elementClipboard'
import type { NoteElement, PlanningElement } from '../../../lib/boardSchema'

const note = (id: string): PlanningElement =>
  ({
    id,
    kind: 'note',
    x: 0,
    y: 0,
    w: 156,
    h: 96,
    tint: 'yellow',
    text: '',
    rotation: 0
  }) satisfies NoteElement

// The clipboard is a module singleton — reset it after every test so state never leaks
// across tests (or, with module isolation off, across files).
afterEach(() => clearClipboard())

describe('elementClipboard', () => {
  it('starts empty (null payload, has=false)', () => {
    expect(getClipboard()).toBeNull()
    expect(hasClipboard()).toBe(false)
  })

  it('set stores the exact payload reference; get returns it; has=true', () => {
    const payload = [note('a'), note('b')]
    setClipboard(payload)
    expect(getClipboard()).toBe(payload) // same reference (insertTransferred re-clones per insert)
    expect(hasClipboard()).toBe(true)
  })

  it('clear empties the slot', () => {
    setClipboard([note('a')])
    expect(hasClipboard()).toBe(true)
    clearClipboard()
    expect(getClipboard()).toBeNull()
    expect(hasClipboard()).toBe(false)
  })

  it('set replaces the previous payload', () => {
    setClipboard([note('a')])
    const next = [note('b'), note('c')]
    setClipboard(next)
    expect(getClipboard()).toBe(next)
    expect(getClipboard()).toHaveLength(2)
  })

  it('hasClipboard is false for a defensively-empty array (get still returns it)', () => {
    setClipboard([])
    expect(hasClipboard()).toBe(false) // length 0 → nothing to paste
    expect(getClipboard()).toEqual([])
  })
})
