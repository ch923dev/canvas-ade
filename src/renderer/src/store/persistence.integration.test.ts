import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import type { Board } from '../lib/boardSchema'

const seed: Board[] = [
  {
    id: 't1',
    type: 'terminal',
    x: 0,
    y: 0,
    w: 420,
    h: 340,
    title: 'T',
    shell: 'pwsh',
    launchCommand: 'claude',
    cwd: 'C:/x',
    port: 5180
  },
  {
    id: 'b1',
    type: 'browser',
    x: 500,
    y: 0,
    w: 700,
    h: 500,
    title: 'B',
    url: 'http://localhost:5173',
    viewport: 'tablet'
  },
  {
    id: 'p1',
    type: 'planning',
    x: 0,
    y: 400,
    w: 516,
    h: 366,
    title: 'P',
    elements: [
      { id: 'n1', kind: 'note', x: 10, y: 10, w: 160, h: 120, text: 'hi', tint: 'yellow' },
      {
        id: 'c1',
        kind: 'checklist',
        x: 200,
        y: 10,
        w: 240,
        h: 0,
        title: 'Tasks',
        items: [{ id: 'i1', label: 'a', done: true }]
      },
      { id: 'a1', kind: 'arrow', x: 0, y: 0, x2: 50, y2: 60 },
      { id: 's1', kind: 'stroke', x: 0, y: 0, points: [0, 0, 1, 1, 2, 2] },
      { id: 'tx', kind: 'text', x: 5, y: 5, text: 'label' }
    ]
  }
]

describe('persistence — full reopen fidelity', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      boards: [],
      connectors: [],
      groups: [],
      viewport: null,
      selectedId: null,
      past: [],
      future: []
    })
  })

  it('boards + planning elements + camera survive a serialize→deserialize cycle', () => {
    useCanvasStore.setState({ boards: seed })
    useCanvasStore.getState().setViewport({ x: -300, y: 120, zoom: 0.85 })

    // Simulate writing to disk and reading back (what canvas.json does).
    const onDisk = JSON.parse(JSON.stringify(useCanvasStore.getState().toObject()))

    // Wipe + reload as if reopening the app.
    useCanvasStore.setState({ boards: [], viewport: null })
    useCanvasStore.getState().loadObject(onDisk)

    const s = useCanvasStore.getState()
    expect(s.boards).toEqual(seed)
    expect(s.viewport).toEqual({ x: -300, y: 120, zoom: 0.85 })
  })

  it('loaded boards do not alias the on-disk object (BUG-027)', () => {
    useCanvasStore.setState({ boards: seed })
    const onDisk = useCanvasStore.getState().toObject()
    useCanvasStore.getState().loadObject(onDisk)
    expect(useCanvasStore.getState().boards).not.toBe(onDisk.boards)
  })

  it('round-trips groups through toObject -> loadObject and prunes deleted boards', () => {
    useCanvasStore.setState({
      boards: [],
      connectors: [],
      groups: [],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
    const b1 = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const b2 = useCanvasStore.getState().addBoard('terminal', { x: 400, y: 0 })
    const gid = useCanvasStore.getState().addGroup('Auth', [b1, b2])
    const doc = useCanvasStore.getState().toObject()
    expect(doc.groups?.find((g) => g.id === gid)?.boardIds).toEqual([b1, b2])

    // Reload a doc whose group references a now-missing board → pruned on load.
    const pruned = { ...doc, boards: doc.boards.filter((b) => b.id === b1) }
    useCanvasStore.getState().loadObject(pruned)
    expect(useCanvasStore.getState().groups.find((g) => g.id === gid)?.boardIds).toEqual([b1])
  })

  it('orchestration connectors survive a reopen; preview links fold via previewSourceId (M2)', () => {
    // Link the Browser to the terminal (runtime preview SoT) + draw an orchestration cable.
    const linkedSeed = seed.map((b) => (b.id === 'b1' ? { ...b, previewSourceId: 't1' } : b))
    useCanvasStore.setState({ boards: linkedSeed, connectors: [] })
    const cableId = useCanvasStore.getState().addConnector('t1', 'p1', 'orchestration')!
    expect(cableId).toBeTypeOf('string')

    const onDisk = JSON.parse(JSON.stringify(useCanvasStore.getState().toObject()))
    // The persisted doc carries BOTH the derived preview connector AND the orchestration cable.
    expect(onDisk.connectors).toContainEqual({
      id: 'preview-b1',
      sourceId: 't1',
      targetId: 'b1',
      kind: 'preview'
    })
    expect(onDisk.connectors).toContainEqual({
      id: cableId,
      sourceId: 't1',
      targetId: 'p1',
      kind: 'orchestration'
    })

    // Reopen.
    useCanvasStore.setState({ boards: [], connectors: [] })
    useCanvasStore.getState().loadObject(onDisk)
    const s = useCanvasStore.getState()
    // Orchestration kept in memory; preview folded back into previewSourceId (not retained).
    expect(s.connectors).toEqual([
      { id: cableId, sourceId: 't1', targetId: 'p1', kind: 'orchestration' }
    ])
    const b = s.boards.find((x) => x.id === 'b1')!
    expect(b.type === 'browser' ? b.previewSourceId : null).toBe('t1')
  })
})
