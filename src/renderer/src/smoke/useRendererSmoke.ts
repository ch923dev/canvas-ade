import { useEffect } from 'react'

/**
 * True only when MAIN loaded the page with the smoke query flag (set only under
 * `CANVAS_SMOKE`, mirroring `isE2E` in `e2eRegistry.ts`).
 */
function isSmoke(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('smoke') === '1'
  } catch {
    return false
  }
}

/**
 * Renderer-side dependency smoke, kept from the Phase 0 harness. On mount it
 * instantiates xterm + the WebGL addon offscreen and logs `RENDERER_SMOKE` so the
 * headless `CANVAS_SMOKE` run can assert the renderer toolchain is healthy. Runs
 * once; the offscreen terminal is disposed immediately. Load-bearing for the smoke
 * gate — do not remove without moving the probe.
 *
 * BUG-056: no-ops outside the smoke harness — this used to run on every real launch.
 *
 * §F code-split: xterm is imported DYNAMICALLY here so this always-mounted probe
 * doesn't pull @xterm into the renderer's entry chunk (which would defeat the lazy
 * TerminalBoard split). It lands in the shared xterm chunk loaded on demand.
 */
export function useRendererSmoke(): void {
  useEffect(() => {
    if (!isSmoke()) return

    void (async () => {
      const r = { reactflow: true, xterm: false, webgl: false }
      const host = document.createElement('div')
      host.style.cssText = 'position:absolute;left:-9999px;width:240px;height:120px'
      document.body.appendChild(host)
      try {
        const { Terminal } = await import('@xterm/xterm')
        const term = new Terminal({ cols: 20, rows: 4 })
        term.open(host)
        r.xterm = true
        try {
          const { WebglAddon } = await import('@xterm/addon-webgl')
          const gl = new WebglAddon()
          term.loadAddon(gl)
          r.webgl = true
          gl.dispose()
        } catch {
          r.webgl = false
        }
        term.dispose()
      } catch {
        r.xterm = false
      }
      host.remove()
      // eslint-disable-next-line no-console
      console.log('RENDERER_SMOKE ' + JSON.stringify(r))
    })()

    // Font probe (Phase 4 §D): confirm self-hosted Geist actually LOADS (not the
    // system-ui fallback). Uses fonts.load() to force the woff2 fetch — works even
    // in the headless smoke window (which never paints, so fonts.ready/check alone
    // would stay idle). Logged on a separate line so RENDERER_SMOKE stays untouched.
    if (typeof document !== 'undefined' && document.fonts?.load) {
      void Promise.all([
        document.fonts.load('16px Geist'),
        document.fonts.load('16px "Geist Mono"')
      ])
        .then(([sans, mono]) => {
          const fonts = { geist: sans.length > 0, geistMono: mono.length > 0 }
          // eslint-disable-next-line no-console
          console.log('RENDERER_FONTS ' + JSON.stringify(fonts))
        })
        .catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.log('RENDERER_FONTS {"error":' + JSON.stringify(String(e)) + '}')
        })
    }
  }, [])
}
