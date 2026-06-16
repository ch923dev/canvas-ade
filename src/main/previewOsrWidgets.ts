import { app, dialog, shell } from 'electron'
import type { BrowserWindow, WebContents, Session, DownloadItem, IpcMain } from 'electron'
import { basename, join, resolve, sep } from 'node:path'
import { isForeignSender } from './ipcGuard'

/**
 * OS-3 Phase 4 — MAIN-side native-widget & dialog support for the OSR Browser preview.
 *
 * The previewed page renders in a hidden offscreen window (`previewOsr.ts`), so every
 * OS-composited affordance silently breaks: `<select>`/date/color popups never render, a JS
 * `confirm`/`prompt` FREEZES the renderer waiting for a native modal it can't show, the file
 * chooser is un-parented, downloads are unhandled, and `<video>` audio plays from an invisible
 * window with no mute. This module fixes them over the **already-attached `wc.debugger`** (ADR 0002
 * pre-authorizes the CDP attach; MAIN-side only — the renderer sandbox is untouched) plus the
 * per-board session. Kept out of `previewOsr.ts` so that file stays focused; `ensureOsr` calls
 * `attachOsrWidgets` once after attaching the debugger.
 *
 * Security: the injected page hook runs in the *previewed* page's world (already untrusted),
 * authored here; it only reports widget data + sets a value on our command. All page-supplied
 * strings (dialog message, option labels, download filenames) are treated as untrusted — capped +
 * sanitized here and rendered as escaped text in the renderer.
 */

/* ── Emitted payloads (mirrored in preload + renderer) ───────────────────────────────────────── */

export type OsrDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

/** A JS dialog the page opened (CDP `Page.javascriptDialogOpening`). `beforeunload` is auto-handled
 *  in MAIN and never emitted. */
export interface OsrDialogInfo {
  dialogType: OsrDialogType
  message: string
  defaultPrompt: string
}

export type OsrPopupKind = 'select' | 'date' | 'color'

export interface OsrSelectOption {
  label: string
  value: string
  selected: boolean
  disabled: boolean
}

/** A native popup widget the page is opening (`<select>`/date/color), reported by the injected
 *  hook. `rect` is in PAGE CSS px; the renderer maps it into the frame and draws the overlay. */
export interface OsrPopupInfo {
  kind: OsrPopupKind
  rect: { x: number; y: number; width: number; height: number }
  value: string
  options?: OsrSelectOption[]
  multiple?: boolean
}

export type OsrDownloadState = 'start' | 'progress' | 'done' | 'fail' | 'throttled'

export interface OsrDownloadInfo {
  state: OsrDownloadState
  name: string
  savePath?: string
  received?: number
  total?: number
}

const MAX_TEXT = 2000 // cap untrusted dialog/prompt strings at the trust boundary
const MAX_OPTIONS = 256
const MAX_LABEL = 256
// Windows-illegal filename chars (the reserved set; space/dash are legal and kept). Control chars
// are stripped separately by char code, so this regex carries no control char (no disable needed).
const RESERVED_NAME_CHARS = /[<>:"/|?*]/g

/* ── Pure helpers (unit-tested) ──────────────────────────────────────────────────────────────── */

/**
 * Sanitize a page-supplied download filename to a safe, single-segment basename: strip any path
 * (traversal defense), drop control + Windows-reserved chars, collapse to `download` if it empties.
 * Length-capped. NOT de-collided (see `uniqueSavePath`).
 */
export function sanitizeDownloadName(raw: string): string {
  // basename strips `../` etc.; also strip backslashes (Windows separators) by hand first.
  const base = basename(String(raw ?? '').replace(/\\/g, '/'))
  const cleaned = Array.from(base.replace(RESERVED_NAME_CHARS, ''))
    .filter((c) => c.charCodeAt(0) >= 32) // drop control chars without a control-char regex
    .join('')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned || 'download').slice(0, 180)
}

/**
 * A non-colliding save path inside `dir` for `name`: appends ` (1)`, ` (2)`, … before the extension
 * until `exists(path)` is false. `exists` is injected so this is unit-testable without fs.
 */
export function uniqueSavePath(dir: string, name: string, exists: (p: string) => boolean): string {
  const first = join(dir, name)
  if (!exists(first)) return first
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`)
    if (!exists(candidate)) return candidate
  }
  return join(dir, `${stem} (${Date.now()})${ext}`) // pathological fallback
}

/**
 * Parse + validate an untrusted `__osrWidget` binding payload (a JSON string from the previewed
 * page) into an `OsrPopupInfo`, or null if malformed. Caps option count + label length and coerces
 * the rect to finite numbers — defense-in-depth: a scripted page could call the binding with junk.
 */
export function parseWidgetPayload(raw: string): OsrPopupInfo | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const kind = o.kind
  if (kind !== 'select' && kind !== 'date' && kind !== 'color') return null
  const r = o.rect as Record<string, unknown> | undefined
  if (!r) return null
  const num = (v: unknown): number => (Number.isFinite(v) ? (v as number) : 0)
  const rect = { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }
  const value = typeof o.value === 'string' ? o.value.slice(0, MAX_TEXT) : ''
  const info: OsrPopupInfo = { kind, rect, value }
  if (kind === 'select' && Array.isArray(o.options)) {
    info.multiple = o.multiple === true
    info.options = o.options.slice(0, MAX_OPTIONS).map((raw2) => {
      const op = (raw2 ?? {}) as Record<string, unknown>
      return {
        label: typeof op.label === 'string' ? op.label.slice(0, MAX_LABEL) : '',
        value: typeof op.value === 'string' ? op.value.slice(0, MAX_LABEL) : '',
        selected: op.selected === true,
        disabled: op.disabled === true
      }
    })
  }
  return info
}

/** Whether a dialog should be auto-handled in MAIN (no UI). `beforeunload` must never prompt in a
 *  preview (a reload/nav would wedge on it); everything else surfaces the modal. */
export function isAutoDialog(type: string): boolean {
  return type === 'beforeunload'
}

/* ── CDP / session wiring ────────────────────────────────────────────────────────────────────── */

/**
 * The page hook injected into every document (CDP `addScriptToEvaluateOnNewDocument` + an immediate
 * eval for the already-loaded page). Runs in the previewed page's main world. On a capture-phase
 * pointerdown of a `<select>`/date/color control it suppresses the (non-rendering) native popup and
 * reports the widget's rect + state to MAIN via the `__osrWidget` binding; `__osrSetWidgetValue`
 * writes a value back + fires input/change so controlled React forms update.
 */
export const OSR_WIDGET_SCRIPT = `(function () {
  if (window.__osrWidgetInstalled) return;
  window.__osrWidgetInstalled = true;
  var active = null;
  var SEL = 'select, input[type="date"], input[type="color"]';
  function kindOf(el) {
    if (el.tagName === 'SELECT') return 'select';
    var t = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'date') return 'date';
    if (t === 'color') return 'color';
    return null;
  }
  function report(el) {
    var kind = kindOf(el);
    if (!kind) return;
    active = el;
    var r = el.getBoundingClientRect();
    var payload = { kind: kind, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, value: el.value };
    if (kind === 'select') {
      var opts = [];
      for (var i = 0; i < el.options.length && i < 256; i++) {
        var o = el.options[i];
        opts.push({ label: String(o.label || o.text || ''), value: o.value, selected: o.selected, disabled: o.disabled });
      }
      payload.options = opts;
      payload.multiple = !!el.multiple;
    }
    try { if (typeof window.__osrWidget === 'function') window.__osrWidget(JSON.stringify(payload)); } catch (e) {}
  }
  document.addEventListener('pointerdown', function (e) {
    var t = e.target;
    var el = t && t.closest ? t.closest(SEL) : null;
    if (!el || el.disabled) return;
    e.preventDefault();
    try { el.focus({ preventScroll: true }); } catch (e2) {}
    report(el);
  }, true);
  window.__osrSetWidgetValue = function (value) {
    var el = active;
    if (!el) return false;
    try {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  };
})();`

/** Minimal CDP surface the per-call helpers drive (a real `WebContents` satisfies it). */
export interface OsrCdp {
  debugger: {
    isAttached(): boolean
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
}

/** Side-effects the CDP-message dispatcher invokes — injected so the routing is unit-testable
 *  without a real `WebContents`/debugger. */
export interface CdpMessageActions {
  /** A dialog we don't surface (beforeunload) — accept it so a reload/nav never wedges. */
  acceptAutoDialog: () => void
  /** A JS dialog to surface as the modal. */
  onDialog: (info: OsrDialogInfo) => void
  /** A native file chooser opened — show the OS dialog + feed the result back. */
  onFileChooser: (params: Record<string, unknown>) => void
  /** A native popup widget is opening — draw the overlay. */
  onPopup: (info: OsrPopupInfo) => void
}

/**
 * Route one CDP `wc.debugger` event to the right Phase-4 action. Pure (no Electron) so the dialog /
 * file-chooser / popup discrimination + the untrusted-payload validation are unit-tested directly.
 */
export function dispatchCdpMessage(method: string, params: unknown, a: CdpMessageActions): void {
  const p = (params ?? {}) as Record<string, unknown>
  if (method === 'Page.javascriptDialogOpening') {
    const type = String(p.type ?? 'alert')
    if (isAutoDialog(type)) {
      a.acceptAutoDialog()
      return
    }
    a.onDialog({
      dialogType: (type === 'confirm' || type === 'prompt' ? type : 'alert') as OsrDialogType,
      message: String(p.message ?? '').slice(0, MAX_TEXT),
      defaultPrompt: String(p.defaultPrompt ?? '').slice(0, MAX_TEXT)
    })
  } else if (method === 'Page.fileChooserOpened') {
    a.onFileChooser(p)
  } else if (method === 'Runtime.bindingCalled' && p.name === '__osrWidget') {
    const info = parseWidgetPayload(String(p.payload ?? ''))
    if (info) a.onPopup(info)
  }
}

export interface OsrWidgetDeps {
  /** A JS dialog opened (non-`beforeunload`) — surface the modal. */
  onDialog: (info: OsrDialogInfo) => void
  /** A native popup widget is opening — draw the overlay. */
  onPopup: (info: OsrPopupInfo) => void
  /** The main window, for parenting the native file dialog. */
  getWin: () => BrowserWindow | null
}

const cdp = (wc: OsrCdp, method: string, params?: Record<string, unknown>): void => {
  try {
    void Promise.resolve(wc.debugger.sendCommand(method, params)).catch(() => {
      /* domain unsupported / window gone */
    })
  } catch {
    /* debugger detached */
  }
}

/**
 * Wire dialog interception, the file-chooser bridge, and the popup-widget hook onto an offscreen
 * board's webContents. Called once from ensureOsr after the debugger attaches. All CDP calls are
 * best-effort; a detached debugger degrades to the pre-Phase-4 (broken-popup) behaviour, never a throw.
 */
export function attachOsrWidgets(wc: WebContents, deps: OsrWidgetDeps): void {
  if (!wc.debugger.isAttached()) return
  cdp(wc, 'Page.enable')
  cdp(wc, 'Runtime.enable')
  cdp(wc, 'DOM.enable')
  cdp(wc, 'Runtime.addBinding', { name: '__osrWidget' })
  cdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: true })
  cdp(wc, 'Page.addScriptToEvaluateOnNewDocument', { source: OSR_WIDGET_SCRIPT })
  cdp(wc, 'Runtime.evaluate', { expression: OSR_WIDGET_SCRIPT }) // already-loaded page

  wc.debugger.on('message', (_e, method, params) =>
    dispatchCdpMessage(method, params, {
      acceptAutoDialog: () => cdp(wc, 'Page.handleJavaScriptDialog', { accept: true }),
      onDialog: deps.onDialog,
      onFileChooser: (p) => void handleFileChooser(wc, deps.getWin, p),
      onPopup: deps.onPopup
    })
  )
}

/** Resolve a `Page.fileChooserOpened` by showing a real, parented OS dialog and feeding the picked
 *  paths back via `DOM.setFileInputFiles`. Cancel → set no files (releases the chooser). */
async function handleFileChooser(
  wc: WebContents,
  getWin: () => BrowserWindow | null,
  params: Record<string, unknown>
): Promise<void> {
  const backendNodeId = params.backendNodeId as number | undefined
  if (backendNodeId === undefined) return
  const multi = params.mode === 'selectMultiple'
  const props: Array<'openFile' | 'multiSelections'> = multi
    ? ['openFile', 'multiSelections']
    : ['openFile']
  let files: string[] = []
  try {
    const win = getWin()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: props })
      : await dialog.showOpenDialog({ properties: props })
    files = res.canceled ? [] : res.filePaths
  } catch {
    files = []
  }
  cdp(wc, 'DOM.setFileInputFiles', { files, backendNodeId })
}

/* ── Per-call CDP actions (invoked from the IPC handlers in previewOsr.ts) ───────────────────── */

/** Apply / clear the audio mute on an offscreen board (4A). */
export function applyOsrMuted(wc: { setAudioMuted(m: boolean): void }, muted: boolean): void {
  try {
    wc.setAudioMuted(muted)
  } catch {
    /* window gone */
  }
}

/** Answer an open JS dialog (4B). `promptText` is sent only for a prompt OK. */
export function respondOsrDialog(wc: OsrCdp, accept: boolean, promptText?: string): void {
  const params: Record<string, unknown> = { accept }
  if (accept && typeof promptText === 'string') params.promptText = promptText
  cdp(wc, 'Page.handleJavaScriptDialog', params)
}

/** Write a value back into the active popup widget (4E commit) via the injected setter. */
export function setOsrWidgetValue(wc: OsrCdp, value: string): void {
  // JSON-encode so any quotes/newlines in the value are safe inside the evaluated expression.
  cdp(wc, 'Runtime.evaluate', {
    expression: `window.__osrSetWidgetValue(${JSON.stringify(String(value))})`
  })
}

/* ── Downloads (4D) ──────────────────────────────────────────────────────────────────────────── */

export interface OsrDownloadDeps {
  downloadsDir: string
  exists: (p: string) => boolean
  /** Token-bucket gate (the `createOpenExternalLimiter` pattern) — false ⇒ over budget, cancel. */
  allow: () => boolean
  emit: (info: OsrDownloadInfo) => void
}

/**
 * Policy for a board's downloads: save to the OS Downloads folder (no parented save-dialog freeze),
 * emit start/progress/done/fail toasts, throttle abusive bursts. Returns a teardown that removes the
 * session listener. The session is the per-board `preview-osr-${id}` partition.
 */
export function registerOsrDownloads(session: Session, deps: OsrDownloadDeps): () => void {
  const onWillDownload = (event: Electron.Event, item: DownloadItem): void => {
    if (!deps.allow()) {
      event.preventDefault()
      deps.emit({ state: 'throttled', name: sanitizeDownloadName(item.getFilename()) })
      return
    }
    const name = sanitizeDownloadName(item.getFilename())
    const savePath = uniqueSavePath(deps.downloadsDir, name, deps.exists)
    item.setSavePath(savePath)
    deps.emit({ state: 'start', name, savePath, total: item.getTotalBytes() })
    item.on('updated', (_e, state) => {
      if (state === 'progressing')
        deps.emit({
          state: 'progress',
          name,
          savePath,
          received: item.getReceivedBytes(),
          total: item.getTotalBytes()
        })
    })
    item.once('done', (_e, state) => {
      if (state === 'completed') deps.emit({ state: 'done', name, savePath })
      else deps.emit({ state: 'fail', name, savePath })
    })
  }
  session.on('will-download', onWillDownload)
  return () => session.removeListener('will-download', onWillDownload)
}

/** Reveal a completed download in the OS file manager (the toast's Show action). Defense-in-depth:
 *  only ever reveal a path INSIDE the OS Downloads dir — the sole place OSR downloads are written
 *  (`uniqueSavePath(downloadsDir, …)` above). A path that escapes the Downloads dir is dropped, so a
 *  compromised renderer can't use this to open an arbitrary location in the OS file manager. */
export function revealDownload(savePath: string): void {
  try {
    const downloads = app.getPath('downloads')
    const full = resolve(savePath)
    if (full !== downloads && !full.startsWith(downloads + sep)) return
    shell.showItemInFolder(full)
  } catch {
    /* path gone / app not ready */
  }
}

/* ── IPC handlers (registered from previewOsr.ts, kept here so that file stays under budget) ──── */

/** The minimal `OsrEntry` shape the Phase-4 handlers need (the live entry satisfies it). */
export interface OsrWidgetEntry {
  osrWin: { webContents: WebContents }
  manualMuted: boolean
  painting: boolean
}

/** Apply the EFFECTIVE mute (manual choice OR not-painting) to an offscreen board (4A). Called on a
 *  manual toggle and on every paint-state flip so a frozen board is silent yet restores on resume. */
export function applyEffectiveMute(e: OsrWidgetEntry): void {
  applyOsrMuted(e.osrWin.webContents, e.manualMuted || !e.painting)
}

/** Register the Phase-4 renderer→MAIN handlers (mute · dialog respond · popup commit/dismiss ·
 *  reveal-download). All `isForeignSender` frame-guarded; `getEntry` resolves the live OSR entry. */
export function registerOsrWidgetIpc(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  getEntry: (id: string) => OsrWidgetEntry | undefined
): void {
  // 4A — manual mute toggle. Effective mute = manual || !painting (auto-muted while frozen).
  ipcMain.handle('preview:osrSetMuted', (ev, args: { id: string; muted: boolean }) => {
    if (isForeignSender(ev, getWin)) return false
    const e = getEntry(args.id)
    if (!e) return false
    e.manualMuted = args.muted === true
    applyEffectiveMute(e)
    return true
  })
  // 4B — answer the open JS dialog (accept + prompt text) → CDP handleJavaScriptDialog. A stray
  // respond with no open dialog is a harmless no-op.
  ipcMain.handle(
    'preview:osrDialogRespond',
    (ev, args: { id: string; accept: boolean; promptText?: string }) => {
      if (isForeignSender(ev, getWin)) return false
      const e = getEntry(args.id)
      if (!e) return false
      // Cap the user-typed reply at MAX_TEXT before it reaches CDP (page-originated dialog text is
      // already capped on the way in; this caps the way out for symmetry).
      respondOsrDialog(
        e.osrWin.webContents,
        args.accept === true,
        typeof args.promptText === 'string' ? args.promptText.slice(0, MAX_TEXT) : undefined
      )
      return true
    }
  )
  // 4E — commit the overlay's chosen value into the active popup widget via the injected setter.
  ipcMain.handle('preview:osrPopupCommit', (ev, args: { id: string; value: string }) => {
    if (isForeignSender(ev, getWin)) return false
    if (typeof args.value !== 'string') return false
    const e = getEntry(args.id)
    if (!e) return false
    setOsrWidgetValue(e.osrWin.webContents, args.value.slice(0, MAX_TEXT))
    return true
  })
  // 4E — overlay dismissed (click-away / Esc) with no write. No CDP needed (no real popup opened);
  // an explicit channel kept for symmetry. Beyond the frame-guard the renderer just clears its state.
  ipcMain.handle('preview:osrPopupDismiss', (ev, _id: string) => {
    if (isForeignSender(ev, getWin)) return false
    return true
  })
  // 4D — reveal a completed download in the OS file manager (the toast's Show action).
  ipcMain.handle('preview:osrRevealDownload', (ev, savePath: string) => {
    if (isForeignSender(ev, getWin)) return false
    if (typeof savePath !== 'string' || !savePath) return false
    revealDownload(savePath)
    return true
  })
}
