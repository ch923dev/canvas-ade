import { beforeEach, describe, expect, test } from 'vitest'
import { usePreviewStore, DEFAULT_RUNTIME } from './previewStore'

describe('previewStore.requestReload', () => {
  beforeEach(() => {
    usePreviewStore.setState({ byId: {}, nodeGesture: false, menuOpen: false })
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
