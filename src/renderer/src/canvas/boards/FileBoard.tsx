/**
 * File board content (file-tree epic - S3: CodeMirror 6 viewer/editor).
 *
 * Replaces the S1 placeholder with the real on-canvas file viewer/editor. CodeMirror 6
 * (NOT Monaco) is the locked engine: it runs cleanly under the prod CSP `script-src 'self'`
 * - no `eval`, no `blob:` script workers - so opening/editing a file produces ZERO CSP /
 * unsafe-eval console errors (the whole reason for the switch; KICKOFF section 3).
 *
 * Two render modes dodge the React-Flow subpixel-transform problem that hits ANY DOM editor
 * (`getClientRects` under a live `transform: scale` mis-maps the caret; non-integer scale
 * blurs on non-retina - KICKOFF section 3):
 *   1. VIEW (default / read-only / not focused): a STATIC syntax-highlighted snapshot built
 *      from CM's Lezer highlighter -> plain `<pre>` HTML. No live `EditorView`, so it is crisp
 *      at any zoom and there is nothing to hit-test.
 *   2. EDIT (on click / focus, editable boards only): a live CodeMirror mounted inside a
 *      wrapper COUNTER-SCALED to 1x (the inverse of the live RF zoom), so the browser never
 *      hit-tests the editor through a non-integer scale - the caret lands where you click.
 *
 * Content is read live from disk via `window.api.file` (the S1 contract; never persisted -
 * the scene/session split). Edits set a dirty flag; Cmd/Ctrl+S writes back atomically. Image
 * files render as an `<img>` (Blob URL) instead of the editor; oversized / binary files show
 * a guard instead of loading. Theme is anchored to the `index.css` tokens (see fileBoardSyntax).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { useStore } from '@xyflow/react'
import CodeMirror, { type EditorView } from '@uiw/react-codemirror'
import type { FileBoard as FileBoardData } from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { showToast } from '../../store/toastStore'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import {
  IMAGE_MIME_BY_EXT,
  LARGE_TEXT_BYTES,
  MAX_IMAGE_BYTES,
  baseName,
  buildEditorExtensions,
  buildSnapshotHtml,
  clampFileFont,
  extOf,
  formatBytes,
  looksBinary,
  readStickyFileFont,
  resolveLanguage,
  writeStickyFileFont
} from './fileBoardSyntax'

type Kind = 'loading' | 'empty' | 'text' | 'image' | 'large' | 'binary' | 'error'

export function FileBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onStartConnect
}: BoardViewProps<FileBoardData>): ReactElement {
  const path = board.path
  const readOnly = !!board.readOnly
  const updateBoard = useCanvasStore((s) => s.updateBoard)

  // Live camera zoom (RF store): drives the edit-mode counter-scale. Object.is equality ->
  // re-renders only when the zoom actually changes; the snapshot HTML is memoised so a zoom
  // frame never re-highlights. FileBoard mounts only above LOD, so zoom is in [0.4, 2.5].
  const zoom = useStore((s) => s.transform[2])

  const [kind, setKind] = useState<Kind>(path ? 'loading' : 'empty')
  const [text, setText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [editing, setEditing] = useState(false)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [size, setSize] = useState(0)
  const [errMsg, setErrMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  // Viewer font: seeded from the sticky global default; A-/A+ (+ Ctrl/Cmd +/-) adjust this board
  // live and update the sticky default (so new boards + reloads inherit it). No per-board schema.
  const [fontSize, setFontSize] = useState(readStickyFileFont)
  const adjustFont = useCallback((delta: number): void => {
    setFontSize((f) => {
      const next = clampFileFont(f + delta)
      writeStickyFileFont(next)
      return next
    })
  }, [])

  const dirty = kind === 'text' && text !== savedText

  // Refs the save handler + the blur handler read (so they see the latest values). Synced in
  // an effect, not during render, so no ref is written/read in the render phase.
  const textRef = useRef(text)
  const dirtyRef = useRef(dirty)
  const pathRef = useRef(path)
  const savingRef = useRef(saving)
  useEffect(() => {
    textRef.current = text
    dirtyRef.current = dirty
    pathRef.current = path
    savingRef.current = saving
  })

  const pendingCaretRef = useRef<{ x: number; y: number } | null>(null)

  const ext = path ? extOf(path) : ''
  const fileName = path ? baseName(path) : ''
  const isImageExt = ext in IMAGE_MIME_BY_EXT

  // -- Load (read live from disk; never persisted) ------------------------------
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    // Reset the view synchronously for the new path (the intended "input changed -> clear the
    // stale view" pattern; cf. BoardNode's LOD hover-clear). Runs once per path/ext change, not
    // per render, so the cascading-render concern the rule guards against doesn't apply.
    /* eslint-disable react-hooks/set-state-in-effect */
    setEditing(false)
    setImgUrl(null)
    setErrMsg('')

    if (!path) {
      setKind('empty')
      return
    }
    setKind('loading')
    /* eslint-enable react-hooks/set-state-in-effect */

    void (async () => {
      try {
        const st = await window.api.file.stat(path)
        if (cancelled) return
        setSize(st.size)
        if (st.isDir) {
          setErrMsg('This is a folder, not a file.')
          setKind('error')
          return
        }

        if (ext in IMAGE_MIME_BY_EXT) {
          if (st.size > MAX_IMAGE_BYTES) {
            setKind('large')
            return
          }
          // SVG is text on disk; raster needs the bytes channel. Both become a Blob URL
          // (CSP `img-src` already allows `blob:`), revoked on path change / unmount. The
          // raster bytes are copied into a fresh ArrayBuffer-backed view so the Blob part
          // type is `Uint8Array<ArrayBuffer>` (the IPC value is `ArrayBufferLike`).
          const mime = IMAGE_MIME_BY_EXT[ext]
          let blob: Blob
          if (ext === 'svg') {
            const svg = await window.api.file.readText(path)
            if (cancelled) return
            blob = new Blob([svg], { type: mime })
          } else {
            const bytes = await window.api.file.readBytes(path)
            if (cancelled) return
            blob = new Blob([new Uint8Array(bytes)], { type: mime })
          }
          objectUrl = URL.createObjectURL(blob)
          setImgUrl(objectUrl)
          setKind('image')
          return
        }

        if (st.size > LARGE_TEXT_BYTES) {
          setKind('large')
          return
        }
        const content = await window.api.file.readText(path)
        if (cancelled) return
        if (looksBinary(content)) {
          setKind('binary')
          return
        }
        setText(content)
        setSavedText(content)
        setKind('text')
      } catch (e) {
        if (cancelled) return
        setErrMsg(e instanceof Error ? e.message : String(e))
        setKind('error')
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, ext])

  // -- Language resolution + highlighting (sync; no worker, no eval) -------------
  const { support, parser } = useMemo(() => resolveLanguage(ext), [ext])
  const extensions = useMemo(() => buildEditorExtensions(support), [support])
  const snapshotHtml = useMemo(() => buildSnapshotHtml(text, parser), [text, parser])

  // -- Save (atomic write via the S1 contract) ----------------------------------
  const doSave = useCallback(async (): Promise<void> => {
    const p = pathRef.current
    if (!p || savingRef.current || !dirtyRef.current) return
    setSaving(true)
    const snapshot = textRef.current
    try {
      const ok = await window.api.file.writeText(p, snapshot)
      if (!ok) throw new Error('write returned false')
      setSavedText(snapshot)
    } catch (e) {
      showToast({
        id: `file-save-${board.id}`,
        kind: 'error',
        message: `Couldn't save ${baseName(p)} - ${e instanceof Error ? e.message : String(e)}`
      })
    } finally {
      setSaving(false)
    }
  }, [board.id])

  const onCreateEditor = useCallback((view: EditorView): void => {
    const at = pendingCaretRef.current
    pendingCaretRef.current = null
    // Defer one frame so the editor has laid out, then place the caret at the click point
    // (its rect == the snapshot's, so `posAtCoords` with the original screen coords maps).
    requestAnimationFrame(() => {
      if (at) {
        const pos = view.posAtCoords(at)
        if (pos != null) view.dispatch({ selection: { anchor: pos } })
      }
      view.focus()
    })
  }, [])

  const enterEdit = useCallback(
    (e: ReactMouseEvent): void => {
      if (readOnly || kind !== 'text') return
      pendingCaretRef.current = { x: e.clientX, y: e.clientY }
      setEditing(true)
    },
    [readOnly, kind]
  )

  // Editor host keydown: keep editor keystrokes off the canvas keymap (the canvas already
  // ignores contentEditable, but Delete / single-letter tools listen on window), and handle
  // Cmd/Ctrl+S (CM has no save command) + Cmd/Ctrl +/- (font size) here so the browser save
  // dialog / page zoom never fire.
  const onEditorKeyDown = useCallback(
    (e: ReactKeyboardEvent): void => {
      e.stopPropagation()
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        void doSave()
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        adjustFont(-1)
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        adjustFont(1)
      }
    },
    [doSave, adjustFont]
  )

  // Leave edit mode (back to the crisp snapshot) when focus leaves a CLEAN editor; a dirty
  // editor stays mounted so unsaved work + undo history survive losing focus.
  const onEditorBlur = useCallback((e: ReactFocusEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    if (!dirtyRef.current) setEditing(false)
  }, [])

  const bindPath = useCallback((): void => {
    const next = pathDraft.trim().replace(/\\/g, '/')
    if (!next) return
    useCanvasStore.getState().beginChange()
    updateBoard(board.id, { path: next })
  }, [pathDraft, board.id, updateBoard])

  // Title-bar controls (text boards): font steppers (always) + dirty dot/Save (editable) or a
  // read-only tag. `onMouseDown preventDefault` keeps the editor focused (no blur -> snapshot flip).
  const stepBtnStyle: CSSProperties = {
    fontFamily: 'var(--ui)',
    fontWeight: 600,
    lineHeight: 1,
    color: 'var(--text-2)',
    background: 'transparent',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-ctl)',
    width: 22,
    height: 20,
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    flex: 'none'
  }
  const actions =
    kind === 'text' ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}
          title={`Font size ${fontSize}px (Ctrl/Cmd +/-)`}
        >
          <button
            className="nodrag"
            aria-label="Decrease font size"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => adjustFont(-1)}
            style={{ ...stepBtnStyle, fontSize: 11 }}
          >
            A-
          </button>
          <button
            className="nodrag"
            aria-label="Increase font size"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => adjustFont(1)}
            style={{ ...stepBtnStyle, fontSize: 13 }}
          >
            A+
          </button>
        </span>
        {!readOnly && dirty && (
          <span
            title="Unsaved changes"
            aria-label="Unsaved changes"
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: 'var(--warn)',
              flex: 'none'
            }}
          />
        )}
        {!readOnly && (
          <button
            className="nodrag"
            title="Save (Cmd/Ctrl+S)"
            disabled={!dirty || saving}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void doSave()}
            style={{
              fontFamily: 'var(--ui)',
              fontSize: 11,
              fontWeight: 500,
              color: dirty ? 'var(--text)' : 'var(--text-faint)',
              background: dirty ? 'var(--surface-overlay)' : 'transparent',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-ctl)',
              padding: '2px 8px',
              cursor: dirty && !saving ? 'pointer' : 'default'
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
        {readOnly && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--text-3)',
              flex: 'none'
            }}
          >
            read-only
          </span>
        )}
      </div>
    ) : undefined

  return (
    <BoardFrame
      type="file"
      boardId={board.id}
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      contentBg="var(--surface)"
      actions={actions}
      onFull={onFull}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onAddToGroup={onAddToGroup}
      onRemoveFromGroup={onRemoveFromGroup}
      onStartConnect={onStartConnect}
    >
      {kind === 'empty' && (
        <EmptyState pathDraft={pathDraft} onDraftChange={setPathDraft} onBind={bindPath} />
      )}

      {kind === 'loading' && (
        <Centered>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--text-3)' }}>
            Loading {fileName}...
          </span>
        </Centered>
      )}

      {kind === 'text' &&
        (editing && !readOnly ? (
          <EditorHost
            zoom={zoom}
            fontPx={fontSize}
            onBlur={onEditorBlur}
            onKeyDown={onEditorKeyDown}
          >
            <CodeMirror
              value={text}
              height="100%"
              style={{ height: '100%' }}
              theme="none"
              editable={!readOnly}
              readOnly={readOnly}
              extensions={extensions}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                autocompletion: false,
                searchKeymap: false,
                highlightSelectionMatches: false,
                syntaxHighlighting: false,
                closeBrackets: true,
                bracketMatching: true
              }}
              onChange={setText}
              onCreateEditor={onCreateEditor}
            />
          </EditorHost>
        ) : (
          <pre
            className="nowheel nodrag nopan"
            data-test="file-snapshot"
            title={readOnly ? undefined : 'Click to edit'}
            onMouseDown={enterEdit}
            style={{
              position: 'absolute',
              inset: 0,
              margin: 0,
              overflow: 'auto',
              padding: '8px 12px',
              fontFamily: 'var(--mono)',
              fontSize: fontSize,
              lineHeight: 1.55,
              color: 'var(--text)',
              whiteSpace: 'pre',
              tabSize: 2,
              cursor: readOnly ? 'default' : 'text'
            }}
            // Safe: text escaped, colours are fixed palette hexes (see buildSnapshotHtml).
            dangerouslySetInnerHTML={{ __html: snapshotHtml }}
          />
        ))}

      {kind === 'image' && imgUrl && (
        <div
          className="nowheel nodrag"
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'auto',
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            background: 'var(--inset)'
          }}
        >
          <img
            src={imgUrl}
            alt={fileName}
            data-test="file-image"
            draggable={false}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        </div>
      )}

      {kind === 'large' && (
        <GuardCard
          title={isImageExt ? 'Image too large to preview' : 'File too large to open here'}
          fileName={fileName}
          detail={`${formatBytes(size)} - open it in your editor.`}
        />
      )}

      {kind === 'binary' && (
        <GuardCard
          title="Binary file"
          fileName={fileName}
          detail="This file isn't text - open it in your editor."
        />
      )}

      {kind === 'error' && (
        <GuardCard title="Couldn't open this file" fileName={fileName} detail={errMsg} danger />
      )}
    </BoardFrame>
  )
}

// -- Presentational sub-pieces -----------------------------------------------------

/** Counter-scaled editor host: wraps the live CodeMirror so the browser hit-tests it at a
 *  NET 1x scale (RF's `scale(z)` x this `scale(1/z)` = identity) - the caret lands where you
 *  click and the text stays crisp. The inner box is sized `z x` so it fills the slot after the
 *  inverse scale. `nowheel/nodrag/nopan` keep wheel-scroll + text-drag from driving the canvas;
 *  `panOnScroll` is on globally, but RF honours `.nowheel` (the terminal/preview boards rely on
 *  the same). */
function EditorHost({
  zoom,
  fontPx,
  onBlur,
  onKeyDown,
  children
}: {
  zoom: number
  fontPx: number
  onBlur: (e: ReactFocusEvent) => void
  onKeyDown: (e: ReactKeyboardEvent) => void
  children: ReactElement
}): ReactElement {
  const z = Math.max(zoom, 0.1)
  const inner: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: `${100 * z}%`,
    height: `${100 * z}%`,
    transform: `scale(${1 / z})`,
    transformOrigin: 'top left'
  }
  // `--cm-font` drives the EDITOR_THEME font-size (content + gutters) so it tracks the snapshot.
  const host = {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    '--cm-font': `${fontPx}px`
  } as CSSProperties
  return (
    <div
      className="nowheel nodrag nopan"
      data-test="file-editor"
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      style={host}
    >
      <div style={inner}>{children}</div>
    </div>
  )
}

function Centered({ children }: { children: ReactElement }): ReactElement {
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

function GuardCard({
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
function EmptyState({
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
