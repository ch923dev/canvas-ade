/**
 * roleSignalsStore — the C9 ephemeral signal store (L11): set / clear / board-delete cleanup, the
 * existing-detect-path feed (`detectTerminalPorts`), the selection → `lastFocusedAt` feed, and the
 * D10 `preview:event` `origin-ports` → `callsPorts` feed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectTerminalPorts,
  ingestOriginPorts,
  installRoleSignalFeeds,
  loopbackPorts,
  normalizePorts,
  recordDetectedPorts,
  useRoleSignalsStore
} from './roleSignalsStore'
import { useCanvasStore } from './canvasStore'
import { useTerminalRuntimeStore } from './terminalRuntimeStore'

const sig = (): ReturnType<typeof useRoleSignalsStore.getState> => useRoleSignalsStore.getState()

beforeEach(() => {
  sig().reset()
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: []
  })
  useTerminalRuntimeStore.setState({ running: {} })
})

describe('normalizePorts / loopbackPorts', () => {
  it('keeps integers 1..65535, de-duplicated in order, at most 8', () => {
    expect(normalizePorts([3000, 3000, 0, 70000, 1.5, '80', NaN, 5173])).toEqual([3000, 5173])
    expect(normalizePorts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(normalizePorts('3000')).toEqual([])
    expect(normalizePorts(undefined)).toEqual([])
  })

  it('takes only the PORT of loopback hosts (no URL, no host kept)', () => {
    expect(
      loopbackPorts([
        { host: 'localhost', port: 5173 },
        { host: '127.0.0.1', port: 3000 },
        { host: '[::1]', port: 8080 },
        { host: '[fe80::1]', port: 9999 }
      ])
    ).toEqual([5173, 3000, 8080])
  })
})

describe('the store: set · clear · forget', () => {
  it('setPorts / setCallsPorts normalize and drop the entry on an empty list', () => {
    sig().setPorts('t1', [3000, 3000, 5173])
    sig().setCallsPorts('b1', [5173])
    expect(sig().ports).toEqual({ t1: [3000, 5173] })
    expect(sig().callsPorts).toEqual({ b1: [5173] })
    sig().setPorts('t1', [])
    sig().setCallsPorts('b1', 'garbage')
    expect(sig().ports).toEqual({})
    expect(sig().callsPorts).toEqual({})
  })

  it('an unchanged set is a no-op (no new state → no re-publish)', () => {
    sig().setPorts('t1', [3000])
    const before = useRoleSignalsStore.getState()
    sig().setPorts('t1', [3000])
    expect(useRoleSignalsStore.getState()).toBe(before)
  })

  it('markFocused stamps every id; clearPorts drops one terminal; forget drops every signal', () => {
    sig().setPorts('t1', [3000])
    sig().setCallsPorts('b1', [3000])
    sig().markFocused(['t1', 'b1'], 1000)
    expect(sig().lastFocusedAt).toEqual({ t1: 1000, b1: 1000 })
    sig().clearPorts('t1')
    expect(sig().ports).toEqual({})
    expect(sig().lastFocusedAt.t1).toBe(1000) // focus is not a port signal
    sig().forget(['t1', 'b1'])
    expect(sig()).toMatchObject({ ports: {}, callsPorts: {}, lastFocusedAt: {} })
  })
})

describe('the existing detect path feeds `ports`', () => {
  const detectPorts = vi.fn()

  beforeEach(() => {
    detectPorts.mockReset()
    ;(globalThis as unknown as { window: unknown }).window = { api: { detectPorts } }
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('detectTerminalPorts returns the URLs unchanged and records the loopback ports', async () => {
    const t = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const urls = [
      { url: 'http://localhost:5173', host: 'localhost', port: 5173 },
      { url: 'http://127.0.0.1:3000', host: '127.0.0.1', port: 3000 }
    ]
    detectPorts.mockResolvedValue(urls)
    await expect(detectTerminalPorts(t)).resolves.toBe(urls)
    expect(detectPorts).toHaveBeenCalledWith(t)
    expect(sig().ports[t]).toEqual([5173, 3000])
  })

  it('a rejection propagates to the caller and records nothing', async () => {
    const t = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    detectPorts.mockRejectedValue(new Error('IPC closed'))
    await expect(detectTerminalPorts(t)).rejects.toThrow('IPC closed')
    expect(sig().ports).toEqual({})
  })

  it('a late result for a board that left the canvas (or is not a terminal) is dropped', () => {
    const b = useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 })
    recordDetectedPorts('gone', [{ host: 'localhost', port: 3000 }])
    recordDetectedPorts(b, [{ host: 'localhost', port: 3000 }])
    expect(sig().ports).toEqual({})
  })
})

describe('installRoleSignalFeeds', () => {
  let off: () => void = () => {}
  afterEach(() => off())

  it('selection → lastFocusedAt for every NEWLY selected board', () => {
    let clock = 100
    off = installRoleSignalFeeds(() => clock)
    const a = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const b = useCanvasStore.getState().addBoard('browser', { x: 500, y: 0 })
    useCanvasStore.getState().setSelection([a])
    expect(sig().lastFocusedAt[a]).toBe(100)
    clock = 200
    useCanvasStore.getState().setSelection([a, b]) // only b is new
    expect(sig().lastFocusedAt).toMatchObject({ [a]: 100, [b]: 200 })
  })

  it('board delete → every signal for it is dropped', () => {
    off = installRoleSignalFeeds(() => 1)
    const t = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const keep = useCanvasStore.getState().addBoard('browser', { x: 500, y: 0 })
    sig().setPorts(t, [3000])
    sig().setCallsPorts(keep, [3000])
    sig().markFocused([t, keep], 5)
    useCanvasStore.getState().removeBoard(t)
    expect(sig().ports).toEqual({})
    expect(sig().lastFocusedAt).toEqual({ [keep]: 5 })
    expect(sig().callsPorts).toEqual({ [keep]: [3000] })
  })

  it('a terminal that stops running loses its ports; one still running keeps them', () => {
    off = installRoleSignalFeeds()
    useTerminalRuntimeStore.getState().setRunning('t1', 'running')
    useTerminalRuntimeStore.getState().setRunning('t2', 'running')
    sig().setPorts('t1', [3000])
    sig().setPorts('t2', [5173])
    useTerminalRuntimeStore.getState().setRunning('t1', 'exited')
    expect(sig().ports).toEqual({ t2: [5173] })
    useTerminalRuntimeStore.getState().clear('t2') // unmount
    expect(sig().ports).toEqual({})
  })

  it('the returned function unsubscribes every feed', () => {
    installRoleSignalFeeds(() => 7)()
    const a = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    useCanvasStore.getState().setSelection([a])
    expect(sig().lastFocusedAt).toEqual({})
  })
})

describe('D10 → callsPorts (preview:event origin-ports)', () => {
  type PreviewListener = (ev: { id: string; type: string; ports?: number[] }) => void
  const detectPorts = vi.fn()
  let previewListener: PreviewListener | null = null
  const unsubscribe = vi.fn()
  let off: () => void = () => {}

  beforeEach(() => {
    detectPorts.mockReset().mockResolvedValue([])
    unsubscribe.mockReset()
    previewListener = null
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        detectPorts,
        onPreviewEvent: (fn: PreviewListener) => {
          previewListener = fn
          return unsubscribe
        }
      }
    }
  })
  afterEach(() => {
    off()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('an origin-ports event lands as the browser board callsPorts; other kinds are ignored', () => {
    off = installRoleSignalFeeds()
    const b = useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 })
    previewListener?.({ id: b, type: 'did-finish-load' })
    expect(sig().callsPorts).toEqual({})
    previewListener?.({ id: b, type: 'origin-ports', ports: [3000, 5173] })
    expect(sig().callsPorts).toEqual({ [b]: [3000, 5173] })
    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('a NEW called port re-reads the running, undocked terminals through the detect path', async () => {
    const b = useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 })
    const api = useCanvasStore.getState().addBoard('terminal', { x: 600, y: 0 })
    const idle = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 600 })
    useTerminalRuntimeStore.getState().setRunning(api, 'running')
    detectPorts.mockResolvedValue([{ url: 'http://localhost:3000', host: 'localhost', port: 3000 }])
    ingestOriginPorts(b, [3000])
    expect(detectPorts).toHaveBeenCalledTimes(1)
    expect(detectPorts).toHaveBeenCalledWith(api) // not the idle terminal
    expect(detectPorts).not.toHaveBeenCalledWith(idle)
    await vi.waitFor(() => expect(sig().ports[api]).toEqual([3000]))
    // The same set again (or a shrink) triggers no re-read.
    ingestOriginPorts(b, [3000])
    ingestOriginPorts(b, [])
    expect(detectPorts).toHaveBeenCalledTimes(1)
  })

  it('an event for an id that is not a live Browser board is dropped', () => {
    const t = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    ingestOriginPorts('gone', [3000])
    ingestOriginPorts(t, [3000])
    expect(sig().callsPorts).toEqual({})
  })
})
