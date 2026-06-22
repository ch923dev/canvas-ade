/**
 * OS-3 Phase 4 — ephemeral per-board state for the OSR native-widget chrome.
 *
 * MAIN detects page events the offscreen bitmap can't render itself (a JS dialog, a `<select>`/
 * date/color popup opening, audio playing) and emits them; `useOsrWidgetEvents` funnels them here.
 * `OsrWidgetLayer` (mounted in `.bb-frame`) reads `dialog`/`popup` to draw the modal/overlay;
 * `BrowserBoard`'s URL bar reads `audible`/`muted` for the mute toggle. Pure session state — never
 * serialized.
 */
import { create } from 'zustand'
import type { OsrDialogEvent, OsrPopupEvent, OsrDownloadEvent } from '../../../preload'

/** A download surfaced in the inspector's Downloads tab — the latest lifecycle state per file
 *  (one row per filename, replace-in-place like the toast). Ephemeral session state. */
export interface OsrDownloadRecord {
  name: string
  state: OsrDownloadEvent['state']
  savePath?: string
  received?: number
  total?: number
}

interface OsrWidgetState {
  /** The open JS dialog per board (alert/confirm/prompt), or null/absent when none. */
  dialog: Record<string, OsrDialogEvent | null>
  /** The open native popup per board (select/date/color), or null/absent when none. */
  popup: Record<string, OsrPopupEvent | null>
  /** Whether the board is currently playing media (drives the mute toggle's visibility). */
  audible: Record<string, boolean>
  /** The user's manual mute choice per board (effective mute also factors off-screen, in MAIN). */
  muted: Record<string, boolean>
  /** Per-board download list (insertion-ordered, one row per filename) for the Downloads tab. */
  downloads: Record<string, OsrDownloadRecord[]>

  setDialog: (id: string, dialog: OsrDialogEvent | null) => void
  setPopup: (id: string, popup: OsrPopupEvent | null) => void
  setAudible: (id: string, audible: boolean) => void
  setMuted: (id: string, muted: boolean) => void
  /** Upsert a download lifecycle event into the board's list (keyed by filename). */
  applyDownload: (id: string, event: OsrDownloadEvent) => void
  /** Empty a board's download list (the Downloads tab's clear button). */
  clearDownloads: (id: string) => void
  /** Drop all state for a board (unmount / disable). */
  clearBoard: (id: string) => void
}

export const useOsrWidgetStore = create<OsrWidgetState>((set) => ({
  dialog: {},
  popup: {},
  audible: {},
  muted: {},
  downloads: {},

  setDialog: (id, dialog) => set((s) => ({ dialog: { ...s.dialog, [id]: dialog } })),
  setPopup: (id, popup) => set((s) => ({ popup: { ...s.popup, [id]: popup } })),
  setAudible: (id, audible) =>
    set((s) => (s.audible[id] === audible ? s : { audible: { ...s.audible, [id]: audible } })),
  setMuted: (id, muted) =>
    set((s) => (s.muted[id] === muted ? s : { muted: { ...s.muted, [id]: muted } })),

  applyDownload: (id, event) =>
    set((s) => {
      // 'throttled' is a transient "too many downloads" warning, not a file row — ignore it here
      // (the toast still fires). Skip nameless events defensively.
      if (event.state === 'throttled' || !event.name) return s
      const list = s.downloads[id] ?? []
      const rec: OsrDownloadRecord = {
        name: event.name,
        state: event.state,
        savePath: event.savePath,
        received: event.received,
        total: event.total
      }
      const at = list.findIndex((d) => d.name === event.name)
      const next = list.slice()
      if (at === -1) next.push(rec)
      else next[at] = { ...list[at], ...rec }
      return { downloads: { ...s.downloads, [id]: next } }
    }),

  clearDownloads: (id) =>
    set((s) => (s.downloads[id]?.length ? { downloads: { ...s.downloads, [id]: [] } } : s)),

  clearBoard: (id) =>
    set((s) => {
      const dialog = { ...s.dialog }
      const popup = { ...s.popup }
      const audible = { ...s.audible }
      const muted = { ...s.muted }
      const downloads = { ...s.downloads }
      delete dialog[id]
      delete popup[id]
      delete audible[id]
      delete muted[id]
      delete downloads[id]
      return { dialog, popup, audible, muted, downloads }
    })
}))
