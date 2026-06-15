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
  type ReactElement
} from 'react'
import type { DiagramElement } from '../../../lib/boardSchema'
import { buildDiagramThemeVars, diagramTypeLabel } from './diagramTheme'

/** Debounce (ms) from the last source keystroke to a committed re-render. */
const RENDER_DEBOUNCE_MS = 450

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
  /** Arm one undo checkpoint at the start of an editing session (beginChange). */
  onEditStart: () => void
  /** Persist a freshly-rendered SVG assetId (UNTRACKED — derived artifact). */
  onCache: (id: string, assetId: string) => void
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
  onCache
}: DiagramCardProps): ReactElement {
  const { id, x, y, w, h, source, svgCache } = element
  const [svgUrl, setSvgUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(source)
  const urlRef = useRef<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Swap the displayed blob URL, revoking the previous one (never leak object URLs).
  const showSvg = useCallback((svg: string) => {
    const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    setSvgUrl(next)
  }, [])

  // Render-or-load effect, keyed on `[source, svgCache]`: a present cache reads instantly; an absent
  // cache (fresh element OR a source edit that cleared it) renders via the hidden worker, then
  // writes the asset + persists the id. A missing cached asset (GC / .bak restore) falls through to
  // a re-render rather than showing a broken image.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (svgCache) {
        const bytes = await window.api.asset.read(svgCache).catch(() => null)
        if (cancelled) return
        if (bytes && bytes.length) {
          showSvg(new TextDecoder().decode(bytes))
          setError(null)
          return
        }
        // cache asset missing → fall through to a re-render below
      }
      const res = await window.api.diagram
        .render({ source, themeVars: buildDiagramThemeVars(), id })
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
  }, [source, svgCache, id, showSvg, onCache])

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
          <button
            type="button"
            title={editing ? 'Done editing' : 'Edit source'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              if (editing) {
                if (debounceRef.current) clearTimeout(debounceRef.current)
                flushDraft(draft)
                setEditing(false)
              } else {
                onEditStart()
                setDraft(source)
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
        <textarea
          className="pl-diagram-src"
          value={draft}
          spellCheck={false}
          onPointerDown={(e) => e.stopPropagation()}
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
      ) : svgUrl ? (
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
    </div>
  )
})
