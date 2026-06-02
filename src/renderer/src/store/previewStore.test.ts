import { beforeEach, describe, expect, test } from 'vitest'
import { usePreviewStore, DEFAULT_RUNTIME } from './previewStore'

describe('previewStore.requestReload', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      byId: {},
      nodeGesture: false,
      openMenus: new Set(),
      menuOpen: false
    })
  })

  test('bumps reloadNonce so a same-URL push forces a re-navigate', () => {
    // A board that already loaded the dev URL (and failed: server was down).
    usePreviewStore.getState().patch('b1', { status: 'load-failed' })
    const before = usePreviewStore.getState().byId.b1.reloadNonce

    // Pushing the SAME url must still signal a reload — the bug was that an
    // unchanged url diff-skipped the navigate in reconcile, stranding the error page.
    usePreviewStore.getState().requestReload('b1')

    const after = usePreviewStore.getState().byId.b1.reloadNonce
    expect(after).toBe(before + 1)
    // Other runtime fields are preserved.
    expect(usePreviewStore.getState().byId.b1.status).toBe('load-failed')
  })

  test('creates an entry (idle default) if the board has no runtime yet', () => {
    usePreviewStore.getState().requestReload('fresh')
    const rt = usePreviewStore.getState().byId.fresh
    expect(rt).toBeDefined()
    expect(rt.reloadNonce).toBe(DEFAULT_RUNTIME.reloadNonce + 1)
    expect(rt.status).toBe('idle')
  })

  test('each call increments monotonically', () => {
    const s = usePreviewStore.getState()
    s.requestReload('b1')
    s.requestReload('b1')
    s.requestReload('b1')
    expect(usePreviewStore.getState().byId.b1.reloadNonce).toBe(3)
  })

  test('DEFAULT_RUNTIME starts at nonce 0', () => {
    expect(DEFAULT_RUNTIME.reloadNonce).toBe(0)
  })
})

describe('previewStore.patchIfPresent', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      byId: {},
      nodeGesture: false,
      openMenus: new Set(),
      menuOpen: false
    })
  })

  test('does NOT create an entry for an absent id (Bug #32 guard)', () => {
    // A main-driven lifecycle event (did-navigate / did-fail-load) that arrives after
    // the board was deleted must not resurrect a cleared orphan entry.
    usePreviewStore.getState().patchIfPresent('ghost', { status: 'connected' })
    expect(usePreviewStore.getState().byId.ghost).toBeUndefined()
    expect(usePreviewStore.getState().byId).toEqual({})
  })

  test('patches an existing entry, preserving other fields', () => {
    usePreviewStore.getState().patch('b1', { status: 'connecting' })
    usePreviewStore.getState().patchIfPresent('b1', { liveUrl: 'http://localhost:3000' })
    const rt = usePreviewStore.getState().byId.b1
    expect(rt.liveUrl).toBe('http://localhost:3000')
    expect(rt.status).toBe('connecting')
  })

  test('returns the same state object when the id is absent (no-op set)', () => {
    const before = usePreviewStore.getState().byId
    usePreviewStore.getState().patchIfPresent('ghost', { status: 'connected' })
    expect(usePreviewStore.getState().byId).toBe(before)
  })
})

describe('previewStore.clear', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      byId: {},
      nodeGesture: false,
      openMenus: new Set(),
      menuOpen: false
    })
  })

  test('removes an existing entry', () => {
    usePreviewStore.getState().patch('b1', { status: 'connected' })
    expect(usePreviewStore.getState().byId.b1).toBeDefined()
    usePreviewStore.getState().clear('b1')
    expect(usePreviewStore.getState().byId.b1).toBeUndefined()
  })

  test('leaves sibling entries intact', () => {
    usePreviewStore.getState().patch('b1', { status: 'connected' })
    usePreviewStore.getState().patch('b2', { status: 'connecting' })
    usePreviewStore.getState().clear('b1')
    expect(usePreviewStore.getState().byId.b1).toBeUndefined()
    expect(usePreviewStore.getState().byId.b2?.status).toBe('connecting')
  })

  test('is a no-op for an absent id (returns same state object)', () => {
    const before = usePreviewStore.getState().byId
    usePreviewStore.getState().clear('ghost')
    expect(usePreviewStore.getState().byId).toBe(before)
  })
})

describe('previewStore.setNodeGesture / setMenuOpen', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      byId: {},
      nodeGesture: false,
      openMenus: new Set(),
      menuOpen: false
    })
  })

  test('setNodeGesture toggles the flag', () => {
    usePreviewStore.getState().setNodeGesture(true)
    expect(usePreviewStore.getState().nodeGesture).toBe(true)
    usePreviewStore.getState().setNodeGesture(false)
    expect(usePreviewStore.getState().nodeGesture).toBe(false)
  })

  test('setNodeGesture is a no-op (same state) when unchanged', () => {
    const before = usePreviewStore.getState()
    usePreviewStore.getState().setNodeGesture(false)
    expect(usePreviewStore.getState()).toBe(before)
  })

  test('setMenuOpen toggles the flag', () => {
    usePreviewStore.getState().setMenuOpen('a', true)
    expect(usePreviewStore.getState().menuOpen).toBe(true)
    usePreviewStore.getState().setMenuOpen('a', false)
    expect(usePreviewStore.getState().menuOpen).toBe(false)
  })

  test('setMenuOpen is a no-op (same state) when unchanged', () => {
    const before = usePreviewStore.getState()
    usePreviewStore.getState().setMenuOpen('a', false)
    expect(usePreviewStore.getState()).toBe(before)
  })

  test('PREV-C: stays open while ANY menu token is open', () => {
    const { setMenuOpen } = usePreviewStore.getState()
    setMenuOpen('a', true)
    setMenuOpen('b', true)
    expect(usePreviewStore.getState().menuOpen).toBe(true)
    setMenuOpen('a', false) // first to close
    expect(usePreviewStore.getState().menuOpen).toBe(true) // b still open
    setMenuOpen('b', false)
    expect(usePreviewStore.getState().menuOpen).toBe(false)
  })

  test('PREV-C: idempotent on repeat open/close of the same token', () => {
    const { setMenuOpen } = usePreviewStore.getState()
    setMenuOpen('a', true)
    const afterOpen = usePreviewStore.getState()
    setMenuOpen('a', true) // redundant open → no new state
    expect(usePreviewStore.getState()).toBe(afterOpen)
    setMenuOpen('a', false)
    expect(usePreviewStore.getState().menuOpen).toBe(false)
  })
})
