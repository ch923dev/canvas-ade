import { resolve, join } from 'path'
import { copyFileSync, mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { injectCspMeta } from './src/main/csp'

/**
 * Terminal recap (Task 10 Step 6): copy the SessionStart hook script into the main build output
 * so it lands at `out/main/hooks/recordSession.js`. electron-vite/rollup only bundles MODULES that
 * are imported — recordSession.js is run by an EXTERNAL process (Claude, via `node <path>`), never
 * imported, so without this copy it would be absent from `out/` and the packaged app. We resolve
 * the destination from the main build's outDir (so it tracks any outDir override) and copy on
 * `writeBundle` for BOTH `pnpm dev` and `pnpm build`. Paired with a hooks asarUnpack glob in
 * electron-builder.yml so the file is extracted to a real on-disk path when packaged.
 */
function copyRecapHook(): Plugin {
  const src = resolve(__dirname, 'src/main/hooks/recordSession.js')
  let outDir = resolve(__dirname, 'out/main')
  return {
    name: 'canvas-ade-copy-recap-hook',
    configResolved(cfg): void {
      // cfg.build.outDir is the main build's output dir (out/main by electron-vite convention).
      if (cfg.build?.outDir) outDir = resolve(__dirname, cfg.build.outDir)
    },
    writeBundle(): void {
      const destDir = join(outDir, 'hooks')
      mkdirSync(destDir, { recursive: true })
      copyFileSync(src, join(destDir, 'recordSession.js'))
    }
  }
}

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

/**
 * Diagram render worker (S4): copy the hidden-worker assets into the main build output so they land
 * at `out/main/diagram-worker/{worker.html, mermaid.min.js}` — where `diagramWorker.ts` loads them
 * via `join(__dirname, 'diagram-worker', 'worker.html')`. Like the recap hook, these are NOT modules
 * the bundler reaches (worker.html is loaded by Electron; mermaid.min.js is a vendored <script> the
 * page pulls), so without this copy they would be absent from `out/` and the packaged app. Packaged
 * via the `out/**` glob in electron-builder.yml — no asarUnpack needed (loadFile reads from asar).
 */
function copyDiagramWorker(): Plugin {
  const srcDir = resolve(__dirname, 'resources/diagram-worker')
  const files = ['worker.html', 'bridge.js', 'mermaid.min.js']
  let outDir = resolve(__dirname, 'out/main')
  return {
    name: 'canvas-ade-copy-diagram-worker',
    configResolved(cfg): void {
      if (cfg.build?.outDir) outDir = resolve(__dirname, cfg.build.outDir)
    },
    writeBundle(): void {
      const destDir = join(outDir, 'diagram-worker')
      mkdirSync(destDir, { recursive: true })
      for (const f of files) copyFileSync(join(srcDir, f), join(destDir, f))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyRecapHook(), copyDiagramWorker()],
    // Phase 5 auto-update gate. electron-updater is wired in main but the actual
    // checkForUpdates call is fenced behind this build-time constant (see
    // src/main/autoUpdate.ts). It is `true` ONLY when the build sets ENABLE_AUTO_UPDATE=1
    // — which the production CI job does exclusively when code-signing secrets are present.
    // So unsigned local/staging builds NEVER auto-update: the security invariant
    // (no unsigned auto-update over a feed) is enforced by the compiler, not by convention.
    define: {
      __ENABLE_AUTO_UPDATE__: JSON.stringify(process.env.ENABLE_AUTO_UPDATE === '1')
    },
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
    plugins: [react(), cspMeta()],
    // Pre-bundle the CodeMirror 6 stack (file-tree S3) at dev startup. The File board is a
    // LAZY chunk (BoardNode code-splits it), and CM6 fans out into many small packages
    // (@codemirror/*, @lezer/*) that Vite's initial scan misses. Without this, the FIRST file
    // board mount makes Vite re-optimize on demand, which 504s the in-flight dynamic import
    // ("Outdated Optimize Dep") and the board renders the ErrorBoundary fallback. Listing the
    // entry packages makes Vite pre-bundle the whole graph up front (dev-only; build is
    // unaffected). The langs pack pulls in every grammar transitively.
    optimizeDeps: {
      include: [
        '@uiw/react-codemirror',
        '@uiw/codemirror-extensions-langs',
        '@codemirror/language',
        '@lezer/highlight'
      ]
    }
  }
})
