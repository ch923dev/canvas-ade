/**
 * MCP dispatch audit-log panel visibility (W1-A / F3) — a tiny runtime-only Zustand slice
 * so the panel's open state has a SINGLE owner reachable from three call sites without a
 * component import: the corner "Audit" launcher (AuditLogViewer), the drift-guarded
 * Ctrl/⌘+Shift+A keymap action (`resolveCanvasKeyAction` → Canvas dispatch), and the Ctrl+K
 * palette's "View audit log" verb.
 *
 * Before W1-A the toggle was a self-registered `window.addEventListener('keydown')` inside
 * AuditLogViewer — invisible to the command registry and the `?` sheet (the F3 finding). Lifting
 * `open` here lets the shortcut live in the one drift-guarded keymap while the viewer stays the
 * sole renderer of the panel. Ephemeral session state — never serialized (same discipline as
 * `commandStore`); the audit TRAIL itself is MAIN-owned and read back over `mcp.readAudit`.
 */
import { create } from 'zustand'

interface AuditLogStore {
  /** Whether the read-only audit panel is showing. */
  open: boolean
  /** Flip visibility (the Ctrl+Shift+A keymap action + the palette verb). */
  toggle: () => void
  /** Force a specific state (the corner launcher opens; the panel's Close button closes). */
  setOpen: (open: boolean) => void
}

export const useAuditLogStore = create<AuditLogStore>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  // Skip the swap when unchanged so a redundant set doesn't churn subscribers.
  setOpen: (open) => set((s) => (s.open === open ? s : { open }))
}))
