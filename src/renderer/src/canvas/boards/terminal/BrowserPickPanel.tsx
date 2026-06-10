/**
 * Multi-select connect picker (Slice C′ / browser-quickwins) — extracted verbatim from
 * TerminalBoard (D0-4, max-lines ratchet): pick one or more browser boards (and/or a
 * fresh spawn) to wire to this terminal and push the detected URL to each. The panel
 * owns the transient checkbox state (it resets by unmounting, exactly as the host's
 * `setChecked(new Set())`-on-open did); the host keeps the routing (`onConfirm`) and
 * the open/close state. Dismissal (Esc / outside pointerdown) is the host's
 * usePickerDismiss — this root stops its own mouse/pointer-down like every picker.
 */
import { useState, type ReactElement } from 'react'
import type { PreviewCandidate } from '../../../lib/previewTarget'

/** Sentinel checkbox key for "+ New browser" (exported for the host's confirm routing). */
export const NEW_BROWSER = ' new'

export function BrowserPickPanel({
  candidates,
  onCancel,
  onConfirm
}: {
  candidates: PreviewCandidate[]
  onCancel: () => void
  /** Called with the checked keys (board ids and/or NEW_BROWSER); host routes + closes. */
  onConfirm: (checked: Set<string>) => void
}): ReactElement {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const toggle = (key: string, on: boolean): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  // Re-pointing an already-connected browser severs its current link — warn first.
  const severCount = [...checked].filter(
    (k) => candidates.find((c) => c.id === k)?.connectedTo
  ).length
  return (
    <div
      className="ca-port-picker nodrag"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ca-port-picker-title">Push to which browser(s)?</div>
      {candidates.map((c) => (
        <label key={c.id} className="ca-browser-choice" title={c.url}>
          <input
            type="checkbox"
            checked={checked.has(c.id)}
            onChange={(e) => toggle(c.id, e.target.checked)}
          />
          <span className="ca-browser-choice-label">{c.title}</span>
          {c.connectedTo && (
            <span className="ca-browser-choice-warn" title={`Connected to ${c.connectedTo.title}`}>
              ⚠ on {c.connectedTo.title}
            </span>
          )}
        </label>
      ))}
      <label className="ca-browser-choice">
        <input
          type="checkbox"
          checked={checked.has(NEW_BROWSER)}
          onChange={(e) => toggle(NEW_BROWSER, e.target.checked)}
        />
        <span className="ca-browser-choice-label">+ New browser</span>
      </label>
      {severCount > 0 && (
        <div className="ca-browser-sever">
          ⚠ Disconnects {severCount} browser{severCount > 1 ? 's' : ''} from{' '}
          {severCount > 1 ? 'their' : 'its'} current terminal.
        </div>
      )}
      <div className="ca-browser-actions">
        <button className="ca-preview-dismiss" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="ca-browser-connect"
          disabled={checked.size === 0}
          onClick={() => onConfirm(checked)}
        >
          Connect{checked.size > 0 ? ` ${checked.size}` : ''}
        </button>
      </div>
    </div>
  )
}
