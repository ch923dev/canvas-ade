/**
 * JsonView (JD-1 + JD-2) — the Network inspector's body viewer.
 *
 * Presentational only: all parsing/fold/raw/path/search logic lives in `lib/osrJson.ts`, the window
 * math in `lib/virtualizer.ts`. Renders a collapsible tree with Option-A coloring (accent keys ·
 * neutral values · grey type badges). Every key/value/URL from the page is emitted as React text
 * inside a `<span>` — auto-escaped, NO `dangerouslySetInnerHTML` anywhere (the page controls these
 * strings).
 *
 * JD-2 enrichments: a uniform-height virtualizer (live DOM stays ~overscan-bounded for huge bodies);
 * in-body search (Ctrl/Cmd+F) with highlight + next/prev (Enter / Ctrl/Cmd+G) that auto-expands a
 * match's collapsed ancestors; copy property-path / copy-subtree; URL values → `shell.openExternal`;
 * an ARIA `role="tree"` keymap with `aria-activedescendant` kept pointing at a *mounted* row under
 * virtualization.
 */
import {
  useMemo,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type ReactElement,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { formatSize } from '../../../lib/osrNetFormat'
import { showToast } from '../../../store/toastStore'
import {
  buildModel,
  initialCollapsed,
  visibleRows,
  reindent,
  pathOf,
  ancestorsOf,
  searchMatches,
  subtreeSource,
  urlInValue,
  type JsonRow,
  type ValueType
} from '../../../lib/osrJson'
import { windowRange, scrollToIndex } from '../../../lib/virtualizer'

const INDENT_PX = 12
/** Fixed uniform row height (px) — MUST match `.bb-net-json-row { height }` in browser-devtools.css;
 *  the virtualizer's window math is row-height-driven. */
const ROW_H = 18

/** The text a value copies: a JSON string copies its decoded-of-quotes content; everything else
 *  (number / bigint / bool / null / form value) copies its literal source. */
function copyTextOf(row: JsonRow): string {
  const raw = row.valueText ?? ''
  if (row.valueType === 'string' && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1)
  }
  return raw
}

function copyToClipboard(text: string, label: string): void {
  void navigator.clipboard?.writeText(text)?.catch(() => {})
  showToast({ id: 'json-copy', kind: 'ok', message: label })
}

const TYPE_BADGE: Record<ValueType, string> = {
  string: 'string',
  number: 'number',
  bigint: 'number',
  bool: 'bool',
  null: 'null',
  raw: ''
}

function closeBraceOf(open: '{' | '[' | '}' | ']' | undefined): string {
  return open === '{' ? '}' : ']'
}

/** Split `text` around case-insensitive occurrences of `query`, wrapping each match in a highlight
 *  `<span>` (a React text child — never injected HTML). `current` flags the active match's row. */
function highlight(text: string, query: string, current: boolean): ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < text.length) {
    const j = lower.indexOf(q, i)
    if (j < 0) {
      parts.push(text.slice(i))
      break
    }
    if (j > i) parts.push(text.slice(i, j))
    parts.push(
      <span key={k++} className={`bb-net-json-match${current ? ' current' : ''}`}>
        {text.slice(j, j + q.length)}
      </span>
    )
    i = j + q.length
  }
  return parts
}

export function JsonView({
  body,
  mime,
  base64,
  truncated,
  embedded
}: {
  body: string | undefined
  mime: string | undefined
  base64?: boolean
  truncated?: boolean
  /** Compact form for inline use (WebSocket text frames): no toolbar / search chrome, capped height. */
  embedded?: boolean
}): ReactElement {
  const text = body ?? ''
  const model = useMemo(() => buildModel(text, mime, base64), [text, mime, base64])

  const [collapsed, setCollapsed] = useState<Set<number>>(() => initialCollapsed(model.rows))
  const [raw, setRaw] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** Landed-match pointer: −1 = typed but not yet jumped (highlight-only); ≥0 = the current match. */
  const [matchIdx, setMatchIdx] = useState(-1)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [scrollTick, setScrollTick] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const pendingScrollRef = useRef<number | null>(null)

  // Reset fold + view when the underlying body changes (new request selected / reloaded). The
  // store-previous-prop pattern resets during render — no effect, no cascading-render lint hit.
  const [prevModel, setPrevModel] = useState(model)
  if (model !== prevModel) {
    setPrevModel(model)
    setCollapsed(initialCollapsed(model.rows))
    setRaw(false)
    setSearchOpen(false)
    setQuery('')
    setMatchIdx(-1)
    setActiveId(null)
    setScrollTop(0)
    // (pendingScrollRef is drained by the layout effect on the next render — no ref write here)
  }

  const visible = useMemo(() => visibleRows(model.rows, collapsed), [model, collapsed])
  const matches = useMemo(() => searchMatches(model.rows, query), [model, query])
  const currentMatchId = matchIdx >= 0 && matchIdx < matches.length ? matches[matchIdx] : null

  const toggle = useCallback((id: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Nudge the scroll container so a visible-list index sits inside the render window (keeps the
   *  active/match row mounted → `aria-activedescendant` stays valid under virtualization). */
  const scrollToVisibleIndex = useCallback((idx: number): void => {
    const el = scrollRef.current
    if (!el || idx < 0) return
    const next = scrollToIndex({
      index: idx,
      scrollTop: el.scrollTop,
      viewportH: el.clientHeight,
      rowH: ROW_H
    })
    if (next !== el.scrollTop) el.scrollTop = next // fires onScroll → re-windows around the row
  }, [])

  /** Land on match `idx`: select it, un-collapse its ancestors, then scroll it into view after the
   *  expansion has re-rendered (the layout effect below drains `pendingScrollRef`). */
  const navigate = useCallback(
    (idx: number): void => {
      const targetId = matches[idx]
      if (targetId == null) return
      setMatchIdx(idx)
      setActiveId(targetId)
      setCollapsed((prev) => {
        const ancestors = ancestorsOf(model.rows, targetId)
        if (ancestors.every((a) => !prev.has(a))) return prev
        const next = new Set(prev)
        for (const a of ancestors) next.delete(a)
        return next
      })
      pendingScrollRef.current = targetId
      setScrollTick((t) => t + 1)
    },
    [matches, model]
  )

  /** Step to the next/prev match (wrapping). From the un-landed state, +1 → first, −1 → last. */
  const step = useCallback(
    (dir: 1 | -1): void => {
      const n = matches.length
      if (!n) return
      const idx = matchIdx < 0 ? (dir > 0 ? 0 : n - 1) : (((matchIdx + dir) % n) + n) % n
      navigate(idx)
    },
    [matches, matchIdx, navigate]
  )

  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
    setQuery('')
    setMatchIdx(-1)
    scrollRef.current?.focus()
  }, [])

  // After an auto-expand re-render, scroll the pending match into view (it now exists in `visible`).
  useLayoutEffect(() => {
    const id = pendingScrollRef.current
    if (id == null) return
    const idx = visible.findIndex((r) => r.id === id)
    if (idx >= 0) scrollToVisibleIndex(idx)
    pendingScrollRef.current = null
  }, [scrollTick, visible, scrollToVisibleIndex])

  // A new query (→ new match set) resets the landed pointer to highlight-only until the user steps.
  // Render-phase reset (store-previous-prop) — not a setState-in-effect.
  const [prevQuery, setPrevQuery] = useState(query)
  if (query !== prevQuery) {
    setPrevQuery(query)
    setMatchIdx(-1)
  }

  // Focus the search box when it opens.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // Measure the scroll viewport (re-attach when returning from Raw, or on a new model).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportH(el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [raw, model])

  const openUrl = useCallback((url: string): void => {
    void window.api?.openExternalPreview?.(url)?.catch?.(() => {})
  }, [])

  const isTruncated = truncated || model.meta.truncated || model.meta.maxDepth || model.meta.rowCap

  // ── Non-tree states (binary / plain-text / empty) → graceful passthrough ──
  if (model.kind === 'binary') {
    return (
      <div className={`bb-net-json${embedded ? ' embedded' : ''}`}>
        <pre className="bb-net-bodytext">
          [binary · base64]{'\n'}
          {text}
          {isTruncated && '\n…(truncated)'}
        </pre>
      </div>
    )
  }
  if (text === '') return <div className="bb-net-json bb-net-dim">(empty body)</div>
  if (model.kind === 'text') {
    return (
      <div className={`bb-net-json${embedded ? ' embedded' : ''}`}>
        <pre className="bb-net-bodytext">
          {text}
          {isTruncated && '\n…(truncated)'}
        </pre>
      </div>
    )
  }

  const root = model.rows[0]
  const rootCount = root?.kind === 'open' ? root.childCount : undefined

  const range = windowRange({ scrollTop, viewportH, rowH: ROW_H, total: visible.length })
  const rendered = visible.slice(range.start, range.end)
  const activeRendered = activeId != null && rendered.some((r) => r.id === activeId)
  const ariaActive = activeRendered ? `jsonrow-${activeId}` : undefined

  // ── Keyboard: tree navigation over the VISIBLE list (active row kept scrolled into the window) ──
  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const vis = visible
    if (!vis.length) return
    const move = (nextIdx: number): void => {
      const clamped = Math.max(0, Math.min(vis.length - 1, nextIdx))
      setActiveId(vis[clamped].id)
      scrollToVisibleIndex(clamped)
    }
    const ai = activeId == null ? -1 : vis.findIndex((r) => r.id === activeId)
    // No current row — either nothing is selected yet, or the active row scrolled / collapsed out of
    // the visible list (e.g. an ancestor was folded after selection). A navigation key seeds the
    // selection at row 0; any other key (copy / expand) has no target, so bail before reading `cur`
    // (guards `vis[-1]` → undefined → TypeError on the copy branches).
    if (ai < 0) {
      const navKeys = [
        'ArrowDown',
        'ArrowUp',
        'Home',
        'End',
        'ArrowRight',
        'ArrowLeft',
        'Enter',
        ' '
      ]
      if (navKeys.includes(e.key)) {
        e.preventDefault()
        move(0)
      }
      return
    }
    const cur = vis[ai]
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(ai + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        move(ai - 1)
        break
      case 'Home':
        e.preventDefault()
        move(0)
        break
      case 'End':
        e.preventDefault()
        move(vis.length - 1)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (cur.kind === 'open' && collapsed.has(cur.id)) toggle(cur.id)
        else if (cur.kind === 'open') move(ai + 1)
        break
      case 'ArrowLeft': {
        e.preventDefault()
        if (cur.kind === 'open' && !collapsed.has(cur.id)) {
          toggle(cur.id)
          break
        }
        const anc = ancestorsOf(model.rows, cur.id)
        const parentId = anc[anc.length - 1]
        if (parentId != null) {
          const pIdx = vis.findIndex((r) => r.id === parentId)
          if (pIdx >= 0) move(pIdx)
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (cur.kind === 'open') toggle(cur.id)
        else {
          const u = urlInValue(cur)
          if (u) openUrl(u)
        }
        break
      }
      case 'c':
      case 'C':
        if (e.ctrlKey || e.metaKey) break // let the browser's native copy run
        e.preventDefault()
        if (cur.kind === 'open') copyToClipboard(subtreeSource(model, cur), 'Subtree copied')
        else if (cur.kind === 'scalar') copyToClipboard(copyTextOf(cur), 'Copied')
        break
      case 'p':
      case 'P':
        e.preventDefault()
        copyToClipboard(pathOf(model.rows, cur.id), 'Path copied')
        break
      default:
        break
    }
  }

  // ── Keyboard: viewer-level find shortcuts (Ctrl/Cmd+F open · Ctrl/Cmd+G next) ──
  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 'f') {
      e.preventDefault()
      e.stopPropagation()
      setSearchOpen(true)
      searchInputRef.current?.select()
    } else if (k === 'g') {
      e.preventDefault()
      e.stopPropagation()
      if (!searchOpen) setSearchOpen(true)
      step(e.shiftKey ? -1 : 1)
    }
  }

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    }
  }

  const countLabel = !query
    ? ''
    : matches.length === 0
      ? '0/0'
      : `${matchIdx >= 0 ? matchIdx + 1 : '–'}/${matches.length}`

  function rowEl(r: JsonRow, absoluteIndex: number): ReactElement {
    const isCollapsedRow = collapsed.has(r.id)
    const isOpen = r.kind === 'open'
    const isCurrent = r.id === currentMatchId
    const active = r.id === activeId
    const pad = { paddingLeft: 2 + r.depth * INDENT_PX }
    const cls =
      'bb-net-json-row' +
      (isOpen ? ' bb-net-json-open' : '') +
      (isCurrent ? ' current' : '') +
      (active ? ' active' : '')

    const keyNode =
      r.key !== undefined ? (
        <>
          <span className="bb-net-json-key">{highlight(r.key, query, isCurrent)}</span>
          <span className="bb-net-json-punc">: </span>
        </>
      ) : null

    const rowProps = {
      key: r.id,
      id: `jsonrow-${r.id}`,
      role: 'treeitem',
      'aria-level': r.depth + 1,
      'aria-setsize': visible.length,
      'aria-posinset': absoluteIndex + 1,
      'aria-selected': active,
      className: cls,
      style: pad
    }

    if (isOpen) {
      return (
        <div
          {...rowProps}
          aria-expanded={!isCollapsedRow}
          onClick={() => {
            setActiveId(r.id)
            toggle(r.id)
          }}
        >
          <span className="bb-net-json-chev">{isCollapsedRow ? '▸' : '▾'}</span>
          {keyNode}
          <span className="bb-net-json-punc">{r.brace}</span>
          {isCollapsedRow && (
            <>
              <span className="bb-net-json-punc"> … </span>
              <span className="bb-net-json-punc">{closeBraceOf(r.brace)}</span>
              <span className="bb-net-json-count">{r.childCount}</span>
            </>
          )}
          <span className="bb-net-json-rowactions">
            <button
              className="bb-net-json-pathbtn"
              tabIndex={-1}
              title="Copy subtree"
              aria-label="Copy subtree"
              onClick={(e) => {
                e.stopPropagation()
                copyToClipboard(subtreeSource(model, r), 'Subtree copied')
              }}
            >
              ⧉
            </button>
            <button
              className="bb-net-json-pathbtn"
              tabIndex={-1}
              title="Copy path"
              aria-label="Copy property path"
              onClick={(e) => {
                e.stopPropagation()
                copyToClipboard(pathOf(model.rows, r.id), 'Path copied')
              }}
            >
              ⌥
            </button>
          </span>
        </div>
      )
    }

    if (r.kind === 'close') {
      return (
        <div {...rowProps}>
          <span className="bb-net-json-punc">{r.brace}</span>
          {r.truncatedHere && <span className="bb-net-json-chip warn"> truncated</span>}
        </div>
      )
    }

    // scalar
    const badge = r.valueType ? TYPE_BADGE[r.valueType] : ''
    const url = urlInValue(r)
    const valueInner = highlight(r.valueText ?? '', query, isCurrent)
    return (
      <div {...rowProps} onClick={() => setActiveId(r.id)}>
        {keyNode}
        {url ? (
          <span
            className="bb-net-json-val bb-net-json-link"
            role="link"
            tabIndex={-1}
            title={`Open ${url}`}
            onClick={(e) => {
              e.stopPropagation()
              openUrl(url)
            }}
          >
            {valueInner}
          </span>
        ) : (
          <span
            className={`bb-net-json-val t-${r.valueType ?? 'raw'}`}
            title={r.valueText}
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              copyToClipboard(copyTextOf(r), 'Copied')
            }}
          >
            {valueInner}
          </span>
        )}
        {badge && <span className="bb-net-json-badge">{badge}</span>}
        {r.valueType === 'bigint' && <span className="bb-net-json-chip warn">64-bit</span>}
        {r.duplicateKey && <span className="bb-net-json-chip warn">dup</span>}
        <span className="bb-net-json-rowactions">
          <button
            className="bb-net-json-pathbtn"
            tabIndex={-1}
            title="Copy path"
            aria-label="Copy property path"
            onClick={(e) => {
              e.stopPropagation()
              copyToClipboard(pathOf(model.rows, r.id), 'Path copied')
            }}
          >
            ⌥
          </button>
        </span>
      </div>
    )
  }

  return (
    <div className={`bb-net-json${embedded ? ' embedded' : ''}`} onKeyDown={onRootKeyDown}>
      {!embedded && (
        <div className="bb-net-json-toolbar">
          <span className="bb-net-json-meta">
            {formatSize(text.length)}
            {rootCount !== undefined && (
              <>
                {' · '}
                {rootCount} {root?.brace === '[' ? 'items' : 'keys'}
              </>
            )}
            {model.kind === 'form' && ' · form'}
          </span>
          <span className="bb-net-json-spacer" />
          {!raw && (
            <button
              className={`bb-net-json-findbtn${searchOpen ? ' on' : ''}`}
              aria-label="Find in body"
              aria-pressed={searchOpen}
              title="Find in body (Ctrl/Cmd+F)"
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              ⌕
            </button>
          )}
          <div className="bb-net-json-toggle" role="group" aria-label="view mode">
            <button className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>
              Tree
            </button>
            <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>
              Raw
            </button>
          </div>
        </div>
      )}

      {!embedded && searchOpen && !raw && (
        <div className="bb-net-json-search">
          <div className="bb-net-json-search-field">
            <span className="bb-net-json-search-ico" aria-hidden>
              ⌕
            </span>
            <input
              ref={searchInputRef}
              type="text"
              role="searchbox"
              aria-label="Find in body"
              placeholder="Find in body…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <span
            className={`bb-net-json-count2${query && matches.length === 0 ? ' zero' : ''}`}
            aria-live="polite"
          >
            {countLabel}
          </span>
          <button
            className="bb-net-json-navbtn"
            disabled={!matches.length}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            onClick={() => step(-1)}
          >
            ▴
          </button>
          <button
            className="bb-net-json-navbtn"
            disabled={!matches.length}
            title="Next match (Enter / Ctrl/Cmd+G)"
            aria-label="Next match"
            onClick={() => step(1)}
          >
            ▾
          </button>
          <button
            className="bb-net-json-navbtn"
            title="Close (Esc)"
            aria-label="Close search"
            onClick={closeSearch}
          >
            ✕
          </button>
        </div>
      )}

      {!embedded && model.meta.parseError && (
        <div className="bb-net-json-notice">
          not valid JSON — showing what parsed{' '}
          <button className="bb-net-srctoggle" onClick={() => setRaw(true)}>
            view raw
          </button>
        </div>
      )}

      {raw ? (
        <pre className="bb-net-bodytext">{reindent(text, mime, base64)}</pre>
      ) : (
        <>
          <div
            className="bb-net-json-rows"
            ref={scrollRef}
            role="tree"
            tabIndex={0}
            aria-label="JSON body"
            aria-activedescendant={ariaActive}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onKeyDown={onTreeKeyDown}
          >
            <div className="bb-net-json-pad" style={{ height: range.padTop }} aria-hidden />
            {rendered.map((r, i) => rowEl(r, range.start + i))}
            <div className="bb-net-json-pad" style={{ height: range.padBottom }} aria-hidden />
          </div>
          {isTruncated && (
            <div className="bb-net-json-trunc">
              …({model.meta.rowCap ? 'row cap' : model.meta.maxDepth ? 'max depth' : 'truncated'})
            </div>
          )}
        </>
      )}
    </div>
  )
}
