/**
 * DevTools Network inspector panel (per Browser board) — the signed-off design artifact
 * (docs/research/2026-06-21-board-devtools-network/mock/). Mounts inside `.bb-stage` so it
 * clips/rounds with the board (no occlusion). Two user-selectable docks (bottom drawer ⇄ right),
 * same internals, switched by the `▤/▥` header control. Reads the ephemeral `osrNetworkStore`;
 * never renders captured strings as HTML (React text-escaping only) — they are page-controlled.
 */
import { useState, useEffect, useRef, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import { useOsrNetworkStore, type NetDock } from '../../../store/osrNetworkStore'
import type { NetRecord } from '../../../../../preload'
import {
  formatSize,
  formatDuration,
  urlName,
  statusLabel,
  sizeLabel,
  isErrorRow,
  applyNetFilter,
  initiatorLabel,
  ttfbMs,
  waterfallWindow,
  waterfallBar,
  sortRecords,
  NET_TYPE_PILLS,
  type NetTypeKey,
  type WfWindow,
  type SortCol,
  type SortState
} from '../../../lib/osrNetFormat'
import { HttpDetail, WsDetail, tabsFor, type DetailTab, type BodyState } from './OsrNetworkDetail'

export function OsrNetworkPanel({
  boardId,
  onFullView,
  paused = false
}: {
  boardId: string
  onFullView?: () => void
  /** The board was evicted (over the MAX_LIVE cap) — its offscreen window is gone, so capture is
   *  frozen until it comes back on-screen. Surfaced as a banner (the spec's capture-policy state). */
  paused?: boolean
}): ReactElement | null {
  const board = useOsrNetworkStore((s) => s.byBoard[boardId])
  const setDock = useOsrNetworkStore((s) => s.setDock)
  const setOpen = useOsrNetworkStore((s) => s.setOpen)
  const setPreserveFlag = useOsrNetworkStore((s) => s.setPreserve)
  const select = useOsrNetworkStore((s) => s.select)

  const [filter, setFilter] = useState('')
  const [regex, setRegex] = useState(false)
  const [invert, setInvert] = useState(false)
  const [typeKeys, setTypeKeys] = useState<NetTypeKey[]>(['all'])
  const [sort, setSort] = useState<SortState | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('headers')
  // Lazily-fetched bodies cache. CDP reuses requestIds (sequential per session) across reloads, so it
  // MUST be dropped whenever the log is cleared (button OR clear-on-nav) — else a reused id shows a
  // stale body. The effect below clears it on the records→empty transition that a clear produces.
  const [bodies, setBodies] = useState<Record<string, BodyState>>({})
  const recordCount = board?.records.length ?? 0
  const prevCount = useRef(0)
  useEffect(() => {
    if (prevCount.current > 0 && recordCount === 0) setBodies({})
    prevCount.current = recordCount
  }, [recordCount])
  // Escape closes the details pane (deselects), matching Chrome. Active only while a row is selected.
  const selectedId = board?.selected
  useEffect(() => {
    if (!selectedId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Chrome: Escape in the filter box blurs/clears the input first — only deselect when not typing.
      const el = document.activeElement
      if (el instanceof HTMLInputElement) {
        el.blur()
        return
      }
      select(boardId, undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, boardId, select])

  if (!board?.open) return null
  const preserve = board.preserve
  const dock: NetDock = board.dock
  const { rows, regexError } = applyNetFilter(board.records, {
    types: typeKeys,
    query: filter,
    regex,
    invert
  })
  const typeNarrowed = !(typeKeys.length === 1 && typeKeys[0] === 'all')
  const filtered = typeNarrowed || filter.trim().length > 0 || invert
  const wfWin = waterfallWindow(rows)
  const sortedRows = sortRecords(rows, sort)
  const onSort = (col: SortCol): void =>
    setSort((cur) =>
      cur?.col === col ? { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }
    )
  // Plain click selects one pill; Ctrl/Cmd-click toggles it in the OR'd set (empty ⇒ back to All).
  const onPill = (key: NetTypeKey, additive: boolean): void => {
    setTypeKeys((cur) => {
      if (key === 'all' || !additive) return [key]
      const set = new Set(cur.filter((k) => k !== 'all'))
      if (set.has(key)) set.delete(key)
      else set.add(key)
      return set.size === 0 ? ['all'] : [...set]
    })
  }
  const selected = board.selected
    ? board.records.find((r) => r.requestId === board.selected)
    : undefined
  const selectedWs =
    selected?.type === 'websocket'
      ? board.ws.find((w) => w.requestId === selected.requestId)
      : undefined

  const total = board.records.length
  const togglePreserve = (): void => {
    const next = !preserve
    setPreserveFlag(boardId, next) // store mirror (survives panel unmount; seeded from replay)
    void window.api.setOsrNetPreserve(boardId, next)
  }
  const clear = (): void => {
    setBodies({}) // drop cached bodies up-front (the records→empty effect also covers clear-on-nav)
    void window.api.clearOsrNet(boardId)
  }
  const onSelect = (rec: NetRecord): void => {
    select(boardId, rec.requestId)
    // Keep the last-used tab (Chrome) — only fall back when it isn't available for this request type.
    setDetailTab((cur) => (tabsFor(rec).includes(cur) ? cur : tabsFor(rec)[0]))
  }
  const loadBody = async (rec: NetRecord, kind: 'response' | 'request'): Promise<void> => {
    const key = `${rec.requestId}:${kind}`
    setBodies((b) => ({ ...b, [key]: { loading: true } }))
    const res = await window.api.getOsrNetBody(boardId, rec.requestId, kind)
    setBodies((b) => ({ ...b, [key]: { ...res, loading: false } }))
  }

  return (
    <div
      className={`bb-net bb-net-${dock} nowheel nodrag`}
      role="region"
      aria-label="Network inspector"
    >
      {/* header: tabs + dock switch + close */}
      <div className="bb-net-head">
        <span className="bb-net-tab bb-net-tab-on">Network</span>
        <span className="bb-net-tab bb-net-soon">
          Console <span className="bb-net-badge">soon</span>
        </span>
        <span className="bb-net-tab bb-net-soon">
          Storage <span className="bb-net-badge">soon</span>
        </span>
        <span className="bb-net-spacer" />
        <div className="bb-net-dockswitch" role="group" aria-label="Dock position">
          <DockBtn
            dock="bottom"
            active={dock === 'bottom'}
            onClick={() => setDock(boardId, 'bottom')}
          />
          <DockBtn
            dock="right"
            active={dock === 'right'}
            onClick={() => setDock(boardId, 'right')}
          />
        </div>
        <button
          className="bb-net-tool"
          title="Close inspector"
          aria-label="Close inspector"
          onClick={() => setOpen(boardId, false)}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      {/* toolbar: clear · preserve · filter · full-view */}
      <div className="bb-net-tools">
        <button
          className="bb-net-tool"
          title="Clear"
          aria-label="Clear network log"
          onClick={clear}
        >
          <Icon name="trash" size={14} />
        </button>
        <button
          className={'bb-net-preserve' + (preserve ? ' bb-net-on' : '')}
          role="checkbox"
          aria-checked={preserve}
          onClick={togglePreserve}
        >
          <span className="bb-net-check">{preserve && <Icon name="check" size={9} />}</span>
          Preserve
        </button>
        <span className={'bb-net-filter' + (regexError ? ' bb-net-filter-err' : '')}>
          <Icon name="search" size={12} />
          <input
            value={filter}
            placeholder="Filter…"
            aria-label="Filter requests"
            aria-invalid={regexError}
            spellCheck={false}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setFilter(e.target.value)}
          />
        </span>
        <button
          className={'bb-net-flag' + (regex ? ' bb-net-on' : '')}
          title="Use regular expression"
          aria-label="Use regular expression"
          aria-pressed={regex}
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>
        <button
          className={'bb-net-flag' + (invert ? ' bb-net-on' : '')}
          title="Invert filter (show requests that do NOT match)"
          aria-label="Invert filter"
          aria-pressed={invert}
          onClick={() => setInvert((v) => !v)}
        >
          Invert
        </button>
        {onFullView && (
          <button
            className="bb-net-tool"
            title="Full view"
            aria-label="Full view"
            onClick={onFullView}
          >
            <Icon name="maximize" size={14} />
          </button>
        )}
      </div>

      {/* resource-type filter pills (DevTools parity) */}
      <div className="bb-net-pills" role="group" aria-label="Filter by type">
        {NET_TYPE_PILLS.map((p) => {
          const on = typeKeys.includes(p.key)
          return (
            <button
              key={p.key}
              className={'bb-net-pill' + (on ? ' bb-net-pill-on' : '')}
              aria-pressed={on}
              title="Ctrl/⌘-click to select multiple types"
              onClick={(e) => onPill(p.key, e.ctrlKey || e.metaKey)}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      {/* meta line: counts (X / Y when filtered) + dropped */}
      <div className="bb-net-meta">
        {filtered ? (
          <>
            {rows.length} / {total} requests
          </>
        ) : (
          <>
            {total} {total === 1 ? 'request' : 'requests'}
          </>
        )}
        {board.dropped > 0 && <span className="bb-net-dropped"> · {board.dropped} dropped</span>}
      </div>

      {/* eviction state — capture stops with the board's offscreen window (MAX_LIVE cap). */}
      {paused && (
        <div className="bb-net-paused" role="status">
          Capture paused — board off-screen (evicted). Bring it on-screen to resume.
        </div>
      )}

      {/* request list */}
      <div className="bb-net-list">
        <table className="bb-net-rows">
          <thead>
            <tr>
              <SortTh col="name" label="Name" sort={sort} onSort={onSort} />
              <SortTh col="status" label="Status" sort={sort} onSort={onSort} />
              <SortTh
                col="type"
                label="Type"
                sort={sort}
                onSort={onSort}
                className="net-col-type"
              />
              <SortTh
                col="initiator"
                label="Initiator"
                sort={sort}
                onSort={onSort}
                className="net-col-initiator"
              />
              <SortTh col="size" label="Size" sort={sort} onSort={onSort} className="net-num" />
              <SortTh col="time" label="Time" sort={sort} onSort={onSort} className="net-num" />
              <th className="net-col-wf">Waterfall</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className="bb-net-empty">
                <td colSpan={7}>{total === 0 ? 'Recording network activity…' : 'No matches'}</td>
              </tr>
            )}
            {sortedRows.map((r) => (
              <Row
                key={r.requestId}
                rec={r}
                selected={r.requestId === board.selected}
                onClick={onSelect}
                wfWin={wfWin}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* details pane */}
      {selected && (
        <div className="bb-net-details">
          <div className="bb-net-subtabs">
            {tabsFor(selected).map((t) => (
              <button
                key={t}
                className={'bb-net-subtab' + (detailTab === t ? ' bb-net-subtab-on' : '')}
                onClick={() => setDetailTab(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
            <span className="bb-net-spacer" />
            <button
              className="bb-net-tool"
              title="Close details (Esc)"
              aria-label="Close details"
              onClick={() => select(boardId, undefined)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="bb-net-dbody">
            {selectedWs ? (
              <WsDetail ws={selectedWs} tab={detailTab} />
            ) : (
              <HttpDetail rec={selected} tab={detailTab} bodies={bodies} onLoad={loadBody} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DockBtn({
  dock,
  active,
  onClick
}: {
  dock: NetDock
  active: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      className={'bb-net-dock' + (active ? ' bb-net-on' : '')}
      title={dock === 'bottom' ? 'Dock to bottom' : 'Dock to right'}
      aria-label={dock === 'bottom' ? 'Dock to bottom' : 'Dock to right'}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon name={dock === 'bottom' ? 'dock-bottom' : 'dock-right'} size={14} />
    </button>
  )
}

function SortTh({
  col,
  label,
  sort,
  onSort,
  className
}: {
  col: SortCol
  label: string
  sort: SortState | null
  onSort: (c: SortCol) => void
  className?: string
}): ReactElement {
  const active = sort?.col === col
  return (
    <th className={className}>
      <button
        className={'bb-net-sortth' + (active ? ' bb-net-sortth-on' : '')}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        onClick={() => onSort(col)}
      >
        {label}
        {active && <span className="bb-net-sortarrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  )
}

function Row({
  rec,
  selected,
  onClick,
  wfWin
}: {
  rec: NetRecord
  selected: boolean
  onClick: (r: NetRecord) => void
  wfWin: WfWindow
}): ReactElement {
  const ws = rec.type === 'websocket'
  const bar = waterfallBar(rec, wfWin)
  return (
    <tr
      className={
        'bb-net-row' + (selected ? ' bb-net-sel' : '') + (isErrorRow(rec) ? ' bb-net-fail' : '')
      }
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => onClick(rec)}
    >
      <td className="net-name" title={rec.url}>
        {rec.crossOrigin && (
          <span className="bb-net-origin" title="sub-target (worker)">
            ⊕
          </span>
        )}
        {urlName(rec.url)}
      </td>
      <td className="net-mono net-status">{statusLabel(rec)}</td>
      <td className="net-col-type">{ws ? <span className="bb-net-ws">ws</span> : rec.type}</td>
      <td className="net-col-initiator" title={rec.initiator}>
        {initiatorLabel(rec.initiator)}
      </td>
      <td
        className="net-num"
        title={
          rec.decodedLength !== undefined ? `Decoded ${formatSize(rec.decodedLength)}` : undefined
        }
      >
        {ws ? '—' : sizeLabel(rec)}
      </td>
      <td
        className="net-num"
        title={ttfbMs(rec) !== undefined ? `TTFB ${ttfbMs(rec)} ms` : undefined}
      >
        {formatDuration(rec.startTs, rec.endTs)}
      </td>
      <td className="net-col-wf">
        <span className="net-wf-track">
          <span
            className="net-wf-bar"
            style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
          >
            {bar.waitPct > 0 && bar.waitPct < 100 && (
              <span className="net-wf-wait" style={{ width: `${bar.waitPct}%` }} />
            )}
          </span>
        </span>
      </td>
    </tr>
  )
}
