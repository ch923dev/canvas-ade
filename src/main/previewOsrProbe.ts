import { WebContentsView, BrowserWindow } from 'electron'
import { isAllowedPreviewUrl } from './previewShared'
import { OSR_WIDTH, OSR_HEIGHT } from './previewOsrSizing'
import { OSR_FRAME_RATE } from './previewOsr'

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
