// @vitest-environment jsdom
/**
 * useMcpPublish — the C1 additions: per-board context signals + the settled `view` on the
 * `mcp:boards` payload, riding the existing 150 ms debounce (never per camera frame).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { boardContextFields, buildCanvasView, useMcpPublish } from './useMcpPublish'
import { useCanvasStore } from './canvasStore'
import { useCanvasViewStore } from './canvasViewStore'
import { useRoleSignalsStore } from './roleSignalsStore'
import { Z_MAX, Z_MIN } from '../lib/canvasView'
import { VIEW_ZOOM_MAX, VIEW_ZOOM_MIN } from '../../../shared/spatialTypes'

describe('boardContextFields (C1 — classified context only)', () => {
  it('terminal → cwd + dockedIn; browser → previewSourceId; dataflow → sourceBoardId', () => {
    expect(boardContextFields({ type: 'terminal', cwd: '/repo/api', dockedIn: 'sw1' })).toEqual({
      cwd: '/repo/api',
      dockedIn: 'sw1'
    })
    expect(boardContextFields({ type: 'browser', previewSourceId: 't1' })).toEqual({
      previewSourceId: 't1'
    })
    expect(boardContextFields({ type: 'dataflow', sourceBoardId: 'b1' })).toEqual({
      sourceBoardId: 'b1'
    })
  })

  it('a field is only read on its own board type, and empty values are omitted', () => {
    expect(boardContextFields({ type: 'browser', cwd: '/x', dockedIn: 'sw1' })).toEqual({})
    expect(boardContextFields({ type: 'planning', previewSourceId: 't1' })).toEqual({})
    expect(boardContextFields({ type: 'terminal', cwd: '' })).toEqual({})
  })

  it('🔒 D9: never forwards a launch line or anything beyond the classified fields', () => {
    const terminal = {
      type: 'terminal',
      cwd: '/repo',
      launchCommand: 'OPENAI_API_KEY=sk-secret claude',
      title: 'Agent'
    }
    // The launch line yields ONLY the C9 `agent` classification — never the line, key or env.
    expect(boardContextFields(terminal)).toEqual({ cwd: '/repo', agent: true })
    expect(JSON.stringify(boardContextFields(terminal))).not.toContain('sk-secret')
  })
})

describe('boardContextFields (C9 role signals — L11)', () => {
  const signals = {
    ports: { t1: [5173, 3000], b1: [9999] },
    callsPorts: { b1: [3000, 5173], t1: [8888] },
    lastFocusedAt: { t1: 111, b1: 222, p1: 333 }
  }

  it('terminal → agent (only when true) + ports; browser → callsPorts; any board → lastFocusedAt', () => {
    expect(boardContextFields({ id: 't1', type: 'terminal', agentKind: 'codex' }, signals)).toEqual(
      {
        agent: true,
        ports: [5173, 3000],
        lastFocusedAt: 111
      }
    )
    expect(boardContextFields({ id: 'b1', type: 'browser' }, signals)).toEqual({
      callsPorts: [3000, 5173],
      lastFocusedAt: 222
    })
    expect(boardContextFields({ id: 'p1', type: 'planning' }, signals)).toEqual({
      lastFocusedAt: 333
    })
  })

  it('a plain shell / dev server carries no `agent`; ports and callsPorts stay on their own type', () => {
    expect(
      boardContextFields({ id: 't1', type: 'terminal', launchCommand: 'pnpm dev' }, signals)
    ).not.toHaveProperty('agent')
    expect(boardContextFields({ id: 't1', type: 'terminal' }, signals)).not.toHaveProperty(
      'callsPorts'
    )
    expect(boardContextFields({ id: 'b1', type: 'browser' }, signals)).not.toHaveProperty('ports')
    expect(boardContextFields({ id: 'zz', type: 'terminal' }, signals)).toEqual({})
  })
})

describe('buildCanvasView (C1)', () => {
  it('MAIN clamps the published zoom to exactly the renderer camera range (parity)', () => {
    expect(VIEW_ZOOM_MIN).toBe(Z_MIN)
    expect(VIEW_ZOOM_MAX).toBe(Z_MAX)
  })

  it('null until BOTH the pane and the camera are known', () => {
    expect(buildCanvasView(null, { x: 0, y: 0, zoom: 1 }, 1)).toBeNull()
    expect(buildCanvasView({ w: 100, h: 100 }, null, 1)).toBeNull()
  })

  it('carries pane · dpr · camera and derives the visible world rect', () => {
    expect(buildCanvasView({ w: 1600, h: 900 }, { x: -200, y: 100, zoom: 2 }, 1.25)).toEqual({
      pane: { w: 1600, h: 900 },
      dpr: 1.25,
      camera: { x: -200, y: 100, zoom: 2 },
      visibleWorld: { x: 100, y: -50, w: 800, h: 450 }
    })
  })
})

describe('useMcpPublish payload (C1)', () => {
  const publishBoards = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    publishBoards.mockClear()
    ;(window as unknown as { api: unknown }).api = { mcp: { publishBoards } }
    useCanvasStore.setState({ boards: [], connectors: [], groups: [] })
    useCanvasViewStore.setState({ pane: null, camera: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
    useRoleSignalsStore.getState().reset()
  })

  const tick = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('publishes context fields per board and omits `view` while no Canvas view is known', () => {
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    useCanvasStore.getState().updateBoard(id, { cwd: '/repo/api' })
    const { unmount } = renderHook(() => useMcpPublish())
    tick(150)
    const payload = publishBoards.mock.calls.at(-1)?.[0]
    expect(payload.boards[0]).toMatchObject({ id, type: 'terminal', cwd: '/repo/api' })
    expect(payload.boards[0]).not.toHaveProperty('launchCommand')
    expect('view' in payload).toBe(false)
    unmount()
  })

  it('re-publishes with the view when the settled view changes — not on raw camera frames', () => {
    const { unmount } = renderHook(() => useMcpPublish())
    tick(150)
    const baseline = publishBoards.mock.calls.length
    // Raw per-frame camera motion (the canvasStore mirror) does NOT re-publish.
    act(() => useCanvasStore.getState().setViewport({ x: 5, y: 5, zoom: 1.1 }))
    tick(150)
    expect(publishBoards.mock.calls.length).toBe(baseline)
    // A settled view (pane + camera on the bus) does, after the debounce.
    act(() =>
      useCanvasViewStore.setState({ pane: { w: 1000, h: 500 }, camera: { x: 0, y: 0, zoom: 1 } })
    )
    expect(publishBoards.mock.calls.length).toBe(baseline)
    tick(150)
    expect(publishBoards.mock.calls.length).toBe(baseline + 1)
    expect(publishBoards.mock.calls.at(-1)?.[0].view).toEqual({
      pane: { w: 1000, h: 500 },
      dpr: window.devicePixelRatio || 1,
      camera: { x: 0, y: 0, zoom: 1 },
      visibleWorld: { x: 0, y: 0, w: 1000, h: 500 }
    })
    unmount()
  })

  it('C9: agent / ports / callsPorts / lastFocusedAt reach the payload — a launch line never does', () => {
    const secret = 'sk-live-SECRET-42'
    const t = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    useCanvasStore.getState().updateBoard(t, { launchCommand: `OPENAI_API_KEY=${secret} codex` })
    const b = useCanvasStore.getState().addBoard('browser', { x: 600, y: 0 })
    const { unmount } = renderHook(() => useMcpPublish())
    act(() => {
      useRoleSignalsStore.getState().setPorts(t, [3000])
      useRoleSignalsStore.getState().setCallsPorts(b, [3000, 5173])
      useRoleSignalsStore.getState().markFocused([b], 1234)
    })
    tick(150)
    const payload = publishBoards.mock.calls.at(-1)?.[0]
    const byId = Object.fromEntries(payload.boards.map((x: { id: string }) => [x.id, x])) as Record<
      string,
      Record<string, unknown>
    >
    expect(byId[t]).toMatchObject({ agent: true, ports: [3000] })
    expect(byId[b]).toMatchObject({ callsPorts: [3000, 5173], lastFocusedAt: 1234 })
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain(secret)
    expect(wire).not.toContain('OPENAI_API_KEY')
    expect(byId[t]).not.toHaveProperty('launchCommand')
    expect(byId[t]).not.toHaveProperty('agentKind')
    unmount()
  })

  it('C9: a role-signal change re-publishes through the same 150 ms debounce', () => {
    const t = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const { unmount } = renderHook(() => useMcpPublish())
    tick(150)
    const baseline = publishBoards.mock.calls.length
    act(() => useRoleSignalsStore.getState().setPorts(t, [5173]))
    expect(publishBoards.mock.calls.length).toBe(baseline)
    tick(150)
    expect(publishBoards.mock.calls.length).toBe(baseline + 1)
    expect(publishBoards.mock.calls.at(-1)?.[0].boards[0]).toMatchObject({ ports: [5173] })
    unmount()
  })

  it('C9: selecting a board stamps lastFocusedAt on the mirror (the feeds are wired by the hook)', () => {
    const t = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    useCanvasStore.getState().setSelection([]) // addBoard selects; start from an empty selection
    const { unmount } = renderHook(() => useMcpPublish())
    tick(150)
    expect(publishBoards.mock.calls.at(-1)?.[0].boards[0]).not.toHaveProperty('lastFocusedAt')
    act(() => useCanvasStore.getState().setSelection([t]))
    tick(150)
    const entry = publishBoards.mock.calls.at(-1)?.[0].boards[0]
    expect(typeof entry.lastFocusedAt).toBe('number')
    unmount()
  })
})
