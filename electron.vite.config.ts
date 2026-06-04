import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { injectCspMeta } from './src/main/csp'

/**
 * Content-Security-Policy hardening (Phase 4 §E). The renderer loads via `loadFile`
 * (file://) in the packaged build, so we ship the policy as an index.html <meta>
 * (webRequest.onHeadersReceived is unreliable for file://). This plugin rewrites that
 * meta at build time so DEV and PROD get their respective policies. The policy strings +
 * the pure injection live in `src/main/csp.ts` (unit-tested) — see that file for the full
 * dev/prod + style/script + hardening-directive rationale.
 */
function cspMeta(): Plugin {
  return {
    name: 'canvas-ade-csp-meta',
    transformIndexHtml(html, ctx): string {
      // ctx.server is present in `serve` (dev) and undefined in `build` (prod).
      return injectCspMeta(html, Boolean(ctx.server))
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
