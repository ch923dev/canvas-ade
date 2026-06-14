import type { IpcMain, BrowserWindow } from 'electron'
import { WebContentsView } from 'electron'
import { isForeignSender } from './ipcGuard'
import { isAllowedPreviewUrl, registerPreviewNavGuards } from './preview'

/**
 * SPIKE (feat/preview-offscreen-spike) — offscreen Browser-preview producer.
 *
 * Renders a Browser board's page OFFSCREEN (the view is NEVER added to the window's
 * native view tree) and streams its frames to the renderer over `preview:osrFrame`,
 * where they paint into a DOM `<canvas>`. This is the occlusion fix under test — see
 * `docs/reviews/2026-06-14-electron-to-flutter-assessment/preview-offscreen-spike-spec.md`:
 * a `<canvas>` clips/rounds/z-orders like any DOM node, so the native-overlay occlusion
 * (ADR 0002) disappears.
 *
 * Deliberately ISOLATED from the shipping native path in `preview.ts` — its own `osr`
 * Map and its own session partition — so the spike can be toggled or deleted without
 * touching the proven path. NOT yet hardened to that path's level (no load-latch /
 * crash-ready gate / zoom persistence): the first slice only proves frames flow and
 * paint sharp (spec M1/M2). Security carry-overs that ARE wired: per-view in-memory
 * session, deny-all permissions, http(s) nav-scheme allowlist, frame-guarded IPC.
 * `preview:osrInput` (spec M3) is scaffolded; the renderer coordinate-transform that
 * feeds it is a later increment.
 */

interface OsrEntry {
  view: WebContentsView
}

const osr = new Map<string, OsrEntry>()
let owner: BrowserWindow | null = null

/** Frame-rate cap for the offscreen renderer (spec M2 throughput knob). */
const OSR_FRAME_RATE = 30
/** Logical render size — desktop-preset aspect. DPR / responsive-preset sizing = M1/M4. */
const OSR_WIDTH = 1280
const OSR_HEIGHT = 800

/** One offscreen-rendered frame (raw BGRA pixels) pushed main → renderer. */
export interface OsrFramePayload {
  id: string
  width: number
  height: number
  /** NativeImage.toBitmap() — raw BGRA; the renderer swaps to RGBA for the canvas. */
  buffer: Buffer
}

/** A renderer-built input event forwarded to the offscreen view (M3 scaffold). */
type OsrInputEvent = Parameters<Electron.WebContents['sendInputEvent']>[0]

function emitFrame(payload: OsrFramePayload): void {
  try {
    owner?.webContents.send('preview:osrFrame', payload)
  } catch {
    /* window gone */
  }
}

function ensureOsr(id: string, win: BrowserWindow, url: string): OsrEntry {
  owner = win
  const existing = osr.get(id)
  if (existing) return existing
  const view = new WebContentsView({
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Distinct from the native path's `preview-${id}` so the two never share a
      // session (cache / zoom / cookies) even if both exist across a spike toggle.
      partition: `preview-osr-${id}`
    }
  })
  const e: OsrEntry = { view }
  osr.set(id, e)
  const wc = view.webContents
  // Deny-all permissions on this view's session (untrusted localhost content) — same
  // posture as the native path (preview.ts).
  const sess = wc.session
  sess.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  sess.setPermissionCheckHandler(() => false)
  // http(s)-only nav scheme allowlist, shared with the native path.
  registerPreviewNavGuards(wc)
  // Offscreen render size + frame cap. NOTE: no addChildView — the whole point is that
  // the view stays OFF the native tree, so nothing paints above the HTML.
  view.setBounds({ x: 0, y: 0, width: OSR_WIDTH, height: OSR_HEIGHT })
  wc.setFrameRate(OSR_FRAME_RATE)
  wc.on('paint', (_ev, _dirty, image) => {
    const size = image.getSize()
    if (size.width === 0 || size.height === 0) return
    // toBitmap() (raw BGRA) — the correctly-typed equivalent of the legacy getBitmap().
    emitFrame({ id, width: size.width, height: size.height, buffer: image.toBitmap() })
  })
  if (isAllowedPreviewUrl(url)) {
    void wc.loadURL(url)
  }
  // Defensive (spec §5 Q1 — does an off-tree offscreen view paint at all?): painting
  // normally auto-starts once content loads and a frame rate is set; kick it explicitly
  // in case an off-tree view doesn't. Harmless if already painting.
  wc.once('did-finish-load', () => {
    try {
      if (!wc.isPainting()) wc.startPainting()
    } catch {
      /* not an OSR-capable webContents */
    }
  })
  return e
}

function disposeOsr(id: string): void {
  const e = osr.get(id)
  if (!e) return
  try {
    e.view.webContents.close() // no destroy() on WebContentsView — close or leak the renderer
  } catch {
    /* already gone */
  }
  osr.delete(id)
}

/** Close every offscreen view (window close / app shutdown). */
export function disposeAllOsr(): void {
  for (const id of [...osr.keys()]) disposeOsr(id)
  owner = null
}

interface OsrOpenArgs {
  id: string
  url: string
}
interface OsrInputArgs {
  id: string
  event: OsrInputEvent
}

export function registerPreviewOsrHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.handle('preview:osrOpen', (ev, args: OsrOpenArgs) => {
    if (isForeignSender(ev, getWin)) throw new Error('preview:osrOpen — forbidden sender')
    const win = getWin()
    if (!win) throw new Error('preview:osrOpen — no window')
    ensureOsr(args.id, win, args.url)
    return true
  })
  ipcMain.handle('preview:osrClose', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return true
    disposeOsr(id)
    return true
  })
  // M3 scaffold: forward a real OS input event to the offscreen view's webContents. The
  // renderer coordinate-transform (canvas-local → page px under camera/preset scale) is
  // a later increment; this proves the channel + the sendInputEvent path exist.
  ipcMain.handle('preview:osrInput', (ev, args: OsrInputArgs) => {
    if (isForeignSender(ev, getWin)) return false
    const e = osr.get(args.id)
    if (!e) return false
    try {
      e.view.webContents.sendInputEvent(args.event)
      return true
    } catch {
      return false
    }
  })
}
