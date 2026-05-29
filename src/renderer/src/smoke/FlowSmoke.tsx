import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  useOnViewportChange
} from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import DiagOverlay from '../spike/DiagOverlay'
import { roundRect, worldRectToScreen, rectsEqual } from '../lib/cameraBounds'
import type { Rect } from '../lib/cameraBounds'

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
 * 1-C: the view follows the camera LIVE via a single rAF pump driven off
 * useOnViewportChange — NOT React re-renders. Each frame computes the screen rect
 * imperatively, diff-skips, and sends at most ONE coalesced setBounds IPC (the
 * channel is shared with node-pty, so per-frame fan-out must stay bounded). The
 * pump self-stops when the camera goes still, so there's no idle rAF.
 */
function PreviewSync({
  paneRef,
  open
}: {
  paneRef: React.RefObject<HTMLDivElement | null>
  open: boolean
}) {
  const { getViewport } = useReactFlow()
  const paneOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lastSent = useRef<Rect | null>(null)
  const openRef = useRef(open)
  // rAF pump state: the raf handle (0 = idle) + consecutive no-change frames.
  const rafRef = useRef(0)
  const idleRef = useRef(0)
  useEffect(() => {
    openRef.current = open
  }, [open])

  // Compute current screen bounds; send ONE coalesced setBounds IPC iff it moved.
  // Reads the viewport imperatively (no React re-render). Returns whether it sent
  // — the pump uses that to auto-stop when the camera goes still.
  const flush = useCallback((): boolean => {
    if (!openRef.current) return false
    const bounds = roundRect(worldRectToScreen(PREVIEW_RECT, getViewport(), paneOffset.current))
    if (lastSent.current && rectsEqual(lastSent.current, bounds)) return false
    lastSent.current = bounds
    void window.api.setPreviewBounds(bounds)
    return true
  }, [getViewport])

  // Single rAF loop: one IPC batch per frame while moving, diff-skipped. Self-stops
  // after a few idle frames — no perpetual rAF when still, and a backstop if onEnd
  // never fires. onChange restarts it (guarded by rafRef === 0).
  const startPump = useCallback(() => {
    if (rafRef.current || !openRef.current) return
    idleRef.current = 0
    const step = (): void => {
      idleRef.current = flush() ? 0 : idleRef.current + 1
      rafRef.current = idleRef.current < 4 ? requestAnimationFrame(step) : 0
    }
    rafRef.current = requestAnimationFrame(step)
  }, [flush])

  // Drive the pump off React Flow's viewport gesture, NOT React re-renders.
  useOnViewportChange({
    onStart: startPump,
    onChange: startPump,
    onEnd: () => {
      flush() // land exact final bounds; the pump then idles out
    }
  })

  // paneOffset = the React Flow pane's top-left in window CSS px. setBounds wants
  // window-content DIP coords, and the pane sits below the 44px topbar + tabs.
  // Compute once per LAYOUT (resize), never per frame — then re-sync once.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      paneOffset.current = { x: r.left, y: r.top }
      flush()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [paneRef, flush])

  // Open/close lifecycle. openPreview creates the view + loads the URL + sets the
  // initial bounds; priming lastSent so the first pump frame diff-skips.
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

  // Tear down on unmount (tab switch / HMR): stop the pump + close the view.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      void window.api.closePreview()
    },
    []
  )

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
