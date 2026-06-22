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
import type { OsrDialogEvent, OsrPopupEvent } from '../../../preload'

interface OsrWidgetState {
  /** The open JS dialog per board (alert/confirm/prompt), or null/absent when none. */
  dialog: Record<string, OsrDialogEvent | null>
  /** The open native popup per board (select/date/color), or null/absent when none. */
  popup: Record<string, OsrPopupEvent | null>
  /** Whether the board is currently playing media (drives the mute toggle's visibility). */
  audible: Record<string, boolean>
  /** The user's manual mute choice per board (effective mute also factors off-screen, in MAIN). */
  muted: Record<string, boolean>
  /** The user's per-board audio volume (0–1, default 1). Ephemeral, like `muted`; MAIN emulates it
   *  by setting `el.volume` on the page's HTML5 media (Electron OSR has no native volume API). */
  volume: Record<string, number>

  setDialog: (id: string, dialog: OsrDialogEvent | null) => void
  setPopup: (id: string, popup: OsrPopupEvent | null) => void
  setAudible: (id: string, audible: boolean) => void
  setMuted: (id: string, muted: boolean) => void
  setVolume: (id: string, volume: number) => void
  /** Drop all state for a board (unmount / disable). */
  clearBoard: (id: string) => void
}

export const useOsrWidgetStore = create<OsrWidgetState>((set) => ({
  dialog: {},
  popup: {},
  audible: {},
  muted: {},
  volume: {},

  setDialog: (id, dialog) => set((s) => ({ dialog: { ...s.dialog, [id]: dialog } })),
  setPopup: (id, popup) => set((s) => ({ popup: { ...s.popup, [id]: popup } })),
  setAudible: (id, audible) =>
    set((s) => (s.audible[id] === audible ? s : { audible: { ...s.audible, [id]: audible } })),
  setMuted: (id, muted) =>
    set((s) => (s.muted[id] === muted ? s : { muted: { ...s.muted, [id]: muted } })),
  setVolume: (id, volume) =>
    set((s) => (s.volume[id] === volume ? s : { volume: { ...s.volume, [id]: volume } })),

  clearBoard: (id) =>
    set((s) => {
      const dialog = { ...s.dialog }
      const popup = { ...s.popup }
      const audible = { ...s.audible }
      const muted = { ...s.muted }
      const volume = { ...s.volume }
      delete dialog[id]
      delete popup[id]
      delete audible[id]
      delete muted[id]
      delete volume[id]
      return { dialog, popup, audible, muted, volume }
    })
}))
