/**
 * Tidy feedback toasts (spatial-awareness C8; DESIGN W3 / W7) — what the USER sees after a tidy
 * they started (the `t` key, the palette, the Tidy picker). Agents get the same facts in the
 * `tidy_canvas` result instead (W3), so the MCP applier never calls this.
 *
 *  - W7 — a `roles` tidy that leaves units OFF-STAGE: "Arranged by role · <stage why>. N more
 *    contexts off-stage: …" with **Show all** (frame every board; if that is unreadable, W3's copy
 *    follows) and **Undo** (the tidy's own step only).
 *  - W3 — a `fit` (or `roles`) tidy that ends `readable:false`: "Tidied N boards. They're too
 *    small to read at once (P%)." with **Focus a group** (the F-key switcher; only when a group
 *    exists) and **Pages** (re-run with `overflow:'pages'`, REPLACING the previous tidy's step).
 *  - I3 — a partial tidy (the group menu's "Tidy group") whose arrangement would have covered a
 *    board outside it, so it moved, whole, to open space: "Group tidied — moved to open space"
 *    with **Undo**. The camera already followed the group; this one wins over W3 / W7.
 *  - Anything else: silence is the success state (W7) — a stale tidy toast is dismissed.
 *
 * ONE toast at a time (keyed {@link TIDY_TOAST_ID}, replaced in place). The existing `info` toast
 * and toast-action pattern — no new visual language. React-free.
 */
import { dismissToast, showToast, type ToastAction } from './toastStore'
import { useCanvasStore } from './canvasStore'
import { useCanvasViewStore } from './canvasViewStore'
import { requestCameraFocus } from './cameraRequestStore'
import { FALLBACK_PANE, runTidy, type TidyRun } from './spatialTidy'
import { isDockedTerminal } from '../lib/boardSchema'
import { boardsBounds } from '../lib/boardGeometry'
import { READABLE_ZOOM, fitZoom } from '../../../shared/spatialGeometry'

/** The one tidy toast's id — every tidy replaces (or clears) it. */
export const TIDY_TOAST_ID = 'tidy-feedback'
/** Off-stage unit names listed before "+N". */
const MAX_NAMES = 3

/** The top of the undo rail right now — the identity of the step a tidy just recorded. */
const undoTop = (): unknown => {
  const { past } = useCanvasStore.getState()
  return past[past.length - 1]
}

/** Undo the tidy ONLY if its step is still the latest one (never someone else's later edit). */
function undoTidy(mark: unknown): boolean {
  if (mark === undefined || undoTop() !== mark) return false
  useCanvasStore.getState().undo()
  return true
}

const once =
  (fn: () => void): (() => void) =>
  () => {
    dismissToast(TIDY_TOAST_ID)
    fn()
  }

/** W3 — the arrangement is too small to read at once. */
function showUnreadable(run: TidyRun, zoom: number, mark: unknown): void {
  const actions: ToastAction[] = []
  if (useCanvasStore.getState().groups.length > 0) {
    actions.push({
      label: 'Focus a group',
      run: once(() => requestCameraFocus({ kind: 'groupPicker' }))
    })
  }
  const pageable = run.args.mode === 'fit' || run.args.mode === 'roles'
  if (pageable && run.args.overflow !== 'pages') {
    actions.push({
      label: 'Pages',
      run: once(() => {
        undoTidy(mark) // one step REPLACES the previous tidy (W3)
        const next = runTidy({ ...run.args, overflow: 'pages' })
        if (next.ok) showTidyFeedback(next)
      })
    })
  }
  showToast({
    id: TIDY_TOAST_ID,
    kind: 'info',
    message:
      `Tidied ${run.count} board${run.count === 1 ? '' : 's'}. They're too small to read at ` +
      `once (${Math.round(zoom * 100)}%).`,
    actions
  })
}

/** W7's "Show all": frame every board; if that is not readable, W3's copy follows. */
function showAll(run: TidyRun, mark: unknown): void {
  const bb = boardsBounds(useCanvasStore.getState().boards.filter((b) => !isDockedTerminal(b)))
  if (!bb) return
  const rect = { x: bb.minX, y: bb.minY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY }
  requestCameraFocus({ kind: 'rect', rect })
  const pane = useCanvasViewStore.getState().pane ?? FALLBACK_PANE
  const zoom = fitZoom(rect, pane)
  if (zoom < READABLE_ZOOM) showUnreadable(run, zoom, mark)
}

/** Show (or clear) the feedback toast for one finished, user-started tidy. */
export function showTidyFeedback(run: TidyRun): void {
  const mark = run.moved > 0 ? undoTop() : undefined
  if (run.relocated) {
    const scope = run.args.scope
    const what =
      typeof scope === 'object' && 'groupId' in scope
        ? 'Group tidied'
        : `Tidied ${run.count} board${run.count === 1 ? '' : 's'}`
    showToast({
      id: TIDY_TOAST_ID,
      kind: 'info',
      message: `${what} — moved to open space`,
      actions: mark !== undefined ? [{ label: 'Undo', run: once(() => undoTidy(mark)) }] : []
    })
    return
  }
  const units = run.args.mode === 'roles' ? (run.units ?? []) : []
  if (units.length > 1) {
    const [stage, ...off] = units
    const names =
      off
        .slice(0, MAX_NAMES)
        .map((u) => u.name)
        .join(', ') + (off.length > MAX_NAMES ? ` +${off.length - MAX_NAMES}` : '')
    const actions: ToastAction[] = [{ label: 'Show all', run: once(() => showAll(run, mark)) }]
    if (mark !== undefined) actions.push({ label: 'Undo', run: once(() => undoTidy(mark)) })
    showToast({
      id: TIDY_TOAST_ID,
      kind: 'info',
      message:
        `Arranged by role · ${stage.why}. ${off.length} more ` +
        `${off.length === 1 ? 'context' : 'contexts'} off-stage: ${names}`,
      actions
    })
    return
  }
  const pageable = run.args.mode === 'fit' || run.args.mode === 'roles'
  if (pageable && run.readable === false && run.fitZoom !== undefined) {
    showUnreadable(run, run.fitZoom, mark)
    return
  }
  dismissToast(TIDY_TOAST_ID)
}
