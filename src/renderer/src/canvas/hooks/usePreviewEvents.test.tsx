import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { usePreviewStore, type PreviewRuntime } from '../../store/previewStore'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewEvents } from './usePreviewEvents'
import type { BoardRec } from '../boards/usePreviewManager'

type PatchFn = (id: string, patch: Partial<PreviewRuntime>) => void

// The preload PreviewEvent union (mirrors main). `escape` is NOT a declared variant — the
// handler reaches it via a widened-string compare — so the test emits it through a loose type.
type PreviewEvent =
  | { id: string; type: 'did-finish-load'; url: string }
  | {
      id: string
      type: 'did-navigate'
      url: string
      canGoBack: boolean
      canGoForward: boolean
      // BUG-004: set by an in-page route that committed after a prior failure.
      recovered?: boolean
    }
  | { id: string; type: 'did-fail-load'; url: string; errorCode: number; errorDescription: string }
  | { id: string; type: 'did-start-navigation' }
  | { id: string; type: 'escape' }
  | { id: string; type: 'render-process-gone'; reason: string }

// ── window.api.onPreviewEvent stub ────────────────────────────────────────────
// Capture the listener the hook registers so the test can invoke it with synthetic
// events, and hand back a spyable unsubscribe so cleanup can be asserted.
let listener: ((ev: PreviewEvent) => void) | null = null
const unsubscribe = vi.fn()

function stubApi(): void {
  listener = null
  unsubscribe.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    onPreviewEvent: vi.fn((cb: (ev: PreviewEvent) => void) => {
      listener = cb
      return unsubscribe
    })
  }
}

/** Emit a synthetic preview event through the captured listener. */
function emit(ev: PreviewEvent): void {
  if (!listener) throw new Error('listener not registered')
  listener(ev)
}

/** A BoardRec-shaped row; only `.exists` matters to the handler, the rest are defaults. */
function makeRec(exists: boolean): BoardRec {
  return {
    exists,
    attached: false,
    lastSent: null,
    lastZoom: 0,
    lastUrl: null,
    lastReloadNonce: 0,
    attachSeq: 0
  }
}

// Per-test refs + spies, rebuilt in beforeEach.
let recs: { current: Map<string, BoardRec> }
let fullViewIdRef: { current: string | null }
let onCloseFullViewRef: { current: ReturnType<typeof vi.fn<() => void>> }
let patchRuntime: ReturnType<typeof vi.fn<PatchFn>>
let patchRuntimeIfPresent: ReturnType<typeof vi.fn<PatchFn>>

function renderEvents(): { unmount: () => void } {
  const { unmount } = renderHook(() =>
    usePreviewEvents({
      recs,
      fullViewIdRef,
      onCloseFullViewRef,
      patchRuntime,
      patchRuntimeIfPresent
    })
  )
  return { unmount }
}

/** Seed one board's runtime status in the real store (status gating reads getState). */
function seedStatus(
  id: string,
  status: 'idle' | 'connecting' | 'connected' | 'load-failed' | 'crashed'
): void {
  usePreviewStore.getState().patch(id, { status })
}

beforeEach(() => {
  stubApi()
  usePreviewStore.setState({ byId: {}, nodeGesture: false, openMenus: new Set(), menuOpen: false })
  useCanvasStore.setState({ boards: [], selectedId: null, selectedIds: [], past: [], future: [] })
  recs = { current: new Map() }
  fullViewIdRef = { current: 'board-fv' }
  onCloseFullViewRef = { current: vi.fn<() => void>() }
  patchRuntime = vi.fn<PatchFn>()
  patchRuntimeIfPresent = vi.fn<PatchFn>()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('usePreviewEvents', () => {
  it('subscribes to onPreviewEvent on mount', () => {
    renderEvents()
    expect(
      (window as unknown as { api: { onPreviewEvent: ReturnType<typeof vi.fn> } }).api
        .onPreviewEvent
    ).toHaveBeenCalledTimes(1)
    expect(listener).toBeTypeOf('function')
  })

  describe('escape', () => {
    it('closes full view when the event board IS the full-view board', () => {
      renderEvents()
      emit({ id: 'board-fv', type: 'escape' })
      expect(onCloseFullViewRef.current).toHaveBeenCalledTimes(1)
    })

    it('does NOT close full view for a different board', () => {
      renderEvents()
      emit({ id: 'other', type: 'escape' })
      expect(onCloseFullViewRef.current).not.toHaveBeenCalled()
    })

    // D4-B (audit A3): outside full view, Esc-in-preview is the focus-return gesture —
    // main hands OS focus back to the host window; this handler selects the board so
    // the keyboard context lands visibly where the user was.
    it('selects the board (focus-return) when the board is NOT the full-view one', () => {
      const id = useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 })
      useCanvasStore.getState().selectBoard(null)
      renderEvents()
      emit({ id, type: 'escape' })
      expect(onCloseFullViewRef.current).not.toHaveBeenCalled()
      expect(useCanvasStore.getState().selectedId).toBe(id)
    })

    it('focus-return is existence-gated: a deleted board is never resurrected into selection', () => {
      renderEvents()
      emit({ id: 'gone', type: 'escape' })
      expect(useCanvasStore.getState().selectedId).toBeNull()
    })

    it('the full-view board closes full view WITHOUT re-selecting via the focus-return branch', () => {
      const id = useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 })
      useCanvasStore.getState().selectBoard(null)
      fullViewIdRef.current = id
      renderEvents()
      emit({ id, type: 'escape' })
      expect(onCloseFullViewRef.current).toHaveBeenCalledTimes(1)
      expect(useCanvasStore.getState().selectedId).toBeNull()
    })
  })

  describe('did-start-navigation', () => {
    it('clears a load-failed latch → connecting for an existing live board', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'load-failed')
      renderEvents()
      emit({ id: 'b1', type: 'did-start-navigation' })
      expect(patchRuntime).toHaveBeenCalledWith('b1', { status: 'connecting', error: null })
    })

    it('does NOTHING when the rec exists but the status is not load-failed', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'connecting')
      renderEvents()
      emit({ id: 'b1', type: 'did-start-navigation' })
      expect(patchRuntime).not.toHaveBeenCalled()
    })

    it('does NOTHING when the rec exists:false (renderer freed)', () => {
      recs.current.set('b1', makeRec(false))
      seedStatus('b1', 'load-failed')
      renderEvents()
      emit({ id: 'b1', type: 'did-start-navigation' })
      expect(patchRuntime).not.toHaveBeenCalled()
    })

    it('does NOTHING when there is no rec at all', () => {
      seedStatus('b1', 'load-failed')
      renderEvents()
      emit({ id: 'b1', type: 'did-start-navigation' })
      expect(patchRuntime).not.toHaveBeenCalled()
    })
  })

  describe('did-finish-load', () => {
    it('promotes connecting → connected for an existing live board', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'connecting')
      renderEvents()
      emit({ id: 'b1', type: 'did-finish-load', url: 'http://localhost:3000/' })
      expect(patchRuntime).toHaveBeenCalledWith('b1', {
        status: 'connected',
        liveUrl: 'http://localhost:3000/',
        error: null
      })
    })

    it('does NOT promote when the status is load-failed (latch respected)', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'load-failed')
      renderEvents()
      emit({ id: 'b1', type: 'did-finish-load', url: 'http://localhost:3000/' })
      expect(patchRuntime).not.toHaveBeenCalled()
    })

    it('does NOTHING when the rec exists:false (renderer freed)', () => {
      recs.current.set('b1', makeRec(false))
      seedStatus('b1', 'connecting')
      renderEvents()
      emit({ id: 'b1', type: 'did-finish-load', url: 'http://localhost:3000/' })
      expect(patchRuntime).not.toHaveBeenCalled()
    })

    it('does NOTHING when there is no live rec (deleted / evicted)', () => {
      seedStatus('b1', 'connecting')
      renderEvents()
      emit({ id: 'b1', type: 'did-finish-load', url: 'http://localhost:3000/' })
      expect(patchRuntime).not.toHaveBeenCalled()
    })
  })

  describe('did-navigate', () => {
    it('patches liveUrl + back/forward via patchIfPresent (not patch)', () => {
      renderEvents()
      emit({
        id: 'b1',
        type: 'did-navigate',
        url: 'http://localhost:3000/about',
        canGoBack: true,
        canGoForward: false
      })
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        liveUrl: 'http://localhost:3000/about',
        canGoBack: true,
        canGoForward: false
      })
      expect(patchRuntime).not.toHaveBeenCalled()
    })
  })

  describe('did-fail-load', () => {
    it('latches load-failed + error via patchIfPresent (not patch)', () => {
      renderEvents()
      emit({
        id: 'b1',
        type: 'did-fail-load',
        url: 'http://localhost:3000/',
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED'
      })
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        status: 'load-failed',
        error: 'ERR_CONNECTION_REFUSED'
      })
      expect(patchRuntime).not.toHaveBeenCalled()
    })
  })

  // BUG-004: a >= 400 document (did-navigate(404) then did-fail-load) latches the board on
  // `load-failed`; a client-side route to a working in-app view fires only
  // did-navigate-in-page, which used to re-emit did-navigate WITHOUT lifting the latch, so
  // the board stayed stuck on `load-failed` (live content hidden behind the error overlay)
  // until a full main-frame reload. Main now flags the recovery did-navigate `recovered`,
  // and this handler must lift load-failed back to `connected`.
  describe('did-navigate recovery (BUG-004 in-page route after a failure)', () => {
    it('lifts load-failed back to connected on a recovered did-navigate', () => {
      recs.current.set('b1', makeRec(true))
      renderEvents()
      // The 4xx document: main emits a terminal did-fail-load → board is load-failed.
      emit({
        id: 'b1',
        type: 'did-fail-load',
        url: 'http://localhost:3000/missing',
        errorCode: 404,
        errorDescription: 'HTTP 404'
      })
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        status: 'load-failed',
        error: 'HTTP 404'
      })
      // Reflect that resolved status in the store the recovery gate reads (the live app's
      // patchRuntimeIfPresent does this; the spy here does not mutate the store).
      seedStatus('b1', 'load-failed')
      patchRuntimeIfPresent.mockClear()
      // The client-side route to a working view: an in-page nav main flags `recovered`.
      emit({
        id: 'b1',
        type: 'did-navigate',
        url: 'http://localhost:3000/dashboard',
        canGoBack: true,
        canGoForward: false,
        recovered: true
      })
      // The board recovers: status moves out of load-failed back to connected.
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        status: 'connected',
        liveUrl: 'http://localhost:3000/dashboard',
        canGoBack: true,
        canGoForward: false,
        error: null
      })
      expect(patchRuntime).not.toHaveBeenCalled()
    })

    it('also recovers a crashed board on a recovered did-navigate', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'crashed')
      renderEvents()
      emit({
        id: 'b1',
        type: 'did-navigate',
        url: 'http://localhost:3000/dashboard',
        canGoBack: false,
        canGoForward: false,
        recovered: true
      })
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        status: 'connected',
        liveUrl: 'http://localhost:3000/dashboard',
        canGoBack: false,
        canGoForward: false,
        error: null
      })
    })

    it('does NOT promote an evicted board (no live rec) even on a recovered did-navigate', () => {
      // Bug #18 discipline: a recovered flag must not flip a board with no live native view
      // to a green connected over a dead/detached snapshot.
      recs.current.set('b1', makeRec(false))
      seedStatus('b1', 'load-failed')
      renderEvents()
      emit({
        id: 'b1',
        type: 'did-navigate',
        url: 'http://localhost:3000/dashboard',
        canGoBack: false,
        canGoForward: false,
        recovered: true
      })
      // Only the usual present-only liveUrl/back-forward patch fires — status stays.
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        liveUrl: 'http://localhost:3000/dashboard',
        canGoBack: false,
        canGoForward: false
      })
      expect(patchRuntimeIfPresent).not.toHaveBeenCalledWith(
        'b1',
        expect.objectContaining({ status: 'connected' })
      )
    })

    it('a recovered did-navigate does NOT touch status when the board is not failed/crashed', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'connected')
      renderEvents()
      emit({
        id: 'b1',
        type: 'did-navigate',
        url: 'http://localhost:3000/dashboard',
        canGoBack: true,
        canGoForward: false,
        recovered: true
      })
      // No status change — only the usual liveUrl + back/forward patch.
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        liveUrl: 'http://localhost:3000/dashboard',
        canGoBack: true,
        canGoForward: false
      })
    })

    it('a plain (non-recovered) did-navigate never lifts a load-failed latch', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'load-failed')
      renderEvents()
      emit({
        id: 'b1',
        type: 'did-navigate',
        url: 'http://localhost:3000/still-broken',
        canGoBack: false,
        canGoForward: false
      })
      // Only the present-only liveUrl/back-forward patch fires — status stays load-failed.
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        liveUrl: 'http://localhost:3000/still-broken',
        canGoBack: false,
        canGoForward: false
      })
      expect(patchRuntimeIfPresent).not.toHaveBeenCalledWith(
        'b1',
        expect.objectContaining({ status: 'connected' })
      )
    })
  })

  // D2-C: a dead preview renderer must surface as a `crashed` state (not a silent
  // freeze), and the Reload CTA's nav-start must clear it back to `connecting`.
  describe('render-process-gone (D2-C crashed state)', () => {
    it('flags the board crashed (with the reason) via patchIfPresent (not patch)', () => {
      renderEvents()
      emit({ id: 'b1', type: 'render-process-gone', reason: 'oom' })
      expect(patchRuntimeIfPresent).toHaveBeenCalledWith('b1', {
        status: 'crashed',
        error: 'oom'
      })
      expect(patchRuntime).not.toHaveBeenCalled()
    })
  })

  describe('did-start-navigation after a crash', () => {
    it('clears a crashed latch → connecting for an existing live board (Reload CTA path)', () => {
      recs.current.set('b1', makeRec(true))
      seedStatus('b1', 'crashed')
      renderEvents()
      emit({ id: 'b1', type: 'did-start-navigation' })
      expect(patchRuntime).toHaveBeenCalledWith('b1', { status: 'connecting', error: null })
    })
  })

  describe('cleanup', () => {
    it('calls the unsubscribe returned by onPreviewEvent on unmount', () => {
      const { unmount } = renderEvents()
      expect(unsubscribe).not.toHaveBeenCalled()
      unmount()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })
  })
})
