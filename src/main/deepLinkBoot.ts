/**
 * expanse:// deep-link routing, extracted from index.ts (max-lines ratchet — see
 * docs/contributing/file-size-doctrine.md; behavior unchanged, mechanical move).
 *
 * The router owns the pre-ready buffer: open-url can fire BEFORE the auth service
 * exists, so links parsed as valid are queued until `connect()` hands over the live
 * `authService.handleCallback`. Validation here is LOG-ONLY (scheme/shape via
 * parseAuthDeepLink) — the service re-parses the raw URL for the code/state query and
 * does the PKCE state-match + MAIN-only exchange. NEVER log the query string — it
 * carries the auth code + state.
 */
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { parseAuthDeepLink, deepLinkFromArgv } from './authDeepLink'

export interface DeepLinkRouter {
  /** Route one raw URL: buffered pre-connect, delivered live after. */
  handle(url: string): void
  /** Auth service ready — flush the pre-ready buffer through it, then route live. */
  connect(sink: (url: string) => void): void
  /** Packaged-only OS registration: protocol client + open-url + second-instance. */
  installPackagedHandlers(): void
  /** Cold start via the scheme (Windows/Linux first launch): the URL is in our argv. */
  handleColdStart(): void
}

export function createDeepLinkRouter(getWin: () => BrowserWindow | null): DeepLinkRouter {
  let sink: ((url: string) => void) | null = null
  const pending: string[] = []

  const handle = (url: string): void => {
    const link = parseAuthDeepLink(url)
    if (!link) {
      console.warn('[auth] ignored a non-expanse / malformed deep-link URL')
      return
    }
    if (sink) sink(url)
    else pending.push(url)
  }

  const focusPrimaryWindow = (): void => {
    const win = getWin()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  return {
    handle,
    connect(next): void {
      sink = next
      for (const url of pending.splice(0)) next(url)
    },
    installPackagedHandlers(): void {
      // electron-builder's `protocols:` block writes the OS registration (NSIS registry /
      // Info.plist / .desktop); this makes the running process the live handler.
      app.setAsDefaultProtocolClient('expanse')
      // macOS delivery (can arrive before ready; Electron buffers until a handler exists).
      app.on('open-url', (event, url) => {
        event.preventDefault()
        handle(url)
      })
      // Windows/Linux delivery: a second launch carrying the URL routes here on the primary.
      app.on('second-instance', (_event, argv) => {
        const url = deepLinkFromArgv(argv)
        if (url) handle(url)
        focusPrimaryWindow()
      })
    },
    handleColdStart(): void {
      const coldLink = deepLinkFromArgv(process.argv)
      if (coldLink) handle(coldLink)
    }
  }
}
