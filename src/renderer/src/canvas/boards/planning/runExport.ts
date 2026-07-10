/**
 * Whiteboard export runner — verbatim extraction from ExportPopover (D4-A) so the
 * command palette and the popover share ONE export path: build (dynamic import keeps
 * the rasteriser out of the main bundle) → save over IPC → toast on genuine failure,
 * silence on user cancel.
 */
import type { PlanningBoard as PlanningBoardData } from '../../../lib/boardSchema'
import { showToast } from '../../../store/toastStore'
import { saveErrorMessage } from '../../../lib/saveError'

export async function runBoardExport(
  board: PlanningBoardData,
  format: 'png' | 'svg'
): Promise<void> {
  try {
    const { buildExport } = await import('./exportBoard')
    const { bytes, ext } = await buildExport(board, format)
    // export:save RETURNS a discriminated result — it never throws on a write failure,
    // so the catch below alone would let a real failure (permission denied / disk full)
    // look like a user cancel. Inspect the result: surface a genuine error, but stay
    // silent on an explicit cancel (the user dismissed the save dialog).
    const res = await window.api.export.save({
      bytes,
      ext,
      defaultName: board.title || 'whiteboard'
    })
    if (!res.ok && !res.canceled) {
      // eslint-disable-next-line no-console
      console.error('whiteboard export failed:', res.error)
      // Fixed copy: res.error is a raw OS/API string (paths, ENOENT) and the toast
      // is read aloud by the alert region; the console line above keeps the detail.
      // D1-A: failures route to the app toast channel (was a board-anchored note);
      // board-keyed so a quick retry replaces the toast instead of stacking.
      showToast({
        id: `export-failed-${board.id}`,
        kind: 'error',
        // C3: errno-mapped when a write actually failed; a code-less failure → neutral generic.
        message: res.error ? saveErrorMessage(res.code, 'Export failed') : 'Export failed'
      })
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('whiteboard export failed', err)
    showToast({ id: `export-failed-${board.id}`, kind: 'error', message: 'Export failed' })
  }
}
