/**
 * The Workspaces pill (WS-4) — the lifecycle entry point beside the project switcher. Only the
 * pill + the open-time reconcile are eager chrome; the menu body and the dialogs it opens load on
 * first open ({@link WorkspacePanel}, the bundle-budget discipline).
 *
 * The reconcile (§4.3 step 5): a workspace whose folder (or worktree) is gone is marked `missing`
 * in the store — ephemeral, nothing on disk is pruned or recreated, and the spawn path refuses a
 * terminal there on its own.
 */
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import type { Workspace } from '../../lib/workspaceSchema'

const WorkspacePanel = lazy(() =>
  import('./WorkspacePanel').then((m) => ({ default: m.WorkspacePanel }))
)

/** The folder a workspace stands on: its worktree when it has one, else its root. */
function folderOf(w: Workspace): string {
  return w.worktrees?.[0]?.worktree ?? w.root
}

/** Open-time reconcile: mark workspaces whose folder is gone (re-run when the set changes). */
function useWorkspaceReconcile(): void {
  const workspaces = useCanvasStore((s) => s.workspaces)
  const dir = useCanvasStore((s) => s.project.dir)
  useEffect(() => {
    const api = window.api?.workspace
    const setMissing = useCanvasStore.getState().setWorkspaceMissing
    if (!api || !dir || workspaces.length === 0) {
      if (Object.keys(useCanvasStore.getState().workspaceMissing).length > 0) setMissing([])
      return
    }
    let live = true
    void api
      .dirsExist(workspaces.map(folderOf))
      .then((exists) => {
        if (live) setMissing(workspaces.filter((_, i) => exists[i] === false).map((w) => w.id))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [workspaces, dir])
}

export function WorkspaceMenu(): ReactElement {
  useWorkspaceReconcile()
  const count = useCanvasStore((s) => s.workspaces.length)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Workspace | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        style={open ? { ...pill, ...pillOn } : pill}
        onClick={() => setOpen((v) => !v)}
        title="Workspaces"
        aria-haspopup="menu"
        aria-expanded={open}
        data-test="workspace-menu-btn"
      >
        <span aria-hidden="true">◫</span>
        Workspaces
        {count > 0 && <span style={countTag}>{count}</span>}
      </button>
      {(open || creating || deleting) && (
        <Suspense fallback={null}>
          <WorkspacePanel
            open={open}
            anchor={triggerRef}
            onClose={() => setOpen(false)}
            creating={creating}
            setCreating={setCreating}
            deleting={deleting}
            setDeleting={setDeleting}
          />
        </Suspense>
      )}
    </>
  )
}

// The ProjectSwitcher pill's island language, one size down (it is the project's sub-menu).
const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  cursor: 'pointer',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-subtle)',
  boxShadow: 'var(--shadow-pop)',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  fontWeight: 500
}
const pillOn: CSSProperties = { color: 'var(--accent)', background: 'var(--accent-wash)' }
// workspaceDialogStyles' `tag`, inlined so the shared dialog styles stay out of the entry chunk.
const countTag: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'var(--text-3)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-pill)',
  padding: '1px 7px'
}
