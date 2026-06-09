/**
 * #BUG-021 — applyPush re-pointing an EXISTING browser must be UNDOABLE (checkpoint the
 * pre-push state) and must NOT silently destroy an armed redo branch.
 *
 * #BUG-012 — keyboard-delete of a board reaches removal through `onNodesChange`, NOT
 * `boardActions.remove`; that path must still tear down any full-view mode pointing at the
 * deleted board FIRST (mirroring the boardActions guards) so `fullViewId`/`cameraFullViewId`
 * never transiently dangle at a board that no longer exists.
 *
 * `applyPush` (driven against the REAL store, so undo/redo is exercised end-to-end) and the
 * pure `planNodeRemovalCleanup` were extracted from inline closures in Canvas.tsx into exported
 * functions in `lib/canvasDecisions.ts` (the Canvas.tsx closures now drive them). Following the
 * BUG-004 / Wave-4 pattern, a regression in the source breaks these tests even though the
 * component never mounts (React Flow + electron preload cannot mount in jsdom).
 *
 * globals: false — import all vitest helpers explicitly (see vitest.config.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { applyPush, planNodeRemovalCleanup, type ApplyPushDeps } from '../lib/canvasDecisions'
import { useCanvasStore } from '../store/canvasStore'
import type { Board, BrowserBoard } from '../lib/boardSchema'

const get = (): ReturnType<typeof useCanvasStore.getState> => useCanvasStore.getState()

beforeEach(() => {
  // Reset the singleton's data between tests (mirrors canvasStore.test.ts).
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    selectedId: null,
    tool: 'select',
    past: [],
    future: []
  })
})

/** A deps object whose `clearFocus`/`hardCloseFullView` are no-ops (we only assert store state). */
function noopDeps(): ApplyPushDeps {
  return { store: get(), clearFocus: () => {}, hardCloseFullView: () => {} }
}

describe('#BUG-021 — applyPush to an existing browser is undoable', () => {
  it('checkpoints the pre-push url so undo restores it', () => {
    const termId = get().addBoard('terminal', { x: 0, y: 0 })
    const browserId = get().addBoard('browser', { x: 500, y: 0 })
    get().updateBoard(browserId, { url: 'http://localhost:3000' })
    // Clear any history accrued by setup so we assert ONLY the push step.
    useCanvasStore.setState({ past: [], future: [] })

    const from = get().boards.find((b) => b.id === termId) as Board
    applyPush(noopDeps(), from, 'http://localhost:5173', { kind: 'existing', id: browserId })

    const after = get().boards.find((b) => b.id === browserId) as BrowserBoard
    expect(after.url).toBe('http://localhost:5173')
    expect(after.previewSourceId).toBe(termId)

    // The push must be a real undo step — undo returns the board to its pre-push url/link.
    get().undo()
    const reverted = get().boards.find((b) => b.id === browserId) as BrowserBoard
    expect(reverted.url).toBe('http://localhost:3000')
    expect(reverted.previewSourceId).toBeUndefined()
  })

  it('the push records exactly one undo step on `past` (was untracked before the fix)', () => {
    const termId = get().addBoard('terminal', { x: 0, y: 0 })
    const browserId = get().addBoard('browser', { x: 500, y: 0 })
    get().updateBoard(browserId, { url: 'http://localhost:3000' })
    // Clear setup history so we count ONLY the push's checkpoint.
    useCanvasStore.setState({ past: [], future: [] })

    const from = get().boards.find((b) => b.id === termId) as Board
    applyPush(noopDeps(), from, 'http://localhost:5173', { kind: 'existing', id: browserId })

    // beginChange() must have pushed the pre-push snapshot — without it `past` stays empty and
    // the re-point is silently untrackable (the bug). updateBoard never grows `past` on its own.
    expect(get().past.length).toBe(1)
  })

  it('spawn target still works (regression guard: the else branch is unchanged)', () => {
    const termId = get().addBoard('terminal', { x: 0, y: 0 })
    const from = get().boards.find((b) => b.id === termId) as Board
    const before = get().boards.length
    applyPush(noopDeps(), from, 'http://localhost:5173', { kind: 'spawn' })
    expect(get().boards.length).toBe(before + 1)
    const spawned = get().boards.find(
      (b): b is BrowserBoard => b.type === 'browser' && b.url === 'http://localhost:5173'
    )
    expect(spawned).toBeDefined()
    expect(spawned?.previewSourceId).toBe(termId)
  })
})

describe('#BUG-012 — planNodeRemovalCleanup tears down full-view state for the removed board', () => {
  it('removing the PORTAL full-view board closes the portal first', () => {
    expect(planNodeRemovalCleanup('br-1', 'br-1', null)).toEqual(['closeFullView'])
  })

  it('removing the CAMERA full-view board exits camera full view first', () => {
    expect(planNodeRemovalCleanup('plan-1', null, 'plan-1')).toEqual(['exitCameraFullView'])
  })

  it('removing a board NOT in any full view does nothing (no spurious teardown)', () => {
    expect(planNodeRemovalCleanup('other', 'br-1', 'plan-1')).toEqual([])
  })

  it('no full view active → empty plan', () => {
    expect(planNodeRemovalCleanup('br-1', null, null)).toEqual([])
  })
})
