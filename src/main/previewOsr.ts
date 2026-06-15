import type { IpcMain } from 'electron'
import { WebContentsView, BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import {
  isAllowedPreviewUrl,
  registerPreviewNavGuards,
  createOpenExternalLimiter,
  openExternalSafe,
  registerLoadLatch,
  registerCrashReadyGate,
  isHttpErrorCode,
  isErrorResponseCode
} from './preview'

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
 * touching the proven path. Security + lifecycle carry-overs now mirrored from the native
 * path: per-view in-memory session, deny-all permissions, http(s) nav-scheme allowlist,
 * frame-guarded IPC, the window.open deny+open-external limiter, and the shared
 * load-latch / crash-ready gate (emitting the same `preview:event` channel). Input (M3) is
 * forwarded via `preview:osrInput`; cursor + per-interaction focus-emulation feed back the
 * browser-like feel. Known-deferred: M1 DPR sharpness, M2 throughput, M4 responsive presets,
 * and the P1 fidelity gaps (IME, native select, clipboard) in the spike spec's gap register.
 */

interface OsrEntry {
  // Hidden offscreen BrowserWindow host — the window's size drives the render surface,
  // which a bare off-tree WebContentsView lacks (spec §8b: a WebContentsView loads but
  // emits zero frames; a hidden offscreen BrowserWindow paints a real, sized frame).
  osrWin: BrowserWindow
  // Last cursor type forwarded (diff-skip dedupe for the cursor-changed pump).
  lastCursorKey?: string
  // Load-failed latch (registerLoadLatch) + first-paint-ready flag (registerCrashReadyGate)
  // — the same lifecycle the native path uses so a dead/404/crashed server resolves state.
  failed: boolean
  ready: boolean
}

/** Browser-preview lifecycle event, emitted on the SAME `preview:event` channel the native
 *  path uses so the renderer's previewStore resolves connecting/connected/load-failed/crashed.
 *  Mirrors the renderer `PreviewEvent` union (minus the native-only `escape`). */
type OsrLifecycleEvent =
  | { id: string; type: 'did-finish-load'; url: string }
  | { id: string; type: 'did-navigate'; url: string; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'did-fail-load'; url: string; errorCode: number; errorDescription: string }
  | { id: string; type: 'did-start-navigation' }
  | { id: string; type: 'render-process-gone'; reason: string }

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

/** The offscreen page's current cursor, mirrored onto the host <canvas> so the preview
 *  shows an I-beam over inputs / pointer over links (a flat bitmap has no cursor of its
 *  own). `image` (a data URL) + `hotspot` are present only for type:'custom'. */
export interface OsrCursorPayload {
  id: string
  type: string
  image?: string
  hotspot?: { x: number; y: number }
  scale?: number
}

function emitFrame(payload: OsrFramePayload): void {
  try {
    owner?.webContents.send('preview:osrFrame', payload)
  } catch {
    /* window gone */
  }
}

function emitCursor(payload: OsrCursorPayload): void {
  try {
    owner?.webContents.send('preview:osrCursor', payload)
  } catch {
    /* window gone */
  }
}

function emitEvent(payload: OsrLifecycleEvent): void {
  try {
    owner?.webContents.send('preview:event', payload)
  } catch {
    /* window gone */
  }
}

/** Toggle CDP focus-emulation for one board's offscreen page (per-interaction; see ensureOsr).
 *  Enabled → blinking caret + :focus ring even though the window is never OS-focused;
 *  disabled → the page's blur/focusout fires (menus close, on-blur validation runs). */
function setOsrFocus(e: OsrEntry, focused: boolean): void {
  try {
    void e.osrWin.webContents.debugger
      .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: focused })
      .catch(() => {
        /* debugger detached / unsupported */
      })
  } catch {
    /* debugger not attached */
  }
}

/** Initial-load gate, shared by ensureOsr and its unit test. Scheme allowlist at the trust
 *  boundary (Bug #32): only http(s) loads. A rejected (non-http(s)) scheme must NOT silently
 *  skip the load — that left useOffscreenPreview stuck on 'connecting' forever and leaked an
 *  idle offscreen renderer (BUG-005). Mirror the native path (preview.ts preview:open): latch
 *  `failed` and emit a terminal synthetic did-fail-load (errorCode -1, 'blocked scheme') so the
 *  renderer transitions to 'load-failed'. */
export function applyOsrInitialLoad(
  id: string,
  url: string,
  e: { failed: boolean },
  load: (url: string) => void,
  emit: (ev: OsrLifecycleEvent) => void
): void {
  if (isAllowedPreviewUrl(url)) {
    load(url)
  } else {
    e.failed = true
    emit({ id, type: 'did-fail-load', url, errorCode: -1, errorDescription: 'blocked scheme' })
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
      // A never-shown window is background-throttled → rAF/timers pause, so the text
      // caret stops blinking and CSS hover/focus transitions freeze. Disabling throttling
      // keeps document.visibilityState 'visible', so the page feels live (research P0).
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Distinct from the native path's `preview-${id}` so the two never share a
      // session (cache / zoom / cookies) even if both exist across a spike toggle.
      partition: `preview-osr-${id}`
    }
  })
  const e: OsrEntry = { osrWin, failed: false, ready: false }
  osr.set(id, e)
  const wc = osrWin.webContents
  // Deny-all permissions on this view's session (untrusted localhost content) — same
  // posture as the native path (preview.ts).
  const sess = wc.session
  sess.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  sess.setPermissionCheckHandler(() => false)
  // http(s)-only nav scheme allowlist, shared with the native path.
  registerPreviewNavGuards(wc)
  // Page-driven popups: a previewed page's window.open / target=_blank / OAuth popup would
  // otherwise mint a REAL on-screen window OUTSIDE this view's deny-all/nav-guard/partition
  // posture (and a scripted page could tab-bomb the desktop). Deny in-window; open allowlisted
  // schemes in the OS browser via the token-bucket limiter — verbatim from the native path.
  const allowExternalOpen = createOpenExternalLimiter()
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    if (allowExternalOpen()) openExternalSafe(openUrl)
    return { action: 'deny' }
  })
  // A hidden, never-OS-focused window makes the page report document.hasFocus()===false:
  // no blinking caret, no :focus ring, dead autofocus. CDP focus-emulation fixes that — but
  // LATCHING it on permanently kills blur/focusout/visibilitychange (menus never close, on-blur
  // validation never fires, video never pauses, every board reports itself focused at once). So
  // attach the debugger here and drive emulation PER-INTERACTION via preview:osrFocus (enabled
  // when the board's canvas gains focus, disabled on blur → the page's blur/focusout fires).
  // ADR 0002 pre-authorizes CDP attach; MAIN-side only — does not weaken the renderer sandbox.
  try {
    wc.debugger.attach('1.3')
  } catch {
    /* devtools already attached / unsupported — caret falls back to wc.focus() only */
  }
  // Frame cap (M2 knob). The window size already set the render surface; the window is
  // never shown, so nothing paints above the HTML — the whole point of the spike.
  wc.setFrameRate(OSR_FRAME_RATE)
  wc.on('paint', (_ev, _dirty, image) => {
    const size = image.getSize()
    if (size.width === 0 || size.height === 0) return
    // toBitmap() (raw BGRA) — the correctly-typed equivalent of the legacy getBitmap().
    emitFrame({ id, width: size.width, height: size.height, buffer: image.toBitmap() })
  })
  // Mirror the offscreen page's cursor onto the host <canvas> (research P0). Signature:
  // (event, type, image, scale, size, hotspot). Standard types are deduped by `type`;
  // custom cursors ship a data URL (NativeImage can't cross IPC) + hotspot and always emit.
  wc.on('cursor-changed', (_ev, type, image, scale, _size, hotspot) => {
    if (type === 'custom') {
      if (image && !image.isEmpty()) {
        e.lastCursorKey = undefined // a following standard cursor must re-emit
        emitCursor({ id, type, image: image.toDataURL(), hotspot, scale })
      }
      return
    }
    if (e.lastCursorKey === type) return // diff-skip, like the frame pump
    e.lastCursorKey = type
    emitCursor({ id, type })
  })
  // Load / fail / crash lifecycle on the SAME preview:event channel the native path uses
  // (useOffscreenPreview consumes it → previewStore status), reusing the unit-tested latch +
  // crash-gate so a dead/404/crashed dev server resolves Connecting → Couldn't-load /
  // Preview-crashed + Reload instead of a frozen bitmap. startPainting() lives in the gate's
  // onReady so it re-arms on the FIRST load AND every crash-reload (the relaunched renderer
  // needs it again). On an initial failed load, onReady is latch-gated → no startPainting →
  // the canvas stays transparent and the board's "Couldn't load" fallback shows through.
  registerLoadLatch(wc, e, {
    getUrl: () => wc.getURL(),
    applyZoom: () => {}, // OSR has no per-board zoom factor (the M1 supersample is separate)
    onNavStart: () => emitEvent({ id, type: 'did-start-navigation' }),
    onSuccess: (loadedUrl) => emitEvent({ id, type: 'did-finish-load', url: loadedUrl }),
    onFail: (errorCode, errorDescription, validatedURL) =>
      emitEvent({ id, type: 'did-fail-load', url: validatedURL, errorCode, errorDescription })
  })
  registerCrashReadyGate(wc, e, {
    onReady: () => {
      try {
        wc.startPainting()
      } catch {
        /* not an OSR-capable webContents */
      }
    },
    onCrashed: (reason) => emitEvent({ id, type: 'render-process-gone', reason }),
    isFailed: () => e.failed
  })
  // Surface navigation for the URL bar + back/forward state. A 4xx/5xx response commits a
  // real error page but fires NO did-fail-load → carry the failure here (mirrors preview.ts).
  wc.on('did-navigate', (_ev, navUrl, httpResponseCode) => {
    if (isErrorResponseCode(httpResponseCode)) e.failed = true
    if (isHttpErrorCode(httpResponseCode))
      emitEvent({
        id,
        type: 'did-fail-load',
        url: navUrl,
        errorCode: httpResponseCode,
        errorDescription: `HTTP ${httpResponseCode}`
      })
    emitEvent({
      id,
      type: 'did-navigate',
      url: navUrl,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    })
  })
  wc.on('did-navigate-in-page', (_ev, navUrl, isMainFrame) => {
    if (!isMainFrame) return
    emitEvent({
      id,
      type: 'did-navigate',
      url: navUrl,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    })
  })
  applyOsrInitialLoad(
    id,
    url,
    e,
    (u) => void wc.loadURL(u),
    (ev) => emitEvent(ev)
  )
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
      const wc = e.osrWin.webContents
      // Keyboard only routes to the page's focused element if the offscreen WIDGET
      // is focused — but a hidden, never-shown window is never OS-focused, so typing
      // is silently dropped (mouse events hit-test by coordinate and don't need this).
      // Focus the offscreen webContents on click/keydown: for an offscreen window this
      // sets renderer-side focus WITHOUT stealing OS focus from the main window (no OS
      // surface), so the renderer keeps receiving the keystrokes it forwards here.
      if (args.event.type === 'mouseDown' || args.event.type === 'keyDown') {
        try {
          wc.focus()
        } catch {
          /* focus unavailable */
        }
      }
      wc.sendInputEvent(args.event)
      return true
    } catch {
      return false
    }
  })
  // URL-bar Back/Forward for an OSR board (the native preview:goBack/goForward operate on a
  // WebContentsView this path never creates, so in OSR mode those buttons would no-op). Mirror
  // the native handlers verbatim against the offscreen window's navigationHistory.
  ipcMain.handle('preview:osrGoBack', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = osr.get(id)
    if (!e) return false
    // try/catch like osrReload: a crash/concurrent-shutdown can leave the window in the Map
    // momentarily; a throw inside ipcMain.handle would surface as an unhandled IPC rejection.
    try {
      const wc = e.osrWin.webContents
      if (wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack()
        return true
      }
      return false
    } catch {
      return false
    }
  })
  ipcMain.handle('preview:osrGoForward', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = osr.get(id)
    if (!e) return false
    try {
      const wc = e.osrWin.webContents
      if (wc.navigationHistory.canGoForward()) {
        wc.navigationHistory.goForward()
        return true
      }
      return false
    } catch {
      return false
    }
  })
  // Reload CTA for a crashed/failed OSR board (the native preview:reload has no view here).
  ipcMain.handle('preview:osrReload', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = osr.get(id)
    if (!e) return false
    try {
      e.osrWin.webContents.reload()
      return true
    } catch {
      return false
    }
  })
  // Per-interaction focus emulation (P0): the renderer enables it on canvas focus, disables
  // on blur — so the caret/:focus ring show while interacting, and blur/focusout still fire.
  ipcMain.handle('preview:osrFocus', (ev, args: { id: string; focused: boolean }) => {
    if (isForeignSender(ev, getWin)) return false
    const e = osr.get(args.id)
    if (!e) return false
    setOsrFocus(e, args.focused)
    return true
  })
}
