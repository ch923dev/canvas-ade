/**
 * Diagram element (v11 / S4). Authors a themed Mermaid diagram as a first-class Planning element.
 *
 * `source` (Mermaid text) is canonical; the rendered SVG is a DERIVED, content-addressed asset
 * cache (`svgCache`). The card displays the SVG as an INERT `<img>` (sanitized in the hidden MAIN
 * worker via `securityLevel:'strict'`; CSP `img-src blob:` permits it), exactly like ImageCard.
 *
 * Render flow:
 *  - `svgCache` present  → read the cached asset bytes → blob URL → show instantly (reopen path).
 *  - `svgCache` absent   → render `source` via `window.api.diagram.render` (the hidden worker),
 *    show the result, write it to the asset store, and persist the assetId via `onCache` (an
 *    UNTRACKED store write — the derived SVG must never push an undo step). A source edit clears
 *    `svgCache` (tracked, in `onChangeSource`), which re-enters the "absent" branch → re-render.
 *
 * The `</>` toggle opens a mono source editor; edits are debounced into a single tracked commit per
 * editing session (beginChange on focus, like NoteCard). Parse/render errors show inline.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type CSSProperties,
  type ReactElement
} from 'react'
import type { DiagramElement } from '../../../lib/boardSchema'
import {
  buildDiagramThemeVars,
  buildDiagramThemeCss,
  cacheMotionMatches,
  diagramTypeLabel
} from './diagramTheme'
import { resizeFromDrag } from './diagramResize'
import { wheelZoom, stepZoom, clampPan, ZOOM_MIN, ZOOM_FIT, type Vec2 } from './diagramZoom'
import { useReducedMotion } from './useReducedMotion'

/** Debounce (ms) from the last source keystroke to a committed re-render. */
const RENDER_DEBOUNCE_MS = 450

/**
 * Lazy CodeMirror source editor (S4b). The chunk (CM core + mermaid grammar) loads once, module-
 * wide, kicked off when a card mounts; WHICH editor an editing session uses is latched at
 * `</>`-open time (`editorAtOpenRef`) so the chunk resolving mid-edit never swaps the component
 * under the user's cursor (an unmounting focused editor would fire blur → close the session).
 * Until the chunk is ready, edits fall back to the plain <textarea> — same contract, no highlight.
 */
type DiagramEditorCmp = typeof import('./DiagramSourceEditor').default
let diagramEditorCmp: DiagramEditorCmp | null = null
let diagramEditorLoad: Promise<void> | null = null
function ensureDiagramEditorLoaded(): void {
  if (diagramEditorCmp || diagramEditorLoad) return
  diagramEditorLoad = import('./DiagramSourceEditor')
    .then((m) => {
      diagramEditorCmp = m.default
    })
    .catch(() => {
      diagramEditorLoad = null // chunk fetch failed → retry on the next card mount
    })
}

export interface DiagramCardProps {
  element: DiagramElement
  /** Owning board id — for the untracked svgCache write-back. */
  boardId: string
  /** True when the `select` tool is active (enables drag + selection). */
  interactive: boolean
  /** Begin a board-local drag from a screen pointer-down on the card. */
  onDragStart: (e: ReactPointerEvent, id: string) => void
  /** True when this element is in the board selection set (draws the accent ring + header). */
  selected?: boolean
  /** Select this element on press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
  /** Tracked source commit (sets source + clears svgCache to invalidate the cache). */
  onChangeSource: (id: string, source: string) => void
  /** Arm one undo checkpoint at the start of an editing session OR a resize drag (beginChange). */
  onEditStart: () => void
  /** Persist a freshly-rendered SVG assetId (UNTRACKED — derived artifact). */
  onCache: (id: string, assetId: string) => void
  /** Tracked resize commit (sets w/h; svgCache stays valid — the SVG scales via object-fit). */
  onResize: (id: string, w: number, h: number) => void
}

export const DiagramCard = memo(function DiagramCard({
  element,
  boardId,
  interactive,
  onDragStart,
  selected,
  onSelect,
  onChangeSource,
  onEditStart,
  onCache,
  onResize
}: DiagramCardProps): ReactElement {
  const { id, x, y, w, h, svgCache } = element
  // v21: source is engine-conditional (mermaid ⇒ present; validated in boardSchema). The expanse
  // engine branches to the spec renderer before any source use — '' never actually renders.
  const source = element.source ?? ''
  const locked = element.locked ?? false
  const reducedMotion = useReducedMotion()
  const motion = !reducedMotion
  // Which editor THIS editing session renders — latched at open (see ensureDiagramEditorLoaded).
  const editorAtOpenRef = useRef<DiagramEditorCmp | null>(null)
  useEffect(() => {
    ensureDiagramEditorLoaded()
  }, [])
  const [svgUrl, setSvgUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(source)
  const urlRef = useRef<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Live corner-resize gesture: start pointer (screen px) + start size + the board-local→screen
  // scale captured at pointerdown. `moved` arms the undo checkpoint lazily so a no-move tap on the
  // handle never pushes a phantom step (the planning lazy-checkpoint discipline).
  const resizeRef = useRef<{
    startX: number
    startY: number
    startW: number
    startH: number
    scale: number
    moved: boolean
  } | null>(null)
  // Focus-gated pan/zoom of the rendered diagram — only active while SELECTED. `.nowheel`/`.nopan` on
  // the viewport (added below when selected) hand the wheel/drag to the card instead of the canvas, so
  // an unfocused diagram still zooms the canvas normally. `zoom === ZOOM_MIN` (1) is "fit".
  const [zoom, setZoom] = useState(ZOOM_MIN)
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 })
  const panRef = useRef<{
    startX: number
    startY: number
    baseX: number
    baseY: number
    scale: number
  } | null>(null)

  const onResizeDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation() // never start a board drag / toggle the selection from the handle
      const handle = e.currentTarget as HTMLElement
      // boardScale = the well's on-screen width ÷ its layout width — captures camera zoom AND any
      // board-node render scale in one ratio (== screenScale). DOM-only, so the memo'd card never
      // subscribes to the camera (no re-render per pan/zoom). Frozen for the gesture (pointer is
      // captured, so the camera can't move mid-drag).
      const well = handle.closest('.pl-well') as HTMLElement | null
      const rect = well?.getBoundingClientRect()
      const scale = well && rect && well.offsetWidth > 0 ? rect.width / well.offsetWidth : 1
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: w,
        startH: h,
        scale,
        moved: false
      }
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic event in tests */
      }
    },
    [w, h]
  )

  const onResizeMove = useCallback(
    (e: ReactPointerEvent) => {
      const r = resizeRef.current
      if (!r) return
      const dx = e.clientX - r.startX
      const dy = e.clientY - r.startY
      // Arm ONE checkpoint on the first real move (>4 SCREEN px — zoom-independent, like the arrow
      // endpoint + textbox gestures); a sub-threshold jiggle commits nothing.
      if (!r.moved) {
        if (Math.hypot(dx, dy) <= 4) return
        onEditStart()
        r.moved = true
      }
      const size = resizeFromDrag({ w: r.startW, h: r.startH }, { dx, dy }, r.scale)
      onResize(id, size.w, size.h)
    },
    [id, onResize, onEditStart]
  )

  const onResizeUp = useCallback((e: ReactPointerEvent) => {
    if (!resizeRef.current) return
    resizeRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* capture already released / synthetic */
    }
  }, [])

  // Set zoom and re-clamp the pan to the new scale (zooming out toward/below fit recentres the model,
  // so it can never get stranded off-screen — the infinite-canvas feel without losing the diagram).
  const applyZoom = useCallback(
    (z: number) => {
      setZoom(z)
      setPan((p) => clampPan(p, { w, h: Math.max(0, h - 22) }, z))
    },
    [w, h]
  )
  // Wheel = zoom (only fires here because the viewport carries `.nowheel` when selected).
  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      e.stopPropagation()
      applyZoom(wheelZoom(zoom, e.deltaY))
    },
    [zoom, applyZoom]
  )

  // Drag inside a zoomed-in diagram PANS it; at/below fit the press falls through to the card (move).
  const onViewportPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!interactive || e.button !== 0 || editing || zoom <= ZOOM_FIT) return
      e.stopPropagation()
      const host = e.currentTarget as HTMLElement
      const well = host.closest('.pl-well') as HTMLElement | null
      const rect = well?.getBoundingClientRect()
      const scale = well && rect && well.offsetWidth > 0 ? rect.width / well.offsetWidth : 1
      panRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y, scale }
      try {
        host.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic */
      }
    },
    [interactive, editing, zoom, pan]
  )
  const onViewportPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const p = panRef.current
      if (!p) return
      const next = clampPan(
        {
          x: p.baseX + (e.clientX - p.startX) / p.scale,
          y: p.baseY + (e.clientY - p.startY) / p.scale
        },
        { w, h: Math.max(0, h - 22) },
        zoom
      )
      setPan(next)
    },
    [w, h, zoom]
  )
  const onViewportPointerUp = useCallback((e: ReactPointerEvent) => {
    if (!panRef.current) return
    panRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* already released / synthetic */
    }
  }, [])

  // Snap back to a clean fit thumbnail whenever the element loses focus.
  useEffect(() => {
    if (!selected) {
      setZoom(ZOOM_FIT)
      setPan({ x: 0, y: 0 })
    }
  }, [selected])

  // Swap the displayed blob URL, revoking the previous one (never leak object URLs).
  const showSvg = useCallback((svg: string) => {
    const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    setSvgUrl(next)
  }, [])

  // Render-or-load effect, keyed on `[source, svgCache, motion]`: a present cache reads instantly;
  // an absent cache (fresh element OR a source edit that cleared it) renders via the hidden worker,
  // then writes the asset + persists the id. A missing cached asset (GC / .bak restore) falls
  // through to a re-render rather than showing a broken image. A cache whose BAKED motion mode
  // (the S4b sentinel) mismatches the live reduced-motion preference also falls through — media
  // queries don't re-evaluate inside an SVG-as-<img>, so an animated cache must never be shown to
  // a reduced-motion user (nor a static one after the preference lifts).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (svgCache) {
        const bytes = await window.api.asset.read(svgCache).catch(() => null)
        if (cancelled) return
        if (bytes && bytes.length) {
          const text = new TextDecoder().decode(bytes)
          if (cacheMotionMatches(text, motion)) {
            showSvg(text)
            setError(null)
            return
          }
          // baked motion mode mismatches the live preference → re-render below
        }
        // cache asset missing → fall through to a re-render below
      }
      const res = await window.api.diagram
        .render({
          source,
          themeVars: buildDiagramThemeVars(),
          themeCss: buildDiagramThemeCss(motion),
          id
        })
        .catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }))
      if (cancelled) return
      if (res.ok) {
        setError(null)
        showSvg(res.svg)
        // Persist the derived SVG as a content-addressed asset; ignore a write failure (the diagram
        // still displays from the in-memory blob — it just re-renders next open).
        const bytes = new TextEncoder().encode(res.svg)
        const wrote = await window.api.asset.write(bytes, 'svg').catch(() => null)
        if (!cancelled && wrote && 'assetId' in wrote) onCache(id, wrote.assetId)
      } else {
        setError(res.error || 'diagram render failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, svgCache, id, showSvg, onCache, motion])

  // Revoke the last object URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    []
  )

  // Keep the editor draft in sync if the source changes from elsewhere (undo/redo, agent write)
  // while NOT actively editing — never clobber the user's in-flight keystrokes.
  useEffect(() => {
    if (!editing) setDraft(source)
  }, [source, editing])

  const flushDraft = useCallback(
    (value: string) => {
      if (value !== source) onChangeSource(id, value)
    },
    [id, source, onChangeSource]
  )

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => flushDraft(value), RENDER_DEBOUNCE_MS)
    },
    [flushDraft]
  )

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    []
  )

  const showHeader = selected || editing
  // The editor component this editing session latched at `</>`-open (null → textarea fallback).
  const SessionEditor = editing ? editorAtOpenRef.current : null
  const zoomBtn = (disabled: boolean): CSSProperties => ({
    all: 'unset',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    padding: '0 5px',
    borderRadius: 4,
    fontFamily: 'var(--term-mono)',
    color: 'var(--text-3)'
  })

  return (
    <div
      className="pl-diagram"
      data-board-id={boardId}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: 'var(--r-inner)',
        overflow: 'hidden',
        background: 'var(--surface)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        outline: selected ? '0.5px solid var(--accent)' : 'none',
        // v17 (P4b) element opacity — absent ⇒ opaque, byte-identical to pre-P4b.
        opacity: element.opacity,
        cursor: interactive ? 'grab' : 'default'
      }}
      onPointerDown={(e) => {
        // Draw modes fall through to the well; select mode = drag handle. The source editor and the
        // header buttons stop propagation themselves so a press there never starts a board drag.
        if (!interactive) return
        if (e.button !== 0) return
        if (editing) return
        e.stopPropagation()
        onSelect?.(id, e.shiftKey)
        onDragStart(e, id)
      }}
    >
      {showHeader && (
        <div
          className="pl-diagram-head"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 6px',
            background: 'var(--surface-raised)',
            borderBottom: '1px solid var(--border-subtle)',
            font: '500 10px var(--ui)',
            color: 'var(--text-3)',
            zIndex: 1
          }}
        >
          <span style={{ color: 'var(--text-2)' }}>{diagramTypeLabel(source)}</span>
          <span style={{ flex: 1 }} />
          {!editing && svgUrl && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 1 }} title="Scroll to zoom">
              <button
                type="button"
                title="Zoom out"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  applyZoom(stepZoom(zoom, -1))
                }}
                disabled={zoom <= ZOOM_MIN}
                style={zoomBtn(zoom <= ZOOM_MIN)}
              >
                −
              </button>
              <button
                type="button"
                title="Reset to fit"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  applyZoom(ZOOM_FIT)
                }}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  minWidth: 34,
                  textAlign: 'center',
                  color: 'var(--text-2)',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                title="Zoom in"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  applyZoom(stepZoom(zoom, 1))
                }}
                style={zoomBtn(false)}
              >
                +
              </button>
            </div>
          )}
          <button
            type="button"
            title={editing ? 'Done editing' : 'Edit source'}
            onPointerDown={(e) => e.stopPropagation()}
            // While editing, the source <textarea> holds focus. A bare press would blur it FIRST
            // (onBlur → setEditing(false) → re-render), so by the time onClick fires it reads
            // editing===false and RE-OPENS the editor — one click = close+reopen, the editor never
            // closes ("clicking once does 2 clicks"). preventDefault on mousedown keeps focus in the
            // textarea so no spurious blur fires and the single click toggles with the correct state.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              if (editing) {
                if (debounceRef.current) clearTimeout(debounceRef.current)
                flushDraft(draft)
                setEditing(false)
              } else {
                onEditStart()
                setDraft(source)
                editorAtOpenRef.current = diagramEditorCmp
                setEditing(true)
              }
            }}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '1px 5px',
              borderRadius: 4,
              fontFamily: 'var(--term-mono)',
              color: editing ? 'var(--accent)' : 'var(--text-3)'
            }}
          >
            {'</>'}
          </button>
        </div>
      )}

      {editing ? (
        SessionEditor ? (
          <div
            className="pl-diagram-src nowheel nodrag nopan"
            onPointerDown={(e) => e.stopPropagation()}
            // Editing cards own their keystrokes (the ChecklistCard/NoteCard contract): without
            // this stop, the well's tool shortcuts (s/n/c/a/p/e/…) fire on letters typed into the
            // source and SWALLOW them (preventDefault) — `C[Ship]` arrives as `[hi]`.
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              // CodeMirror moves focus between internal nodes — only a blur that LEAVES the
              // wrapper ends the editing session (mirrors the textarea's blur contract).
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              if (debounceRef.current) clearTimeout(debounceRef.current)
              flushDraft(draft)
              setEditing(false)
            }}
            style={{
              position: 'absolute',
              inset: '22px 0 0 0',
              background: 'var(--surface)',
              overflow: 'hidden'
            }}
          >
            <SessionEditor value={draft} onChange={onDraftChange} />
          </div>
        ) : (
          <textarea
            className="pl-diagram-src"
            value={draft}
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            // Same keystroke-ownership stop as the CodeMirror wrapper above — this was MISSING
            // pre-S4b: bare tool letters typed into the source switched the planning tool and
            // never reached the textarea (latent, masked by agent-written sources).
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => onDraftChange(e.target.value)}
            onBlur={() => {
              if (debounceRef.current) clearTimeout(debounceRef.current)
              flushDraft(draft)
              setEditing(false)
            }}
            autoFocus
            style={{
              position: 'absolute',
              inset: '22px 0 0 0',
              width: '100%',
              height: 'calc(100% - 22px)',
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'var(--surface)',
              color: 'var(--text)',
              font: '12px/1.5 var(--term-mono)',
              padding: 8,
              boxSizing: 'border-box'
            }}
          />
        )
      ) : svgUrl ? (
        <div
          className={'pl-diagram-view' + (selected ? ' nowheel nodrag nopan' : '')}
          onWheel={selected ? onWheel : undefined}
          onPointerDown={onViewportPointerDown}
          onPointerMove={onViewportPointerMove}
          onPointerUp={onViewportPointerUp}
          onPointerCancel={onViewportPointerUp}
          style={{
            position: 'absolute',
            // Sit BELOW the header bar when it's shown — otherwise it overlays (clips) the top of the
            // diagram (the "cut off at the top" bug).
            inset: showHeader ? '22px 0 0 0' : 0,
            overflow: 'hidden',
            cursor: selected && zoom > ZOOM_FIT ? 'grab' : undefined,
            touchAction: 'none'
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center'
            }}
          >
            <img
              src={svgUrl}
              draggable={false}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block',
                pointerEvents: 'none'
              }}
            />
          </div>
        </div>
      ) : (
        <div
          className="pl-diagram-state"
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: 12,
            boxSizing: 'border-box',
            border: error ? '1px dashed var(--border)' : 'none',
            color: error ? 'var(--text-3)' : 'var(--text-faint)',
            fontFamily: 'var(--ui)',
            fontSize: 11,
            pointerEvents: 'none'
          }}
        >
          {error ? `diagram error: ${error}` : 'rendering…'}
        </div>
      )}

      {/* Inline error ribbon while editing — so a bad edit reads as a parse error, not silence. */}
      {editing && error && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '3px 8px',
            background: 'var(--surface-overlay)',
            borderTop: '1px solid var(--border-subtle)',
            color: 'var(--text-3)',
            font: '11px var(--term-mono)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            pointerEvents: 'none'
          }}
        >
          {error}
        </div>
      )}

      {/* Bottom-right resize handle (select mode, selected + unlocked, not editing). Reuses the
          arrow endpoint-handle discipline: screen-px threshold, ONE undo step per drag, accent mark.
          The SVG scales via object-fit so a resize keeps the cached svgCache valid (w/h only). */}
      {selected && interactive && !locked && !editing && (
        <div
          className="pl-diagram-resize"
          title="Resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'flex-end',
            cursor: 'nwse-resize',
            zIndex: 2
          }}
        >
          <div
            style={{
              width: 9,
              height: 9,
              margin: 2,
              borderRight: '2px solid var(--accent)',
              borderBottom: '2px solid var(--accent)',
              borderBottomRightRadius: 2,
              pointerEvents: 'none'
            }}
          />
        </div>
      )}
    </div>
  )
})
