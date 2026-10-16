import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { useCameraRequestStore } from './cameraRequestStore'
import { useCanvasViewStore } from './canvasViewStore'
import { applySpatialMcpCommand } from './spatialMcpApply'

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: [],
    tool: 'select',
    past: [],
    future: []
  })
  useCameraRequestStore.setState({ seq: 0, target: null })
})
afterEach(() => useCanvasViewStore.setState({ pane: null }))

/** Three terminals stacked on ONE spot (fresh history) so a tidy must move at least two of them. */
function seedOverlapping(): void {
  useCanvasStore.setState({ boards: [], past: [], future: [] })
  const s = useCanvasStore.getState()
  for (const id of ['b1', 'b2', 'b3']) s.addBoard('terminal', { x: 0, y: 0 }, { id })
  useCanvasStore.setState((st) => ({
    boards: st.boards.map((b) => ({ ...b, x: 100, y: 100 })),
    past: [],
    future: []
  }))
}

const positions = (): Array<[string, number, number]> =>
  useCanvasStore.getState().boards.map((b) => [b.id, b.x, b.y])

describe('applySpatialMcpCommand tidyBoards (S0 — screen-aware agent tidy)', () => {
  it('G1: packs toward the mounted PANE aspect (wide pane ⇒ one row, tall pane ⇒ one column)', () => {
    seedOverlapping()
    useCanvasViewStore.setState({ pane: { w: 4000, h: 400 } })
    applySpatialMcpCommand({ type: 'tidyBoards', mode: 'grid' })
    expect(new Set(useCanvasStore.getState().boards.map((b) => b.y)).size).toBe(1)

    seedOverlapping()
    useCanvasViewStore.setState({ pane: { w: 400, h: 4000 } })
    applySpatialMcpCommand({ type: 'tidyBoards', mode: 'grid' })
    expect(new Set(useCanvasStore.getState().boards.map((b) => b.x)).size).toBe(1)
  })

  it('G1: passes the aspect exactly like the UI tidy (w / max(1, h)) — same result as a direct call', () => {
    seedOverlapping()
    useCanvasStore.getState().tidyBoards('grid', 1600 / 900)
    const expected = positions()
    seedOverlapping()
    useCanvasViewStore.setState({ pane: { w: 1600, h: 900 } })
    applySpatialMcpCommand({ type: 'tidyBoards', mode: 'grid' })
    expect(positions()).toEqual(expected)
  })

  it('G1: no mounted pane ⇒ no aspect — identical to the packer default (pre-S0 behaviour)', () => {
    seedOverlapping()
    useCanvasStore.getState().tidyBoards('grid')
    const expected = positions()
    seedOverlapping()
    applySpatialMcpCommand({ type: 'tidyBoards', mode: 'grid' })
    expect(positions()).toEqual(expected)
  })

  it('G4: frames the camera on the result via the focusCamera path, still ONE undo step', () => {
    seedOverlapping()
    const ack = applySpatialMcpCommand({ type: 'tidyBoards', mode: 'grid' })
    expect(ack).toMatchObject({ ok: true, type: 'tidyBoards' })
    expect(useCameraRequestStore.getState().seq).toBe(1)
    expect(useCameraRequestStore.getState().target).toEqual({ kind: 'all' })
    expect(useCanvasStore.getState().past).toHaveLength(1)
  })

  it('G4: an already-tidy canvas still frames the camera (tidy-and-fit, like the UI)', () => {
    seedOverlapping()
    applySpatialMcpCommand({ type: 'tidyBoards', mode: 'grid' })
    const again = applySpatialMcpCommand({ type: 'tidyBoards', mode: 'grid' })
    expect(again).toEqual({ ok: true, type: 'tidyBoards', moved: 0 })
    expect(useCameraRequestStore.getState().seq).toBe(2)
  })
})

describe('applySpatialMcpCommand focusCamera / spawnGroup (moved unchanged — C5 pre-split)', () => {
  it('focusCamera parks a board request for a live board, rejects an unknown one', () => {
    useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 }, { id: 't1' })
    expect(applySpatialMcpCommand({ type: 'focusCamera', boardId: 't1' })).toEqual({
      ok: true,
      type: 'focusCamera'
    })
    expect(useCameraRequestStore.getState().target).toEqual({ kind: 'board', id: 't1' })
    expect(applySpatialMcpCommand({ type: 'focusCamera', boardId: 'ghost' }).ok).toBe(false)
  })

  it('focusCamera with no target parks a fit-all and pushes no undo step', () => {
    expect(applySpatialMcpCommand({ type: 'focusCamera' })).toEqual({
      ok: true,
      type: 'focusCamera'
    })
    expect(useCameraRequestStore.getState().target).toEqual({ kind: 'all' })
    expect(useCanvasStore.getState().past).toHaveLength(0)
  })

  it('spawnGroup lands the zone as ONE undo step, idempotent by group id', () => {
    const cmd = {
      type: 'spawnGroup' as const,
      group: { id: 'grp-1', name: 'Auth zone' },
      members: { terminal: { id: 't-1' }, browser: { id: 'b-1' } }
    }
    expect(applySpatialMcpCommand(cmd)).toEqual({ ok: true, type: 'spawnGroup' })
    expect(applySpatialMcpCommand(cmd)).toEqual({ ok: true, type: 'spawnGroup' })
    const st = useCanvasStore.getState()
    expect(st.groups).toEqual([{ id: 'grp-1', name: 'Auth zone', boardIds: ['t-1', 'b-1'] }])
    expect(st.past).toHaveLength(1)
  })

  it('spawnGroup rejects a malformed envelope without mutating the canvas', () => {
    const ack = applySpatialMcpCommand({
      type: 'spawnGroup',
      group: { id: 'g', name: '' },
      members: { terminal: { id: 't' } }
    })
    expect(ack.ok).toBe(false)
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })
})
