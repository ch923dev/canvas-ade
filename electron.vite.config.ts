import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * Content-Security-Policy hardening (Phase 4 §E). The renderer loads via `loadFile`
 * (file://) in the packaged build, so we ship the policy as an index.html <meta>
 * (webRequest.onHeadersReceived is unreliable for file://). This plugin rewrites
 * that meta at build time so DEV and PROD get different policies:
 *
 * - DEV keeps `script-src 'unsafe-inline'` — Vite's React-refresh preamble + the
 *   @vite/client are injected as inline scripts and there's no nonce hook for them.
 * - PROD drops `script-src 'unsafe-inline'` entirely → `script-src 'self'`. The
 *   built HTML's only script is the EXTERNAL hashed module bundle, so 'self' is
 *   sufficient and inline-script injection (the real XSS vector) is now blocked.
 *
 * `style-src` keeps `'unsafe-inline'` in BOTH: the app uses React inline `style={{}}`
 * attributes pervasively (plus xterm sets element styles at runtime), and CSP nonces
 * cannot authorize inline style ATTRIBUTES — only <style>/<link> elements. Dropping
 * it would require refactoring every inline style to a class; out of scope and not
 * the meaningful security win. Never weaken contextIsolation/sandbox/nodeIntegration.
 */
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: http://localhost:* http://127.0.0.1:*"
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'"

function cspMeta(): Plugin {
  return {
    name: 'canvas-ade-csp-meta',
    transformIndexHtml(html, ctx): string {
      // ctx.server is present in `serve` (dev) and undefined in `build` (prod).
      const csp = ctx.server ? DEV_CSP : PROD_CSP
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
        `$1${csp}$2`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react(), cspMeta()]
  }
})
