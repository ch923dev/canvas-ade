/**
 * File board (S3) - the dumb presentational pieces, split out of FileBoard.tsx (keeps it under
 * the max-lines gate). Centered/GuardCard/EmptyState are pure layout; FileActionsMenu is the
 * right-click context menu (copy path / name / absolute path / GitHub link + Find in file).
 */
import type { ReactElement } from 'react'
import { Menu } from '../Menu'
import { showToast } from '../../store/toastStore'
import { baseName } from './fileBoardSyntax'

// -- Markdown preview (rendered, read-only) ----------------------------------------
// Dark, token-aligned styling for `renderMarkdownToHtml`'s output. Injected once into <head>
// (CSP allows inline <style>); scoped under `.cm-md-preview` so it can't leak to other boards.
const MD_CSS = `
.cm-md-preview { font-family: var(--ui); font-size: 14px; line-height: 1.6; color: var(--text); padding: 14px 18px; }
.cm-md-preview > :first-child { margin-top: 0; }
.cm-md-preview h1,.cm-md-preview h2,.cm-md-preview h3,.cm-md-preview h4,.cm-md-preview h5,.cm-md-preview h6 { font-weight: 600; line-height: 1.3; margin: 1.2em 0 0.5em; }
.cm-md-preview h1 { font-size: 1.7em; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3em; }
.cm-md-preview h2 { font-size: 1.4em; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.2em; }
.cm-md-preview h3 { font-size: 1.2em; }
.cm-md-preview p { margin: 0.6em 0; }
.cm-md-preview a { color: var(--accent); text-decoration: none; }
.cm-md-preview a:hover { text-decoration: underline; }
.cm-md-preview strong { font-weight: 600; }
.cm-md-preview code { font-family: var(--mono); font-size: 0.88em; background: var(--inset); padding: 0.15em 0.4em; border-radius: var(--r-ctl); }
.cm-md-preview pre.cm-md-code { background: var(--inset); border: 1px solid var(--border-subtle); border-radius: var(--r-inner); padding: 10px 12px; overflow: auto; }
.cm-md-preview pre.cm-md-code code { background: none; padding: 0; font-size: 12.5px; line-height: 1.5; white-space: pre; }
.cm-md-preview blockquote { margin: 0.6em 0; padding: 0.2em 0.9em; border-left: 3px solid var(--border-strong); color: var(--text-2); }
.cm-md-preview ul,.cm-md-preview ol { margin: 0.5em 0; padding-left: 1.5em; }
.cm-md-preview li { margin: 0.2em 0; }
.cm-md-preview hr { border: none; border-top: 1px solid var(--border-subtle); margin: 1.2em 0; }
.cm-md-preview table { border-collapse: collapse; margin: 0.8em 0; font-size: 0.95em; }
.cm-md-preview th,.cm-md-preview td { border: 1px solid var(--border-subtle); padding: 5px 10px; text-align: left; }
.cm-md-preview th { background: var(--surface-raised); font-weight: 600; }
.cm-md-preview img { max-width: 100%; }
`
let mdStylesInjected = false
function ensureMarkdownStyles(): void {
  if (mdStylesInjected || typeof document === 'undefined') return
  mdStylesInjected = true
  const el = document.createElement('style')
  el.id = 'cm-md-styles'
  el.textContent = MD_CSS
  document.head.appendChild(el)
}

/** Rendered Markdown view (read-only). The HTML is XSS-safe by construction (see
 *  renderMarkdownToHtml: escaped text + fixed tags + scheme-filtered URLs only). Links navigate
 *  through the app's will-navigate guard, which routes http(s) to the OS browser. */
export function MarkdownPreview({ html }: { html: string }): ReactElement {
  ensureMarkdownStyles()
  return (
    <div
      className="cm-md-preview nowheel nodrag nopan"
      style={{ position: 'absolute', inset: 0, overflow: 'auto' }}
      // Safe: renderMarkdownToHtml emits only escaped text + fixed tags + filtered URLs.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

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

/** Unbound board. Primary path: "Browse files" reveals the docked tree and ARMS this board so the
 *  next file clicked in the tree fills it (or drag a file straight onto the board). Typing a
 *  project-relative path is kept as a secondary affordance under an "or" divider. */
export function EmptyState({
  pathDraft,
  onDraftChange,
  onBind,
  onBrowse,
  armed,
  onCancelBrowse
}: {
  pathDraft: string
  onDraftChange: (v: string) => void
  onBind: () => void
  onBrowse: () => void
  armed: boolean
  onCancelBrowse: () => void
}): ReactElement {
  return (
    <Centered>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          width: '86%',
          maxWidth: 340
        }}
      >
        <svg
          width={26}
          height={26}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-3)"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 4h7l4 4v12H7zM14 4v4h4" />
        </svg>
        <div
          style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 500, color: 'var(--text-2)' }}
        >
          No file open
        </div>

        <button
          className="nodrag"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={armed ? onCancelBrowse : onBrowse}
          style={{
            fontFamily: 'var(--ui)',
            fontSize: 12,
            fontWeight: 500,
            color: armed ? 'var(--accent)' : 'var(--text)',
            background: armed ? 'var(--accent-wash)' : 'var(--surface-overlay)',
            border: `1px solid ${armed ? 'var(--accent)' : 'var(--border-subtle)'}`,
            borderRadius: 'var(--r-ctl)',
            padding: '6px 14px',
            cursor: 'pointer'
          }}
        >
          {armed ? 'Choose a file in the tree — cancel' : 'Browse files'}
        </button>
        <div
          style={{
            fontFamily: 'var(--ui)',
            fontSize: 11,
            color: 'var(--text-3)',
            textAlign: 'center'
          }}
        >
          {armed
            ? 'Pick a file from the tree on the left, or drag one onto this board.'
            : 'Click a file in the tree, or drag one onto this board.'}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            color: 'var(--text-faint)'
          }}
        >
          <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
          <span style={{ fontFamily: 'var(--ui)', fontSize: 10 }}>or</span>
          <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
        </div>

        <div style={{ display: 'flex', gap: 6, width: '100%' }}>
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
    // Guard like copyAbs: gitPermalink returns {ok:false} for expected misses, but the IPC can
    // still reject (foreign-sender / unexpected MAIN error) — don't leak an unhandled rejection.
    try {
      const res = await window.api.file.gitPermalink(path)
      if (res.ok) await copyText(res.url, 'GitHub link', boardId)
      else showToast({ id: `file-copy-${boardId}`, kind: 'error', message: res.reason })
    } catch {
      showToast({
        id: `file-copy-${boardId}`,
        kind: 'error',
        message: "Couldn't build a GitHub link"
      })
    }
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
