/**
 * Load-time notices for a freshly-parsed document — the toasts every load path (loadObject, open,
 * `.bak` recovery) raises right before it applies the doc. Extracted from canvasStore (max-lines
 * ratchet at the v24 workspaces bump) so a new notice never costs the store a line.
 */
import { SCHEMA_VERSION, type CanvasDoc } from '../lib/boardSchema'
import { workspaceLoadNotices } from '../lib/workspaceSchema'
import { showToast } from './toastStore'

/**
 * - ADR 0007 forward-compatible open: a doc written by a newer app (additive bump) opens fine, but
 *   the user should know features may be missing and that the next save re-stamps the file at THIS
 *   app's version. Non-blocking info toast, keyed so a project switch replaces rather than stacks it.
 * - v24: a workspace the load reconcile DROPPED (its folder escapes the project, or it duplicated
 *   another) is surfaced, never silently lost — its boards are already project-level by now.
 */
export function noticeLoadedDoc(d: CanvasDoc): void {
  if (d.schemaVersion > SCHEMA_VERSION) {
    showToast({
      id: 'schema-forward-open',
      kind: 'info',
      message:
        `Project was saved by a newer version of the app (schema v${d.schemaVersion}). ` +
        `Opened in compatibility mode — saving re-stamps it at v${SCHEMA_VERSION}.`
    })
  }
  const dropped = workspaceLoadNotices(d)
  if (dropped.length > 0) {
    showToast({
      id: 'workspace-load-dropped',
      kind: 'error',
      message:
        `${dropped.join(' ')} ` +
        `${dropped.length === 1 ? 'Its' : 'Their'} boards are now project-level.`
    })
  }
}
