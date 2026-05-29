import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  useViewport
} from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import DiagOverlay from '../spike/DiagOverlay'
import { roundRect, worldRectToScreen, rectsEqual } from '../lib/cameraBounds'
import type { Rect, Viewport } from '../lib/cameraBounds'

// 1-B: one WebContentsView pinned to ONE node's bounds, camera still. The
// "preview node" has a KNOWN world rect; the native view is positioned by the
// camera→bounds math (worldRectToScreen), NOT getBoundingClientRect. Verify it
// sits pixel-aligned over the dashed cutout at a few static zoom levels.
const PREVIEW_NODE_ID = '2'
const PREVIEW_RECT: Rect = { x: 280, y: 60, width: 360, height: 240 }

// Custom node = the seed of a future "board". The preview node renders a dashed
// "cutout" so misalignment is visible: a perfectly-placed native view hides it;
// any drift reveals the dashed edge peeking out on one side.
function SmokeNode({ data }: NodeProps) {
  const d = data as { label: string; sub: string; preview?: boolean }
  if (d.preview) {
    return (
      <div style={cutoutStyle}>
        <div className="t">{d.label}</div>
        <div className="s">{d.sub}</div>
        <div style={{ marginTop: 'auto', color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          native view mounts over this cutout
        </div>
      </div>
    )
  }
  return (
    <>
      <div className="t">{d.label}</div>
      <div className="s">{d.sub}</div>
    </>
  )
}

const cutoutStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  border: '1.5px dashed var(--accent)',
  borderRadius: 'var(--r-board)',
  background: 'var(--accent-wash)',
  fontSize: 11
}

const nodeTypes = { smoke: SmokeNode }

const nodes: Node[] = [
  {
    id: '1',
    type: 'smoke',
    position: { x: 0, y: 0 },
    data: { label: 'Terminal board', sub: 'agent · main' }
  },
  {
    id: PREVIEW_NODE_ID,
    type: 'smoke',
    position: { x: PREVIEW_RECT.x, y: PREVIEW_RECT.y },
    style: { width: PREVIEW_RECT.width, height: PREVIEW_RECT.height, padding: 0 },
    data: { label: 'Browser board', sub: 'localhost (preview)', preview: true }
  },
  {
    id: '3',
    type: 'smoke',
    position: { x: 120, y: 360 },
    data: { label: 'Planning board', sub: 'milestone 2' }
  }
]

/**
 * Keeps the single native WebContentsView glued to PREVIEW_RECT under the React
 * Flow camera. Must live INSIDE <ReactFlow> to use the viewport hooks.
 *
 * 1-B drives the sync off React's reactive `useViewport()` — correct while the
 * camera is still (open, then set zoom via Controls). 1-C replaces this with a
 * single rAF loop off useOnViewportChange for live pan/zoom (no React re-renders).
 */
function PreviewSync({
  paneRef,
  open
}: {
  paneRef: React.RefObject<HTMLDivElement | null>
  open: boolean
}) {
  const { getViewport } = useReactFlow()
  const vp = useViewport()
  const paneOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lastSent = useRef<Rect | null>(null)
  // Mirror `open` into a ref so the stable `sync` callback can guard on it
  // without re-creating itself (and tearing down the ResizeObserver) per toggle.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  const sync = useCallback((viewport: Viewport) => {
    if (!openRef.current) return
    const bounds = roundRect(worldRectToScreen(PREVIEW_RECT, viewport, paneOffset.current))
    if (lastSent.current && rectsEqual(lastSent.current, bounds)) return
    lastSent.current = bounds
    void window.api.setPreviewBounds(bounds)
  }, [])

  // paneOffset = the React Flow pane's top-left in window CSS px. setBounds wants
  // window-content DIP coords, and the pane sits below the 44px topbar + tabs.
  // Compute once per LAYOUT (resize), never per frame — then re-sync bounds.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      paneOffset.current = { x: r.left, y: r.top }
      sync(getViewport())
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [paneRef, sync, getViewport])

  // Open/close lifecycle. openPreview creates the view + loads the URL + sets the
  // initial bounds; priming lastSent so the first reactive sync diff-skips.
  useEffect(() => {
    if (open) {
      const bounds = roundRect(worldRectToScreen(PREVIEW_RECT, getViewport(), paneOffset.current))
      lastSent.current = bounds
      void window.api.openPreview({ bounds })
    } else {
      lastSent.current = null
      void window.api.closePreview()
    }
  }, [open, getViewport])

  // Re-sync when the camera changes (reactive; still-camera path for 1-B).
  useEffect(() => {
    sync(vp)
  }, [vp, sync])

  // Tear the native view down when the canvas unmounts (tab switch / HMR).
  useEffect(() => () => void window.api.closePreview(), [])

  return null
}

export default function FlowSmoke() {
  // Diagnostics overlay: on by default in dev, off in packaged builds. The 1-C+
  // sync work reads frame-time/FPS from it. Toggle with Ctrl/⌘+Shift+D.
  const [diag, setDiag] = useState(import.meta.env.DEV)
  const [open, setOpen] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault()
        setDiag((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <div className="hint">React Flow · drag to pan · ⌘/Ctrl + wheel to zoom (0.1–2.5)</div>
      <div style={previewToolbarStyle}>
        <button className={open ? 'btn' : 'btn accent'} onClick={() => setOpen((v) => !v)}>
          {open ? 'Close preview' : 'Open preview'}
        </button>
      </div>
      <div ref={paneRef} style={{ position: 'absolute', inset: 0 }}>
        <ReactFlow
          nodes={nodes}
          nodeTypes={nodeTypes}
          minZoom={0.1}
          maxZoom={2.5}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#232327" />
          <Controls />
          <MiniMap pannable zoomable />
          <PreviewSync paneRef={paneRef} open={open} />
        </ReactFlow>
      </div>
      {diag && <DiagOverlay liveViews={open ? 1 : 0} />}
    </>
  )
}

const previewToolbarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 6
}
