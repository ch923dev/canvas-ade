/**
 * Selected-request detail pane for the DevTools Network inspector (extracted from OsrNetworkPanel to
 * keep each file under the size cap). Renders the per-tab content for an HTTP request (Headers /
 * Payload / Response / Timing) or a WebSocket (Headers / Messages). Pure presentational — all data
 * is the renderer mirror (MAIN already capped every page-controlled string); React text-escaping
 * only, never dangerouslySetInnerHTML.
 */
import { useState, type ReactElement } from 'react'
import type { NetRecord, WsRecord, WsFrame, NetHeader } from '../../../../../preload'
import {
  formatSize,
  formatDuration,
  statusLabel,
  isErrorRow,
  timingPhases,
  queryParams,
  requestCookies,
  responseCookies,
  hasPayload,
  hasCookies,
  initiatorLabel,
  type NetKV
} from '../../../lib/osrNetFormat'

export type DetailTab =
  | 'headers'
  | 'payload'
  | 'preview'
  | 'response'
  | 'initiator'
  | 'timing'
  | 'cookies'
  | 'frames'
/** The detail tabs available for a record. WebSocket has its own set; Payload + Cookies are
 *  conditional (Chrome only shows them when there's a query/body or cookies). */
export const tabsFor = (rec: NetRecord): DetailTab[] => {
  if (rec.type === 'websocket') return ['frames', 'headers']
  const tabs: DetailTab[] = ['headers']
  if (hasPayload(rec)) tabs.push('payload')
  tabs.push('preview', 'response', 'initiator', 'timing')
  if (hasCookies(rec)) tabs.push('cookies')
  return tabs
}

export interface BodyState {
  loading?: boolean
  body?: string
  base64?: boolean
  truncated?: boolean
  error?: string
}

function HeaderList({
  title,
  headers
}: {
  title: string
  headers?: NetHeader[]
}): ReactElement | null {
  // "view parsed" (default) sorts alphabetically; "view source" shows the captured wire order.
  const [source, setSource] = useState(false)
  if (!headers || headers.length === 0) return null
  const shown = source ? headers : [...headers].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <details className="bb-net-headers" open>
      <summary>
        {title} <span className="bb-net-dim">({headers.length})</span>
        <button
          className="bb-net-srctoggle"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setSource((v) => !v)
          }}
        >
          {source ? 'view parsed' : 'view source'}
        </button>
      </summary>
      <dl>
        {shown.map((h, i) => (
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

function GenRow({ k, v }: { k: string; v: string }): ReactElement {
  return (
    <div className="bb-net-genrow">
      <span className="bb-net-k">{k}</span>
      <span className="bb-net-v">{v}</span>
    </div>
  )
}

function TimingTab({ rec }: { rec: NetRecord }): ReactElement {
  const phases = timingPhases(rec)
  if (phases.length === 0)
    return (
      <div className="bb-net-kv">
        <div className="bb-net-dim">No timing breakdown (served from cache or still pending).</div>
        <GenRow k="Duration" v={formatDuration(rec.startTs, rec.endTs)} />
        <GenRow k="Transferred" v={formatSize(rec.encodedDataLength)} />
      </div>
    )
  const total = phases[phases.length - 1].end || 1
  return (
    <div className="bb-net-timing">
      {phases.map((p, i) => (
        <div key={i} className="bb-net-tphase">
          <span className="bb-net-tlabel">{p.label}</span>
          <span className="bb-net-tbar">
            <span
              className="bb-net-tfill"
              style={{
                left: `${(p.start / total) * 100}%`,
                width: `${Math.max(((p.end - p.start) / total) * 100, 0.5)}%`
              }}
            />
          </span>
          <span className="bb-net-tdur">{Math.round(p.end - p.start)} ms</span>
        </div>
      ))}
      <div className="bb-net-tphase bb-net-ttotal">
        <span className="bb-net-tlabel">Total</span>
        <span className="bb-net-tbar" />
        <span className="bb-net-tdur">{Math.round(total)} ms</span>
      </div>
    </div>
  )
}

/** A small name/value table (Query String Parameters · Request/Response Cookies). */
function KVTable({ title, rows }: { title: string; rows: NetKV[] }): ReactElement | null {
  if (rows.length === 0) return null
  return (
    <details className="bb-net-headers" open>
      <summary>
        {title} <span className="bb-net-dim">({rows.length})</span>
      </summary>
      <dl>
        {rows.map((r, i) => (
          <div key={i}>
            <dt>{r.name}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function PayloadTab({
  rec,
  bodies,
  onLoad
}: {
  rec: NetRecord
  bodies: Record<string, BodyState>
  onLoad: (r: NetRecord, k: 'response' | 'request') => void
}): ReactElement {
  const qs = queryParams(rec.url)
  return (
    <div className="bb-net-kv">
      <KVTable title="Query String Parameters" rows={qs} />
      <BodyBar
        rec={rec}
        kind="request"
        state={bodies[`${rec.requestId}:request`]}
        onLoad={onLoad}
      />
    </div>
  )
}

/** Preview the response body: raster image → <img>; JSON → pretty-printed; else raw text. Reuses
 *  the lazy response-body fetch (same cache key as the Response tab). */
function PreviewTab({
  rec,
  state,
  onLoad
}: {
  rec: NetRecord
  state: BodyState | undefined
  onLoad: (r: NetRecord, k: 'response' | 'request') => void
}): ReactElement {
  if (state?.body === undefined)
    return <BodyBar rec={rec} kind="response" state={state} onLoad={onLoad} />
  const mime = (rec.mimeType ?? '').toLowerCase()
  if (state.base64 && mime.startsWith('image/') && !mime.includes('svg')) {
    // raster only — data: <img> never executes script; SVG excluded out of caution
    return (
      <img
        className="bb-net-preview-img"
        alt="response preview"
        src={`data:${mime};base64,${state.body}`}
      />
    )
  }
  let text = state.body
  if (mime.includes('json')) {
    try {
      text = JSON.stringify(JSON.parse(state.body), null, 2)
    } catch {
      /* not valid JSON — show raw */
    }
  }
  return (
    <pre className="bb-net-bodytext">
      {text}
      {state.truncated && '\n…(truncated)'}
    </pre>
  )
}

function InitiatorTab({ rec }: { rec: NetRecord }): ReactElement {
  return (
    <div className="bb-net-kv">
      <div className="bb-net-genrow">
        <span className="bb-net-k">Request initiator</span>
        <span className="bb-net-v">{rec.initiator ? initiatorLabel(rec.initiator) : 'other'}</span>
      </div>
      {rec.initiator?.includes('://') && (
        <div className="bb-net-genrow">
          <span className="bb-net-k">Source</span>
          <span className="bb-net-v">{rec.initiator}</span>
        </div>
      )}
    </div>
  )
}

function CookiesTab({ rec }: { rec: NetRecord }): ReactElement {
  const req = requestCookies(rec.reqHeaders)
  const res = responseCookies(rec.resHeaders)
  return (
    <div className="bb-net-kv">
      <KVTable title="Request Cookies" rows={req} />
      <KVTable title="Response Cookies" rows={res} />
      {req.length === 0 && res.length === 0 && <span className="bb-net-dim">No cookies</span>}
    </div>
  )
}

export function HttpDetail({
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
  if (tab === 'payload') return <PayloadTab rec={rec} bodies={bodies} onLoad={onLoad} />
  if (tab === 'preview')
    return <PreviewTab rec={rec} state={bodies[`${rec.requestId}:response`]} onLoad={onLoad} />
  if (tab === 'initiator') return <InitiatorTab rec={rec} />
  if (tab === 'timing') return <TimingTab rec={rec} />
  if (tab === 'cookies') return <CookiesTab rec={rec} />

  // headers
  return (
    <div className="bb-net-kv">
      <div className="bb-net-general">
        <div className="bb-net-url">
          <span className="bb-net-k">Request URL</span>
          <span className="bb-net-v">{rec.url}</span>
        </div>
        <GenRow k="Request Method" v={rec.method} />
        <div className="bb-net-genrow">
          <span className="bb-net-k">Status Code</span>
          <span className="bb-net-v">
            <span className={'bb-net-statusdot ' + (isErrorRow(rec) ? 'bad' : 'ok')} />
            {statusLabel(rec)}
            {rec.statusText ? ` ${rec.statusText}` : ''}
            {rec.failed?.errorText && <span className="bb-net-err"> · {rec.failed.errorText}</span>}
          </span>
        </div>
        {rec.remoteAddress && <GenRow k="Remote Address" v={rec.remoteAddress} />}
        {rec.referrerPolicy && <GenRow k="Referrer Policy" v={rec.referrerPolicy} />}
      </div>
      <HeaderList title="Response Headers" headers={rec.resHeaders} />
      <HeaderList title="Request Headers" headers={rec.reqHeaders} />
    </div>
  )
}

/** WebSocket opcode → the literal Chrome label (text opcode 1 shows its payload, so it has no entry). */
const WS_OPCODE: Record<number, string> = {
  0: 'Continuation Frame',
  2: 'Binary Message',
  8: 'Connection Close Frame',
  9: 'Ping Frame',
  10: 'Pong Frame'
}
/** Row class: control/continuation frames de-emphasized; otherwise sent vs received. */
function wsFrameClass(f: WsFrame): string {
  if (f.opcode >= 8 || f.opcode === 0) return 'ws-ctrl'
  return f.dir === 'sent' ? 'ws-sent' : 'ws-recv'
}
/** HH:MM:SS.mmm local clock for a frame's timestamp (Chrome's Messages Time column). */
function frameClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function WsDetail({ ws, tab }: { ws: WsRecord; tab: DetailTab }): ReactElement {
  if (tab === 'headers')
    return (
      <div className="bb-net-kv">
        <div className="bb-net-general">
          <div className="bb-net-url">
            <span className="bb-net-k">URL</span>
            <span className="bb-net-v">{ws.url}</span>
          </div>
          <div className="bb-net-genrow">
            <span className="bb-net-k">Status</span>
            <span className="bb-net-v">
              101 Switching Protocols{ws.closedTs ? ' · closed' : ' · open'}
            </span>
          </div>
        </div>
        <HeaderList title="Response Headers" headers={ws.resHeaders} />
        <HeaderList title="Request Headers" headers={ws.reqHeaders} />
      </div>
    )
  // frames (Messages)
  return (
    <table className="bb-net-frames">
      <thead>
        <tr>
          <th className="ws-dir" />
          <th>Data</th>
          <th className="net-num">Length</th>
          <th className="net-num">Time</th>
        </tr>
      </thead>
      <tbody>
        {ws.frames.length === 0 && (
          <tr>
            <td className="bb-net-dim" colSpan={4}>
              No frames yet
            </td>
          </tr>
        )}
        {ws.frames.map((f, i) => {
          const ctrl = WS_OPCODE[f.opcode]
          return (
            <tr key={i} className={wsFrameClass(f)}>
              <td className="ws-dir">
                <span className="ws-arrow">{f.dir === 'sent' ? '↑' : '↓'}</span>
              </td>
              <td className="ws-data">
                {f.opcode === 1 ? (
                  <>
                    {f.payload}
                    {f.truncated && <span className="bb-net-dim"> ·truncated</span>}
                  </>
                ) : (
                  <span className="bb-net-dim">{ctrl ?? 'Frame'}</span>
                )}
              </td>
              <td className="net-num">{f.length}</td>
              <td className="net-num">{frameClock(f.ts)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
