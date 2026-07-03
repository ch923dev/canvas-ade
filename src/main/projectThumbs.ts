import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * Project-dock thumbnails (Background Project Sessions, Phase 4b — PHASE4-UX-DESIGN §4).
 *
 * Each session project's dock card shows a static snapshot of its canvas — never a live
 * render (one React Flow instance per app, locked). The renderer asks for a capture at two
 * moments: the OUTGOING project at switch-away (inside `performProjectSwitch`, before the
 * unmount) and the ACTIVE project on dock-open. MAIN captures the app window's canvas rect
 * (`webContents.capturePage`), downscales ~2×, and caches the PNG at
 * `userData/project-thumbs/<dirHash>.png` — app cache, NEVER the project folder (ADR 0009).
 *
 * Security: both handlers are frame-guarded. The capture dir is MAIN-resolved (`getCurrentDir`
 * — the renderer never names it), and `project:thumbs` serves ONLY the session set (active dir
 * + registry residents), so a compromised renderer can neither write outside the thumb cache
 * nor read an arbitrary file back as a "thumbnail".
 *
 * capturePage is env-flaky (the browser-trio e2e flake class) — a failed capture resolves
 * `false` and the renderer falls back to its dot-grid placeholder; it is a normal outcome,
 * never an error path.
 */

/** Renderer-supplied capture area (the React Flow pane's bounding rect, window DIP coords). */
export interface ThumbRect {
  x: number
  y: number
  width: number
  height: number
}

/** Stable file key for a project dir (pure — the cache filename is `<dirHash>.png`). */
export function dirHash(dir: string): string {
  return createHash('sha1').update(dir).digest('hex')
}

/** Anything larger is not a plausible window rect (guards absurd allocations). */
const MAX_THUMB_DIM = 8192

/**
 * Validate + integerize a renderer-supplied rect. Null when unusable (non-object, non-finite,
 * or degenerate after rounding) — the handler then no-ops rather than throwing.
 */
export function sanitizeThumbRect(raw: unknown): ThumbRect | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const int = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
  const x = int(rec.x)
  const y = int(rec.y)
  const width = int(rec.width)
  const height = int(rec.height)
  if (x === null || y === null || width === null || height === null) return null
  const rect: ThumbRect = {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.min(width, MAX_THUMB_DIM),
    height: Math.min(height, MAX_THUMB_DIM)
  }
  if (rect.width < 8 || rect.height < 8) return null
  return rect
}

/** PNG bytes → the data URL the renderer's <img> renders directly (no file:// reach-back). */
export function pngDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/**
 * Assemble the dir→dataUrl map for the session dirs (pure over the injected reader — a
 * missing/unreadable cache file simply omits that dir; the renderer placeholders it).
 */
export function buildThumbsMap(
  dirs: string[],
  readPng: (fileName: string) => Buffer | null
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const dir of dirs) {
    const png = readPng(`${dirHash(dir)}.png`)
    if (png) out[dir] = pngDataUrl(png)
  }
  return out
}

export interface ProjectThumbsDeps {
  /** projectStore.getCurrentDir — the capture is keyed to the ACTIVE dir, MAIN-resolved. */
  getCurrentDir(): string | null
  /** Backgrounded residents' dirs (the registry) — thumbs() membership beside the active dir. */
  sessionDirs(): string[]
  /** `join(userData, 'project-thumbs')` — app cache, never the project folder (ADR 0009). */
  thumbsDir(): string
}

/** Min gap between captures. Thumbnails are cosmetic — a rapid switch storm (A⇄B flipping,
 *  the rapid-switch e2e) must NOT stack capturePage calls on the compositor: under full-suite
 *  GPU load that storm reproducibly killed the app (the capturePage-contention flake class,
 *  amplified). A skipped capture just leaves the previous thumb / placeholder. */
const CAPTURE_MIN_GAP_MS = 1_000

export function registerProjectThumbHandlers(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: ProjectThumbsDeps
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)
  let lastCaptureAt = 0
  let captureInFlight = false

  ipc.handle('project:captureThumb', async (e, raw: unknown): Promise<boolean> => {
    if (guard(e)) return false
    const dir = deps.getCurrentDir()
    const rect = sanitizeThumbRect(raw)
    const win = getWin()
    if (!dir || !rect || !win || win.isDestroyed()) return false
    // Throttle + TRUE single-flight (review [warning]): the timestamp gate alone let a
    // second capturePage start whenever the first one itself outlasted the 1s gap — the
    // exact GPU-load scenario the crop-kill note below describes. The in-flight flag
    // blocks concurrency outright; the time gap still limits back-to-back captures once idle.
    if (captureInFlight) return false
    const now = Date.now()
    if (now - lastCaptureAt < CAPTURE_MIN_GAP_MS) return false
    lastCaptureAt = now
    captureInFlight = true
    try {
      // Capture the FULL page and crop CPU-side (nativeImage.crop): the rect-parameterized
      // capturePage path reproducibly killed the app under e2e GPU load (3/3 full-leg runs;
      // green with captures disabled) — the full-page capture is the same call the OSR
      // screenshot feature has shipped on.
      const img = await win.webContents.capturePage()
      if (img.isEmpty()) return false
      const size = img.getSize()
      const clamped = {
        x: Math.min(rect.x, Math.max(0, size.width - 8)),
        y: Math.min(rect.y, Math.max(0, size.height - 8)),
        width: 0,
        height: 0
      }
      clamped.width = Math.min(rect.width, size.width - clamped.x)
      clamped.height = Math.min(rect.height, size.height - clamped.y)
      if (clamped.width < 8 || clamped.height < 8) return false
      const cropped = img.crop(clamped)
      // Downscale ~2× — the dock card is small; half-size keeps the cache cheap and crisp.
      const half = cropped.resize({
        width: Math.max(1, Math.round(cropped.getSize().width / 2))
      })
      const outDir = deps.thumbsDir()
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, `${dirHash(dir)}.png`), half.toPNG())
      return true
    } catch {
      return false // env-flaky capture / disk failure — the placeholder path, not an error
    } finally {
      captureInFlight = false
    }
  })

  ipc.handle('project:thumbs', (e): Record<string, string> => {
    if (guard(e)) return {}
    const dirs: string[] = []
    const current = deps.getCurrentDir()
    if (current) dirs.push(current)
    for (const d of deps.sessionDirs()) if (!dirs.includes(d)) dirs.push(d)
    return buildThumbsMap(dirs, (fileName) => {
      try {
        return readFileSync(join(deps.thumbsDir(), fileName))
      } catch {
        return null
      }
    })
  })

  // Single-dir fetch for the switch-transition snapshot (review fix): the whole-map
  // `project:thumbs` read + base64-encoded EVERY resident's PNG synchronously just to serve
  // one entry on the switch's animation-critical path. Same membership rule as the map —
  // only the active dir or a registry resident is servable (never an arbitrary file read).
  ipc.handle('project:thumb', (e, rawDir: unknown): string | null => {
    if (guard(e)) return null
    if (typeof rawDir !== 'string' || rawDir.length === 0) return null
    const allowed = rawDir === deps.getCurrentDir() || deps.sessionDirs().includes(rawDir)
    if (!allowed) return null
    try {
      return pngDataUrl(readFileSync(join(deps.thumbsDir(), `${dirHash(rawDir)}.png`)))
    } catch {
      return null // no cached thumb — the overlay takes its fade/HOLD path
    }
  })
}
