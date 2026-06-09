/**
 * Canvas decision logic extracted from Canvas.tsx (god-file maintainability, Tier-1).
 * Behavior-preserving move: the full-view toggle plan (planFullViewAction), the node-removal
 * full-view cleanup plan (planNodeRemovalCleanup), and the push-target applier (applyPush) —
 * each unit-tested directly (Canvas.fullview.test.ts / Canvas.pushundo.test.ts). No logic changed.
 */
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import type { Board, BoardType } from './boardSchema'
import type { ResolvedPushTarget } from './previewTarget'

/** One step of the full-view decision (consumed in order by `requestFullView`). */
export type FullViewAction =
  | 'exitCameraFullView'
  | 'enterCameraFullView'
  | 'closeFullView'
  | 'openFullView'

/**
 * Pure decision for the maximize (⤢) toggle — what `requestFullView` should do for a
 * board given the two mutually-exclusive full-view modes currently active. Returned as an
 * ORDERED list so the caller runs them in sequence (order matters: a stale camera-FV must
 * be exited BEFORE opening the portal modal). Portal full view (browser/terminal) and
 * camera full view (planning) must never both be live — `enterCameraFullView` already
 * `hardCloseFullView`s the portal on the way in; this is the symmetric guard for the
 * portal path so maximizing a Terminal/Browser while a Planning board is in camera-FV
 * doesn't leave BOTH set (the double-mode that needed two Esc — #BUG-004).
 */
export function planFullViewAction(
  type: BoardType | undefined,
  id: string,
  currentFullViewId: string | null,
  currentCameraFullViewId: string | null
): FullViewAction[] {
  if (type === 'planning') {
    return currentCameraFullViewId === id ? ['exitCameraFullView'] : ['enterCameraFullView']
  }
  if (currentFullViewId === id) return ['closeFullView']
  // Opening the portal modal: first leave any active Planning camera-FV so the two modes
  // are never simultaneously live (#BUG-004).
  return currentCameraFullViewId ? ['exitCameraFullView', 'openFullView'] : ['openFullView']
}

/** One full-view cleanup step a node removal must run BEFORE the board leaves the store. */
export type RemovalCleanupAction = 'closeFullView' | 'exitCameraFullView'

/**
 * Pure decision for what full-view state a board removal must tear down FIRST — mirrors the
 * guards in `boardActions.remove` so React Flow's keyboard-delete path (deleteKeyCode →
 * `onNodesChange` remove intent) can't bypass them. Without this, deleting a portal-full-view
 * board with the keyboard leaves `fullViewId` transiently pointing at a board that no longer
 * exists for one render (#BUG-012): `applyLiveness` then runs with a stale `fullViewIdRef` and
 * needlessly demotes every other Browser board to a snapshot before the healing effect heals it.
 * Returns the steps to run (in any order — they target independent state) before `removeBoard`.
 */
export function planNodeRemovalCleanup(
  removeId: string,
  currentFullViewId: string | null,
  currentCameraFullViewId: string | null
): RemovalCleanupAction[] {
  const out: RemovalCleanupAction[] = []
  if (currentFullViewId === removeId) out.push('closeFullView')
  if (currentCameraFullViewId === removeId) out.push('exitCameraFullView')
  return out
}

/** Store + canvas glue `applyPush` needs (the store handle plus the two ephemeral resetters). */
export interface ApplyPushDeps {
  store: ReturnType<typeof useCanvasStore.getState>
  clearFocus: () => void
  hardCloseFullView: () => void
}

/**
 * Apply a resolved push target: re-point an EXISTING browser (forcing a reload) or spawn a fresh
 * one beside the source terminal. Shared by the auto path (pushPreview) and the explicit
 * multi-browser picker (pushPreviewTo). Pure-ish glue: all effects go through `deps`, so it is
 * unit-testable against the real store (proving the push is undoable — #BUG-021).
 *
 * #BUG-021: the EXISTING branch checkpoints via `beginChange()` BEFORE `updateBoard` so the
 * pre-push url/previewSourceId lands on the undo stack — otherwise the re-point is silently
 * untrackable (no `past` entry) AND, because `updateBoard` clears `future` on a real change, any
 * armed redo branch is destroyed with nothing to undo it. Mirrors BrowserBoard.tsx's manual
 * URL-commit, which already calls `beginChange()` first.
 */
export function applyPush(
  deps: ApplyPushDeps,
  from: Board,
  url: string,
  target: ResolvedPushTarget
): void {
  const { store: st, clearFocus, hardCloseFullView } = deps
  const patch = { url, previewSourceId: from.id } as Partial<Board>
  if (target.kind === 'existing') {
    // Force a (re)load even when the pushed url equals the target's current url
    // (same dev-server URL): bump the reload nonce BEFORE the store mutation so the
    // reconcile that updateBoard triggers sees it and re-navigates — otherwise the
    // url diff-skip (Bug #44) strands a load-failed view on its stale error page.
    usePreviewStore.getState().requestReload(target.id)
    // #BUG-021: checkpoint the pre-push state so the re-point is undoable (and doesn't
    // silently wipe an armed redo branch). One undo step per applied push.
    st.beginChange()
    st.updateBoard(target.id, patch)
    st.selectBoard(target.id)
  } else {
    // Exit focus so the freshly spawned browser isn't born dimmed (STATE-1).
    clearFocus()
    const id = st.addBoard('browser', { x: from.x + from.w + 40, y: from.y })
    st.updateBoard(id, patch)
    st.selectBoard(id)
  }
  hardCloseFullView()
}
