/**
 * Terminal detail pane — the `terminal` tile. Holds the agent-recap consent toggle that used to
 * sit under Settings › Terminal. Consent is per-project and immediate-apply (the recap/voice
 * precedent — no Save button): the checkbox writes through `recap.setConsent` on change, with the
 * optimistic-then-revert guard (BUG-065) so a rejected/`{ok:false}` write never leaves the box
 * showing a state that didn't persist (privacy-relevant on untick — the hook stays installed).
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { pane } from '../paneStyles'
import { BackgroundSessionsSection } from './BackgroundSessionsSection'

export function TerminalPane(): ReactElement {
  const projectDir = useCanvasStore((s) => s.project.dir)
  const [recapConsent, setRecapConsent] = useState<'enabled' | 'declined' | 'undecided'>(
    'undecided'
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.recap
      .getConsent()
      .then((c) => {
        if (!cancelled) setRecapConsent(c)
      })
      .catch(() => {
        if (!cancelled) setRecapConsent('undecided')
      })
    return () => {
      cancelled = true
    }
  }, [projectDir])

  const onToggle = async (next: 'enabled' | 'declined'): Promise<void> => {
    const prev = recapConsent
    setRecapConsent(next)
    setError(null)
    try {
      const r = await window.api.recap.setConsent(next)
      if (!r.ok) {
        setRecapConsent(prev)
        setError('Could not update agent recaps — please try again.')
      }
    } catch {
      setRecapConsent(prev)
      setError('Could not update agent recaps — please try again.')
    }
  }

  return (
    <div style={pane.section}>
      <label style={{ ...pane.field, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          data-test="settings-recap-toggle"
          checked={recapConsent === 'enabled'}
          disabled={projectDir === null}
          aria-label="Agent recaps (this project)"
          onChange={(e) => {
            void onToggle(e.target.checked ? 'enabled' : 'declined')
          }}
          style={{
            marginTop: 2,
            accentColor: 'var(--accent)',
            cursor: projectDir === null ? 'not-allowed' : 'pointer'
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={pane.label}>
            Agent recaps (this project)
            {projectDir === null && (
              <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
                {' '}
                — open a project to enable
              </span>
            )}
          </span>
          <span style={pane.hint}>
            Flip a terminal to a recap of what its agent is doing. Reads the session transcript
            locally; only a scrubbed slice is sent to your chosen LLM.
          </span>
        </div>
      </label>

      {error && (
        <div role="alert" data-test="settings-recap-error" style={pane.error}>
          {error}
        </div>
      )}

      {/* PR-2 background sessions: close policy + notify + surviveRestart (mock 4). */}
      <BackgroundSessionsSection />
    </div>
  )
}
