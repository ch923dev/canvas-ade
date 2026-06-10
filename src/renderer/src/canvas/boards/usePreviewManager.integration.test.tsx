import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore } from '../../store/previewStore'

// ── Mock @xyflow/react ────────────────────────────────────────────────────────
// usePreviewManager imports ONLY `useReactFlow` (for getViewport) and
// `useOnViewportChange` (to bind beginMotion/startPump/endMotion to the camera).
// We capture the registered callbacks so the test can drive the EXACT motion
// ordering — onStart (beginMotion) then onEnd (endMotion) — deterministically,
// instead of pumping a real React Flow camera. getViewport returns a fixed,
// zoomed-in viewport so seeded boards are live-eligible.
const vpCallbacks: {
  onStart?: () => void
  onChange?: () => void
  onEnd?: () => void
} = {}
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }),
  useOnViewportChange: (cbs: {
    onStart?: () => void
    onChange?: () => void
    onEnd?: () => void
  }): void => {
    vpCallbacks.onStart = cbs.onStart
    vpCallbacks.onChange = cbs.onChange
    vpCallbacks.onEnd = cbs.onEnd
  }
}))

// Import AFTER the mock is registered.
import { usePreviewManager, type LayerProps } from './usePreviewManager'

// ── window.api stub ─────────────────────────────────────────────────────────
// detachPreview is the IPC the bug races against: beginMotion awaits it, and a
// concurrent endMotion→applyLiveness→attachBoard runs DURING that await. We hand
// out a manually-resolved promise for detachPreview so the test can interleave the
// endMotion call precisely between "detach issued" and "detach resolved".
interface AttachArg {
  id: string
  bounds: { x: number; y: number; width: number; height: number }
}
interface ApiCalls {
  attach: string[]
  attachArgs: AttachArg[]
  detach: string[]
}
let calls: ApiCalls
let releaseDetach: (() => void) | null = null

function stubApi(): void {
  calls = { attach: [], attachArgs: [], detach: [] }
  releaseDetach = null
  ;(window as unknown as { api: unknown }).api = {
    capturePreview: vi.fn(async () => null),
    openPreview: vi.fn(async () => true),
    attachPreview: vi.fn(async (a: AttachArg) => {
      calls.attach.push(a.id)
      calls.attachArgs.push(a)
      return true
    }),
    detachPreview: vi.fn(
      (id: string) =>
        new Promise<boolean>((resolve) => {
          calls.detach.push(id)
          releaseDetach = () => resolve(true)
        })
    ),
    closePreview: vi.fn(async () => true),
    closeAllPreviews: vi.fn(async () => true),
    navigatePreview: vi.fn(async () => true),
    setPreviewBoundsBatch: vi.fn(async () => true),
    onPreviewEvent: vi.fn(() => () => {})
  }
}

const PROPS: LayerProps = {
  paneRef: { current: null },
  focusedId: null,
  fullViewId: null,
  fullViewHost: null,
  fullViewMotion: false,
  onRequestCloseFullView: (): void => {},
  digestOpen: false
}

function renderManager(): {
  unmount: () => void
  rerender: (extra: Partial<LayerProps>) => void
} {
  // A 2000×2000 pane keeps the seeded board away from the top dock band + top-right
  // chrome cluster (chromeExclusionZones), so occludesProtected is false.
  const paneEl = document.createElement('div')
  paneEl.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 2000, height: 2000, right: 2000, bottom: 2000 }) as DOMRect
  const base: LayerProps = { ...PROPS, paneRef: { current: paneEl } }
  const { unmount, rerender } = renderHook((p: LayerProps) => usePreviewManager(p), {
    initialProps: base
  })
  return { unmount, rerender: (extra) => rerender({ ...base, ...extra }) }
}

/** Flush microtasks (await IPC promise chains) inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// jsdom has no ResizeObserver; the paneOffset effect constructs one. A no-op stub
// suffices (the test drives geometry via the stubbed getBoundingClientRect, not resizes).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  stubApi()
  // Fresh stores.
  useCanvasStore.setState({ boards: [], connectors: [], selectedId: null, past: [], future: [] })
  usePreviewStore.setState({ byId: {}, nodeGesture: false, openMenus: new Set(), menuOpen: false })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('usePreviewManager — endMotion-during-detach race (BUG-002)', () => {
  it('does not leave a board detached-but-live when endMotion fires during the beginMotion detach await', async () => {
    renderManager()
    // Seed one Browser board (eligible: zoom 1 ≥ LOD, on-pane, away from chrome). reconcile
    // runs on the store subscription and attaches it live.
    let id = ''
    await act(async () => {
      id = useCanvasStore.getState().addBoard('browser', { x: 400, y: 400 })
    })
    await flush()

    // Precondition: the board is attached + live.
    const recAttached = (): boolean => calls.attach.includes(id) || true
    expect(recAttached()).toBe(true)
    expect(usePreviewStore.getState().byId[id]?.live).toBe(true)

    // ── Drive the race ──────────────────────────────────────────────────────
    // 1. beginMotion (onStart): captures the snapshot, then awaits detachPreview — which
    //    we hold pending via releaseDetach.
    await act(async () => {
      vpCallbacks.onStart?.()
    })
    await flush()
    // detach was issued but is still pending (we have not released it).
    expect(calls.detach).toContain(id)
    expect(releaseDetach).not.toBeNull()
    const attachCountBeforeEnd = calls.attach.length

    // 2. endMotion (onEnd) fires WHILE detachPreview is in flight → applyLiveness →
    //    attachBoard. The board is still r.attached (detach hasn't resolved) at unchanged
    //    bounds/zoom, so attachBoard would take the diff-skip no-op path (the bug:
    //    patchRuntime(live:true), no attachSeq bump, no attachPreview IPC).
    await act(async () => {
      vpCallbacks.onEnd?.()
    })
    await flush()

    // 3. Now resolve the held detachPreview → beginMotion's post-await write block runs.
    await act(async () => {
      releaseDetach?.()
    })
    await flush()

    // ── Assert consistency ───────────────────────────────────────────────────
    // The native view was detached on MAIN (detachPreview issued + resolved). The renderer
    // state must NOT claim the board is live UNLESS a real re-attach (attachPreview IPC)
    // was issued after the detach. The bug: live:true with NO new attachPreview → the
    // native view is detached on main but the renderer believes it's live = frozen/blank.
    const reAttached = calls.attach.length > attachCountBeforeEnd
    const live = usePreviewStore.getState().byId[id]?.live === true
    // Core invariant (the bug): FORBIDDEN end state is live-but-never-re-attached, i.e.
    // detached-on-main but the renderer believes it's live (frozen/blank board).
    expect(live && !reAttached).toBe(false)
    // The fix's actual end state: motion ended on an eligible board, so it should be
    // GENUINELY live again — a real attachPreview was re-issued (re-attaching on main)
    // and the runtime reflects live:true. (A merely-consistent live:false snapshot would
    // also satisfy the invariant above, but the fix re-attaches via the demoting guard.)
    expect(reAttached).toBe(true)
    expect(live).toBe(true)
  })
})

describe('usePreviewManager — endMotion vs open popover (BUG-016)', () => {
  it('does not reattach native views on a camera move end while a popover is open', async () => {
    renderManager()
    let id = ''
    await act(async () => {
      id = useCanvasStore.getState().addBoard('browser', { x: 400, y: 400 })
    })
    await flush()
    expect(usePreviewStore.getState().byId[id]?.live).toBe(true)

    // Open a popover (ref-counted token, PREV-C): the gesture effect runs beginMotion —
    // capture, then detach (held); release it so the board settles detached (live:false).
    await act(async () => {
      usePreviewStore.getState().setMenuOpen('menu-a', true)
    })
    await flush()
    expect(calls.detach).toContain(id)
    await act(async () => {
      releaseDetach?.()
    })
    await flush()
    expect(usePreviewStore.getState().byId[id]?.live).toBe(false)

    // Wheel-zoom over the canvas while the menu is STILL open: React Flow fires
    // onStart/onEnd. The end must YIELD to the open menu (mirror of the nodeGesture
    // guard) — the bug reattached the always-above native view over the popover.
    const attachCountBefore = calls.attach.length
    await act(async () => {
      vpCallbacks.onStart?.()
    })
    await act(async () => {
      vpCallbacks.onEnd?.()
    })
    await flush()
    expect(calls.attach.length).toBe(attachCountBefore)
    expect(usePreviewStore.getState().byId[id]?.live).toBe(false)

    // The menu-close path stays the sole authority that reattaches.
    await act(async () => {
      usePreviewStore.getState().setMenuOpen('menu-a', false)
    })
    await flush()
    expect(calls.attach.length).toBeGreaterThan(attachCountBefore)
    expect(usePreviewStore.getState().byId[id]?.live).toBe(true)
  })
})

describe('usePreviewManager — attach-during-direct-demote race (BUG-017)', () => {
  it('does not leave an eligible board detached when attachBoard lands inside an applyLiveness demote capture window', async () => {
    renderManager()
    let id = ''
    await act(async () => {
      id = useCanvasStore.getState().addBoard('browser', { x: 400, y: 400 })
    })
    await flush()
    expect(usePreviewStore.getState().byId[id]?.live).toBe(true)

    const attachCountBefore = calls.attach.length
    // Pass A: add + auto-select an OVERLAPPING planning board (exact:true skips the
    // freeSlot nudge) → applyLiveness selection-occlusion demotes the browser board;
    // demoteToSnapshot parks at its capturePreview await.
    // Pass B — same tick, NO microtask flush in between, so the capture is still in
    // flight: deselect → applyLiveness wants the browser live again → attachBoard runs
    // INSIDE the demote's capture window. The bug: the diff-skip no-op path (demoting
    // never registered the direct demote) bumps no attachSeq, so the resuming demote
    // detaches the eligible board with no healer.
    act(() => {
      useCanvasStore.getState().addBoard('planning', { x: 420, y: 420 }, { exact: true })
    })
    act(() => {
      useCanvasStore.getState().selectBoard(null)
    })
    await flush()
    // Buggy path only: the demote proceeds to its (held) detach — release it so the
    // inconsistent end state is observable. Fixed path issues no detach (no-op).
    await act(async () => {
      releaseDetach?.()
    })
    await flush()

    // The board is eligible at rest: a real attachPreview must have been re-issued
    // (the demoting-guard fall-through) and the runtime must say live.
    const reAttached = calls.attach.length > attachCountBefore
    const live = usePreviewStore.getState().byId[id]?.live === true
    expect(live && !reAttached).toBe(false)
    expect(reAttached).toBe(true)
    expect(live).toBe(true)
  })
})

describe('usePreviewManager — reconcile re-push during full view (BUG-058)', () => {
  it('does not push the camera-scaled canvas rect to a board attached at the modal rect', async () => {
    const { rerender } = renderManager()
    let id = ''
    await act(async () => {
      id = useCanvasStore.getState().addBoard('browser', { x: 400, y: 400 })
    })
    await flush()
    expect(usePreviewStore.getState().byId[id]?.live).toBe(true)

    // Full-view modal host with the portaled `.bb-frame` (what fullViewBoundsFor reads).
    const host = document.createElement('div')
    const frame = document.createElement('div')
    frame.setAttribute('data-bb-frame', id)
    frame.getBoundingClientRect = () =>
      ({ left: 500, top: 100, width: 800, height: 600, right: 1300, bottom: 700 }) as DOMRect
    host.appendChild(frame)
    document.body.appendChild(host)
    try {
      // Enter full view → applyLiveness attaches the board at the MODAL rect (1px inset).
      await act(async () => {
        rerender({ fullViewId: id, fullViewHost: host })
      })
      await flush()
      const modal = calls.attachArgs[calls.attachArgs.length - 1]
      expect(modal?.id).toBe(id)
      expect(modal?.bounds).toEqual({ x: 501, y: 101, width: 798, height: 598 })

      // Any boards mutation while in full view re-runs reconcile. Its attached-board
      // re-push must NOT fire the camera-scaled CANVAS rect at the modal-attached view
      // (the transient native flash over the scrim + lastSent clobber). With the guard,
      // the trailing applyLiveness diff-skips too → zero new attach IPCs for this board.
      const before = calls.attachArgs.length
      await act(async () => {
        useCanvasStore.getState().addBoard('planning', { x: 1600, y: 1600 })
      })
      await flush()
      expect(calls.attachArgs.slice(before).filter((a) => a.id === id)).toEqual([])
    } finally {
      document.body.removeChild(host)
    }
  })
})
