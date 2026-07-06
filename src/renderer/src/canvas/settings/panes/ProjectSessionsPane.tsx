/**
 * Project · Sessions detail pane — "Keep in background" for the ACTIVE project. Surfaces the
 * PERSISTED keep-forever flag (until now reachable only via the ask-on-switch dialog's checkbox and
 * the ∞ badge's "forget") as a first-class project setting. Machine-scoped: the flag lives in
 * userData (`background-keep.json`), NEVER the project folder — so it never git-syncs to a
 * collaborator (mirrors the recent-projects list).
 *
 * The toggle represents the persisted forever flag:
 *   state ← project.keepForeverDirs().includes(dir)
 *   ON    → setKeepPolicy(true)      (MAIN resolves the ACTIVE dir; also arms the session keep)
 *   OFF   → forgetKeepPolicy(dir)     (there is NO setKeepPolicy(false) — the forever flag is only
 *                                       ever cleared by forgetting the policy, which also drops the
 *                                       session-scoped keep: the correct "stop auto-keeping" reset)
 *
 * Gated on an open project (mirrors OrchestrationPane): with none, renders the shared empty state.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { pane } from '../paneStyles'
import { NoProjectEmpty } from './NoProjectEmpty'

export function ProjectSessionsPane(): ReactElement {
  const projectDir = useCanvasStore((s) => s.project.dir)
  const [kept, setKept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Hydrate the toggle from the persisted forever set whenever the active project changes.
  // Promise.resolve().then wrapper: a partial window.api mock must degrade to "not kept", not throw.
  useEffect(() => {
    if (projectDir === null) return
    let cancelled = false
    void Promise.resolve()
      .then(() => window.api.project.keepForeverDirs())
      .then((dirs) => {
        if (!cancelled) setKept(dirs.includes(projectDir))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectDir])

  if (projectDir === null) return <NoProjectEmpty />

  // Guard the async write (busy-disabled) so a rapid double-click can't fire two interleaved
  // policy writes. Only adopt the new value once MAIN confirms (mirrors OrchestrationPane).
  const onToggle = async (): Promise<void> => {
    const next = !kept
    setBusy(true)
    setError(null)
    try {
      const ok = next
        ? await window.api.project.setKeepPolicy(true)
        : await window.api.project.forgetKeepPolicy(projectDir)
      if (ok) setKept(next)
      else setError('Could not update keep in background — please try again.')
    } catch {
      setError('Could not update keep in background — please try again.')
    }
    setBusy(false)
  }

  return (
    <div style={pane.section}>
      <div style={pane.setrow} data-test="settings-keep-background-row">
        <div style={{ flex: 1 }}>
          <div style={pane.rowTitle}>Keep in background</div>
          <div style={pane.rowSub}>
            Keep this project&rsquo;s terminals and previews alive when you switch away, instead of
            asking each time. Applies to this machine only.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={kept}
          aria-label="Keep in background"
          disabled={busy}
          onClick={() => void onToggle()}
          data-test="settings-keep-background-toggle"
          style={{
            ...pane.toggle,
            background: kept ? 'var(--accent)' : 'var(--border-strong)',
            cursor: busy ? 'default' : 'pointer'
          }}
        >
          <span style={{ ...pane.toggleKnob, left: kept ? 17 : 2 }} />
        </button>
      </div>

      {error && (
        <div role="alert" data-test="settings-keep-background-error" style={pane.error}>
          {error}
        </div>
      )}
    </div>
  )
}
