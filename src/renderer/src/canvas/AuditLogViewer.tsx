import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Read-only viewer for the MCP dispatch audit trail (T4.1). The trail is written
 * MAIN-side only (the dispatch path, T4.3+); this panel just reads it back via
 * `window.api.mcp.readAudit` — there is no write/clear affordance by design, so the
 * record can't be doctored from the renderer.
 *
 * Opens with ⌘/Ctrl+Shift+A or the corner launcher; refreshes its list each time it
 * opens. Minimal "shell" for M4 — a dense, read-only list; richer filtering/detail can
 * land later without changing the data path.
 */

/** Mirror of the MAIN/preload `AuditEntry` (type-only; kept local to avoid a cross-bundle import). */
interface AuditEntry {
  seq: number
  ts: number
  type: string
  targetId: string
  prompt: string
  nonce: string
  status: string
  outputs?: string
  detail?: string
}

const STATUS_COLOR: Record<string, string> = {
  dispatched: 'var(--accent)',
  completed: 'var(--ok)',
  denied: 'var(--warn)',
  rejected: 'var(--err)',
  interrupted: 'var(--warn)'
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return String(ts)
  }
}

export default function AuditLogViewer(): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  // Mirrors `open` for the keydown handler (a stable listener can't close over state).
  const openRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    const read = window.api?.mcp?.readAudit
    if (!read) return
    setEntries(await read({ limit: 200 }))
  }, [])

  // Open sets state + pulls a fresh list (refresh on every open, not via an effect, so
  // there's no setState-in-effect); close just hides.
  const openViewer = useCallback((): void => {
    openRef.current = true
    setOpen(true)
    void refresh()
  }, [refresh])
  const closeViewer = useCallback((): void => {
    openRef.current = false
    setOpen(false)
  }, [])

  // Global toggle: ⌘/Ctrl+Shift+A.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (openRef.current) closeViewer()
        else openViewer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openViewer, closeViewer])

  if (!open) {
    return (
      <button
        type="button"
        onClick={openViewer}
        title="MCP dispatch audit log (⌘/Ctrl+Shift+A)"
        style={{
          position: 'fixed',
          bottom: 12,
          left: 12,
          zIndex: 9000,
          padding: '4px 10px',
          fontFamily: 'var(--ui)',
          fontSize: 'var(--fs-micro)',
          fontWeight: 'var(--fw-micro)' as React.CSSProperties['fontWeight'],
          letterSpacing: 'var(--tr-micro)',
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 6,
          cursor: 'pointer'
        }}
      >
        Audit
      </button>
    )
  }

  return (
    // MCP-01: this is a persistent, non-modal side panel (opened via shortcut, no focus trap,
    // no backdrop) — a landmark `complementary` region, NOT a `dialog`. The aria-label names it.
    <div
      role="complementary"
      aria-label="MCP dispatch audit log"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 420,
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-overlay)',
        borderLeft: '1px solid var(--border)',
        fontFamily: 'var(--ui)',
        color: 'var(--text)'
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderBottom: '1px solid var(--border-subtle)'
        }}
      >
        <span
          style={{
            fontSize: 'var(--fs-label)',
            fontWeight: 600,
            letterSpacing: 'var(--tr-label)'
          }}
        >
          Dispatch audit log
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => void refresh()} style={launcherBtn} title="Refresh">
            Refresh
          </button>
          <button type="button" onClick={closeViewer} style={launcherBtn} title="Close">
            Close
          </button>
        </div>
      </header>
      <div style={{ overflowY: 'auto', flex: 1 }} data-testid="audit-list">
        {entries.length === 0 ? (
          <p style={{ padding: 16, color: 'var(--text-3)', fontSize: 'var(--fs-meta)' }}>
            No dispatch events recorded.
          </p>
        ) : (
          entries.map((e) => (
            <div
              key={e.seq}
              data-audit-seq={e.seq}
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 'var(--fs-meta)',
                lineHeight: 'var(--lh-meta)'
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  color: 'var(--text-2)'
                }}
              >
                <span style={{ color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>
                  #{e.seq}
                </span>
                <span style={{ fontWeight: 500, color: 'var(--text)' }}>{e.type}</span>
                <span style={{ color: STATUS_COLOR[e.status] ?? 'var(--text-2)' }}>{e.status}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>{fmtTime(e.ts)}</span>
              </div>
              <div style={{ color: 'var(--text-3)', marginTop: 2 }}>→ {e.targetId}</div>
              {e.prompt && (
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: 'var(--mono)',
                    color: 'var(--text-2)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {e.prompt}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const launcherBtn: React.CSSProperties = {
  padding: '3px 8px',
  fontFamily: 'var(--ui)',
  fontSize: 'var(--fs-micro)',
  fontWeight: 500,
  letterSpacing: 'var(--tr-micro)',
  textTransform: 'uppercase',
  color: 'var(--text-2)',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 5,
  cursor: 'pointer'
}
