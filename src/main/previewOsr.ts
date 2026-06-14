import type { IpcMain } from 'electron'
import { WebContentsView, BrowserWindow } from 'electron'
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
  // Hidden offscreen BrowserWindow host — the window's size drives the render surface,
  // which a bare off-tree WebContentsView lacks (spec §8b: a WebContentsView loads but
  // emits zero frames; a hidden offscreen BrowserWindow paints a real, sized frame).
  osrWin: BrowserWindow
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
  // Hidden offscreen BrowserWindow (never shown, off the taskbar). Its width/height set
  // the render surface — the proven OSR host (spec §8b).
  const osrWin = new BrowserWindow({
    width: OSR_WIDTH,
    height: OSR_HEIGHT,
    show: false,
    skipTaskbar: true,
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
  const e: OsrEntry = { osrWin }
  osr.set(id, e)
  const wc = osrWin.webContents
  // Deny-all permissions on this view's session (untrusted localhost content) — same
  // posture as the native path (preview.ts).
  const sess = wc.session
  sess.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  sess.setPermissionCheckHandler(() => false)
  // http(s)-only nav scheme allowlist, shared with the native path.
  registerPreviewNavGuards(wc)
  // Frame cap (M2 knob). The window size already set the render surface; the window is
  // never shown, so nothing paints above the HTML — the whole point of the spike.
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
  // Kick the offscreen frame scheduler once content loads — the probe showed the hidden
  // window needs startPainting() to emit its first frame. Harmless if already painting.
  wc.once('did-finish-load', () => {
    try {
      wc.startPainting()
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
    e.osrWin.destroy() // hidden offscreen window — destroy to free the renderer
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

/**
 * SPIKE probe (spec §5 Q1) — does an OFF-TREE offscreen WebContentsView actually paint?
 *
 * Creates a throwaway offscreen view (NEVER added to the window's view tree), loads
 * `url`, and resolves on the FIRST `paint` with the frame size — or a timeout/failure
 * verdict. Answers the make-or-break question headlessly (no headed app, no human eyes):
 * if this resolves `painted:true` with non-zero dimensions, the whole offscreen→canvas
 * approach is alive and M1/M2 can proceed. Standalone (its own session, not in the live
 * `osr` Map) so it never collides with real spike views. Surfaced via the self-test.
 */
export function probeOsrPaint(
  url: string,
  timeoutMs = 8000
): Promise<{ painted: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false
    let loaded = false
    const view = new WebContentsView({
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'preview-osr-probe'
      }
    })
    const wc = view.webContents
    const finish = (painted: boolean, detail: string): void => {
      if (done) return
      done = true
      try {
        wc.close() // throwaway view — close or leak the renderer
      } catch {
        /* already gone */
      }
      resolve({ painted, detail })
    }
    if (!isAllowedPreviewUrl(url)) {
      finish(false, `blocked/empty url: ${url || '(none)'}`)
      return
    }
    let paints = 0
    let lastSize = '0x0'
    view.setBounds({ x: 0, y: 0, width: OSR_WIDTH, height: OSR_HEIGHT })
    wc.setFrameRate(OSR_FRAME_RATE)
    wc.on('paint', (_ev, _dirty, image) => {
      const size = image.getSize()
      paints++
      lastSize = `${size.width}x${size.height}`
      // Ignore pre-layout 0×0 frames; only a real, sized frame proves the path works.
      if (size.width > 0 && size.height > 0)
        finish(true, `painted ${lastSize} (after ${paints} paints)`)
    })
    wc.once('did-finish-load', () => {
      loaded = true
      try {
        wc.startPainting() // nudge the offscreen frame scheduler
      } catch {
        /* not an OSR-capable webContents */
      }
    })
    wc.once('did-fail-load', (_e, code, desc) => finish(false, `did-fail-load ${code} ${desc}`))
    void wc.loadURL(url)
    setTimeout(() => {
      let painting = 'n/a'
      try {
        painting = String(wc.isPainting())
      } catch {
        /* gone */
      }
      finish(
        false,
        `no sized paint in ${timeoutMs}ms (paints=${paints}, last=${lastSize}, finishLoad=${loaded}, painting=${painting})`
      )
    }, timeoutMs)
  })
}

/**
 * SPIKE probe variant (spec §5 Q1, transport choice) — the DOCUMENTED OSR host: a
 * hidden offscreen `BrowserWindow` whose size drives the render surface. The plain
 * `WebContentsView` probe above renders 0×0 off-tree (no window → no size); this checks
 * whether a hidden window paints a real frame, which would make "one hidden OSR window
 * per Browser board" the viable producer instead of a bare WebContentsView.
 */
export function probeOsrPaintWindow(
  url: string,
  timeoutMs = 8000
): Promise<{ painted: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false
    let loaded = false
    const win = new BrowserWindow({
      width: OSR_WIDTH,
      height: OSR_HEIGHT,
      show: false,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'preview-osr-probe-win'
      }
    })
    const wc = win.webContents
    const finish = (painted: boolean, detail: string): void => {
      if (done) return
      done = true
      try {
        win.destroy()
      } catch {
        /* already gone */
      }
      resolve({ painted, detail })
    }
    if (!isAllowedPreviewUrl(url)) {
      finish(false, `blocked/empty url: ${url || '(none)'}`)
      return
    }
    let paints = 0
    let lastSize = '0x0'
    wc.setFrameRate(OSR_FRAME_RATE)
    wc.on('paint', (_ev, _dirty, image) => {
      const size = image.getSize()
      paints++
      lastSize = `${size.width}x${size.height}`
      if (size.width > 0 && size.height > 0)
        finish(true, `painted ${lastSize} (after ${paints} paints)`)
    })
    wc.once('did-finish-load', () => {
      loaded = true
      try {
        wc.startPainting()
      } catch {
        /* not an OSR-capable webContents */
      }
    })
    wc.once('did-fail-load', (_e, code, desc) => finish(false, `did-fail-load ${code} ${desc}`))
    void wc.loadURL(url)
    setTimeout(
      () =>
        finish(
          false,
          `no sized paint in ${timeoutMs}ms (paints=${paints}, last=${lastSize}, finishLoad=${loaded})`
        ),
      timeoutMs
    )
  })
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
      e.osrWin.webContents.sendInputEvent(args.event)
      return true
    } catch {
      return false
    }
  })
}
