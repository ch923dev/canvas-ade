import { describe, it, expect } from 'vitest'
import {
  SELECTION_SNAPSHOT_TTL_MS,
  cacheSnapshot,
  clearSnapshot,
  emptySnapshot,
  readSnapshot
} from './selectionSnapshot'

describe('selectionSnapshot', () => {
  it('caches non-empty text and reads it back within the TTL', () => {
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'npm run dev', 1000)
    expect(readSnapshot(cell, 1000)).toBe('npm run dev')
    expect(readSnapshot(cell, 1000 + SELECTION_SNAPSHOT_TTL_MS)).toBe('npm run dev')
  })

  it('expires after the TTL', () => {
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'https://example.com/pr/42', 1000)
    expect(readSnapshot(cell, 1001 + SELECTION_SNAPSHOT_TTL_MS)).toBe('')
  })

  it('ignores empty text (clears are gesture-driven, not onSelectionChange-driven)', () => {
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'keep me', 1000)
    // xterm fires onSelectionChange with an empty selection on every clear — including the
    // agent-caused wipes this cache exists to survive. Empty must NOT overwrite the cache.
    cacheSnapshot(cell, '', 2000)
    expect(readSnapshot(cell, 2000)).toBe('keep me')
  })

  it('re-caching refreshes both text and timestamp', () => {
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'old', 1000)
    cacheSnapshot(cell, 'new', 5000)
    expect(readSnapshot(cell, 5000 + SELECTION_SNAPSHOT_TTL_MS)).toBe('new')
  })

  it('clearSnapshot empties the cell', () => {
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'gone', 1000)
    clearSnapshot(cell)
    expect(readSnapshot(cell, 1000)).toBe('')
  })

  it('empty cell reads as empty', () => {
    expect(readSnapshot(emptySnapshot(), 0)).toBe('')
  })
})
