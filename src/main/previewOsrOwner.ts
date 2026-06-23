import type { BrowserWindow } from 'electron'
import { isMainFramePageNav, type NavDetails } from './previewOsrNetwork'

/**
 * The host-owner reference + frame-readiness gate for the OSR emit pumps (the disposed-frame send
 * fix), split out of previewOsr.ts so that god-file stays under the max-lines ratchet.
 *
 * THE BUG. previewOsr's four emit helpers ferry every frame / cursor / lifecycle / widget message to
 * the HOST renderer via `owner.webContents.send(...)`, where `owner` is the singleton main window.
 * The OSR paint pump (`wc.on('paint')` on each board's HIDDEN offscreen window) keeps firing on its
 * own schedule, independent of the host. So when the host renderer RELOADS — a dev electron-vite HMR
 * full-page reload, or any same-origin re-navigation — its top-level render frame is disposed and
 * swapped while the BrowserWindow and its webContents stay ALIVE (`isDestroyed()` === false), and
 * `render-process-gone` never fires (a reload is a navigation, not a crash). Each paint then sends
 * into that disposed frame, and Electron logs — asynchronously, INSIDE its IPC dispatch, so the
 * surrounding try/catch can NEVER catch it — "Error sending from webFrameMain: Render frame was
 * disposed before WebFrameMain could be accessed", once per paint (continuous spew).
 *
 * THE FIX (two layers).
 *  1. `canEmitToOwner` — the canonical house destroyed-guard (`isDestroyed()` BEFORE `.webContents`,
 *     mirroring ipcGuard.isForeignSender / autoUpdate.ts). Covers window close / app quit / crash.
 *  2. `ownerGate.ready` — a navigation-driven readiness flag, the load-bearing addition: it is the
 *     ONLY signal that can see the reload frame-swap (where both destroyed-checks stay false). It is
 *     flipped false the instant a main-frame cross-document navigation starts and true again on its
 *     commit / terminal outcome (registerOwnerLifecycle).
 */

let owner: BrowserWindow | null = null
// Default true: a bare module-load has no owner (canEmitToOwner's null-check covers that); the flag
// only matters once armOwner has set an owner. `ownerWired` keeps the host listener wiring idempotent
// — armOwner runs on every preview:osrOpen, but the host is one singleton window (wire it once).
const ownerGate = { ready: true }
let ownerWired: BrowserWindow | null = null

/** Minimal host-window surface `canEmitToOwner` reads — so the send guard is unit-testable without
 *  a real Electron `BrowserWindow`. A `BrowserWindow` satisfies it structurally. */
export type EmitTargetWin = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>

/**
 * Can we safely `webContents.send` to the host owner window right now? (The OSR disposed-frame send
 * guard.) Reads `isDestroyed()` BEFORE touching `.webContents` — the canonical house guard shape
 * (ipcGuard.isForeignSender / autoUpdate.ts) so a destroyed window's throwing `.webContents` getter
 * can never escape. The `ownerReady` arm is the load-bearing addition: across a dev HMR full-page
 * reload neither the window nor its webContents is destroyed (only the top-level render frame is
 * swapped + briefly disposed), so the two destroyed-checks alone return true and the send still hits
 * a disposed frame (the uncatchable spew). The navigation-driven readiness flag (false across the
 * frame swap) is what actually closes that gap.
 */
export function canEmitToOwner(win: EmitTargetWin | null, ownerReady: boolean): boolean {
  if (!win || win.isDestroyed()) return false
  if (win.webContents.isDestroyed()) return false
  return ownerReady
}

/** Minimal host webContents surface `registerOwnerLifecycle` listens on — so the readiness-gate
 *  wiring is unit-testable without Electron (mirrors registerLoadLatch / registerCrashReadyGate in
 *  previewShared). A real `WebContents` satisfies it structurally. */
interface OwnerLifecycleTarget {
  on(event: 'did-start-navigation', listener: (details: NavDetails) => void): unknown
  on(event: 'did-navigate', listener: () => void): unknown
  on(event: 'did-finish-load', listener: () => void): unknown
  on(
    event: 'did-fail-load',
    listener: (ev: unknown, code: number, desc: string, url: string, isMainFrame: boolean) => void
  ): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
}
/** Holder for the mutable owner-readiness flag (the module-level `ownerGate` satisfies it). */
interface OwnerReadyHolder {
  ready: boolean
}

/**
 * Wire the host owner window's navigation lifecycle to the emit frame-readiness gate. `holder.ready`
 * goes FALSE the instant a main-frame cross-document navigation STARTS — the window in which the
 * host's top-level render frame is swapped + briefly disposed, which the OSR paint pump would
 * otherwise keep sending into (the uncatchable "Render frame was disposed" spew) — and TRUE again on
 * the navigation's commit/terminal outcome.
 *
 * Re-arming on did-navigate (commit) AND did-finish-load (loaded) AND a main-frame did-fail-load
 * (aborted/failed) is deliberate: gating the re-arm on did-finish-load ALONE would leave the gate
 * stuck false forever — every open Browser board permanently silent — whenever a reload aborts mid-
 * HMR (dev server bounced) and never finishes loading. By any of those terminal events the disposed-
 * frame interval is over (the new frame committed, or the old one is back), so re-arming is always
 * safe. `render-process-gone` (a true host crash) forces false and nulls the owner via `onGone`.
 *
 * Pure listener wiring (mutates only the passed holder + calls onGone) — unit-tested with a fake
 * emitter, exactly like registerLoadLatch / registerCrashReadyGate. A same-document SPA route
 * (React Router hash/pushState) is excluded by isMainFramePageNav so it never trips the gate.
 */
export function registerOwnerLifecycle(
  wc: OwnerLifecycleTarget,
  holder: OwnerReadyHolder,
  onGone: () => void
): void {
  wc.on('did-start-navigation', (details) => {
    if (isMainFramePageNav(details)) holder.ready = false
  })
  wc.on('did-navigate', () => {
    holder.ready = true
  })
  wc.on('did-finish-load', () => {
    holder.ready = true
  })
  wc.on('did-fail-load', (_ev, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) holder.ready = true
  })
  wc.on('render-process-gone', () => {
    holder.ready = false
    onGone()
  })
}

/**
 * Adopt `win` as the host owner and (re-)arm the readiness gate. Called on every preview:osrOpen with
 * the SAME singleton host window: reset `ready` true each open (a board re-opening after a host reload
 * resumes sends) but wire the host's navigation listeners exactly ONCE (the `ownerWired` identity
 * guard) — re-wiring the same live webContents would stack duplicate listeners. An already-open board
 * that SURVIVED the reload is re-armed by the host's own did-navigate / did-finish-load, independent
 * of any re-open.
 */
export function armOwner(win: BrowserWindow): void {
  owner = win
  ownerGate.ready = true
  if (win !== ownerWired) {
    registerOwnerLifecycle(win.webContents, ownerGate, () => {
      owner = null
    })
    ownerWired = win
  }
}

/**
 * Drop the host owner (project switch / window close). Closes the gate while there is no owner. NB:
 * deliberately does NOT reset `ownerWired` — this also runs on a project switch (preview:osrCloseAll)
 * where the host window stays ALIVE, so clearing it would re-wire (and thus DUPLICATE) the host
 * listeners on the next armOwner. The identity guard re-wires only for a genuinely different window;
 * the current window's listeners are torn down with it on host 'closed' (→ here), never leaked.
 */
export function clearOwner(): void {
  owner = null
  ownerGate.ready = false
}

/** The current host owner window (or null), for the few consumers that need the live ref directly
 *  (e.g. attachOsrWidgets' getWin). */
export function getOwner(): BrowserWindow | null {
  return owner
}

/** Send a message to the host owner renderer IFF its frame is live and ready (the disposed-frame
 *  guard). A no-op otherwise — that brief gap drops only idempotent repaints / re-derivable events.
 *  The try/catch is the residual backstop for a torn-down race between the guard and the send. */
export function emitToOwner(channel: string, payload: unknown): void {
  if (!canEmitToOwner(owner, ownerGate.ready)) return
  try {
    owner?.webContents.send(channel, payload)
  } catch {
    /* torn down between guard and send (residual race) */
  }
}
