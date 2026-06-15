import { join } from 'path'
import type { BrowserWindow as BrowserWindowType, IpcMain } from 'electron'
import { BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * Hidden Mermaid render worker (S4 — Planning Diagram element).
 *
 * Renders Mermaid source text → SVG inside a NEVER-SHOWN `BrowserWindow` (`show:false,
 * sandbox:true`), then hands the SVG string back to the renderer, which caches it as a
 * content-addressed asset and displays it as an inert `<img>`. The window is the only place in the
 * app granted `script-src 'unsafe-eval'` (Mermaid 11 needs it for dagre / `new Function`) — scoped
 * by `DIAGRAM_WORKER_CSP` (csp.ts) to that one invisible window; the main window CSP stays locked.
 *
 * Why a real Chromium window, not jsdom-in-MAIN: Mermaid measures text via
 * `getComputedTextLength` / `getBBox`, which jsdom/happy-dom stub to 0 — silently corrupting every
 * non-trivial diagram. A hidden BrowserWindow has a live, laid-out document (the `previewOsr.ts`
 * precedent). Security model: `securityLevel:'strict'` is FORCED in worker.html (DOMPurify-sanitized
 * SVG, no html labels), the source is embedded injection-safely (URI-encoded) into the
 * `executeJavaScript` expression and NEVER reaches a PTY (ADR 0003), and a render is hard-capped in
 * size + time. ONE shared window, renders SERIALIZED (the locked decision) — concurrent Mermaid
 * renders in one document would race the temp measurement node.
 */

/** Max source length (chars) accepted for a render — DoS guard (mirrors the worker's maxTextSize). */
export const DIAGRAM_MAX_SOURCE = 50_000
/** Hard ceiling on one render before it is abandoned + the worker recycled (a pathological diagram
 *  can wedge layout). On timeout the window is destroyed so the next render starts from a fresh one. */
export const DIAGRAM_RENDER_TIMEOUT_MS = 8_000

/** A diagram render request crossing the IPC boundary (renderer → MAIN). */
export interface DiagramRenderRequest {
  /** Mermaid source text. */
  source: string
  /** Theme-variable overrides (resolved app-token hex/strings) merged into Mermaid `theme:'base'`. */
  themeVars?: Record<string, string>
  /** A unique, CSS-id-safe token → the SVG root id (namespaces every internal id per render). */
  id: string
}

/** Render result: the SVG markup on success, or a human-readable error string. */
export type DiagramRenderResult = { ok: true; svg: string } | { ok: false; error: string }

let workerWin: BrowserWindow | null = null
let ready: Promise<BrowserWindow> | null = null
// Serialize renders: one Mermaid window, one render at a time. Each request chains onto the previous
// so two renderer cards re-rendering at once never collide on the worker's shared measurement DOM.
let queue: Promise<unknown> = Promise.resolve()

/** Trim Electron's `executeJavaScript` wrapper noise off a Mermaid error + bound its length so a
 *  hostile source can't return a megabyte of error text to the toast. Pure → unit-testable. */
export function cleanDiagramError(raw: string): string {
  const msg = String(raw ?? '')
    .replace(/^Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const short = msg.length > 300 ? `${msg.slice(0, 300)}…` : msg
  return short || 'diagram render failed'
}

/** CSS-id-safe sanitize of the render token: it is embedded raw as the SVG root id, and Mermaid
 *  requires an id starting with a letter. Strips anything but [A-Za-z0-9_-]; prefixes `d` if needed. */
export function safeDiagramId(id: string): string {
  const s = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  return /^[a-zA-Z]/.test(s) ? s : `d${s || '0'}`
}

function createWorker(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1200,
    height: 800,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // A never-shown window is background-throttled → timers Mermaid may schedule pause. Keep the
      // document "visible" so renders complete promptly (same rationale as previewOsr.ts).
      backgroundThrottling: false,
      // Own ephemeral session — never shares cache/cookies/storage with the app or previews.
      partition: 'diagram-worker'
    }
  })
  workerWin = win
  win.on('closed', () => {
    if (workerWin === win) {
      workerWin = null
      ready = null
    }
  })
  const wc = win.webContents
  // The worker page only ever loads its own bundled HTML + the sibling vendored mermaid.min.js.
  // Deny everything else: permissions, popups, and any navigation away from the worker document.
  wc.session.setPermissionRequestHandler((_w, _p, cb) => cb(false))
  wc.session.setPermissionCheckHandler(() => false)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())
  // __dirname is out/main/ (electron-vite); the copyDiagramWorker plugin lands the assets in
  // out/main/diagram-worker/ for both `pnpm dev` and `pnpm build`.
  const htmlPath = join(__dirname, 'diagram-worker', 'worker.html')
  return new Promise<BrowserWindow>((resolve, reject) => {
    wc.once('did-finish-load', () => resolve(win))
    wc.once('did-fail-load', (_e, code, desc) =>
      reject(new Error(`diagram worker failed to load (${code} ${desc})`))
    )
    void wc.loadFile(htmlPath)
  })
}

function ensureWorker(): Promise<BrowserWindow> {
  if (workerWin && !workerWin.isDestroyed()) return Promise.resolve(workerWin)
  if (!ready)
    ready = createWorker().catch((err) => {
      ready = null
      throw err
    })
  return ready
}

async function renderOnce(req: DiagramRenderRequest): Promise<DiagramRenderResult> {
  let win: BrowserWindow
  try {
    win = await ensureWorker()
  } catch (e) {
    return {
      ok: false,
      error: `worker init failed: ${cleanDiagramError(String((e as Error)?.message ?? e))}`
    }
  }
  const id = safeDiagramId(req.id)
  // Source is URI-encoded so it embeds as a safe ASCII string literal (no quotes/backslashes/JS line
  // terminators); themeVars is data MAIN controls, embedded as a JSON object literal.
  const encoded = encodeURIComponent(req.source)
  const themeLiteral = JSON.stringify(req.themeVars ?? {})
  const expr = `window.__renderDiagram(${JSON.stringify(encoded)}, ${JSON.stringify(id)}, ${themeLiteral})`
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const svg = await Promise.race<string>([
      win.webContents.executeJavaScript(expr, true),
      new Promise<string>((_resolve, rej) => {
        timer = setTimeout(() => rej(new Error('render timed out')), DIAGRAM_RENDER_TIMEOUT_MS)
      })
    ])
    if (typeof svg !== 'string' || svg.length === 0)
      return { ok: false, error: 'diagram produced no output' }
    return { ok: true, svg }
  } catch (e) {
    const error = cleanDiagramError(String((e as Error)?.message ?? e))
    // A timed-out render may have left the single worker document wedged → recycle it so the next
    // request starts from a fresh window instead of inheriting the hang.
    if (error.includes('timed out')) disposeDiagramWorker()
    return { ok: false, error }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Render Mermaid `source` → SVG. Validates + caps input, then runs serialized through the one
 *  shared hidden worker. Resolves to `{ok:true,svg}` or `{ok:false,error}` (never rejects). */
export function renderDiagram(req: DiagramRenderRequest): Promise<DiagramRenderResult> {
  if (!req || typeof req.source !== 'string')
    return Promise.resolve({ ok: false, error: 'source must be a string' })
  if (req.source.length === 0) return Promise.resolve({ ok: false, error: 'empty diagram source' })
  if (req.source.length > DIAGRAM_MAX_SOURCE)
    return Promise.resolve({ ok: false, error: `source exceeds ${DIAGRAM_MAX_SOURCE} characters` })
  const run = queue.then(() => renderOnce(req))
  // Keep the queue chained even when a render throws, but never let a rejection poison the chain.
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Destroy the hidden worker window (app shutdown, main-window close, or render-timeout recycle). */
export function disposeDiagramWorker(): void {
  const w = workerWin
  workerWin = null
  ready = null
  if (w && !w.isDestroyed()) {
    try {
      w.destroy()
    } catch {
      /* already gone */
    }
  }
}

/** Register the frame-guarded `diagram:render` IPC handler (renderer → MAIN). */
export function registerDiagramHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindowType | null
): void {
  ipcMain.handle('diagram:render', (ev, req: DiagramRenderRequest) => {
    if (isForeignSender(ev, getWin)) throw new Error('diagram:render — forbidden sender')
    return renderDiagram(req)
  })
}
