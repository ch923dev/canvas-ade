/**
 * Parity: `src/shared/deriveContexts.ts` MIRRORS the per-type default board titles (it skips them
 * when naming a context) because a shared module, compiled by tsconfig.node too, cannot import
 * renderer code. This test lives on the renderer side, where the web tsconfig sees both trees, and
 * pins the mirror to its `boardDefaults` source so a new board type cannot drift past it.
 */
import { describe, expect, test } from 'vitest'
import { DEFAULT_TITLE } from './boardDefaults'
import { GENERIC_BOARD_TITLES } from '../../../shared/deriveContexts'

describe('deriveContexts ↔ boardDefaults parity', () => {
  test('GENERIC_BOARD_TITLES is exactly the lowercased DEFAULT_TITLE values', () => {
    const expected = Object.values(DEFAULT_TITLE)
      .map((t) => t.toLowerCase())
      .sort()
    expect([...GENERIC_BOARD_TITLES].sort()).toEqual(expected)
  })
})
