import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BackgroundProjectInfo } from '../../../preload'

// Mock the canvas store so the snapshot builds off a fixed active project.
const { project } = vi.hoisted(() => ({
  project: { dir: null as string | null, name: null as string | null }
}))
vi.mock('./canvasStore', () => ({
  useCanvasStore: { getState: () => ({ project }) }
}))

import { useRunningSwitcherStore } from './runningSwitcherStore'

const listBackground = vi.fn<() => Promise<BackgroundProjectInfo[]>>()

function resident(
  dir: string,
  backgroundedAt: number,
  terminals = 0,
  previews = 0
): BackgroundProjectInfo {
  return {
    dir,
    name: dir.split('/').pop() as string,
    terminalsRunning: terminals,
    previews,
    backgroundedAt
  }
}

const reset = (): void =>
  useRunningSwitcherStore.setState({
    open: false,
    cards: [],
    index: 0,
    holdKey: null,
    holdReleased: false
  })

/** A listBackground whose promise this test resolves by hand — the only way to land a second
 *  press INSIDE the snapshot fetch, which is the whole race R16 fixes. */
function deferredBackground(): { resolve: (v: BackgroundProjectInfo[]) => void } {
  let resolve!: (v: BackgroundProjectInfo[]) => void
  listBackground.mockReturnValue(
    new Promise<BackgroundProjectInfo[]>((r) => {
      resolve = r
    })
  )
  return { resolve }
}

beforeEach(() => {
  reset()
  project.dir = 'C:/active'
  project.name = 'active'
  listBackground.mockReset().mockResolvedValue([])
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { project: { listBackground, thumb: vi.fn().mockResolvedValue(null) } }
  }
})

describe('runningSwitcherStore — snapshot + ordering', () => {
  it('snapshots active-first then residents most-recently-backgrounded first', async () => {
    listBackground.mockResolvedValue([resident('C:/A', 100), resident('C:/B', 200)])
    await useRunningSwitcherStore.getState().openWith(1)
    const s = useRunningSwitcherStore.getState()
    expect(s.open).toBe(true)
    expect(s.cards.map((c) => c.dir)).toEqual(['C:/active', 'C:/B', 'C:/A'])
    expect(s.cards[0].active).toBe(true)
  })

  it('next (dir=1) highlights the card after active; prev (dir=-1) highlights the last', async () => {
    listBackground.mockResolvedValue([resident('C:/A', 100), resident('C:/B', 200)])
    await useRunningSwitcherStore.getState().openWith(1)
    expect(useRunningSwitcherStore.getState().index).toBe(1)

    reset()
    await useRunningSwitcherStore.getState().openWith(-1)
    expect(useRunningSwitcherStore.getState().index).toBe(2)
  })

  it('never dips into cold recents — the universe is active + residents only (fix #3)', async () => {
    listBackground.mockResolvedValue([resident('C:/A', 100)])
    await useRunningSwitcherStore.getState().openWith(1)
    // Two running projects → exactly two cards; no historical recents are appended.
    expect(useRunningSwitcherStore.getState().cards).toHaveLength(2)
  })
})

describe('runningSwitcherStore — single / empty running set', () => {
  it('a single running project opens with just itself (no jump into history)', async () => {
    listBackground.mockResolvedValue([])
    await useRunningSwitcherStore.getState().openWith(1)
    const s = useRunningSwitcherStore.getState()
    expect(s.open).toBe(true)
    expect(s.cards).toHaveLength(1)
    expect(s.index).toBe(0)
  })

  it('nothing running (no active, no residents) → stays closed', async () => {
    project.dir = null
    project.name = null
    listBackground.mockResolvedValue([])
    await useRunningSwitcherStore.getState().openWith(1)
    expect(useRunningSwitcherStore.getState().open).toBe(false)
  })
})

describe('runningSwitcherStore — stable cycle (fix #3)', () => {
  it('advance walks a FROZEN snapshot and returns to the origin (no MRU churn)', async () => {
    listBackground.mockResolvedValue([resident('C:/A', 100), resident('C:/B', 200)])
    await useRunningSwitcherStore.getState().openWith(1)
    const snapshot = useRunningSwitcherStore.getState().cards
    const start = useRunningSwitcherStore.getState().index

    // Full loop of length-3 → back to start, and the cards array is never re-fetched/re-ordered.
    for (let n = 0; n < 3; n++) useRunningSwitcherStore.getState().advance(1)
    const s = useRunningSwitcherStore.getState()
    expect(s.index).toBe(start)
    expect(s.cards).toBe(snapshot)
    // The snapshot was built from ONE listBackground read — no re-read churns it mid-cycle.
    expect(listBackground).toHaveBeenCalledTimes(1)
  })

  it('advance is a no-op with fewer than two running projects', async () => {
    listBackground.mockResolvedValue([])
    await useRunningSwitcherStore.getState().openWith(1)
    useRunningSwitcherStore.getState().advance(1)
    expect(useRunningSwitcherStore.getState().index).toBe(0)
  })

  it('a hotkey press while already open advances instead of re-opening', async () => {
    listBackground.mockResolvedValue([resident('C:/A', 100), resident('C:/B', 200)])
    await useRunningSwitcherStore.getState().openWith(1)
    expect(useRunningSwitcherStore.getState().index).toBe(1)
    await useRunningSwitcherStore.getState().openWith(1)
    expect(useRunningSwitcherStore.getState().index).toBe(2)
    // Still one snapshot read — the second press did not re-fetch.
    expect(listBackground).toHaveBeenCalledTimes(1)
  })
})

/**
 * R16. A press that lands while the snapshot fetch is in flight used to be DROPPED: the guard
 * returned without ever applying its `dir`, so a fast double-tap moved one step instead of two.
 * The comment claimed it "respected" the racing press; it did not. Under commit-on-release the
 * drop gets worse — hold the modifier, tap the key twice quickly, and the switch lands on the
 * wrong project.
 */
describe('runningSwitcherStore — a press racing the fetch is QUEUED, not dropped (R16)', () => {
  it('a second press during the fetch lands as an extra step once the snapshot arrives', async () => {
    const gate = deferredBackground()
    const first = useRunningSwitcherStore.getState().openWith(1)
    // Mid-fetch: the overlay does not exist yet, so this cannot be handled as an advance.
    void useRunningSwitcherStore.getState().openWith(1)
    gate.resolve([resident('C:/A', 100), resident('C:/B', 200)])
    await first

    const s = useRunningSwitcherStore.getState()
    expect(s.open).toBe(true)
    // active-first list is [active, B, A]; one press → index 1, the queued second → index 2.
    expect(s.index).toBe(2)
    // …and it is still ONE snapshot: the queued press must not trigger a second fetch.
    expect(listBackground).toHaveBeenCalledTimes(1)
  })

  it('queued presses accumulate — three fast taps land three steps away (wrapping)', async () => {
    const gate = deferredBackground()
    const first = useRunningSwitcherStore.getState().openWith(1)
    void useRunningSwitcherStore.getState().openWith(1)
    void useRunningSwitcherStore.getState().openWith(1)
    gate.resolve([resident('C:/A', 100), resident('C:/B', 200)])
    await first

    // base 1 + 2 queued = 3, wrapped over a 3-card ring → back to the active card.
    expect(useRunningSwitcherStore.getState().index).toBe(0)
  })

  it('a queued press in the OPPOSITE direction cancels out (net steps, not a press count)', async () => {
    const gate = deferredBackground()
    const first = useRunningSwitcherStore.getState().openWith(1)
    void useRunningSwitcherStore.getState().openWith(-1)
    gate.resolve([resident('C:/A', 100), resident('C:/B', 200)])
    await first

    // Next moved one off the active card; prev steps back onto it — the same round trip
    // Alt+Tab → Alt+Shift+Tab makes, and the reason the queue tracks NET steps rather than a
    // press count.
    expect(useRunningSwitcherStore.getState().index).toBe(0)
  })

  it('the queue does not leak into the NEXT interaction', async () => {
    const gate = deferredBackground()
    const first = useRunningSwitcherStore.getState().openWith(1)
    void useRunningSwitcherStore.getState().openWith(1)
    gate.resolve([resident('C:/A', 100), resident('C:/B', 200)])
    await first
    useRunningSwitcherStore.getState().close()

    listBackground.mockResolvedValue([resident('C:/A', 100), resident('C:/B', 200)])
    await useRunningSwitcherStore.getState().openWith(1)
    // A fresh interaction starts at the neighbour — not at the stale queued offset.
    expect(useRunningSwitcherStore.getState().index).toBe(1)
  })

  it('presses queued against an EMPTY running set are discarded with the interaction', async () => {
    const gate = deferredBackground()
    const first = useRunningSwitcherStore.getState().openWith(1)
    void useRunningSwitcherStore.getState().openWith(1)
    project.dir = null
    project.name = null
    gate.resolve([])
    await first
    expect(useRunningSwitcherStore.getState().open).toBe(false)
  })
})

/**
 * R16. The hold is armed at CHORD time, not at open time: the overlay only mounts after the async
 * fetch, and a tap releases the modifier before that lands. An arm-on-open design would miss the
 * release of the commonest Alt-Tab gesture there is and strand the picker open.
 */
describe('runningSwitcherStore — the commit-on-release hold (R16)', () => {
  it('records the held modifier and clears the release flag', () => {
    useRunningSwitcherStore.getState().noteHoldKey('Control')
    expect(useRunningSwitcherStore.getState().holdKey).toBe('Control')
    expect(useRunningSwitcherStore.getState().holdReleased).toBe(false)
  })

  it('a release that lands BEFORE the overlay opens is still recorded (the fast-tap race)', async () => {
    const gate = deferredBackground()
    useRunningSwitcherStore.getState().noteHoldKey('Control')
    const opening = useRunningSwitcherStore.getState().openWith(1)
    // The user has already let go — the overlay does not even exist yet.
    useRunningSwitcherStore.getState().noteHoldReleased()
    gate.resolve([resident('C:/A', 100)])
    await opening

    const s = useRunningSwitcherStore.getState()
    expect(s.open).toBe(true)
    // The component reads exactly this pair and commits immediately.
    expect(s.holdKey).toBe('Control')
    expect(s.holdReleased).toBe(true)
  })

  it("a fresh chord re-arms — the previous interaction's release is stale, not a commit", () => {
    useRunningSwitcherStore.getState().noteHoldKey('Control')
    useRunningSwitcherStore.getState().noteHoldReleased()
    useRunningSwitcherStore.getState().noteHoldKey('Control')
    expect(useRunningSwitcherStore.getState().holdReleased).toBe(false)
  })

  it('a release with nothing armed is ignored (a stray Ctrl keyup must never commit)', () => {
    useRunningSwitcherStore.getState().noteHoldReleased()
    expect(useRunningSwitcherStore.getState().holdReleased).toBe(false)
  })

  it('a modifier-free chord arms no hold — the overlay keeps Enter/click/Esc', () => {
    useRunningSwitcherStore.getState().noteHoldKey(null)
    useRunningSwitcherStore.getState().noteHoldReleased()
    expect(useRunningSwitcherStore.getState().holdKey).toBeNull()
    expect(useRunningSwitcherStore.getState().holdReleased).toBe(false)
  })

  it('nothing running clears the armed hold, so it cannot fire on the next interaction', async () => {
    project.dir = null
    project.name = null
    listBackground.mockResolvedValue([])
    useRunningSwitcherStore.getState().noteHoldKey('Control')
    await useRunningSwitcherStore.getState().openWith(1)

    const s = useRunningSwitcherStore.getState()
    expect(s.open).toBe(false)
    expect(s.holdKey).toBeNull()
  })

  it('close() clears the hold along with the snapshot', async () => {
    listBackground.mockResolvedValue([resident('C:/A', 100)])
    useRunningSwitcherStore.getState().noteHoldKey('Meta')
    await useRunningSwitcherStore.getState().openWith(1)
    useRunningSwitcherStore.getState().close()

    const s = useRunningSwitcherStore.getState()
    expect(s.holdKey).toBeNull()
    expect(s.holdReleased).toBe(false)
  })
})
