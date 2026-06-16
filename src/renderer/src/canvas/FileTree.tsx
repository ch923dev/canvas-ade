/**
 * File-tree epic (S2) — the virtualized, lazily-loaded project file tree.
 *
 * Reads the project folder one directory at a time via the S1 `window.api.file.listDir`
 * contract (NEVER eager-walks the repo): the root loads on mount, each folder's children load
 * on first expand. Stays live by subscribing to `file:treeEvent` (the S2 chokidar watcher) and
 * re-listing only the affected — and currently-loaded — parent folder, debounced.
 *
 * Rows are native HTML5 drag sources emitting the `application/x-canvas-ade-fileref` payload
 * (the drop target lands in S4); clicking a file opens it as a File board via the S1
 * `openFileBoard` action (placeholder board until S3). react-arborist provides the windowing
 * + collapse; its internal react-dnd reordering is disabled (`disableDrag`/`disableDrop`) so the
 * native drag-out is unobstructed. The pure data model lives in `fileTreeData.ts`.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { Tree, type NodeRendererProps } from 'react-arborist'
import { useCanvasStore } from '../store/canvasStore'
import { Icon } from './Icon'
import { FILEREF_MIME, applyListing, findNode, parentOf, type FileNode } from './fileTreeData'

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
const FILE_PATH = 'M7 4h7l4 4v12H7zM14 4v4h4'

// ── row renderer ───────────────────────────────────────────────────────────────

function FileRow({ node, dragHandle }: NodeRendererProps<FileNode>): ReactElement {
  const openFileBoard = useCanvasStore((s) => s.openFileBoard)
  const d = node.data

  const onClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (d.isDir) node.toggle()
    else openFileBoard(d.id)
  }
  const onDragStart = (e: React.DragEvent): void => {
    // setData is string-only — JSON-encode the {path,label} payload (the S4 drop handler parses it).
    e.dataTransfer.setData(FILEREF_MIME, JSON.stringify({ path: d.id, label: d.name }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      ref={dragHandle}
      className="ca-ftree-row"
      // Own the indent (arborist's `style` only carries paddingLeft) so root rows keep a base inset.
      style={{ paddingLeft: 8 + node.level * 12 }}
      data-dir={d.isDir || undefined}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title={d.id}
    >
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
        d={d.isDir ? FOLDER_PATH : FILE_PATH}
        style={{ color: d.isDir ? 'var(--text-2)' : 'var(--text-3)' }}
      />
      <span className="ca-ftree-name">{d.name}</span>
    </div>
  )
}

// ── component ────────────────────────────────────────────────────────────────

export function FileTree(): ReactElement {
  const [data, setData] = useState<FileNode[]>([])
  const [rootLoaded, setRootLoaded] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const hostRef = useRef<HTMLDivElement>(null)
  // Mirror `data` into a ref so the (once-registered) live-event subscription and the toggle
  // handler read the latest tree without re-subscribing on every change.
  const dataRef = useRef<FileNode[]>(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  // Load one directory's children lazily ('' = root). Preserves expanded subtrees on refresh.
  const loadDir = useCallback(async (parentId: string): Promise<void> => {
    const listDir = window.api?.file?.listDir
    if (!listDir) return
    try {
      const entries = await listDir(parentId)
      setData((prev) => applyListing(prev, parentId, entries))
      if (parentId === '') setRootLoaded(true)
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

  // Initial root listing — load via a .then chain (setState stays inside a callback, mirroring
  // AppChrome's consent effect) rather than a direct call into the async loader.
  useEffect(() => {
    const listDir = window.api?.file?.listDir
    if (!listDir) return
    let cancelled = false
    listDir('')
      .then((entries) => {
        if (cancelled) return
        setData((prev) => applyListing(prev, '', entries))
        setRootLoaded(true)
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        if (!cancelled) console.warn('[FileTree] initial listDir failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  return (
    <div ref={hostRef} className="ca-ftree-scroll">
      {size.h > 0 && (
        <Tree<FileNode>
          data={data}
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
}
