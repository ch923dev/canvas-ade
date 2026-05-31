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
    useCanvasStore.setState({ boards: [], viewport: null, selectedId: null, past: [], future: [] })
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
})
