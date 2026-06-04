import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './canvas/ErrorBoundary'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'

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
