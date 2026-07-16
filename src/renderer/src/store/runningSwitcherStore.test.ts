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

const reset = (): void => useRunningSwitcherStore.setState({ open: false, cards: [], index: 0 })

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
