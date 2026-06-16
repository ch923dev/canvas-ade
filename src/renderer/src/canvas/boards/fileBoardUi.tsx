/**
 * File board (S3) - the dumb presentational pieces, split out of FileBoard.tsx (keeps it under
 * the max-lines gate). Centered/GuardCard/EmptyState are pure layout; FileActionsMenu is the
 * right-click context menu (copy path / name / absolute path / GitHub link + Find in file).
 */
import type { ReactElement } from 'react'
import { Menu } from '../Menu'
import { showToast } from '../../store/toastStore'
import { baseName } from './fileBoardSyntax'

export function Centered({ children }: { children: ReactElement }): ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        textAlign: 'center'
      }}
    >
      {children}
    </div>
  )
}

export function GuardCard({
  title,
  fileName,
  detail,
  danger = false
}: {
  title: string
  fileName: string
  detail?: string
  danger?: boolean
}): ReactElement {
  return (
    <Centered>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '100%' }}>
        <div
          style={{
            fontFamily: 'var(--ui)',
            fontSize: 13,
            fontWeight: 500,
            color: danger ? 'var(--err)' : 'var(--text-2)'
          }}
        >
          {title}
        </div>
        {fileName && (
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--text)',
              wordBreak: 'break-all'
            }}
          >
            {fileName}
          </div>
        )}
        {detail && (
          <div
            style={{
              fontFamily: 'var(--ui)',
              fontSize: 11,
              color: 'var(--text-3)',
              wordBreak: 'break-word'
            }}
          >
            {detail}
          </div>
        )}
      </div>
    </Centered>
  )
}

/** Unbound board: a hint plus a project-relative path field so a file board is usable before
 *  the S2 tree lands (and as a permanent "point this board at a file" affordance). */
export function EmptyState({
  pathDraft,
  onDraftChange,
  onBind
}: {
  pathDraft: string
  onDraftChange: (v: string) => void
  onBind: () => void
}): ReactElement {
  return (
    <Centered>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '82%', maxWidth: 320 }}
      >
        <div style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--text-2)' }}>
          No file open
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="nodrag nopan"
            value={pathDraft}
            placeholder="src/index.ts"
            aria-label="Project-relative file path"
            onChange={(e) => onDraftChange(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') onBind()
            }}
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--text)',
              background: 'var(--inset)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-ctl)',
              padding: '5px 8px',
              outline: 'none'
            }}
          />
          <button
            className="nodrag"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onBind}
            style={{
              fontFamily: 'var(--ui)',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text)',
              background: 'var(--surface-overlay)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-ctl)',
              padding: '5px 10px',
              cursor: 'pointer'
            }}
          >
            Open
          </button>
        </div>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--text-3)' }}>
          Open a file from the tree, or type a project-relative path.
        </div>
      </div>
    </Centered>
  )
}

// -- Right-click context menu (copy actions + find) --------------------------------
async function copyText(text: string, label: string, boardId: string): Promise<void> {
  const ok = await window.api.clipboard.writeText(text)
  showToast({
    id: `file-copy-${boardId}`,
    kind: ok ? 'ok' : 'error',
    message: ok ? `Copied ${label}` : `Couldn't copy ${label}`
  })
}

/** Context menu opened at the pointer (the shared `Menu` shell handles clamp/outside/Esc).
 *  Copy actions resolve through the S1+S3 file IPC; "Find in file" defers to the board. */
export function FileActionsMenu({
  at,
  path,
  boardId,
  canFind,
  onFind,
  onClose
}: {
  at: { x: number; y: number }
  path: string
  boardId: string
  canFind: boolean
  onFind: () => void
  onClose: () => void
}): ReactElement {
  const run = (fn: () => void) => (): void => {
    onClose()
    fn()
  }
  const item = (label: string, fn: () => void): ReactElement => (
    <button className="board-menu-item" role="menuitem" onClick={run(fn)}>
      {label}
    </button>
  )
  const copyAbs = async (): Promise<void> => {
    try {
      await copyText(await window.api.file.realPath(path), 'absolute path', boardId)
    } catch {
      showToast({ id: `file-copy-${boardId}`, kind: 'error', message: "Couldn't resolve the path" })
    }
  }
  const copyGit = async (): Promise<void> => {
    const res = await window.api.file.gitPermalink(path)
    if (res.ok) await copyText(res.url, 'GitHub link', boardId)
    else showToast({ id: `file-copy-${boardId}`, kind: 'error', message: res.reason })
  }
  return (
    <Menu anchor={at} label="File actions" className="board-menu" onClose={onClose}>
      {item('Copy path', () => void copyText(path, 'path', boardId))}
      {item('Copy file name', () => void copyText(baseName(path), 'file name', boardId))}
      {item('Copy absolute path', () => void copyAbs())}
      {item('Copy GitHub link', () => void copyGit())}
      {canFind && (
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
      )}
      {canFind && item('Find in file', onFind)}
    </Menu>
  )
}
