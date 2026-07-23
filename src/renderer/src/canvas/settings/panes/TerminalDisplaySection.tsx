/**
 * Settings › Terminal › "Flicker-free terminals" (T1d) — the app-wide toggle that decides whether
 * Claude Code keeps its default alt-screen TUI (zero resize-scrollback litter,
 * anthropics/claude-code#51828) or has it forced off. Default ON: Shift+drag still copies in
 * alt-screen, so this doesn't re-break #332's copy fix — only modifier-less drag-select is lost, so
 * the sub-copy carries the "Hold Shift to select" hint. One switch, all terminals; new/restarted.
 *
 * Own file (max-lines doctrine); rendered by TerminalPane. Immediate-apply with the
 * optimistic-then-revert guard (the recap-consent BUG-065 precedent): a rejected / `{ok:false}` write
 * never leaves the switch showing a state that did not persist. Renders null without
 * `window.api.terminalDisplay` (the BackgroundSessionsSection discipline — unit mocks of the settings
 * modal stay green without the preload).
 */
import { useEffect, useState, type ReactElement } from 'react'
import { pane } from '../paneStyles'

const WRITE_ERROR = 'Could not update terminal display settings — please try again.'

export function TerminalDisplaySection(): ReactElement | null {
  const api = window.api?.terminalDisplay
  const [flickerFree, setFlickerFree] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    let cancelled = false
    void api
      .get()
      .then((c) => {
        if (!cancelled && c) setFlickerFree(c.flickerFree)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api])

  if (!api) return null

  const onToggle = (next: boolean): void => {
    if (flickerFree === null) return
    const prev = flickerFree
    setFlickerFree(next)
    setError(null)
    api
      .set({ flickerFree: next })
      .then((r) => {
        if (!r.ok) {
          setFlickerFree(prev)
          setError(WRITE_ERROR)
        }
      })
      .catch(() => {
        setFlickerFree(prev)
        setError(WRITE_ERROR)
      })
  }

  const on = flickerFree ?? false
  const ready = flickerFree !== null

  return (
    <>
      <div style={pane.divider} />
      <div style={pane.head}>Display</div>

      <div style={pane.setrow}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={pane.rowTitle}>Flicker-free terminals</div>
          <div style={pane.rowSub}>
            Agents paint in the alternate screen, so resizing never leaves duplicate lines behind.
            Hold Shift to select text while an agent is streaming. Applies to new or restarted
            terminals.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Flicker-free terminals"
          disabled={!ready}
          data-test="settings-flicker-free"
          onClick={() => ready && onToggle(!on)}
          style={{
            ...pane.toggle,
            cursor: ready ? 'pointer' : 'not-allowed',
            background: on ? 'var(--accent)' : 'var(--border-strong)'
          }}
        >
          <span style={{ ...pane.toggleKnob, left: on ? 17 : 2 }} />
        </button>
      </div>

      {error && (
        <div role="alert" data-test="settings-flicker-free-error" style={pane.error}>
          {error}
        </div>
      )}
    </>
  )
}
