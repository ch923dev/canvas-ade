import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  useOnViewportChange,
  useNodesState
} from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import DiagOverlay from '../spike/DiagOverlay'
import { roundRect, worldRectToScreen, rectsEqual, fitZoomFactor } from '../lib/cameraBounds'
import type { Rect } from '../lib/cameraBounds'

// 1-E: N native WebContentsViews, one per "preview board", positioned by the
// camera→bounds math. Each board has a KNOWN world rect and a responsive preset W
// (390/834/1280) the page is held at. The native views are synced via a single
// rAF batch (one IPC/frame for ALL views); motion / LOD is carried by capturePage
// snapshots rendered inside the node (so React Flow scales them with the camera).
const LOD_ZOOM = 0.4 // below this camera zoom a board shows its snapshot, not live
const MAX_LIVE = 4 // cap concurrent live renderers; over-cap boards are closed
const PRESETS = [390, 834, 1280] as const

interface PreviewBoard {
  id: string
  label: string
  rect: Rect
  defaultPreset: number
}

// Two boards side by side. World width 720 keeps every preset above Chromium's
// 0.25 zoom-factor floor from ~40% camera zoom up (below 40% a board shows a
// snapshot anyway). zoomFactor = (720 / presetW) * camZoom; e.g. 1280 → 0.56*cam,
// unclamped for cam ≥ 0.44. Without enough world size, the desktop preset clamps
// at zoom-out and lays the page out narrower than its breakpoint.
const PREVIEW_BOARDS: PreviewBoard[] = [
  {
    id: 'mobile',
    label: 'Browser · A',
    rect: { x: 0, y: 0, width: 720, height: 460 },
    defaultPreset: 390
  },
  {
    id: 'desktop',
    label: 'Browser · B',
    rect: { x: 860, y: 0, width: 720, height: 460 },
    defaultPreset: 1280
  }
]

type PresetMap = Record<string, number>

// ── Node rendering ──────────────────────────────────────────────────────────

// The preview node shows a dashed cutout (alignment aid) when live, or — during
// motion / LOD — `data.snapshot` (a capturePage data URL) as an <img> INSIDE the
// node, so React Flow scales it with the camera as a unit.
function SmokeNode({ data }: NodeProps) {
  const d = data as { label: string; sub: string; preview?: boolean; snapshot?: string | null }
  if (d.preview) {
    return (
      <div style={cutoutStyle}>
        {d.snapshot ? (
          <img src={d.snapshot} alt="" draggable={false} style={snapshotStyle} />
        ) : (
          <>
            <div className="t">{d.label}</div>
            <div className="s">{d.sub}</div>
            <div style={{ marginTop: 'auto', color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
              native view mounts over this cutout
            </div>
          </>
        )}
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
  fontSize: 11,
  overflow: 'hidden'
}

const snapshotStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  borderRadius: 'var(--r-board)'
}

const nodeTypes = { smoke: SmokeNode }

const initialNodes: Node[] = [
  ...PREVIEW_BOARDS.map(
    (b): Node => ({
      id: b.id,
      type: 'smoke',
      position: { x: b.rect.x, y: b.rect.y },
      style: { width: b.rect.width, height: b.rect.height, padding: 0 },
      data: { preview: true, label: b.label, sub: 'localhost', snapshot: null }
    })
  ),
  {
    id: 'plan',
    type: 'smoke',
    // Clear of the browser boards (y 0–460) so they don't overlap; a native view
    // would otherwise paint over this HTML node (the documented occlusion).
    position: { x: 300, y: 620 },
    data: { label: 'Planning board', sub: 'milestone 2' }
  }
]

// ── Preview manager (lives inside <ReactFlow> for the viewport hooks) ─────────

interface ManagerHandle {
  /** Open→close the views N times for the leak check. */
  cycle: (n: number) => Promise<void>
}

interface ManagerProps {
  paneRef: React.RefObject<HTMLDivElement | null>
  open: boolean
  presets: PresetMap
  onLive: (n: number) => void
}

interface BoardRec {
  attached: boolean
  exists: boolean // a WebContentsView is created (open) and not closed
  lastSent: Rect | null
  lastZoom: number
}

const PreviewManager = forwardRef<ManagerHandle, ManagerProps>(function PreviewManager(
  { paneRef, open, presets, onLive },
  ref
) {
  const { getViewport, updateNodeData } = useReactFlow()
  const paneOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const openedRef = useRef(open)
  const presetsRef = useRef(presets)
  const gestureRef = useRef(false)
  const rafRef = useRef(0)
  const idleRef = useRef(0)
  const recs = useRef<Map<string, BoardRec>>(
    new Map(
      PREVIEW_BOARDS.map((b) => [
        b.id,
        { attached: false, exists: false, lastSent: null, lastZoom: 0 }
      ])
    )
  )

  const boundsFor = useCallback(
    (b: PreviewBoard): Rect =>
      roundRect(worldRectToScreen(b.rect, getViewport(), paneOffset.current)),
    [getViewport]
  )
  const zoomFor = useCallback(
    (b: PreviewBoard): number =>
      fitZoomFactor(b.rect.width, presetsRef.current[b.id] ?? b.defaultPreset, getViewport().zoom),
    [getViewport]
  )
  const liveCount = useCallback((): number => {
    let n = 0
    for (const r of recs.current.values()) if (r.attached) n++
    return n
  }, [])

  // A board may be LIVE only if it's zoomed in enough AND its top edge is at/below
  // the pane top — a native view can't be clipped, so a board panned up into the
  // topbar/tabs must fall back to its (clippable) HTML snapshot instead.
  const liveEligible = useCallback(
    (b: PreviewBoard): boolean => {
      const vp = getViewport()
      if (vp.zoom < LOD_ZOOM) return false
      const s = worldRectToScreen(b.rect, vp, paneOffset.current)
      return s.y >= paneOffset.current.y
    },
    [getViewport]
  )

  // Capture → snapshot → detach a single live board (used when a board leaves the
  // live set while still attached, so it never strands on the bare cutout).
  const demoteToSnapshot = useCallback(
    async (b: PreviewBoard): Promise<void> => {
      const rec = recs.current.get(b.id)!
      if (!rec.attached) return
      const url = await window.api.capturePreview(b.id)
      if (url) updateNodeData(b.id, { snapshot: url })
      await window.api.detachPreview(b.id)
      rec.attached = false
      onLive(liveCount())
    },
    [updateNodeData, liveCount, onLive]
  )

  // Bring a board's live view onto its node (creating the renderer if needed). The
  // snapshot is NOT cleared — it stays as a fallback layer UNDER the native view
  // (which paints over it), so a reattach can never flash the bare cutout.
  const attachBoard = useCallback(
    async (b: PreviewBoard): Promise<void> => {
      const rec = recs.current.get(b.id)!
      const bounds = boundsFor(b)
      const zoomFactor = zoomFor(b)
      rec.lastSent = bounds
      rec.lastZoom = zoomFactor
      rec.attached = true
      if (rec.exists) {
        void window.api.attachPreview({ id: b.id, bounds, zoomFactor })
      } else {
        rec.exists = true
        await window.api.openPreview({ id: b.id, bounds, zoomFactor })
      }
    },
    [boundsFor, zoomFor]
  )

  // Free a renderer (over the live cap). The last snapshot keeps showing.
  const closeBoard = useCallback((b: PreviewBoard): void => {
    const rec = recs.current.get(b.id)!
    rec.attached = false
    rec.exists = false
    rec.lastSent = null
    void window.api.closePreview(b.id)
  }, [])

  const openAll = useCallback(async (): Promise<void> => {
    openedRef.current = true
    await Promise.all(PREVIEW_BOARDS.map((b) => attachBoard(b)))
    onLive(liveCount())
  }, [attachBoard, liveCount, onLive])

  const closeAll = useCallback(async (): Promise<void> => {
    openedRef.current = false
    gestureRef.current = false
    await window.api.closeAllPreviews()
    for (const b of PREVIEW_BOARDS) {
      const rec = recs.current.get(b.id)!
      rec.attached = false
      rec.exists = false
      rec.lastSent = null
      updateNodeData(b.id, { snapshot: null })
    }
    onLive(0)
  }, [updateNodeData, onLive])

  // Reflow attached boards to the current presets (zoom factor + bounds).
  const reflowAll = useCallback((): void => {
    for (const b of PREVIEW_BOARDS) {
      const rec = recs.current.get(b.id)!
      if (!rec.attached) continue
      const bounds = boundsFor(b)
      const zoomFactor = zoomFor(b)
      rec.lastSent = bounds
      rec.lastZoom = zoomFactor
      void window.api.attachPreview({ id: b.id, bounds, zoomFactor })
    }
  }, [boundsFor, zoomFor])

  // One coalesced batch per frame for every attached board, diff-skipped.
  const flushBatch = useCallback((): boolean => {
    if (!openedRef.current) return false
    const items: Array<{ id: string; bounds: Rect; zoomFactor: number }> = []
    for (const b of PREVIEW_BOARDS) {
      const rec = recs.current.get(b.id)!
      if (!rec.attached) continue
      const bounds = boundsFor(b)
      const zoomFactor = zoomFor(b)
      if (rec.lastSent && rectsEqual(rec.lastSent, bounds) && rec.lastZoom === zoomFactor) continue
      rec.lastSent = bounds
      rec.lastZoom = zoomFactor
      items.push({ id: b.id, bounds, zoomFactor })
    }
    if (!items.length) return false
    void window.api.setPreviewBoundsBatch(items)
    return true
  }, [boundsFor, zoomFor])

  const startPump = useCallback((): void => {
    if (rafRef.current || !openedRef.current) return
    idleRef.current = 0
    const stepFn = (): void => {
      idleRef.current = flushBatch() ? 0 : idleRef.current + 1
      rafRef.current = idleRef.current < 4 ? requestAnimationFrame(stepFn) : 0
    }
    rafRef.current = requestAnimationFrame(stepFn)
  }, [flushBatch])

  // onMoveStart: keep tracking live (pump) AND capture every live board → snapshot
  // → detach, so HTML images carry the motion (no trailing native layers).
  const beginMotion = useCallback((): void => {
    startPump()
    if (gestureRef.current || !openedRef.current) return
    const live = PREVIEW_BOARDS.filter((b) => recs.current.get(b.id)!.attached)
    if (!live.length) return
    gestureRef.current = true
    void (async () => {
      const shots = await Promise.all(live.map((b) => window.api.capturePreview(b.id)))
      if (!gestureRef.current) return // gesture ended before capture → keep live
      // Detach ONLY boards that captured a snapshot — never strand one on the bare
      // cutout (a null capture keeps the board live until it can be snapshotted).
      const captured: PreviewBoard[] = []
      live.forEach((b, i) => {
        if (shots[i]) {
          updateNodeData(b.id, { snapshot: shots[i] })
          captured.push(b)
        }
      })
      await Promise.all(captured.map((b) => window.api.detachPreview(b.id)))
      captured.forEach((b) => {
        recs.current.get(b.id)!.attached = false
      })
      onLive(liveCount())
    })()
  }, [startPump, updateNodeData, liveCount, onLive])

  // onMoveEnd: reattach the boards that should be live (zoom ≥ LOD, under the cap);
  // over-cap boards are CLOSED (free the renderer); below-LOD boards stay snapshot.
  const endMotion = useCallback((): void => {
    gestureRef.current = false
    if (!openedRef.current) return
    const wantLive = PREVIEW_BOARDS.filter((b) => liveEligible(b))
    const liveIds = new Set(wantLive.slice(0, MAX_LIVE).map((b) => b.id))
    for (const b of PREVIEW_BOARDS) {
      const rec = recs.current.get(b.id)!
      if (liveIds.has(b.id))
        void attachBoard(b) // live: attach (open if needed)
      else if (wantLive.includes(b))
        closeBoard(b) // over the live cap → free renderer
      else if (rec.attached) void demoteToSnapshot(b) // LOD / chrome zone → snapshot
      // else: already detached with a snapshot — keep it for a fast reattach
    }
    onLive(liveCount())
  }, [liveEligible, attachBoard, closeBoard, demoteToSnapshot, liveCount, onLive])

  useOnViewportChange({ onStart: beginMotion, onChange: startPump, onEnd: endMotion })

  // paneOffset = the React Flow pane's top-left in window CSS px (setBounds wants
  // window-content DIP coords; the pane sits below the topbar + tabs). Once per
  // layout, never per frame — then re-sync the batch.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      paneOffset.current = { x: r.left, y: r.top }
      flushBatch()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [paneRef, flushBatch])

  // Open/close lifecycle driven by the toolbar toggle.
  useEffect(() => {
    openedRef.current = open
    if (open) void openAll()
    else void closeAll()
  }, [open, openAll, closeAll])

  // Reflow when a board's preset changes.
  useEffect(() => {
    presetsRef.current = presets
    reflowAll()
  }, [presets, reflowAll])

  // Leak check: open→close N times, with a beat for each load/teardown to settle
  // (openPreview resolves when loadURL is kicked off, not finished — racing it
  // churns half-loaded views). Renderer count + heap must return to baseline.
  useImperativeHandle(
    ref,
    () => ({
      cycle: async (n: number) => {
        const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < n; i++) {
          await closeAll()
          await wait(120)
          await openAll()
          await wait(220)
        }
        reflowAll() // re-apply correct per-board zoom after the churn
      }
    }),
    [closeAll, openAll, reflowAll]
  )

  // Tear down on unmount (tab switch / HMR): stop the pump + close every view.
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      void window.api.closeAllPreviews()
    },
    []
  )

  return null
})

// ── Canvas tab ────────────────────────────────────────────────────────────────

export default function FlowSmoke() {
  // Diagnostics overlay: on by default in dev, off in packaged builds. Toggle with
  // Ctrl/⌘+Shift+D. `liveViews` is the real attached-view count from the manager.
  const [diag, setDiag] = useState(import.meta.env.DEV)
  const [open, setOpen] = useState(false)
  const [live, setLive] = useState(0)
  const [presets, setPresets] = useState<PresetMap>(() =>
    Object.fromEntries(PREVIEW_BOARDS.map((b) => [b.id, b.defaultPreset]))
  )
  const paneRef = useRef<HTMLDivElement>(null)
  const mgrRef = useRef<ManagerHandle>(null)
  // Owned node state so updateNodeData(snapshot) sticks; dragging off keeps the
  // boards' world rects authoritative for the camera math.
  const [rfNodes, , onNodesChange] = useNodesState(initialNodes)

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
    // Flex column: a control BAR above the canvas pane. The native views are
    // bounded to the pane (below the bar), so they can't paint over the controls —
    // the WebContentsView-over-HTML occlusion only bites inside the canvas itself.
    <div style={rootStyle}>
      <div style={controlBarStyle}>
        <button className={open ? 'btn' : 'btn accent'} onClick={() => setOpen((v) => !v)}>
          {open ? 'Close previews' : 'Open previews'}
        </button>
        <button className="btn" onClick={() => void mgrRef.current?.cycle(15)} disabled={!open}>
          Leak cycle ×15
        </button>
        {PREVIEW_BOARDS.map((b) => (
          <div key={b.id} style={presetRowStyle}>
            <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{b.label}</span>
            {PRESETS.map((w) => (
              <button
                key={w}
                className="btn"
                style={presets[b.id] === w ? activePreset : undefined}
                onClick={() => setPresets((p) => ({ ...p, [b.id]: w }))}
              >
                {w}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div ref={paneRef} style={paneStyle}>
        <div className="hint">React Flow · drag to pan · ⌘/Ctrl + wheel to zoom (0.1–2.5)</div>
        <ReactFlow
          nodes={rfNodes}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          minZoom={0.1}
          maxZoom={2.5}
          fitView
          proOptions={{ hideAttribution: true }}
          style={{ width: '100%', height: '100%' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#232327" />
          <Controls />
          <MiniMap pannable zoomable />
          <PreviewManager
            ref={mgrRef}
            paneRef={paneRef}
            open={open}
            presets={presets}
            onLive={setLive}
          />
        </ReactFlow>
        {diag && <DiagOverlay liveViews={live} />}
      </div>
    </div>
  )
}

const rootStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column'
}

const controlBarStyle: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border-subtle)',
  background: 'var(--surface)'
}

const paneStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative'
}

const presetRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11
}

const activePreset: React.CSSProperties = {
  color: 'var(--accent)',
  borderColor: 'var(--accent)'
}
