import { describe, it, expect, vi } from 'vitest'
import {
  SELECTION_SNAPSHOT_TTL_MS,
  cacheSnapshot,
  clearSnapshot,
  copyWithFallback,
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

describe('copyWithFallback (PR #332 review fix: consume only on a VERIFIED write)', () => {
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('prefers the live selection; verified write consumes the snapshot + clears the highlight', async () => {
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'stale-snap', 1000)
    const write = vi.fn().mockResolvedValue(true)
    const clearHighlight = vi.fn()
    expect(copyWithFallback({ live: 'live-text', cell, now: 1000, write, clearHighlight })).toBe(
      true
    )
    await settle()
    expect(write).toHaveBeenCalledWith('live-text')
    expect(readSnapshot(cell, 1000)).toBe('') // consumed → next Ctrl+C is SIGINT again
    expect(clearHighlight).toHaveBeenCalledOnce()
  })

  it('falls back to the snapshot when the live selection was wiped', async () => {
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'from-snap', 1000)
    const write = vi.fn().mockResolvedValue(true)
    expect(copyWithFallback({ live: '', cell, now: 1000, write, clearHighlight: vi.fn() })).toBe(
      true
    )
    await settle()
    expect(write).toHaveBeenCalledWith('from-snap')
    expect(readSnapshot(cell, 1000)).toBe('')
  })

  it('FAILED write keeps the snapshot so a retry can copy (no SIGINT strand)', async () => {
    // The reviewer scenario: live selection wiped by the agent, snapshot-fallback copy fires,
    // MAIN honestly reports the clipboard write failed (Windows contention). The snapshot must
    // SURVIVE — the user's second Ctrl+C retries the copy instead of falling through to SIGINT.
    const cell = emptySnapshot()
    cacheSnapshot(cell, 'must-survive', 1000)
    const write = vi.fn().mockResolvedValue(false)
    const clearHighlight = vi.fn()
    expect(copyWithFallback({ live: '', cell, now: 1000, write, clearHighlight })).toBe(true)
    await settle()
    expect(readSnapshot(cell, 1000)).toBe('must-survive')
    expect(clearHighlight).not.toHaveBeenCalled()
    // Retry succeeds → NOW it consumes.
    const write2 = vi.fn().mockResolvedValue(true)
    expect(copyWithFallback({ live: '', cell, now: 1500, write: write2, clearHighlight })).toBe(
      true
    )
    await settle()
    expect(write2).toHaveBeenCalledWith('must-survive')
    expect(readSnapshot(cell, 1500)).toBe('')
  })

  it('returns false only when live AND snapshot are both empty (SIGINT falls through)', () => {
    expect(
      copyWithFallback({
        live: '',
        cell: emptySnapshot(),
        now: 0,
        write: vi.fn(),
        clearHighlight: vi.fn()
      })
    ).toBe(false)
  })
})
