import { useEffect } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/**
 * Renderer-side dependency smoke, kept from the Phase 0 harness. On mount it
 * instantiates xterm + the WebGL addon offscreen and logs `RENDERER_SMOKE` so the
 * headless `CANVAS_SMOKE` run can assert the renderer toolchain is healthy. Runs
 * once; the offscreen terminal is disposed immediately. Load-bearing for the smoke
 * gate — do not remove without moving the probe.
 */
export function useRendererSmoke(): void {
  useEffect(() => {
    const r = { reactflow: true, xterm: false, webgl: false }
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:-9999px;width:240px;height:120px'
    document.body.appendChild(host)
    try {
      const term = new Terminal({ cols: 20, rows: 4 })
      term.open(host)
      r.xterm = true
      try {
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
  }, [])
}
