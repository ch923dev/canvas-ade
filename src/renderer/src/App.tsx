import Canvas from './canvas/Canvas'
import { useRendererSmoke } from './smoke/useRendererSmoke'
import { useMcpPublish } from './store/useMcpPublish'

/**
 * App root = the full-bleed canvas. The old tab harness (Phase 0–1 smoke) is gone;
 * the smoke components live on under `smoke/` as salvage sources for the parallel
 * board work (FlowSmoke → 2.2 PreviewManager, TerminalSmoke → 2.1 xterm wiring).
 * `useRendererSmoke` keeps the headless RENDERER_SMOKE probe alive.
 */
function App(): React.ReactElement {
  useRendererSmoke()
  useMcpPublish()
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Canvas />
    </div>
  )
}

export default App
