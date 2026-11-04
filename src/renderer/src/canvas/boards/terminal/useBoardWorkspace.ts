/**
 * WS-3 — the terminal dialog's READ-ONLY view of the workspace a board already belongs to (design
 * §4.2; signed-off wireframe 2026-11-03). The dialog never picks a workspace: membership is decided
 * once, by WS-5's sticky dock checkbox or WS-4's "Move to workspace", and lives on
 * `board.workspaceId`. This module only reflects it — the Workspace line, the Working dir default
 * (the effective root), and an early warning when that folder is gone. MAIN stays the authority:
 * the same problem is refused at spawn with the same sentence (`ptyShells.strictCwd`), so Create is
 * never blocked here — once the folder is restored, Start just works.
 */
import { useEffect, useState } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { effectiveRoot } from '../../../../../shared/workspaceRules'

/** What the dialog shows for a workspace board. `shown` is the effective root as `api/` (`./` for
 *  the whole project), or null when it cannot be resolved. */
export interface BoardWorkspaceView {
  name: string
  color: string
  shown: string | null
  problem: string | null
}

const GONE =
  "This terminal's workspace no longer exists. Make the terminal project-level, or restore the workspace."
const FIX = 'Restore it or remove the workspace.'

const shownOf = (rel: string): string => (rel === '.' ? './' : `${rel}/`)

/** The board's workspace, or null for a project-level board. Probes the effective root through the
 *  project-contained `file.stat` so a missing folder shows BEFORE the user hits Create/Start. */
export function useBoardWorkspace(workspaceId: string | undefined): BoardWorkspaceView | null {
  const ws = useCanvasStore((s) =>
    workspaceId ? s.workspaces.find((w) => w.id === workspaceId) : undefined
  )
  const rel = ws ? effectiveRoot(ws) : null
  const name = ws?.name ?? ''
  const [probe, setProbe] = useState<{ rel: string; problem: string | null } | null>(null)
  useEffect(() => {
    if (rel === null) return
    let live = true
    const label = `Workspace "${name}" folder`
    // Same sentences as MAIN's strictCwd, so the dialog and the spawn error never disagree.
    const report = (problem: string | null): void => {
      if (live) setProbe({ rel, problem })
    }
    window.api.file.stat(rel).then(
      (s) => report(s.isDir ? null : `${label} (${shownOf(rel)}) is a file, not a folder. ${FIX}`),
      () => report(`${label} is missing (${shownOf(rel)}). ${FIX}`)
    )
    return () => {
      live = false
    }
  }, [rel, name])
  if (!workspaceId) return null
  if (!ws) return { name: 'Unknown workspace', color: '', shown: null, problem: GONE }
  if (rel === null) {
    const problem = `Workspace "${ws.name}" has an invalid folder setting. Remove the workspace and create it again.`
    return { name: ws.name, color: ws.color, shown: null, problem }
  }
  const problem = probe?.rel === rel ? probe.problem : null
  return { name: ws.name, color: ws.color, shown: shownOf(rel), problem }
}

/** The Working dir field's placeholder + hint for a workspace board (null ⇒ project-level copy). */
export function workspaceCwdCopy(view: BoardWorkspaceView | null): {
  placeholder: string
  hint: string | null
} {
  if (!view) return { placeholder: '(blank = project folder)', hint: null }
  if (!view.shown) return { placeholder: 'blank = workspace folder', hint: null }
  return {
    placeholder: `blank = ${view.shown} (workspace)`,
    hint: `Stays inside ${view.shown} — relative paths start there`
  }
}
