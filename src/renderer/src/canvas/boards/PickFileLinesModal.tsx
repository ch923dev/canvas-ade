/**
 * Pick file & lines modal (v19, card-detail epic) — the browse-view-select surface a Kanban card's
 * file-ref row opens instead of two blank text boxes. Three panes of one job: the LEFT is a lazy
 * project file tree (+ filter); the RIGHT renders the picked file read-only in the SAME CodeMirror +
 * syntax the File board uses; the FOOTER shows the selected line range and commits `{path, line,
 * endLine}` back to the card. Reuses `window.api.file.listDir`/`readText`, `fileBoardSyntax`'s
 * language resolution, and the shared `Modal` primitive.
 *
 * This is the AUTHORING surface for a ref; the card row's ↗ stays the separate "open it on the canvas
 * at the line" action (openFileRef). Opening in EDIT mode (`initial`) pre-loads that file + range.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import type { KanbanFileRef } from '../../lib/boardSchema'
import type { FileEntry } from '../fileTreeData'
import { Modal } from '../Modal'
import { buildEditorExtensions, extOf, looksBinary, resolveLanguage } from './fileBoardSyntax'

const childId = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name)

type LoadStatus = 'idle' | 'loading' | 'binary' | 'error'

export function PickFileLinesModal({
  initial,
  onPick,
  onClose
}: {
  initial?: KanbanFileRef
  onPick: (ref: KanbanFileRef) => void
  onClose: () => void
}): ReactElement {
  // The tree: each loaded directory's listing, keyed by its root-relative path ('' = project root).
  const [listings, setListings] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [path, setPath] = useState<string>(initial?.path ?? '')
  const [text, setText] = useState<string | null>(null)
  const [status, setStatus] = useState<LoadStatus>(initial?.path ? 'loading' : 'idle')
  // The live selection (1-based line range) read off the editor; seeded from `initial` in edit mode.
  const [sel, setSel] = useState<{ line: number; endLine: number } | null>(
    initial?.line ? { line: initial.line, endLine: initial.endLine ?? initial.line } : null
  )
  // Applied once, on the FIRST editor mount, to restore an edited ref's range (then cleared).
  const pendingSelRef = useRef<{ line: number; endLine: number } | null>(
    initial?.line ? { line: initial.line, endLine: initial.endLine ?? initial.line } : null
  )

  const loadDir = useCallback(async (parent: string): Promise<void> => {
    const list = window.api?.file?.listDir
    if (!list) return
    try {
      const entries = await list(parent)
      setListings((prev) => ({ ...prev, [parent]: entries }))
    } catch {
      /* a dir that fails to list is skipped — the rest of the tree still works */
    }
  }, [])

  // Monotonic read token: each read captures one, and a resolved read only writes state if it's still
  // the latest. Guards the click-A-then-B race — if A's readText resolves after B's, A must NOT clobber
  // B's content (the path label already says B). Mirrors FileBoard's `cancelled` load guard.
  const reqRef = useRef(0)

  // Async read ONLY (all setState is post-await) so the mount effect can call it without tripping the
  // set-state-in-effect rule. The click path pre-sets path/loading synchronously via `openFile` below.
  const readInto = useCallback(async (p: string): Promise<void> => {
    const req = ++reqRef.current
    try {
      const content = await window.api.file.readText(p)
      if (reqRef.current !== req) return // superseded by a newer open — drop this stale result
      if (looksBinary(content)) {
        setStatus('binary')
        return
      }
      setText(content)
      setStatus('idle')
    } catch {
      if (reqRef.current !== req) return
      setStatus('error')
    }
  }, [])

  const openFile = (p: string): void => {
    setPath(p)
    setText(null)
    setStatus('loading')
    void readInto(p)
  }

  // On mount: load the root listing, and (edit mode) read the file being edited. `path`/`status` are
  // already seeded from `initial` in useState. Both loaders setState only AFTER an await (async), so the
  // set-state-in-effect flag is a false positive here — same load-on-mount pattern + disable as
  // FileBoard's load effect. Mount-only by design (exhaustive-deps also disabled).
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    void loadDir('')
    if (initial?.path) void readInto(initial.path)
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const toggleDir = (id: string): void => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    if (!listings[id]) void loadDir(id)
  }

  const ext = extOf(path)
  const { support } = useMemo(() => resolveLanguage(ext), [ext])
  const extensions = useMemo(
    () => [
      ...buildEditorExtensions(support),
      // Live line-range readout — fires whenever the caret/selection moves.
      EditorView.updateListener.of((u) => {
        if (!u.selectionSet && !u.docChanged) return
        const r = u.state.selection.main
        const d = u.state.doc
        setSel({ line: d.lineAt(r.from).number, endLine: d.lineAt(r.to).number })
      })
    ],
    [support]
  )

  const onCreateEditor = useCallback((view: EditorView): void => {
    const pending = pendingSelRef.current
    pendingSelRef.current = null
    if (!pending) return
    // Defer a frame so the doc is laid out, then restore the edited ref's range (clamped to the doc).
    requestAnimationFrame(() => {
      const d = view.state.doc
      const start = Math.min(Math.max(1, pending.line), d.lines)
      const end = Math.min(Math.max(start, pending.endLine), d.lines)
      view.dispatch({
        selection: { anchor: d.line(start).from, head: d.line(end).to },
        scrollIntoView: true
      })
    })
  }, [])

  const canAdd = !!path && status === 'idle'
  const add = (): void => {
    if (!canAdd) return
    const ref: KanbanFileRef = { path }
    if (sel && sel.line > 0) {
      ref.line = sel.line
      if (sel.endLine > sel.line) ref.endLine = sel.endLine
    }
    onPick(ref)
  }

  // Recursive tree render. Dirs always show (so you can navigate); the filter only hides FILE rows by
  // name within the loaded listings (an MVP filter — it doesn't force-load unexpanded dirs).
  const f = filter.trim().toLowerCase()
  const renderTree = (parent: string, depth: number): ReactElement[] => {
    const entries = listings[parent]
    if (!entries) return []
    const rows: ReactElement[] = []
    for (const e of entries) {
      const id = childId(parent, e.name)
      const pad = { paddingLeft: 6 + depth * 14 }
      if (e.isDir) {
        const open = expanded.has(id)
        rows.push(
          <div
            key={id}
            className="pfl-row dir"
            style={pad}
            onClick={() => toggleDir(id)}
            title={id}
          >
            <span className="pfl-caret">{open ? '▾' : '▸'}</span>
            {e.name}
          </div>
        )
        if (open) rows.push(...renderTree(id, depth + 1))
      } else {
        if (f && !e.name.toLowerCase().includes(f)) continue
        rows.push(
          <div
            key={id}
            className={'pfl-row file' + (id === path ? ' sel' : '')}
            style={pad}
            data-testid="pfl-file"
            title={id}
            onClick={() => openFile(id)}
          >
            <span className="pfl-fjunk" />
            {e.name}
          </div>
        )
      }
    }
    return rows
  }

  const selLabel = sel
    ? sel.endLine > sel.line
      ? `L${sel.line}–${sel.endLine}`
      : `L${sel.line}`
    : '—'

  return (
    <Modal
      label="Pick file and lines"
      onClose={onClose}
      zIndex={9500}
      cardProps={{ 'data-testid': 'pick-file-lines' }}
      cardStyle={{ width: 860, maxWidth: '94vw', padding: 0 }}
    >
      <div className="pfl">
        <div className="pfl-head">
          <span className="pfl-title">Pick file &amp; lines</span>
          <span className="pfl-spacer" />
          <span className="pfl-hint">Esc to close</span>
          <button className="pfl-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="pfl-body">
          <div className="pfl-files">
            <div className="pfl-filter">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <circle cx="5" cy="5" r="3.2" stroke="currentColor" strokeWidth="1.1" />
                <path
                  d="M7.6 7.6 10 10"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                />
              </svg>
              <input
                value={filter}
                placeholder="Filter files…"
                aria-label="Filter files"
                data-testid="pfl-filter"
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="pfl-tree">{renderTree('', 0)}</div>
          </div>

          <div className="pfl-code">
            <div className="pfl-path">{path || 'Pick a file to view its lines'}</div>
            <div className="pfl-view">
              {status === 'idle' && text !== null ? (
                <CodeMirror
                  value={text}
                  height="100%"
                  style={{ height: '100%' }}
                  theme="none"
                  editable={false}
                  readOnly
                  extensions={extensions}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: false,
                    highlightActiveLine: true,
                    highlightActiveLineGutter: true,
                    autocompletion: false,
                    searchKeymap: false,
                    highlightSelectionMatches: false,
                    syntaxHighlighting: false
                  }}
                  onCreateEditor={onCreateEditor}
                />
              ) : (
                <div className="pfl-empty">
                  {status === 'loading'
                    ? 'Loading…'
                    : status === 'binary'
                      ? 'Binary file — pick a text file to select lines.'
                      : status === 'error'
                        ? "Couldn't read that file."
                        : 'Pick a file on the left, then select the lines.'}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="pfl-foot">
          <span className="pfl-sel" data-testid="pfl-selection">
            Selected: <b>{selLabel}</b>
            {path && <span className="pfl-sel-path"> {path}</span>}
          </span>
          <span className="pfl-spacer" />
          <button className="ca-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="ca-btn-primary" data-testid="pfl-add" disabled={!canAdd} onClick={add}>
            {initial ? 'Update ref' : 'Add ref'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
