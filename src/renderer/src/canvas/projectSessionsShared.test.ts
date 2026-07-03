import { describe, it, expect } from 'vitest'
import { basenameOf, bgBadge, closeBody, dockCards } from './projectSessionsShared'
import type { BackgroundProjectInfo } from '../../../preload'

// Phase 4b — the shared project-session UI helpers (switcher + dock). The dock membership
// model is the load-bearing piece: SESSION projects only, active first, residents
// most-recently-backgrounded first, cold recents never consulted.

const bg = (dir: string, over: Partial<BackgroundProjectInfo> = {}): BackgroundProjectInfo => ({
  dir,
  name: basenameOf(dir),
  terminalsRunning: 1,
  previews: 0,
  backgroundedAt: 0,
  ...over
})

describe('basenameOf', () => {
  it('takes the last segment on Windows and POSIX paths, ignoring trailing separators', () => {
    expect(basenameOf('C:\\work\\alpha')).toBe('alpha')
    expect(basenameOf('/home/u/beta/')).toBe('beta')
    expect(basenameOf('gamma')).toBe('gamma')
  })
})

describe('bgBadge / closeBody', () => {
  it('renders only the non-zero parts', () => {
    expect(bgBadge({ terminalsRunning: 2, previews: 1 })).toBe('2 term · 1 prev')
    expect(bgBadge({ terminalsRunning: 0, previews: 3 })).toBe('3 prev')
    expect(bgBadge({ terminalsRunning: 0, previews: 0 })).toBe('')
  })

  it('closeBody pluralizes and joins with "and"', () => {
    expect(closeBody({ terminalsRunning: 1, previews: 2 })).toBe(
      '1 running terminal (their processes are killed) and closes 2 previews'
    )
    expect(closeBody({ terminalsRunning: 2, previews: 0 })).toBe(
      '2 running terminals (their processes are killed)'
    )
  })
})

describe('dockCards (PHASE4-UX-DESIGN §4 membership + order)', () => {
  it('puts the active project first, then residents most-recently-backgrounded first', () => {
    const cards = dockCards(
      { dir: 'C:\\p\\active', name: 'active' },
      { terminals: 1, previews: 2 },
      [bg('C:\\p\\old', { backgroundedAt: 10 }), bg('C:\\p\\recent', { backgroundedAt: 99 })]
    )
    expect(cards.map((c) => c.dir)).toEqual(['C:\\p\\active', 'C:\\p\\recent', 'C:\\p\\old'])
    expect(cards[0]).toMatchObject({ active: true, terminalsRunning: 1, previews: 2 })
    expect(cards[1].active).toBe(false)
  })

  it('is session-only: no active dir → residents only; residents never duplicate the active dir', () => {
    const noActive = dockCards({ dir: null, name: null }, null, [bg('C:\\p\\a')])
    expect(noActive.map((c) => c.dir)).toEqual(['C:\\p\\a'])
    // A registry entry for the active dir (transient foreground race) must not double-card.
    const deduped = dockCards({ dir: 'C:\\p\\a', name: 'a' }, null, [bg('C:\\p\\a')])
    expect(deduped).toHaveLength(1)
    expect(deduped[0].active).toBe(true)
  })

  it('degrades a null active-counts payload (partial mock / welcome boot) to zero counts', () => {
    const cards = dockCards({ dir: 'C:\\p\\active', name: null }, null, [])
    expect(cards[0]).toMatchObject({ name: 'active', terminalsRunning: 0, previews: 0 })
  })
})
