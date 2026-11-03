/**
 * The Workspaces menu (WS-4) — the lifecycle entry point beside the project switcher: lists every
 * workspace (colour · name · folder / branch · missing / archived), with New workspace… at the
 * bottom, Delete… per row, and Re-open / Remove when clean for an archived one. WS-5 turns this
 * into the workspace chip + switcher; the dialogs it opens stay.
 *
 * It also runs the open-time reconcile (§4.3 step 5): a workspace whose folder (or worktree) is
 * gone is marked `missing` in the store — ephemeral, nothing on disk is pruned or recreated, and
 * the spawn path refuses a terminal there on its own.
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
import { useReactFlow } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import type { Workspace } from '../../lib/workspaceSchema'
import { Menu } from '../Menu'
import { WORKSPACE_COLOR_CSS } from './workspaceColors'
import * as S from './workspaceDialogStyles'

// The dialogs load on first open (the bundle-budget discipline): the pill is eager chrome, the
// lifecycle UI is not.
const NewWorkspaceDialog = lazy(() =>
  import('./NewWorkspaceDialog').then((m) => ({ default: m.NewWorkspaceDialog }))
)
const DeleteWorkspaceDialog = lazy(() =>
  import('./DeleteWorkspaceDialog').then((m) => ({ default: m.DeleteWorkspaceDialog }))
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
  const workspaces = useCanvasStore((s) => s.workspaces)
  const missing = useCanvasStore((s) => s.workspaceMissing)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Workspace | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const pick = (fn: () => void) => (): void => {
    setOpen(false)
    fn()
  }

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
        {workspaces.length > 0 && <span style={S.tag}>{workspaces.length}</span>}
      </button>
      {open && (
        <Menu
          anchor={triggerRef}
          align="left"
          gap={6}
          label="Workspaces"
          className="project-switcher-menu"
          style={{ width: 340 }}
          reclampKey={workspaces.length}
          onClose={() => setOpen(false)}
        >
          <div style={head}>Workspaces</div>
          {workspaces.length === 0 && (
            <div style={{ ...S.hint, padding: '2px 10px 6px' }}>
              No workspaces yet. A workspace is a folder in this project — optionally its own git
              worktree and branch — with its own boards.
            </div>
          )}
          {workspaces.map((w) => {
            const wt = w.worktrees?.[0]
            const archived = w.state === 'archived'
            return (
              <div key={w.id} style={rowStyle} role="none" data-test={`ws-row-${w.name}`}>
                <span style={S.colorDot(WORKSPACE_COLOR_CSS[w.color])} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={nameStyle}>{w.name}</span>
                  <span style={subStyle}>
                    {wt ? wt.branch : w.root === '.' ? '. · folder' : `${w.root}/ · folder`}
                  </span>
                </span>
                {missing[w.id] && (
                  <span style={S.tagTone.err} data-test="ws-tag-missing">
                    missing
                  </span>
                )}
                {archived && (
                  <span style={S.tagTone.warn} data-test="ws-tag-archived">
                    archived
                  </span>
                )}
                {archived ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      style={rowBtn}
                      data-test={`ws-reopen-${w.name}`}
                      onClick={pick(() =>
                        useCanvasStore.getState().setWorkspaceArchived(w.id, false)
                      )}
                    >
                      Re-open
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      style={rowBtn}
                      data-test={`ws-remove-clean-${w.name}`}
                      onClick={pick(() => setDeleting(w))}
                    >
                      Remove when clean
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    style={rowBtn}
                    data-test={`ws-delete-${w.name}`}
                    onClick={pick(() => setDeleting(w))}
                  >
                    Delete…
                  </button>
                )}
              </div>
            )
          })}
          <div className="project-switcher-divider" />
          <button
            type="button"
            role="menuitem"
            data-test="ws-new"
            onClick={pick(() => setCreating(true))}
          >
            + New workspace…
          </button>
        </Menu>
      )}
      <Suspense fallback={null}>
        {creating && <NewWorkspaceHost onClose={() => setCreating(false)} />}
        {deleting && (
          <DeleteWorkspaceDialog workspace={deleting} onClose={() => setDeleting(null)} />
        )}
      </Suspense>
    </>
  )
}

/**
 * The New Workspace dialog's host: the ONLY place this menu touches React Flow (the starter boards
 * land at the viewport centre). Mounted only while the dialog is open — the switcher itself also
 * renders outside a ReactFlowProvider (its integration tests), where useReactFlow would throw.
 */
function NewWorkspaceHost({ onClose }: { onClose: () => void }): ReactElement {
  const rf = useReactFlow()
  const anchor = (): { x: number; y: number } =>
    rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  return <NewWorkspaceDialog onClose={onClose} anchor={anchor} />
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
const head: CSSProperties = {
  fontSize: 11,
  color: 'var(--text-3)',
  fontWeight: 600,
  letterSpacing: '0.02em',
  padding: '4px 10px 6px'
}
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 4px 4px 10px',
  minWidth: 0
}
const nameStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text)',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}
const subStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--text-3)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}
const rowBtn: CSSProperties = { flex: 'none', fontSize: 12, padding: '5px 8px' }
