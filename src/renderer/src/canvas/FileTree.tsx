/**
 * File-tree epic (S2) — the virtualized, lazily-loaded project file tree.
 *
 * Reads the project folder one directory at a time via the S1 `window.api.file.listDir`
 * contract (NEVER eager-walks the repo): the root loads on mount, each folder's children load
 * on first expand. Stays live by subscribing to `file:treeEvent` (the S2 chokidar watcher) and
 * re-listing only the affected — and currently-loaded — parent folder, debounced.
 *
 * Rows are native HTML5 drag sources emitting the `application/x-canvas-ade-fileref` payload
 * (S3 drop targets: a File board rebinds to the dropped file; empty canvas opens a new File
 * board); clicking a file opens it as a File board via the S1 `openFileBoard` action.
 * react-arborist provides the windowing + collapse; its internal react-dnd reordering is disabled
 * (`disableDrag`/`disableDrop`). Because that disables arborist's `canDrag`, we must NOT attach its
 * `dragHandle` to the row (react-dnd would cancel the native dragstart) — see FileRow. The pure
 * data model lives in `fileTreeData.ts`.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { createDragDropManager } from 'dnd-core'
import { useCanvasStore } from '../store/canvasStore'
import { useFileTreeUiStore } from '../store/fileTreeUiStore'
import { Icon } from './Icon'
import {
  FILEREF_MIME,
  applyListing,
  compactTree,
  findNode,
  parentOf,
  type FileNode
} from './fileTreeData'

// ONE shared react-dnd manager for every <Tree>. react-arborist otherwise spins up its own
// <DndProvider backend={HTML5Backend}> per Tree instance; when the SidePanel unmounts + remounts
// on a project switch the old and new backends briefly overlap and react-dnd throws "Cannot have
// two HTML5 backends at the same time" (crashing the whole canvas to the ErrorBoundary). A single
// module-level manager means exactly one backend, reused across mounts, so a remount never conflicts.
const dndManager = createDragDropManager(HTML5Backend)

// ── glyphs ───────────────────────────────────────────────────────────────────

function Glyph({ d, style }: { d: string; style?: CSSProperties }): ReactElement {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: '0 0 auto', ...style }}
    >
      <path d={d} />
    </svg>
  )
}

const FOLDER_PATH = 'M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z'
// File glyphs all share the folded-corner silhouette + a type mark inside, so they read as a
// family. Kept NEUTRAL (no per-type colour) to honour the one-accent design contract (DESIGN.md);
// the differentiation is by shape, like a minimal icon theme.
const FILE_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4'
const CODE_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4M10 12l-1.6 2 1.6 2M14 12l1.6 2-1.6 2' // </>
const DOC_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4M9.5 13h5M9.5 16h3.5' // text lines
const IMG_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4M9 17l2-2.4 1.5 1.5L15.5 13l1.5 2' // mountain

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])
const DOC_EXT = new Set(['md', 'mdx', 'markdown', 'txt'])
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'])

/** The folded-file glyph for a filename, picked by extension (folders use FOLDER_PATH). */
function fileGlyphPath(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (CODE_EXT.has(ext)) return CODE_PATH
  if (DOC_EXT.has(ext)) return DOC_PATH
  if (IMG_EXT.has(ext)) return IMG_PATH
  return FILE_PATH
}

// ── row renderer ───────────────────────────────────────────────────────────────

function FileRow({ node }: NodeRendererProps<FileNode>): ReactElement {
  // Single-click PEEKS (reuse the one ghosted preview board); double-click PINS a permanent board
  // — VS Code's preview-tab discipline, so browsing the tree never litters the canvas.
  const peekFile = useCanvasStore((s) => s.peekFile)
  const pinFile = useCanvasStore((s) => s.pinFile)
  const d = node.data
  // Compact-folder rows render the whole chain ("a / b / c"); the deepest path is the real target.
  const segs = d.segments
  const label = segs ? segs.map((s) => s.name).join(' / ') : d.name
  const targetPath = segs ? segs[segs.length - 1].id : d.id

  const onClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (d.isDir) {
      node.toggle()
      return
    }
    // If an empty File board armed itself via "Browse files", bind THIS file INTO it (and focus
    // it) rather than opening a separate board. Guard against a stale/now-bound target.
    const pendingId = useFileTreeUiStore.getState().pendingBindId
    if (pendingId) {
      const cs = useCanvasStore.getState()
      const target = cs.boards.find((b) => b.id === pendingId)
      useFileTreeUiStore.getState().clearPendingBind()
      if (target && target.type === 'file' && !target.path) {
        cs.beginChange()
        cs.updateBoard(pendingId, { path: d.id })
        useCanvasStore.setState({ pendingFocusId: pendingId })
        return
      }
    }
    peekFile(d.id)
  }
  // Double-click pins: promote the peek (or focus/spawn) a PERMANENT board for this file.
  const onDoubleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!d.isDir) pinFile(d.id)
  }
  const onDragStart = (e: React.DragEvent): void => {
    // setData is string-only — JSON-encode the {path,label} payload (the drop handlers parse it).
    e.dataTransfer.setData(FILEREF_MIME, JSON.stringify({ path: d.id, label: d.name }))
    // CRITICAL: also set a react-dnd-recognised native type (text/plain). react-arborist mounts
    // react-dnd's HTML5Backend, whose WINDOW-level dragstart listener calls preventDefault on any
    // native drag that carries neither a react-dnd source nor a recognised native type (Files/URL/
    // text) — which would silently cancel this drag-out. Setting text/plain makes it a "native text"
    // drag react-dnd leaves alone; our drop targets still read the FILEREF_MIME payload. The text
    // value (the path) is a sensible plain-text fallback for drops outside the app.
    e.dataTransfer.setData('text/plain', d.id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    // NB: we deliberately do NOT attach arborist's `dragHandle` here. That handle is react-dnd's
    // drag-source connector, and with `disableDrag` set arborist's `canDrag` is false → react-dnd
    // would `preventDefault` the native `dragstart` and our drag-out would never begin. Leaving it
    // unattached frees the native HTML5 drag below (the tree's only drag is this file-ref drag-out).
    <div
      className="ca-ftree-row"
      // Base inset only; one indent guide per ancestor level is rendered below (the per-level
      // padding now lives in the guide spans, so the lines align with the nesting).
      style={{ paddingLeft: 8 }}
      data-dir={d.isDir || undefined}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={targetPath}
    >
      {Array.from({ length: node.level }, (_, i) => (
        <span key={i} className="ca-ftree-guide" aria-hidden />
      ))}
      {d.isDir ? (
        <Icon
          name="chevron"
          size={13}
          style={{
            flex: '0 0 auto',
            color: 'var(--text-3)',
            transform: node.isOpen ? 'none' : 'rotate(-90deg)'
          }}
        />
      ) : (
        <span style={{ width: 13, flex: '0 0 auto' }} aria-hidden />
      )}
      <Glyph
        d={d.isDir ? FOLDER_PATH : fileGlyphPath(d.name)}
        style={{ color: d.isDir ? 'var(--text-2)' : 'var(--text-3)' }}
      />
      <span className="ca-ftree-name">{label}</span>
    </div>
  )
}

// ── component ────────────────────────────────────────────────────────────────

/** Imperative handle the SidePanel drives (collapse-all button + Ctrl+Shift+B). */
export interface FileTreeHandle {
  collapseAll: () => void
}

export const FileTree = forwardRef<FileTreeHandle>(function FileTree(_props, ref): ReactElement {
  const [data, setData] = useState<FileNode[]>([])
  const [rootLoaded, setRootLoaded] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const hostRef = useRef<HTMLDivElement>(null)
  // react-arborist's imperative API (closeAll/openParents/scrollTo) — used for collapse-all now.
  const treeApiRef = useRef<TreeApi<FileNode> | null>(null)
  useImperativeHandle(ref, () => ({ collapseAll: () => treeApiRef.current?.closeAll() }), [])
  // Mirror `data` into a ref so the (once-registered) live-event subscription and the toggle
  // handler read the latest tree without re-subscribing on every change.
  const dataRef = useRef<FileNode[]>(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  // Load one directory's children lazily ('' = root). Preserves expanded subtrees on refresh.
  // Cascade-loads a sole sub-folder so single-folder chains render compact (see compactTree)
  // without a flash; capped depth guards against a runaway descent on a deep one-child chain.
  const loadDir = useCallback(async function load(parentId: string, depth = 0): Promise<void> {
    const listDir = window.api?.file?.listDir
    if (!listDir) return
    try {
      const entries = await listDir(parentId)
      setData((prev) => applyListing(prev, parentId, entries))
      if (parentId === '') setRootLoaded(true)
      if (depth < 16 && entries.length === 1 && entries[0].isDir) {
        const childId = parentId ? `${parentId}/${entries[0].name}` : entries[0].name
        await load(childId, depth + 1)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[FileTree] listDir failed for', parentId || '<root>', err)
    }
  }, [])

  // Measure the scroll host so react-arborist's windowing has real pixel dimensions.
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ w: Math.floor(r.width), h: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // (Re)list the root whenever the open project changes — resets stale data on a project switch
  // and runs once on mount. loadDir also cascade-loads a sole root sub-folder (compact folders).
  const projectDir = useCanvasStore((s) => s.project.dir)
  useEffect(() => {
    setData([])
    setRootLoaded(false)
    void loadDir('')
  }, [projectDir, loadDir])

  // Live updates: re-list only the affected (and currently-loaded) parent folder, debounced.
  useEffect(() => {
    const onTreeEvent = window.api?.file?.onTreeEvent
    if (!onTreeEvent) return
    const pending = new Set<string>()
    let timer: number | null = null
    const flush = (): void => {
      timer = null
      const dirs = [...pending]
      pending.clear()
      for (const dir of dirs) {
        if (dir === '' || findNode(dataRef.current, dir)?.loaded) void loadDir(dir)
      }
    }
    const unsub = onTreeEvent((ev) => {
      pending.add(parentOf(ev.path))
      if (timer === null) timer = window.setTimeout(flush, 250)
    })
    return () => {
      unsub()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [loadDir])

  // Expand → load on first open (onToggle fires on open AND close; the loaded guard no-ops close).
  const onToggle = useCallback(
    (id: string): void => {
      const node = findNode(dataRef.current, id)
      if (node?.isDir && !node.loaded) void loadDir(id)
    },
    [loadDir]
  )

  // Compact single-child folder chains into one row just before render (VS Code "compact folders").
  const displayData = useMemo(() => compactTree(data), [data])

  return (
    <div ref={hostRef} className="ca-ftree-scroll">
      {size.h > 0 && (
        <Tree<FileNode>
          ref={treeApiRef}
          dndManager={dndManager}
          data={displayData}
          idAccessor="id"
          childrenAccessor={(n) => (n.isDir ? (n.children ?? []) : null)}
          openByDefault={false}
          disableDrag
          disableDrop
          disableMultiSelection
          width={size.w}
          height={size.h}
          indent={12}
          rowHeight={26}
          onToggle={onToggle}
          className="ca-ftree-list"
        >
          {FileRow}
        </Tree>
      )}
      {rootLoaded && data.length === 0 && <div className="ca-ftree-empty">Empty folder</div>}
    </div>
  )
})
