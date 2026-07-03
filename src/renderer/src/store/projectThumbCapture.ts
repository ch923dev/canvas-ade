/**
 * Renderer half of the project-dock thumbnail capture (Phase 4b, PHASE4-UX-DESIGN §4).
 *
 * MAIN does the actual `capturePage` — this just measures the React Flow pane's bounding
 * rect (the canvas area, excluding nothing else the renderer could name) and asks over the
 * frame-guarded IPC. Called at the two capture moments: switch-away (projectSwitch.ts,
 * BEFORE the unmount) and dock-open (ProjectDock).
 *
 * Best-effort by contract: capturePage is env-flaky, so `false` is a normal outcome — the
 * dock renders its dot-grid placeholder for a dir with no cached thumb. Never throws.
 */
export async function captureProjectThumb(): Promise<boolean> {
  // Non-DOM test runtimes (node-env vitest driving performProjectSwitch) skip cleanly.
  if (typeof document === 'undefined') return false
  const pane = document.querySelector('.react-flow')
  if (!pane) return false
  const r = pane.getBoundingClientRect()
  const rect = {
    x: Math.max(0, Math.round(r.x)),
    y: Math.max(0, Math.round(r.y)),
    width: Math.round(r.width),
    height: Math.round(r.height)
  }
  if (rect.width < 8 || rect.height < 8) return false
  // Promise.resolve().then wrapper: a partial window.api mock must degrade to false,
  // not throw synchronously before .catch can attach (the integration-test contract).
  return Promise.resolve()
    .then(() => window.api.project.captureThumb(rect))
    .catch(() => false)
}
