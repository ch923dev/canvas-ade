/**
 * Toast channel (design-audit D1-A) — the app's single transient-feedback store.
 * Surfaces that used to own a private note (D0-5/D0-8 interim chips, the Slice C′
 * port-detect note, browser screenshot/open-external notes, recap consent-save
 * errors) all route here; the ToastIsland (canvas/Toast.tsx) renders the queue
 * bottom-right. Ephemeral session state — never serialized.
 */
import { create } from 'zustand'

export type ToastKind = 'error' | 'ok' | 'info'

export interface Toast {
  id: string
  message: string
  kind: ToastKind
  /** Sticky toasts never auto-dismiss (data-loss class, e.g. save failure). */
  sticky: boolean
  /** Optional action button (e.g. the save-failure Retry). */
  action?: { label: string; run: () => void }
}

export interface ToastInput {
  message: string
  kind?: ToastKind
  sticky?: boolean
  action?: { label: string; run: () => void }
  /**
   * Stable identity for replace/clear semantics (e.g. the save-failure toast is
   * keyed so a repeat failure updates in place and the next successful save can
   * dismiss it by id). Omitted → an auto id is assigned.
   */
  id?: string
}

interface ToastState {
  toasts: Toast[]
  /** Enqueue (or, when `id` already exists, replace in place). Returns the toast id. */
  showToast: (t: ToastInput) => string
  dismissToast: (id: string) => void
  clearToasts: () => void
}

let autoId = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  showToast: (t) => {
    const id = t.id ?? `toast-${++autoId}`
    const toast: Toast = {
      id,
      message: t.message,
      kind: t.kind ?? 'info',
      sticky: t.sticky ?? false,
      action: t.action
    }
    set((s) => {
      const i = s.toasts.findIndex((x) => x.id === id)
      // Replace in place so a repeated keyed toast (save-failure) doesn't jump the queue.
      if (i >= 0) return { toasts: s.toasts.map((x, j) => (j === i ? toast : x)) }
      return { toasts: [...s.toasts, toast] }
    })
    return id
  },
  dismissToast: (id) =>
    set((s) => {
      const next = s.toasts.filter((t) => t.id !== id)
      // Conditional set: dismissing an already-gone id must not churn subscribers
      // (the save-success clear path fires on every successful autosave).
      return next.length === s.toasts.length ? s : { toasts: next }
    }),
  clearToasts: () => set((s) => (s.toasts.length === 0 ? s : { toasts: [] }))
}))

/** Module-scope helpers — callable from non-React code (autosave hook, IPC handlers). */
export const showToast = (t: ToastInput): string => useToastStore.getState().showToast(t)
export const dismissToast = (id: string): void => useToastStore.getState().dismissToast(id)
