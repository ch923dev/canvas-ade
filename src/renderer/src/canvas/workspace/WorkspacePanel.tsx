/**
 * The Workspaces menu body + the dialogs it opens (WS-4) — lazy-loaded by {@link WorkspaceMenu} on
 * first open (the bundle-budget discipline: the pill is eager chrome, this is not). Lists every
 * workspace (colour · name · folder / branch · missing / archived), with New workspace… at the
 * bottom, Delete… per row, and Re-open / Remove when clean for an archived one. WS-5 turns this
 * into the workspace chip + switcher; the dialogs it opens stay.
 */
import { lazy, Suspense, type CSSProperties, type ReactElement, type RefObject } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import type { Workspace } from '../../lib/workspaceSchema'
import { Menu } from '../Menu'
import { WORKSPACE_COLOR_CSS } from './workspaceColors'
import * as S from './workspaceDialogStyles'

const NewWorkspaceDialog = lazy(() =>
  import('./NewWorkspaceDialog').then((m) => ({ default: m.NewWorkspaceDialog }))
)
const DeleteWorkspaceDialog = lazy(() =>
  import('./DeleteWorkspaceDialog').then((m) => ({ default: m.DeleteWorkspaceDialog }))
)

export interface WorkspacePanelProps {
  open: boolean
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
  creating: boolean
  setCreating: (v: boolean) => void
  deleting: Workspace | null
  setDeleting: (w: Workspace | null) => void
}

export function WorkspacePanel({
  open,
  anchor,
  onClose,
  creating,
  setCreating,
  deleting,
  setDeleting
}: WorkspacePanelProps): ReactElement {
  const workspaces = useCanvasStore((s) => s.workspaces)
  const missing = useCanvasStore((s) => s.workspaceMissing)

  const pick = (fn: () => void) => (): void => {
    onClose()
    fn()
  }

  return (
    <>
      {open && (
        <Menu
          anchor={anchor}
          align="left"
          gap={6}
          label="Workspaces"
          className="project-switcher-menu"
          style={{ width: 340 }}
          reclampKey={workspaces.length}
          onClose={onClose}
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
