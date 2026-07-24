import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './canvas/ErrorBoundary'
import { setLowRamMode } from './lib/osrSizing'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'
// Side-effect: wires the @expanse-ade/diagram host seams (styles.css, ELK worker, Icon renderer)
// before any diagram mounts — see the bridge header for the full seam map.
import './canvas/boards/planning/diagramPackageBridge'

// Low-RAM (AUDIT §5): MAIN decides once from os.totalmem; apply the OSR supersample cap (2×→1×)
// BEFORE any Browser board mounts. Read defensively — a torn preload leaves the cap at 2× (safe).
setLowRamMode(window.api?.lowRam === true)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary
    fallback={(reset) => (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text)',
          background: 'var(--void)'
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h2>Something went wrong</h2>
          <p style={{ color: 'var(--text-2)' }}>
            The canvas hit an unexpected error. Your last save is on disk.
          </p>
          <button
            onClick={() => {
              reset()
              location.reload()
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )}
  >
    <App />
  </ErrorBoundary>
)
