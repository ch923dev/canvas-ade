import type { IpcMain } from 'electron'
import { WebContentsView, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { isForeignSender } from './ipcGuard'
import {
  isAllowedPreviewUrl,
  registerPreviewNavGuards,
  createOpenExternalLimiter,
  openExternalSafe,
  registerLoadLatch,
  clearLatchOnInPageRecovery,
  registerCrashReadyGate,
  isHttpErrorCode,
  isErrorResponseCode,
  type PreviewEvent
} from './previewShared'
import {
  attachOsrWidgets,
  registerOsrDownloads,
  applyEffectiveMute,
  applyOsrVolume,
  registerOsrWidgetIpc
} from './previewOsrWidgets'
import {
  wireOsrNetwork,
  registerOsrNetworkIpc,
  createNetState,
  stopNetFlush,
  type OsrNetState
} from './previewOsrNetwork'
import {
  OSR_WIDTH,
  OSR_HEIGHT,
  sanitizeOsrSize,
  applyOsrSize,
  type OsrSizeRequest
} from './previewOsrSizing'
import { scaleOsrInputEvent, type OsrInputEvent } from './previewOsrInput'

/**
 * Offscreen Browser-preview producer (OSR) — the SOLE preview engine since OS-3 Phase 5C deleted
 * the legacy native `WebContentsView` path (ADR 0002).
 *
 * Renders a Browser board's page OFFSCREEN (the window is NEVER added to the host window's native
 * view tree) and streams its frames to the renderer over `preview:osrFrame`, where they paint into
 * a DOM `<canvas>`. That is the occlusion fix: a `<canvas>` clips / rounds / z-orders like any DOM
 * node, so the native-overlay occlusion problem (ADR 0002) disappears.
 *
 * Each board gets its own `osr` Map entry + session partition. Security + lifecycle: per-view
 * in-memory session, deny-all permissions, http(s) nav-scheme allowlist, frame-guarded IPC, the
 * window.open deny + open-external limiter, and the shared load-latch / crash-ready gate (emitting
 * on the `preview:event` channel). Input (M3) is forwarded via `preview:osrInput`; cursor +
 * per-interaction focus-emulation feed back the browser-like feel; IME / clipboard / AltGr ride the
 * attached CDP debugger (Phase 3). M1 DPR sharpness, M2 throughput gating, and M4 responsive
 * presets all shipped.
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
  // Current offscreen render size (OS-3 Phase 1 — M1 supersample + M4 logical reflow).
  // `superSample` is re-applied as the page zoom factor on every did-finish-load (applyZoom),
  // so a SPA route / reload keeps the supersample. `sizeKey` is the no-op guard that skips a
  // redundant `setContentSize` relayout.
  logicalW: number
  logicalH: number
  superSample: number
  sizeKey?: string
  // OS-3 Phase 2 (M2 / 2A) — DESIRED paint state, driven by the renderer's settle-gated
  // liveness manager (`preview:osrSetPaint`). Default true (a board paints on first ready); an
  // off-screen / below-LOD board is set false → `wc.stopPainting()` (CPU→0, and the last frame
  // stays on the host <canvas> as a free static snapshot). The crash-ready gate's first
  // `startPainting` honors this flag, so a board that opens already-frozen never paints until it
  // becomes visible (then `preview:osrSetPaint(true)` → startPainting + invalidate).
  painting: boolean
  // OS-3 Phase 4 (4A) — the user's MANUAL mute choice (ephemeral; the toggle in the URL bar). The
  // EFFECTIVE mute applied to `wc.setAudioMuted` is `manualMuted || !painting`, so a frozen
  // off-screen board is silent without losing the user's choice (restored on resume).
  manualMuted: boolean
  // OS-3 Phase 4 (4A volume) — the user's emulated audio volume (0–1). Absent ⇒ full (the default,
  // so the common untouched-volume board carries no injection). Electron OSR has no native
  // per-window volume, so applyOsrVolume injects `el.volume` onto the page's HTML5 media; re-applied
  // on every did-finish-load (a fresh document resets it). See previewOsrWidgets.
  volume?: number
  // Last audible state emitted (diff-skip dedupe for the media-started/paused pump).
  lastAudible?: boolean
  // Removes the session `will-download` listener (4D). MUST run on dispose: the per-board session
  // (`preview-osr-${id}`) OUTLIVES the destroyed window, so a discarded listener would leak + double-
  // fire if the board id is ever reused (project restore / migration).
  teardownDownloads?: () => void
  // Per-board DevTools Network/WS capture (MAIN ring buffer + subscription state). See previewOsrNetwork.
  net: OsrNetState
}

// Browser-preview lifecycle events are the SHARED `PreviewEvent` union (previewShared) — emitted on
// the same `preview:event` channel the native path used. (Previously duplicated here as a local
// `OsrLifecycleEvent`; reusing the source of truth also carries `did-navigate.recovered` for FIND-010.)

const osr = new Map<string, OsrEntry>()
// A resize requested before its OSR window exists (the renderer's sizing hook fires on mount,
// same as the open) is buffered here and drained by ensureOsr — so the initial size lands
// without a window-less setContentSize and without a 1280→preset reflow flash on open.
const pendingSize = new Map<string, OsrSizeRequest>()
// A paint-state (`preview:osrSetPaint`) that raced ahead of its OSR window's open (the renderer's
// liveness manager reconciles on mount, same as the open) is buffered here and drained by
// ensureOsr — so a board that should open ALREADY-FROZEN (off-screen at mount) never paints a
// frame before the manager's decision lands. Default-true means an un-buffered board paints.
const pendingPaint = new Map<string, boolean>()
// A debounced follow-up `invalidate()` per board, scheduled after a REAL resize (applyOsrSize
// returned true). A large size jump (full-view enter) makes an idle page re-render asynchronously;
// the single synchronous invalidate inside applyOsrSize can fire before that re-render lands, so a
// static page would stay blank until the next resize. This re-invalidates once the layout settles
// (debounced so a drag-resize's burst collapses to a single trailing repaint).
const resizeSettle = new Map<string, ReturnType<typeof setTimeout>>()
const RESIZE_SETTLE_MS = 250
function scheduleResizeSettle(id: string): void {
  const existing = resizeSettle.get(id)
  if (existing) clearTimeout(existing)
  resizeSettle.set(
    id,
    setTimeout(() => {
      resizeSettle.delete(id)
      try {
        osr.get(id)?.osrWin.webContents.invalidate() // entry gone (closed) ⇒ no-op
      } catch {
        /* window torn down mid-timer */
      }
    }, RESIZE_SETTLE_MS)
  )
}
let owner: BrowserWindow | null = null

/** Frame-rate cap for the offscreen renderer (spec M2 throughput knob). */
const OSR_FRAME_RATE = 30

/** The frame-guarded IPC args for `preview:osrResize` (an `OsrSizeRequest` + the board id). */
export interface OsrResizeArgs extends OsrSizeRequest {
  id: string
}

/** A pixel rect (OS-3 Phase 2 / 2C — the dirty region of a frame). */
export interface OsrRect {
  x: number
  y: number
  width: number
  height: number
}

/** One offscreen-rendered frame pushed main → renderer (OS-3 Phase 2 / 2C — dirty-rect aware).
 *  `buffer` is the BGRA pixels of the DIRTY region only (cropped from the full paint); the
 *  renderer keeps its <canvas> at `full` size and blits `buffer` at `dirty`'s offset. A full
 *  repaint (first paint / resize / resume invalidate) sends `dirty == full`, which is just the
 *  whole-frame case — so there is no separate full-frame path. */
export interface OsrFramePayload {
  id: string
  /** The whole frame's pixel size (the <canvas> tracks this; a change re-sizes + clears it). */
  full: { width: number; height: number }
  /** The changed sub-rect this buffer covers (in the same supersampled surface px as `full`). */
  dirty: OsrRect
  /** NativeImage.toBitmap() of the DIRTY region — raw BGRA; the renderer swaps to RGBA. */
  buffer: Buffer
}

/** Minimal hidden-window surface `applyOsrPaint` drives — so paint-gating is unit-testable
 *  without a real Electron `BrowserWindow`. A `BrowserWindow` satisfies it structurally. */
interface OsrPaintTarget {
  webContents: { startPainting(): void; stopPainting(): void; invalidate(): void }
}
/** The mutable paint state `applyOsrPaint` reads/writes (the live `OsrEntry` satisfies it). */
interface OsrPaintState {
  painting: boolean
}

/**
 * Apply a desired paint state (M2 / 2A). Idempotent — a redundant set is a no-op (the manager
 * re-sends on every settle, so most sets are no-ops). On resume (false→true) `invalidate()`
 * forces one fresh repaint so the board never shows its stale pre-freeze frame for a beat (the
 * §8c "stale frame on resume" row); on freeze (true→false) `stopPainting()` drops CPU to ~0 and
 * the last frame stays on the host <canvas>.
 */
export function applyOsrPaint(win: OsrPaintTarget, state: OsrPaintState, on: boolean): void {
  if (state.painting === on) return // idempotent — already in the requested state
  state.painting = on
  try {
    if (on) {
      win.webContents.startPainting()
      win.webContents.invalidate()
    } else {
      win.webContents.stopPainting()
    }
  } catch {
    /* window gone / not OSR-capable */
  }
}

/** Clamp a paint `dirtyRect` to the frame's pixel bounds (defensive — a bogus rect would make
 *  `image.crop` throw or emit an off-canvas blit). Returns a zero-size rect if fully clipped. */
export function clampOsrDirty(dirty: OsrRect, full: { width: number; height: number }): OsrRect {
  const x = Math.max(0, Math.min(Math.floor(dirty.x), full.width))
  const y = Math.max(0, Math.min(Math.floor(dirty.y), full.height))
  const width = Math.max(0, Math.min(Math.ceil(dirty.width), full.width - x))
  const height = Math.max(0, Math.min(Math.ceil(dirty.height), full.height - y))
  return { x, y, width, height }
}

/**
 * The rect to actually ship for a paint (2C — hardened). Honors the dirty-rect crop ONLY at
 * supersample 1, where the paint `dirtyRect`'s coordinate space provably matches the physical
 * surface 1:1 (zoomFactor=1 ⇒ contentSize == logical, so DIP == device px). At S>1 the
 * dirtyRect-vs-`image` coordinate space is NOT guaranteed equal (a DIP-reported dirtyRect would
 * crop the wrong sub-region of a supersampled image), so we return the WHOLE frame instead — no
 * crop, no misalignment. The fast word-swizzle still applies on every frame; only the dirty-rect
 * BANDWIDTH win is skipped at S>1. (Most OSR setups report a full dirtyRect per paint anyway, so
 * this rarely changes anything in practice; it makes the S>1 path provably safe.)
 */
export function osrPaintRect(
  dirty: OsrRect,
  full: { width: number; height: number },
  superSample: number
): OsrRect {
  if (superSample === 1) return clampOsrDirty(dirty, full)
  return { x: 0, y: 0, width: full.width, height: full.height }
}

/* ── OS-3 Phase 3 (input fidelity) ──────────────────────────────────────────────────────────── */

/** Clipboard / selection edit verbs routed to the WebContents' OWN edit methods (Phase 3 / 3C).
 *  The previewed page's `navigator.clipboard` is denied (deny-all permissions), so a synthetic
 *  Ctrl+V cannot read the OS clipboard; `wc.paste()` is the trusted MAIN-side bridge (and copy/cut
 *  push the page selection to the OS clipboard). NOT forwarded as synthetic key chords. */
export type OsrEditAction = 'copy' | 'cut' | 'paste' | 'selectAll'

/** Minimal WebContents surface `applyOsrEdit` drives (a real `WebContents` satisfies it). */
interface OsrEditTarget {
  copy(): void
  cut(): void
  paste(): void
  selectAll(): void
}

/** Apply a clipboard/selection verb. `action` is typed `string` (defense-in-depth: the channel is
 *  frame-guarded but MAIN must never trust a forged verb) → an unknown verb is a no-op (returns
 *  false). Returns whether a verb actually ran. */
export function applyOsrEdit(wc: OsrEditTarget, action: string): boolean {
  switch (action) {
    case 'copy':
      wc.copy()
      return true
    case 'cut':
      wc.cut()
      return true
    case 'paste':
      wc.paste()
      return true
    case 'selectAll':
      wc.selectAll()
      return true
    default:
      return false
  }
}

/** Text-commit (`commit`) vs in-progress IME preview (`compose`) — Phase 3 / 3A+3B. */
export type OsrImeKind = 'compose' | 'commit'

/** Minimal WebContents surface `applyOsrIme` drives — the attached CDP debugger (ADR 0002) plus a
 *  `sendInputEvent` fallback. A real `WebContents` satisfies it. */
interface OsrImeTarget {
  debugger: {
    isAttached(): boolean
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
  sendInputEvent(event: OsrInputEvent): void
}

/**
 * Commit text / drive IME composition into the offscreen page (Phase 3 / 3A+3B). All TEXT (plain
 * typing, AltGr/dead-key results, and IME commits) routes here as `Input.insertText` over the
 * attached `wc.debugger` — so the page composes graphemes for us instead of us guessing modifiers.
 * In-progress composition (`compose`) drives `Input.imeSetComposition` for the inline underlined
 * preview (best-effort). `Input.insertText` commits the active composition (replacing the composing
 * range — no doubling) or inserts at the caret when none is active.
 *
 * Resilience: if the debugger is detached/unsupported (or `sendCommand` throws/rejects), `commit`
 * falls back to per-code-point `char` `sendInputEvent`s so text never silently drops — including on
 * an ASYNC CDP rejection (a rejected `Input.insertText` did not apply, so the char fallback can't
 * double-insert). `compose` falls back to a no-op (the inline preview just won't show — the eventual
 * `commit` still lands the text).
 */
function sendCharsFallback(wc: OsrImeTarget, text: string): void {
  try {
    for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch })
  } catch {
    /* window gone */
  }
}

export function applyOsrIme(wc: OsrImeTarget, kind: OsrImeKind, text: string): void {
  try {
    if (wc.debugger.isAttached()) {
      if (kind === 'compose') {
        void Promise.resolve(
          wc.debugger.sendCommand('Input.imeSetComposition', {
            text,
            selectionStart: text.length,
            selectionEnd: text.length
          })
        ).catch(() => {
          /* composition unsupported on this page — the commit still inserts */
        })
      } else {
        // A rejected insertText did NOT apply → fall back to char events so the text still lands
        // (mirrors the synchronous-detached path; a rejection can't have partially inserted).
        void Promise.resolve(wc.debugger.sendCommand('Input.insertText', { text })).catch(() => {
          sendCharsFallback(wc, text)
        })
      }
      return
    }
  } catch {
    /* debugger gone mid-call → fall through to the sendInputEvent fallback */
  }
  // No CDP: can't preview a composition, but a commit must still land — type each code point.
  if (kind === 'commit') sendCharsFallback(wc, text)
}

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

function emitEvent(payload: PreviewEvent): void {
  try {
    owner?.webContents.send('preview:event', payload)
  } catch {
    /* window gone */
  }
}

/* ── OS-3 Phase 4 emit helpers (native widgets & dialogs) ───────────────────────────────────────
 * Ferry a MAIN-detected page event to the renderer (its osrWidgetStore + OsrWidgetLayer draw the
 * dialog modal / popup overlay; downloads → showToast). One generic sender; audible diff-skips. */
function emitWidget(channel: string, payload: object): void {
  try {
    owner?.webContents.send(channel, payload)
  } catch {
    /* window gone */
  }
}

function emitAudible(e: OsrEntry, id: string, audible: boolean): void {
  if (e.lastAudible === audible) return // diff-skip, like the cursor/frame pumps
  e.lastAudible = audible
  emitWidget('preview:osrAudible', { id, audible })
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
 *  idle offscreen renderer (BUG-005). On the rejected branch, latch
 *  `failed` and emit a terminal synthetic did-fail-load (errorCode -1, 'blocked scheme') so the
 *  renderer transitions to 'load-failed'. */
export function applyOsrInitialLoad(
  id: string,
  url: string,
  e: { failed: boolean },
  load: (url: string) => void,
  emit: (ev: PreviewEvent) => void
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
      // Per-board partition: each Browser board gets its own session (cache / zoom / cookies), so
      // Chromium's per-host-per-session zoom doesn't sync across boards (ADR 0002).
      partition: `preview-osr-${id}`
    }
  })
  const e: OsrEntry = {
    osrWin,
    failed: false,
    ready: false,
    logicalW: OSR_WIDTH,
    logicalH: OSR_HEIGHT,
    superSample: 1,
    painting: true,
    manualMuted: false,
    net: createNetState()
  }
  osr.set(id, e)
  const wc = osrWin.webContents
  // Deny-all permissions on this view's session — untrusted localhost content never needs
  // camera / mic / geolocation / notifications, so reject every request + check.
  const sess = wc.session
  sess.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  sess.setPermissionCheckHandler(() => false)
  // http(s)-only nav scheme allowlist.
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
  // OS-3 Phase 4 — native widgets & dialogs over the just-attached debugger (ADR 0002, MAIN-only).
  // A bitmap can't composite native popups and a JS dialog freezes the hidden renderer, so we
  // intercept both via CDP and draw our own chrome; emit* ferry each to the renderer's overlay layer.
  attachOsrWidgets(wc, {
    onDialog: (info) => emitWidget('preview:osrDialog', { id, ...info }),
    onPopup: (info) => emitWidget('preview:osrPopup', { id, ...info }),
    getWin: () => owner
  })
  // Per-board DevTools Network/WS capture over the SAME debugger (MAIN-only, ADR 0002). Root Network
  // covers the main doc + all frames (incl. cross-origin iframes); flat-mode auto-attach adds workers
  // (verified 2026-06-21). Always-on into a bounded ring; deltas emit only while a panel is subscribed.
  wireOsrNetwork(wc, e.net, emitWidget, id)
  // Downloads (4D): saved into the project's `.canvas/downloads/` (ADR 0009; OS Downloads when no
  // project is open — no parented save-dialog freeze), resolved per-download + toast, token-bucket
  // throttled. Per-board session (`preview-osr-${id}`), so the listener is board-scoped.
  const allowDownload = createOpenExternalLimiter()
  e.teardownDownloads = registerOsrDownloads(sess, {
    exists: existsSync,
    allow: allowDownload,
    emit: (info) => emitWidget('preview:osrDownload', { id, ...info })
  })
  // Audio (4A): surface a mute toggle while the page plays media. media-started/paused fire
  // regardless of mute, so muting keeps the button visible; the emit is diff-skipped.
  wc.on('media-started-playing', () => emitAudible(e, id, true))
  wc.on('media-paused', () => emitAudible(e, id, false))
  // Frame cap (M2 knob). The window size already set the render surface; the window is
  // never shown, so nothing paints above the HTML — the whole point of OSR (occlusion-free).
  wc.setFrameRate(OSR_FRAME_RATE)
  wc.on('paint', (_ev, dirty, image) => {
    const size = image.getSize()
    if (size.width === 0 || size.height === 0) return
    // 2C — ship only the changed region (less IPC, smaller renderer-side swizzle). HARDENED:
    // crop ONLY at supersample 1 (where the paint dirtyRect's coordinate space matches the
    // physical surface 1:1); at S>1 osrPaintRect returns the whole frame, so a possible
    // DIP-vs-device dirtyRect mismatch can never misalign the patch. A full repaint (first paint
    // / resize / resume invalidate) reports dirty == the whole image → `isFull` skips the crop
    // and the renderer treats it as a whole-frame paint (also re-filling a just-resized canvas).
    const full = { width: size.width, height: size.height }
    const d = osrPaintRect(dirty, full, e.superSample)
    if (d.width === 0 || d.height === 0) return
    const isFull = d.x === 0 && d.y === 0 && d.width === size.width && d.height === size.height
    const patch = isFull ? image : image.crop(d)
    emitFrame({ id, full, dirty: d, buffer: patch.toBitmap() })
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
    // Re-apply the M1 supersample as the page zoom factor on every finish-load: a fresh
    // load / SPA route / crash-reload resets the host's zoom, so without this the page would
    // revert to 1× (blurry) after navigating. setContentSize persists across nav; zoom doesn't.
    applyZoom: () => {
      try {
        wc.setZoomFactor(e.superSample)
      } catch {
        /* not OSR-capable / window gone */
      }
      // 4A (volume) — a fresh document resets element volumes to 1 and drops the observer, so
      // re-establish a non-default level. Absent/default ⇒ skipped, keeping the common path
      // injection-free; applyOsrVolume itself no-ops/disconnects when the level is 1.
      if (e.volume !== undefined && e.volume !== 1) applyOsrVolume(wc, e.volume)
    },
    onNavStart: () => emitEvent({ id, type: 'did-start-navigation' }),
    onSuccess: (loadedUrl) => emitEvent({ id, type: 'did-finish-load', url: loadedUrl }),
    onFail: (errorCode, errorDescription, validatedURL) =>
      emitEvent({ id, type: 'did-fail-load', url: validatedURL, errorCode, errorDescription })
  })
  registerCrashReadyGate(wc, e, {
    onReady: () => {
      // 2A — honor the DESIRED paint state: a board that opened (or crash-reloaded) while
      // off-screen must NOT start painting; the liveness manager flips it on when it becomes
      // visible (preview:osrSetPaint(true) → startPainting + invalidate). Default true → the
      // common visible-at-open board paints on first ready exactly as before.
      if (!e.painting) return
      try {
        wc.startPainting()
        // PAIR startPainting WITH invalidate — exactly like the applyOsrPaint resume path
        // (startPainting + invalidate). For an IDLE page (paints once on load then never again)
        // startPainting alone is NOT a reliable first-frame trigger: other work on the
        // did-finish-load tick (e.g. wireOsrNetwork's armOsrNetwork → Network.enable +
        // Target.setAutoAttach CDP, registered before this gate) can consume/defer Chromium's
        // single implicit begin-frame, so the host <canvas> stays blank until the next resize
        // invalidate (the Network-panel-toggle "workaround"). invalidate() forces one fresh
        // whole-frame paint deterministically; it is a no-op while painting is stopped and never
        // double-paints (the same call applyOsrPaint already makes on resume).
        wc.invalidate()
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
    // FIND-010: an in-page (client-side) route commits real, non-error in-app content. If a prior
    // load-failure latched `e.failed` (a 4xx/5xx did-navigate), nothing else clears it for an SPA
    // route — registerLoadLatch only clears on a main-frame did-start-navigation, which an in-page
    // nav never fires — so the board stays stuck on 'load-failed'. Clear the latch and tell the
    // renderer to lift its stale load-failed state (the recovery helper was previously unwired).
    const recovered = clearLatchOnInPageRecovery(e)
    emitEvent({
      id,
      type: 'did-navigate',
      url: navUrl,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      ...(recovered ? { recovered: true } : {})
    })
  })
  // If a resize raced ahead of this open (the sizing hook fires on mount too), apply the
  // buffered size now — BEFORE load — so the page lays out at the right logical width from
  // the first paint (no 1280→preset reflow flash). Drains the pending entry.
  const pend = pendingSize.get(id)
  if (pend) {
    pendingSize.delete(id)
    // Mirror the preview:osrResize IPC handler: a REAL size change schedules a settle-catching
    // follow-up invalidate (the page re-renders asynchronously after a large size jump; the sync
    // invalidate inside applyOsrSize can fire before that lands). On the initial open this is the
    // belt-and-suspenders behind onReady's startPainting+invalidate — an idle page that still
    // missed its first frame self-recovers ~250ms later without depending on a user resize.
    if (applyOsrSize(osrWin, e, pend)) scheduleResizeSettle(id)
  }
  // 2A — if a paint-state raced ahead of this open (the liveness manager reconciles on mount),
  // drain it onto the desired flag BEFORE load so onReady honors it (a board that should open
  // already-frozen never paints a frame). startPainting itself is the gate's job, not here.
  const pendPaint = pendingPaint.get(id)
  if (pendPaint !== undefined) {
    pendingPaint.delete(id)
    e.painting = pendPaint
  }
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
  pendingSize.delete(id) // drop a buffered-but-never-applied resize
  pendingPaint.delete(id) // …and a buffered-but-never-applied paint-state
  const settle = resizeSettle.get(id) // cancel a pending settle-invalidate before the window dies
  if (settle) clearTimeout(settle)
  resizeSettle.delete(id) // Map.delete is idempotent when the id was never scheduled
  const e = osr.get(id)
  if (!e) return
  stopNetFlush(e.net) // cancel a pending Network delta flush before the window dies
  e.teardownDownloads?.() // 4D — remove the session will-download listener (the session outlives the window)
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
 * The offscreen window backing a board, or undefined when none is open. The capture + crash
 * helpers (previewOsrCapture.ts — used by the screenshot IPC and the e2e harness) read through
 * this so they need no access to the private `osr` Map.
 */
export function getOsrWindow(id: string): BrowserWindow | undefined {
  return osr.get(id)?.osrWin
}

/**
 * Self-test paint probe — does an OFF-TREE offscreen `WebContentsView` actually paint? Creates a
 * throwaway offscreen view (NEVER added to the window's view tree), loads `url`, and resolves on
 * the FIRST `paint` with the frame size — or a timeout/failure verdict. A headless viability check
 * (no headed app, no human eyes) for the offscreen→canvas approach. Standalone (its own session,
 * not in the live `osr` Map) so it never collides with real preview windows. Surfaced via the self-test.
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
 * Self-test paint probe variant — the production OSR host: a hidden offscreen `BrowserWindow` whose
 * size drives the render surface. The plain `WebContentsView` probe above renders 0×0 off-tree (no
 * window → no size); this confirms a hidden window paints a real frame, which is why "one hidden OSR
 * window per Browser board" is the producer rather than a bare WebContentsView.
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
  // Open the preview's current URL in the OS browser (for real DevTools / extensions). The
  // renderer passes the URL it already shows (liveUrl ?? board.url); the scheme stays
  // allowlisted via openExternalSafe (Bug #23) so nothing new reaches the OS handler that the
  // page's own window.open couldn't. Returns whether it actually opened (false = scheme blocked)
  // so the renderer can surface feedback. Frame-guarded (Bug #33). Engine-agnostic — lived in the
  // native preview module until 5C deleted it.
  ipcMain.handle('preview:openExternal', (ev, url: string) => {
    if (isForeignSender(ev, getWin)) return false
    return openExternalSafe(String(url))
  })
  // Forward a real OS input event to the offscreen view's webContents. The renderer sends pointer
  // coords in page-logical CSS px (the preset box); `scaleOsrInputEvent` scales them by this board's
  // live supersample (the page zoom factor) into the widget's coordinate space so the hover/click
  // lands under the real cursor — without it a supersampled (S>1) board hit-tests up-left of the
  // pointer (the hover-misalignment bug). Keyboard events pass through unscaled.
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
      wc.sendInputEvent(scaleOsrInputEvent(args.event, e.superSample))
      return true
    } catch {
      return false
    }
  })
  // Phase 3 / 3C — clipboard + select-all routed to the offscreen page's OWN edit methods (NOT a
  // synthetic Ctrl+V, which can't read the OS clipboard against the page's denied
  // navigator.clipboard). `wc.copy()/cut()` push the page selection to the OS clipboard;
  // `wc.paste()` pastes the OS clipboard into the page's focused field. Frame-guarded.
  ipcMain.handle('preview:osrEdit', (ev, args: { id: string; action: string }) => {
    if (isForeignSender(ev, getWin)) return false
    const e = osr.get(args.id)
    if (!e) return false
    try {
      return applyOsrEdit(e.osrWin.webContents, args.action)
    } catch {
      return false
    }
  })
  // Phase 3 / 3A+3B — commit text / drive IME composition into the offscreen page over the attached
  // CDP debugger (Input.insertText / Input.imeSetComposition). All TEXT (plain typing, AltGr/dead-key
  // results, IME commits) flows here from the renderer's hidden composition-proxy <textarea>; raw key
  // events stay on preview:osrInput. Frame-guarded; validates the discriminant + payload shape.
  ipcMain.handle('preview:osrIme', (ev, args: { id: string; kind: OsrImeKind; text: string }) => {
    if (isForeignSender(ev, getWin)) return false
    if (args.kind !== 'compose' && args.kind !== 'commit') return false
    if (typeof args.text !== 'string') return false
    const e = osr.get(args.id)
    if (!e) return false
    // Cap untrusted IME text at 2000 chars — the same trust-boundary cap as page dialog/prompt
    // strings (previewOsrWidgets MAX_TEXT). A composed commit is short in practice; this just
    // bounds a pathological proxy-textarea paste.
    applyOsrIme(e.osrWin.webContents, args.kind, args.text.slice(0, 2000))
    return true
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
  // Resize the offscreen surface (M1 supersample + M4 responsive logical width). Sent by the
  // renderer's settle-gated sizing hook ONLY on a settled-zoom / preset / board-resize change —
  // NOT per camera frame (the OSR path's whole win is zero per-frame camera IPC). If the window
  // isn't open yet (resize raced the open), buffer the latest request; ensureOsr drains it.
  ipcMain.handle('preview:osrResize', (ev, args: OsrResizeArgs) => {
    if (isForeignSender(ev, getWin)) return false
    const size = sanitizeOsrSize(args)
    const e = osr.get(args.id)
    if (!e) {
      pendingSize.set(args.id, size)
      return true
    }
    if (applyOsrSize(e.osrWin, e, size)) scheduleResizeSettle(args.id)
    return true
  })
  // M2 / 2A — set a board's desired paint state. Sent by the renderer's settle-gated liveness
  // manager ONLY when a board's visibility flips (on-screen ⇄ off-screen / below-LOD), NOT per
  // frame. A `false` stops the offscreen paint pump (CPU→0; the last frame stays on the canvas as
  // a free snapshot); a `true` resumes + invalidates (fresh repaint, no stale frame). If the
  // window isn't open yet (the manager raced the open), buffer it; ensureOsr drains it pre-load.
  ipcMain.handle('preview:osrSetPaint', (ev, args: { id: string; painting: boolean }) => {
    if (isForeignSender(ev, getWin)) return false
    const on = args.painting === true
    const e = osr.get(args.id)
    if (!e) {
      pendingPaint.set(args.id, on)
      return true
    }
    applyOsrPaint(e.osrWin, e, on)
    // 4A — a frozen off-screen board is auto-muted; on resume the user's manual choice is restored.
    applyEffectiveMute(e)
    return true
  })
  // Tear down EVERY offscreen window + its per-board session listeners in one shot — the canonical
  // project-switch / e2e-reset teardown (mirrors native preview:closeAll). Per-board cleanup also
  // runs on board unmount (useOffscreenPreview), but that races React commit timing; this is the
  // deterministic sweep so an OSR window/session can't leak across a project switch or e2e spec.
  ipcMain.handle('preview:osrCloseAll', (ev) => {
    if (isForeignSender(ev, getWin)) return true
    disposeAllOsr()
    return true
  })
  // OS-3 Phase 4 — native-widget handlers (mute · dialog respond · popup commit/dismiss · reveal
  // download). Registered from previewOsrWidgets.ts (frame-guarded there) so this file stays focused.
  registerOsrWidgetIpc(ipcMain, getWin, (id) => osr.get(id))
  // Per-board DevTools Network handlers (subscribe · unsubscribe · clear · setPreserve · getBody),
  // frame-guarded in previewOsrNetwork.ts; `emit` injects the board id onto the shared widget channel.
  registerOsrNetworkIpc(
    ipcMain,
    getWin,
    (id) => osr.get(id),
    (id, msg) => emitWidget('preview:osrNet', { id, ...msg })
  )
}
