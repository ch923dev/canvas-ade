/**
 * ToastIsland (design-audit D1-A) — the single transient-feedback surface, a
 * bottom-right island of stacked toasts (DESIGN.md §8 floating-island chrome,
 * status-dot variant signed off 2026-06-10). Reads the queue from toastStore;
 * shows the oldest MAX_VISIBLE, the rest wait their turn. Auto-dismiss starts
 * when a toast becomes VISIBLE (mount), so a queued toast still gets its full
 * read time. Sticky toasts (data-loss class, e.g. save failure) never expire.
 *
 * Native-view occlusion (ADR 0002): a live WebContentsView paints above all
 * HTML, so while any toast is visible the island's rect joins the preview
 * manager's chrome-exclusion zones (usePreviewManager.resolveChromeZones reads
 * `[data-test=toast-island]` — the digest-panel pattern from PR #82).
 */
import { useEffect, type ReactElement } from 'react'
import { useToastStore, type Toast } from '../store/toastStore'

/** Visible stack cap — older toasts hold the slots; newer ones queue behind. */
const MAX_VISIBLE = 3
export const TOAST_AUTO_DISMISS_MS = 5000

export function ToastIsland(): ReactElement | null {
  const toasts = useToastStore((s) => s.toasts)
  const visible = toasts.slice(0, MAX_VISIBLE)
  if (visible.length === 0) return null
  return (
    <div className="toast-island" data-test="toast-island">
      {visible.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastItem({ toast }: { toast: Toast }): ReactElement {
  const dismissToast = useToastStore((s) => s.dismissToast)
  // Auto-dismiss countdown — runs from MOUNT (first visibility), not enqueue.
  // `toast.message` is a dep on purpose: a keyed in-place replace (repeat save
  // failure) restarts the countdown so the fresh message gets full read time.
  useEffect(() => {
    if (toast.sticky) return
    const id = setTimeout(() => dismissToast(toast.id), TOAST_AUTO_DISMISS_MS)
    return () => clearTimeout(id)
  }, [toast.id, toast.sticky, toast.message, dismissToast])
  return (
    <div
      className="toast-item"
      data-kind={toast.kind}
      // Errors announce assertively; alert is valid here because the toast root is
      // not itself interactive (unlike the D0-8 chip button, which needed a hidden
      // sibling region). Everything else stays a polite status.
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-msg">{toast.message}</span>
      {toast.action && (
        <button className="toast-action" onClick={toast.action.run}>
          {toast.action.label}
        </button>
      )}
      <button className="toast-dismiss" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        ✕
      </button>
    </div>
  )
}
