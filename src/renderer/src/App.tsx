import { useEffect, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import Canvas from './canvas/Canvas'
import FlowSmoke from './smoke/FlowSmoke'
import TerminalSmoke from './smoke/TerminalSmoke'
import PreviewSmoke from './smoke/PreviewSmoke'

type Tab = 'canvas' | 'spike' | 'terminal' | 'preview'

interface RendererSmoke {
  reactflow: boolean
  xterm: boolean
  webgl: boolean
}

function App() {
  const [tab, setTab] = useState<Tab>('canvas')
  const [smoke, setSmoke] = useState<RendererSmoke>({ reactflow: true, xterm: false, webgl: false })

  // Renderer-side dependency smoke (React Flow imported = ok; xterm + webgl
  // instantiated offscreen). Result is logged for the headless CANVAS_SMOKE run.
  useEffect(() => {
    const r: RendererSmoke = { reactflow: true, xterm: false, webgl: false }
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
    // One-shot smoke measurement on mount; a single extra render here is intended.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSmoke(r)
    // eslint-disable-next-line no-console
    console.log('RENDERER_SMOKE ' + JSON.stringify(r))
  }, [])

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="mark">◇</span>Canvas ADE
        </div>
        <span className="tag">phase 2.0-C · canvas</span>
        <div className="status">
          <span className={smoke.reactflow ? 'ok' : 'bad'}>react-flow</span>
          <span className={smoke.xterm ? 'ok' : 'bad'}>xterm</span>
          <span className={smoke.webgl ? 'ok' : 'pending'}>webgl</span>
        </div>
      </div>

      <div className="tabs">
        <button className="tab" data-active={tab === 'canvas'} onClick={() => setTab('canvas')}>
          Canvas
        </button>
        <button className="tab" data-active={tab === 'spike'} onClick={() => setTab('spike')}>
          Preview spike
        </button>
        <button className="tab" data-active={tab === 'terminal'} onClick={() => setTab('terminal')}>
          Terminal (PTY)
        </button>
        <button className="tab" data-active={tab === 'preview'} onClick={() => setTab('preview')}>
          Browser preview
        </button>
      </div>

      <div className="panel">
        {tab === 'canvas' && <Canvas />}
        {tab === 'spike' && <FlowSmoke />}
        {tab === 'terminal' && <TerminalSmoke />}
        {tab === 'preview' && <PreviewSmoke />}
      </div>
    </div>
  )
}

export default App
