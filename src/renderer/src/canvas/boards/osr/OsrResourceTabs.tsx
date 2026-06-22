/**
 * The "Assets" and "Downloads" tab bodies for the DevTools inspector (`OsrNetworkPanel`). Split out
 * of the panel per the file-size doctrine. Both are read-only views over ephemeral session state:
 *   · Assets    — the static resources the page loaded, derived from the SAME network capture
 *                 (`assetRecords` filters image/font/css/js/media/manifest). Clicking a row selects
 *                 it, driving the panel's shared detail pane (so images get the Preview tab).
 *   · Downloads — files the page saved, from `osrWidgetStore.downloads` (fed by the always-mounted
 *                 widget-event hook, so downloads accrue even while the panel is closed). A done
 *                 download offers "Show" → reveal-in-folder (path-containment guarded in MAIN).
 * Never renders a captured string as HTML (React text-escaping only) — urls/filenames are
 * page-controlled.
 */
import { useState, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import type { NetRecord } from '../../../../../preload'
import type { OsrDownloadRecord } from '../../../store/osrWidgetStore'
import {
  assetRecords,
  downloadPct,
  formatSize,
  sizeLabel,
  urlName
} from '../../../lib/osrNetFormat'

/** Asset sub-type filter pills (a focused subset of resource types). `all` ⇒ every asset. */
const ASSET_PILLS: { key: string; label: string; type?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'image', label: 'Img', type: 'image' },
  { key: 'stylesheet', label: 'CSS', type: 'stylesheet' },
  { key: 'script', label: 'JS', type: 'script' },
  { key: 'font', label: 'Font', type: 'font' },
  { key: 'media', label: 'Media', type: 'media' }
]

export function AssetsTab({
  records,
  selectedId,
  onSelect
}: {
  records: NetRecord[]
  selectedId?: string
  onSelect: (rec: NetRecord) => void
}): ReactElement {
  const [filter, setFilter] = useState('')
  const [typeKey, setTypeKey] = useState('all')
  const q = filter.trim().toLowerCase()
  const rows = assetRecords(records).filter((r) => {
    // MAIN stores the capitalized CDP resourceType; the pill keys are lowercase → compare lowered.
    if (typeKey !== 'all' && (r.type || '').toLowerCase() !== typeKey) return false
    if (q && !r.url.toLowerCase().includes(q)) return false
    return true
  })
  return (
    <>
      <div className="bb-net-tools">
        <span className={'bb-net-filter'}>
          <Icon name="search" size={12} />
          <input
            value={filter}
            placeholder="Filter assets…"
            aria-label="Filter assets"
            spellCheck={false}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setFilter(e.target.value)}
          />
        </span>
      </div>
      <div className="bb-net-pills" role="group" aria-label="Filter by asset type">
        {ASSET_PILLS.map((p) => {
          const on = typeKey === p.key
          return (
            <button
              key={p.key}
              className={'bb-net-pill' + (on ? ' bb-net-pill-on' : '')}
              aria-pressed={on}
              onClick={() => setTypeKey(p.key)}
            >
              {p.label}
            </button>
          )
        })}
      </div>
      <div className="bb-net-meta">
        <span>
          {rows.length} {rows.length === 1 ? 'asset' : 'assets'}
        </span>
      </div>
      <div className="bb-net-list bb-asset-list">
        {rows.length === 0 ? (
          <div className="bb-net-empty">No assets captured yet.</div>
        ) : (
          rows.map((r) => (
            <button
              key={r.requestId}
              className={'bb-asset-row' + (r.requestId === selectedId ? ' bb-net-sel' : '')}
              title={r.url}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onSelect(r)}
            >
              <span className="bb-asset-name">{urlName(r.url)}</span>
              <span className="bb-asset-type">{r.type}</span>
              <span className="bb-asset-size">{sizeLabel(r)}</span>
            </button>
          ))
        )}
      </div>
    </>
  )
}

export function DownloadsTab({
  downloads,
  onReveal,
  onClear
}: {
  downloads: OsrDownloadRecord[]
  onReveal: (savePath: string) => void
  onClear: () => void
}): ReactElement {
  return (
    <>
      <div className="bb-net-tools">
        <button
          className="bb-net-tool"
          title="Clear downloads"
          aria-label="Clear downloads"
          disabled={downloads.length === 0}
          onClick={onClear}
        >
          <Icon name="trash" size={14} />
        </button>
        <span className="bb-net-meta-inline">
          {downloads.length} {downloads.length === 1 ? 'download' : 'downloads'}
        </span>
      </div>
      <div className="bb-net-list bb-dl-list">
        {downloads.length === 0 ? (
          <div className="bb-net-empty">No downloads yet.</div>
        ) : (
          downloads.map((d) => <DownloadRow key={d.name} d={d} onReveal={onReveal} />)
        )}
      </div>
    </>
  )
}

function DownloadRow({
  d,
  onReveal
}: {
  d: OsrDownloadRecord
  onReveal: (savePath: string) => void
}): ReactElement {
  const pct = downloadPct(d.received, d.total)
  return (
    <div className={'bb-dl-row bb-dl-' + d.state}>
      <Icon name="download" size={13} />
      <span className="bb-dl-name" title={d.savePath ?? d.name}>
        {d.name}
      </span>
      <span className="bb-dl-meta">{downloadMeta(d, pct)}</span>
      {d.state === 'progress' && (
        <span className="bb-dl-bar" aria-hidden>
          <span className="bb-dl-fill" style={{ width: `${pct ?? 0}%` }} />
        </span>
      )}
      {d.state === 'done' && d.savePath && (
        <button
          className="bb-dl-show"
          title="Show in folder"
          onClick={() => onReveal(d.savePath as string)}
        >
          Show
        </button>
      )}
    </div>
  )
}

/** The right-side status text for a download row. */
function downloadMeta(d: OsrDownloadRecord, pct: number | undefined): string {
  switch (d.state) {
    case 'done':
      return d.total ? `${formatSize(d.total)} · done` : 'done'
    case 'fail':
      return 'failed'
    case 'progress':
      return pct !== undefined ? `${pct}%` : formatSize(d.received)
    default:
      return 'starting…'
  }
}
