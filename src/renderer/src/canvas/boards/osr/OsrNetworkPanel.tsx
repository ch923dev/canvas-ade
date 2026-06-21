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
import type { NetRecord, WsRecord, NetHeader } from '../../../../../preload'
import {
  formatSize,
  formatDuration,
  urlName,
  statusLabel,
  applyNetFilter,
  initiatorLabel,
  NET_TYPE_PILLS,
  type NetTypeKey
} from '../../../lib/osrNetFormat'

type DetailTab = 'headers' | 'payload' | 'response' | 'timing' | 'frames'
interface BodyState {
  loading?: boolean
  body?: string
  base64?: boolean
  truncated?: boolean
  error?: string
}

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
  const [typeKey, setTypeKey] = useState<NetTypeKey>('all')
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

  if (!board?.open) return null
  const preserve = board.preserve
  const dock: NetDock = board.dock
  const { rows, regexError } = applyNetFilter(board.records, {
    type: typeKey,
    query: filter,
    regex,
    invert
  })
  const filtered = typeKey !== 'all' || filter.trim().length > 0 || invert
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
    setDetailTab(rec.type === 'websocket' ? 'frames' : 'headers')
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
        {NET_TYPE_PILLS.map((p) => (
          <button
            key={p.key}
            className={'bb-net-pill' + (typeKey === p.key ? ' bb-net-pill-on' : '')}
            aria-pressed={typeKey === p.key}
            onClick={() => setTypeKey(p.key)}
          >
            {p.label}
          </button>
        ))}
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
              <th>Name</th>
              <th>Status</th>
              <th className="net-col-type">Type</th>
              <th className="net-col-initiator">Initiator</th>
              <th className="net-num">Size</th>
              <th className="net-num">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className="bb-net-empty">
                <td colSpan={6}>{total === 0 ? 'Recording network activity…' : 'No matches'}</td>
              </tr>
            )}
            {rows.map((r) => (
              <Row
                key={r.requestId}
                rec={r}
                selected={r.requestId === board.selected}
                onClick={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* details pane */}
      {selected && (
        <div className="bb-net-details">
          <div className="bb-net-subtabs">
            {(selected.type === 'websocket'
              ? (['frames', 'headers'] as DetailTab[])
              : (['headers', 'payload', 'response', 'timing'] as DetailTab[])
            ).map((t) => (
              <button
                key={t}
                className={'bb-net-subtab' + (detailTab === t ? ' bb-net-subtab-on' : '')}
                onClick={() => setDetailTab(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
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

function Row({
  rec,
  selected,
  onClick
}: {
  rec: NetRecord
  selected: boolean
  onClick: (r: NetRecord) => void
}): ReactElement {
  const ws = rec.type === 'websocket'
  return (
    <tr
      className={
        'bb-net-row' + (selected ? ' bb-net-sel' : '') + (rec.failed ? ' bb-net-fail' : '')
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
      <td className="net-num">
        {ws ? <span className="bb-net-live">live</span> : formatSize(rec.encodedDataLength)}
      </td>
      <td className="net-num">{formatDuration(rec.startTs, rec.endTs)}</td>
    </tr>
  )
}

function HeaderList({
  title,
  headers
}: {
  title: string
  headers?: NetHeader[]
}): ReactElement | null {
  if (!headers || headers.length === 0) return null
  return (
    <details className="bb-net-headers">
      <summary>
        {title} <span className="bb-net-dim">({headers.length})</span>
      </summary>
      <dl>
        {headers.map((h, i) => (
          <div key={i}>
            <dt>{h.name}</dt>
            <dd>{h.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function BodyBar({
  rec,
  kind,
  state,
  onLoad
}: {
  rec: NetRecord
  kind: 'response' | 'request'
  state: BodyState | undefined
  onLoad: (r: NetRecord, k: 'response' | 'request') => void
}): ReactElement {
  return (
    <div className="bb-net-bodybar">
      {state?.body !== undefined ? (
        <pre className="bb-net-bodytext">
          {state.base64 ? '[binary · base64]\n' : ''}
          {state.body}
          {state.truncated && '\n…(truncated)'}
        </pre>
      ) : state?.error ? (
        <span className="bb-net-err">Couldn’t load body: {state.error}</span>
      ) : (
        <>
          <span className="bb-net-lbl">
            {kind === 'request' ? 'Request payload' : 'Response body'}
            {kind === 'response' && rec.encodedDataLength !== undefined && (
              <> · {formatSize(rec.encodedDataLength)}</>
            )}
          </span>
          <button
            className="bb-net-loadbtn"
            disabled={state?.loading}
            onClick={() => onLoad(rec, kind)}
          >
            {state?.loading ? 'Loading…' : 'Load body'}
          </button>
          <span className="bb-net-hint">lazy · capped 5 MB</span>
        </>
      )}
    </div>
  )
}

function HttpDetail({
  rec,
  tab,
  bodies,
  onLoad
}: {
  rec: NetRecord
  tab: DetailTab
  bodies: Record<string, BodyState>
  onLoad: (r: NetRecord, k: 'response' | 'request') => void
}): ReactElement {
  if (tab === 'response')
    return (
      <BodyBar
        rec={rec}
        kind="response"
        state={bodies[`${rec.requestId}:response`]}
        onLoad={onLoad}
      />
    )
  if (tab === 'payload')
    return (
      <BodyBar
        rec={rec}
        kind="request"
        state={bodies[`${rec.requestId}:request`]}
        onLoad={onLoad}
      />
    )
  if (tab === 'timing')
    return (
      <div className="bb-net-kv">
        <div>
          <span className="bb-net-k">Duration</span> {formatDuration(rec.startTs, rec.endTs)}
        </div>
        <div>
          <span className="bb-net-k">Transferred</span> {formatSize(rec.encodedDataLength)}
        </div>
        <div>
          <span className="bb-net-k">From cache</span> {rec.fromCache ? 'yes' : 'no'}
        </div>
      </div>
    )
  // headers
  return (
    <div className="bb-net-kv">
      <div className="bb-net-url">
        <span className="bb-net-k">Request URL</span>
        <span className="bb-net-v">{rec.url}</span>
      </div>
      <div>
        <span className="bb-net-k">Status</span> <b>{statusLabel(rec)}</b>
        {rec.statusText ? ` ${rec.statusText}` : ''}
        {rec.mimeType ? ` · ${rec.mimeType}` : ''}
        {rec.failed && <span className="bb-net-err"> · {rec.failed.errorText}</span>}
      </div>
      <HeaderList title="Response Headers" headers={rec.resHeaders} />
      <HeaderList title="Request Headers" headers={rec.reqHeaders} />
    </div>
  )
}

function WsDetail({ ws, tab }: { ws: WsRecord; tab: DetailTab }): ReactElement {
  if (tab === 'headers')
    return (
      <div className="bb-net-kv">
        <div className="bb-net-url">
          <span className="bb-net-k">URL</span>
          <span className="bb-net-v">{ws.url}</span>
        </div>
        <div>
          <span className="bb-net-k">Frames</span> {ws.frames.length}
          {ws.closedTs ? ' · closed' : ' · live'}
        </div>
      </div>
    )
  // frames
  return (
    <table className="bb-net-frames">
      <tbody>
        {ws.frames.length === 0 && (
          <tr>
            <td className="bb-net-dim">No frames yet</td>
          </tr>
        )}
        {ws.frames.map((f, i) => (
          <tr key={i} className={f.dir === 'sent' ? 'ws-sent' : 'ws-recv'}>
            <td className="ws-dir">
              <span className="ws-arrow">{f.dir === 'sent' ? '▲' : '▼'}</span> {f.dir}
            </td>
            <td className="ws-type">{f.opcode === 2 ? 'binary' : 'text'}</td>
            <td className="ws-data">
              {f.opcode === 2 ? (
                <span className="bb-net-dim">‹binary {f.payload.length}B›</span>
              ) : (
                f.payload
              )}
              {f.truncated && <span className="bb-net-dim"> ·truncated</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
