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
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { useStore } from '@xyflow/react'
import { createPortal } from 'react-dom'
import CodeMirror, { type EditorView } from '@uiw/react-codemirror'
import { openSearchPanel } from '@codemirror/search'
import type { FileBoard as FileBoardData } from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { useFileTreeUiStore } from '../../store/fileTreeUiStore'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import {
  IMAGE_MIME_BY_EXT,
  LARGE_TEXT_BYTES,
  MAX_IMAGE_BYTES,
  baseName,
  buildEditorExtensions,
  clampFileFont,
  extOf,
  fileCaps,
  formatBytes,
  looksBinary,
  readStickyFileFont,
  resolveLanguage,
  writeStickyFileFont
} from './fileBoardSyntax'
import { useFileSnapshotHtml } from './useFileSnapshotHtml'
import { renderMarkdownToHtml } from './fileBoardMarkdown'
import { useFileSave } from './fileBoardSave'
import { Centered, EmptyState, FileActionsMenu, GuardCard, MarkdownPreview } from './fileBoardUi'
import { FILEREF_MIME } from '../fileTreeData'
import { FileInspector } from './file/FileInspector'
import { useInspectorSlot } from '../inspector/inspectorSlotStore'

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
  // Board Inspector slot (P2): non-null only while THIS board is the single eligible selection.
  const inspectorSlot = useInspectorSlot(board.id)
  const selectBoard = useCanvasStore((s) => s.selectBoard)
  // This board is the single reusable "peek" (preview) board ⟺ its id is the store's peekBoardId:
  // render it ghosted (dashed) and offer an explicit Pin. Pinning (here, a double-click in the tree,
  // or the first edit below) promotes it to a permanent board.
  const isPeek = useCanvasStore((s) => s.peekBoardId === board.id)
  // Empty-board "Browse files": arms this board so the next tree-file click fills it (S3 redesign).
  const armed = useFileTreeUiStore((s) => s.pendingBindId === board.id)
  const requestBrowse = useFileTreeUiStore((s) => s.requestBrowse)
  const clearPendingBind = useFileTreeUiStore((s) => s.clearPendingBind)

  // Live camera zoom (RF store): drives the edit-mode counter-scale. Object.is equality ->
  // re-renders only when the zoom actually changes; the snapshot HTML is memoised so a zoom
  // frame never re-highlights. FileBoard mounts only above LOD, so zoom is in [0.4, 2.5].
  const zoom = useStore((s) => s.transform[2])

  const [kind, setKind] = useState<Kind>(path ? 'loading' : 'empty')
  // P5 (D5): the Inspector's error-state Retry re-runs the loader effect for the SAME path by
  // bumping this nonce (a dep of the load effect below) — no path mutation, no board patch.
  const [loadNonce, setLoadNonce] = useState(0)
  const [text, setText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [size, setSize] = useState(0)
  const [errMsg, setErrMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  // Markdown boards switch between the rendered preview, a side-by-side split, and the source
  // editor (set per path; auto-recognised to 'preview' for .md, 'source' otherwise).
  const [mode, setMode] = useState<'preview' | 'split' | 'source'>('source')
  // True while a file-ref is dragged over this board (drop → rebind it to that file).
  const [dragOver, setDragOver] = useState(false)
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
  // "Live editor on the focused board" (the locked S3 behaviour): the SELECTED text board shows
  // the live, counter-scaled CodeMirror straight away — no click-to-edit step; every other File
  // board shows the cheap, crisp static snapshot. A dirty board stays live even while deselected
  // so its unsaved buffer + CM undo history survive losing selection.
  const showEditor = !readOnly && kind === 'text' && (selected || dirty)

  // Refs the save handler + the blur handler read (so they see the latest values). Synced in
  // an effect, not during render, so no ref is written/read in the render phase.
  const textRef = useRef(text)
  const dirtyRef = useRef(dirty)
  const pathRef = useRef(path)
  const savingRef = useRef(saving)
  // FIND-002: the on-disk mtime we last loaded/saved. Passed to writeText so MAIN refuses to
  // blind-overwrite a file an external process (e.g. an agent) changed since — no silent lost update.
  const savedMtimeRef = useRef<number | null>(null)
  useEffect(() => {
    textRef.current = text
    dirtyRef.current = dirty
    pathRef.current = path
    savingRef.current = saving
  })

  // Auto-pin on edit (VS Code parity): the moment a peek board becomes dirty, promote it so the
  // edited buffer can never be recycled out from under the user. `pinBoard` no-ops once pinned.
  useEffect(() => {
    if (dirty) useCanvasStore.getState().pinBoard(board.id)
  }, [dirty, board.id])

  const pendingCaretRef = useRef<{ x: number; y: number } | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const pendingSearchRef = useRef(false)
  // Split-mode scroll-sync: the source pane (CM6 editor or snapshot) + the preview pane wrappers.
  const sourcePaneRef = useRef<HTMLDivElement | null>(null)
  const previewPaneRef = useRef<HTMLDivElement | null>(null)
  // Bumped when the CM6 view is (re)created so the split-sync effect re-runs once `viewRef.scrollDOM`
  // actually exists — the editor mounts lazily when you switch into Split, after the effect first ran.
  const [editorNonce, setEditorNonce] = useState(0)
  // Right-click context menu (copy actions + find), opened at the pointer.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  const ext = path ? extOf(path) : ''
  const fileName = path ? baseName(path) : ''
  // Title bar shows the FILE NAME (VS Code shows the filename in its tab), not the generic "File".
  // A user rename (title differs from the 'File' default) still wins. Italicised when this is the
  // peek/preview board — VS Code's italic-tab cue, the clear signal that it will be recycled.
  const displayTitle = board.title && board.title !== 'File' ? board.title : fileName || 'File'
  const isImageExt = ext in IMAGE_MIME_BY_EXT
  const caps = useMemo(() => fileCaps(ext), [ext])
  const isMarkdown = caps.preview === 'markdown'

  // -- Load (read live from disk; never persisted) ------------------------------
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    // Reset the view synchronously for the new path (the intended "input changed -> clear the
    // stale view" pattern; cf. BoardNode's LOD hover-clear). Runs once per path/ext change, not
    // per render, so the cascading-render concern the rule guards against doesn't apply.
    /* eslint-disable react-hooks/set-state-in-effect */
    setImgUrl(null)
    setErrMsg('')
    // Auto-recognition: previewable+editable (Markdown) opens in Preview; everything else Source.
    setMode(fileCaps(ext).preview === 'markdown' ? 'preview' : 'source')

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
        savedMtimeRef.current = st.mtimeMs // FIND-002: baseline for the optimistic-concurrency save
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
  }, [path, ext, loadNonce])

  // -- Language resolution + highlighting (sync; no worker, no eval) -------------
  // SLICE-009: the highlight (Lezer parse) + markdown render are the per-keystroke hot paths. Key
  // them on a DEFERRED copy of `text` (React 19) so an edit commits the urgent editor update first
  // and the expensive parse runs at low priority — fast typing skips intermediate values (coalesced
  // like a debounce) and never blocks input. VIEW-mode snapshot / split preview converge once typing
  // settles. (Does NOT move the parse off-thread — that first-open block is SLICE-008's worker.)
  const deferredText = useDeferredValue(text)
  const { support, parser } = useMemo(() => resolveLanguage(ext), [ext])
  const extensions = useMemo(() => buildEditorExtensions(support), [support])
  // SLICE-008: the snapshot highlight runs off the open-time critical path (small files sync, large
  // files time-sliced async). The deferred text (SLICE-009) coalesces fast typing into the parse.
  const snapshotHtml = useFileSnapshotHtml(deferredText, parser)
  // Render Markdown only when a markdown board is showing the preview or the split (cheap to skip).
  const showMarkdown = isMarkdown && (mode === 'preview' || mode === 'split')
  const markdownHtml = useMemo(
    () => (showMarkdown ? renderMarkdownToHtml(deferredText) : ''),
    [showMarkdown, deferredText]
  )

  // -- Save (atomic write via the S1 contract) ----------------------------------
  // Extracted to keep this host under the file-size doctrine; owns the FIND-002 overwrite guard.
  const doSave = useFileSave({
    boardId: board.id,
    pathRef,
    textRef,
    dirtyRef,
    savingRef,
    savedMtimeRef,
    setSaving,
    setSavedText
  })

  const onCreateEditor = useCallback((view: EditorView): void => {
    viewRef.current = view
    // Re-run the split-sync effect now that the editor's scrollDOM exists (idempotent; the value/
    // extensions are stable, so this re-render never recreates the view → no loop).
    setEditorNonce((n) => n + 1)
    const at = pendingCaretRef.current
    pendingCaretRef.current = null
    const wantSearch = pendingSearchRef.current
    pendingSearchRef.current = false
    // Defer one frame so the editor has laid out, then place the caret at the click point
    // (its rect == the snapshot's, so `posAtCoords` with the original screen coords maps).
    requestAnimationFrame(() => {
      if (at) {
        const pos = view.posAtCoords(at)
        if (pos != null) view.dispatch({ selection: { anchor: pos } })
      }
      view.focus()
      if (wantSearch) openSearchPanel(view)
    })
  }, [])

  // Split-mode scroll sync (source → preview): scrolling the source pane drives the rendered preview
  // to the same scroll FRACTION, so the two panes track together. Fraction-based ⇒ correct at any
  // camera zoom (the editor's counter-scale doesn't change scrollTop/scrollHeight ratios). Only
  // source→preview, so writing preview.scrollTop never feeds back into a loop. The source scroller is
  // the live CM6 editor's `scrollDOM` while editing (reliable handle — no fragile querySelector/timing,
  // and the effect re-runs via `editorNonce` once the view exists), else the read-only `<pre>` snapshot.
  useEffect(() => {
    if (!(kind === 'text' && isMarkdown && mode === 'split')) return
    const src: HTMLElement | null = showEditor
      ? (viewRef.current?.scrollDOM ?? null)
      : (sourcePaneRef.current?.querySelector<HTMLElement>('[data-test="file-snapshot"]') ?? null)
    const prev = previewPaneRef.current?.querySelector<HTMLElement>('.cm-md-preview')
    if (!src || !prev) return
    const onScroll = (): void => {
      const range = src.scrollHeight - src.clientHeight
      const frac = range > 0 ? src.scrollTop / range : 0
      prev.scrollTop = frac * (prev.scrollHeight - prev.clientHeight)
    }
    src.addEventListener('scroll', onScroll, { passive: true })
    onScroll() // align once on (re)attach
    return () => src.removeEventListener('scroll', onScroll)
  }, [kind, isMarkdown, mode, showEditor, markdownHtml, editorNonce])

  const enterEdit = useCallback(
    (e: ReactMouseEvent): void => {
      // Left-click only — a right-click opens the context menu (and must not also edit). Record the
      // click point so the caret lands there once the editor mounts, then SELECT this board — that
      // flips `showEditor` on (selected), swapping the snapshot for the live editor in place.
      if (e.button !== 0 || readOnly || kind !== 'text') return
      pendingCaretRef.current = { x: e.clientX, y: e.clientY }
      selectBoard(board.id)
    },
    [readOnly, kind, selectBoard, board.id]
  )

  // Open the find-in-file panel: if the live editor is up, open it; otherwise mount it (select the
  // board → showEditor) and open it once it mounts (onCreateEditor consumes pendingSearchRef).
  const openFind = useCallback((): void => {
    const editorUp = !!viewRef.current && showEditor && !(isMarkdown && mode === 'preview')
    if (editorUp && viewRef.current) {
      openSearchPanel(viewRef.current)
      viewRef.current.focus()
      return
    }
    // Leave the rendered-only preview (no editor there), select the board, search on mount.
    if (isMarkdown && mode === 'preview') setMode('source')
    pendingSearchRef.current = true
    selectBoard(board.id)
  }, [showEditor, isMarkdown, mode, selectBoard, board.id])

  // Right-click anywhere on a bound board's content → the file actions menu (suppress the
  // native menu + keep it off the canvas).
  const onContextMenu = useCallback(
    (e: ReactMouseEvent): void => {
      if (!path) return
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    },
    [path]
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

  // Drop a file-ref (dragged from the tree) ONTO this board → rebind it to that file. Wired in the
  // CAPTURE phase (see the wrapper) so this fires BEFORE the live CodeMirror editor's own built-in
  // drag/drop — otherwise CM swallows the drop on a focused board and the rebind never happens.
  // stopPropagation then keeps the canvas drop handler from ALSO opening a second board behind it.
  const onBoardDragOver = useCallback((e: ReactDragEvent): void => {
    if (!e.dataTransfer.types.includes(FILEREF_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])
  const onBoardDragLeave = useCallback((e: ReactDragEvent): void => {
    // Ignore leaves into descendants (dragleave fires crossing child boundaries).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }, [])
  const onBoardDrop = useCallback(
    (e: ReactDragEvent): void => {
      const raw = e.dataTransfer.getData(FILEREF_MIME)
      setDragOver(false)
      if (!raw) return
      e.preventDefault()
      e.stopPropagation()
      let next = ''
      try {
        next = String(JSON.parse(raw).path ?? '')
      } catch {
        return
      }
      if (!next || next === path) return
      useCanvasStore.getState().beginChange()
      updateBoard(board.id, { path: next })
    },
    [board.id, path, updateBoard]
  )

  const bindPath = useCallback((): void => {
    const next = pathDraft.trim().replace(/\\/g, '/')
    if (!next) return
    useCanvasStore.getState().beginChange()
    updateBoard(board.id, { path: next })
  }, [pathDraft, board.id, updateBoard])

  // P5: the title-bar cluster (pin / mode seg / font ± / Save) is gone — FileInspector is the one
  // control home. Only the at-a-glance UNSAVED cue survives on the bar, as a quiet dot beside the
  // title (D1); Save itself lives in Inspector › File.
  const titleBadge = dirty ? (
    <span
      role="img"
      aria-label="Unsaved changes"
      title="Unsaved changes"
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: 'var(--warn)',
        flex: 'none'
      }}
    />
  ) : undefined

  // The text content's left/sole pane: the live editor on the focused board, else the crisp
  // snapshot. Built once so the plain (source) view and the split view's left half share it.
  const textPane: ReactElement = showEditor ? (
    <EditorHost zoom={zoom} fontPx={fontSize} onKeyDown={onEditorKeyDown}>
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
  )

  return (
    <>
      {inspectorSlot &&
        createPortal(
          <FileInspector
            kind={kind}
            isMarkdown={isMarkdown}
            mode={mode}
            onMode={setMode}
            fontSize={fontSize}
            onDecFont={() => adjustFont(-1)}
            onIncFont={() => adjustFont(1)}
            readOnly={readOnly}
            dirty={dirty}
            saving={saving}
            onSave={() => void doSave()}
            canFind={kind === 'text' && !readOnly}
            onFind={openFind}
            isPeek={isPeek}
            onPin={() => useCanvasStore.getState().pinBoard(board.id)}
            path={path ?? ''}
            typeLabel={ext ? ext.toUpperCase() : ''}
            sizeText={size ? formatBytes(size) : ''}
            errorDetail={errMsg}
            onBrowse={() => requestBrowse(board.id)}
            onRetry={() => setLoadNonce((n) => n + 1)}
          />,
          inspectorSlot
        )}
      <BoardFrame
        type="file"
        boardId={board.id}
        title={displayTitle}
        titleItalic={isPeek}
        selected={selected}
        hovered={hovered}
        dimmed={dimmed}
        contentBg="var(--surface)"
        titleBadge={titleBadge}
        onFull={onFull}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onAddToGroup={onAddToGroup}
        onRemoveFromGroup={onRemoveFromGroup}
        onStartConnect={onStartConnect}
      >
        <div
          style={{ position: 'absolute', inset: 0 }}
          onContextMenu={onContextMenu}
          onDragOverCapture={onBoardDragOver}
          onDragLeaveCapture={onBoardDragLeave}
          onDropCapture={onBoardDrop}
        >
          {kind === 'empty' && (
            <EmptyState
              pathDraft={pathDraft}
              onDraftChange={setPathDraft}
              onBind={bindPath}
              onBrowse={() => requestBrowse(board.id)}
              armed={armed}
              onCancelBrowse={clearPendingBind}
            />
          )}

          {kind === 'loading' && (
            <Centered>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--text-3)' }}>
                Loading {fileName}...
              </span>
            </Centered>
          )}

          {kind === 'text' &&
            (isMarkdown && mode === 'preview' ? (
              <MarkdownPreview html={markdownHtml} />
            ) : isMarkdown && mode === 'split' ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
                <div
                  ref={sourcePaneRef}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    position: 'relative',
                    borderRight: '1px solid var(--border-subtle)'
                  }}
                >
                  {textPane}
                </div>
                <div ref={previewPaneRef} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                  <MarkdownPreview html={markdownHtml} />
                </div>
              </div>
            ) : (
              textPane
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

          {/* Drop affordance: a file-ref dragged from the tree is hovering this board → drop rebinds
            it to that file. pointer-events:none so it never eats the drop it advertises. */}
          {dragOver && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--accent-wash)',
                border: '2px dashed var(--accent)',
                borderRadius: 'var(--r-inner)',
                zIndex: 2
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--ui)',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--accent)'
                }}
              >
                Drop to open here
              </span>
            </div>
          )}
        </div>
        {ctxMenu && path && (
          <FileActionsMenu
            at={ctxMenu}
            path={path}
            boardId={board.id}
            canFind={kind === 'text' && !readOnly}
            onFind={openFind}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </BoardFrame>
    </>
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
  onKeyDown,
  children
}: {
  zoom: number
  fontPx: number
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
  // `--cm-font` drives the EDITOR_THEME font-size. The editor is counter-scaled to net 1x, so a
  // logical font of `fontPx` would render a CONSTANT on-screen size — but the snapshot is canvas
  // content that scales with the camera (on-screen `fontPx * z`). To make EDIT and VIEW match at
  // every zoom, the editor renders at the EFFECTIVE font `fontPx * z`: after the inner `scale(1/z)`
  // and RF's `scale(z)` that lands at `fontPx * z` on screen too (the terminal's effective-font
  // trick). Net scale stays 1, so the caret still hit-tests correctly.
  const host = {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    '--cm-font': `${fontPx * z}px`
  } as CSSProperties
  return (
    <div
      className="nowheel nodrag nopan"
      data-test="file-editor"
      onKeyDown={onKeyDown}
      style={host}
    >
      <div style={inner}>{children}</div>
    </div>
  )
}
