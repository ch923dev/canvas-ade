/**
 * JsonView (JD-1) — the Network inspector's body viewer.
 *
 * Presentational only: all parsing/fold/raw logic lives in `lib/osrJson.ts`. Renders a collapsible
 * tree with Option-A coloring (accent keys · neutral values · grey type badges). Every key/value/URL
 * from the page is emitted as React text inside a `<span>` — auto-escaped, NO `dangerouslySetInnerHTML`
 * anywhere (the page controls these strings). Click a value to copy it (toast confirms). No
 * virtualization / search / copy-path yet — those are JD-2.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { formatSize } from '../../../lib/osrNetFormat'
import { showToast } from '../../../store/toastStore'
import {
  buildModel,
  initialCollapsed,
  visibleRows,
  reindent,
  type JsonRow,
  type ValueType
} from '../../../lib/osrJson'

const INDENT_PX = 12

/** The text a value copies: a JSON string copies its decoded-of-quotes content; everything else
 *  (number / bigint / bool / null / form value) copies its literal source. */
function copyTextOf(row: JsonRow): string {
  const raw = row.valueText ?? ''
  if (row.valueType === 'string' && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1)
  }
  return raw
}

/** Click-to-copy a value → clipboard + a transient "Copied" toast (keyed so rapid copies replace). */
function copyValue(row: JsonRow): void {
  void navigator.clipboard?.writeText(copyTextOf(row))?.catch(() => {})
  showToast({ id: 'json-copy', kind: 'ok', message: 'Copied' })
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

function Row({
  row,
  collapsed,
  onToggle
}: {
  row: JsonRow
  collapsed: boolean
  onToggle: (id: number) => void
}): ReactElement {
  const pad = { paddingLeft: 2 + row.depth * INDENT_PX }
  const key =
    row.key !== undefined ? (
      <>
        <span className="bb-net-json-key">{row.key}</span>
        <span className="bb-net-json-punc">: </span>
      </>
    ) : null

  if (row.kind === 'open') {
    const isOpen = !collapsed
    return (
      <div
        className="bb-net-json-row bb-net-json-open"
        style={pad}
        onClick={() => onToggle(row.id)}
        role="button"
        tabIndex={-1}
      >
        <span className="bb-net-json-chev">{isOpen ? '▾' : '▸'}</span>
        {key}
        <span className="bb-net-json-punc">{row.brace}</span>
        {!isOpen && (
          <>
            <span className="bb-net-json-punc"> … </span>
            <span className="bb-net-json-punc">{closeBraceOf(row.brace)}</span>
            <span className="bb-net-json-count">{row.childCount}</span>
          </>
        )}
      </div>
    )
  }

  if (row.kind === 'close') {
    return (
      <div className="bb-net-json-row" style={pad}>
        <span className="bb-net-json-punc">{row.brace}</span>
        {row.truncatedHere && <span className="bb-net-json-chip warn"> truncated</span>}
      </div>
    )
  }

  // scalar
  const badge = row.valueType ? TYPE_BADGE[row.valueType] : ''
  return (
    <div className="bb-net-json-row" style={pad}>
      {key}
      <span
        className={`bb-net-json-val t-${row.valueType ?? 'raw'}`}
        onClick={(e) => {
          e.stopPropagation()
          copyValue(row)
        }}
        title="Click to copy"
        role="button"
        tabIndex={-1}
      >
        {row.valueText}
      </span>
      {badge && <span className="bb-net-json-badge">{badge}</span>}
      {row.valueType === 'bigint' && <span className="bb-net-json-chip warn">64-bit</span>}
      {row.duplicateKey && <span className="bb-net-json-chip warn">dup</span>}
    </div>
  )
}

export function JsonView({
  body,
  mime,
  base64,
  truncated
}: {
  body: string | undefined
  mime: string | undefined
  base64?: boolean
  truncated?: boolean
}): ReactElement {
  const text = body ?? ''
  const model = useMemo(() => buildModel(text, mime, base64), [text, mime, base64])
  const [collapsed, setCollapsed] = useState<Set<number>>(() => initialCollapsed(model.rows))
  const [raw, setRaw] = useState(false)
  // Reset fold + view when the underlying body changes (new request selected / reloaded). The
  // store-previous-prop pattern resets during render — no effect, no cascading-render lint hit.
  const [prevModel, setPrevModel] = useState(model)
  if (model !== prevModel) {
    setPrevModel(model)
    setCollapsed(initialCollapsed(model.rows))
    setRaw(false)
  }

  const toggle = (id: number): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const isTruncated = truncated || model.meta.truncated || model.meta.maxDepth

  // Binary / plain-text / empty → graceful passthrough (no tree).
  if (model.kind === 'binary') {
    return (
      <div className="bb-net-json">
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
      <div className="bb-net-json">
        <pre className="bb-net-bodytext">
          {text}
          {isTruncated && '\n…(truncated)'}
        </pre>
      </div>
    )
  }

  const root = model.rows[0]
  const rootCount = root?.kind === 'open' ? root.childCount : undefined

  return (
    <div className="bb-net-json">
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
        <div className="bb-net-json-toggle" role="group" aria-label="view mode">
          <button className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>
            Tree
          </button>
          <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
      </div>

      {model.meta.parseError && (
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
        <div className="bb-net-json-rows">
          {visibleRows(model.rows, collapsed).map((r) => (
            <Row key={r.id} row={r} collapsed={collapsed.has(r.id)} onToggle={toggle} />
          ))}
          {isTruncated && (
            <div className="bb-net-json-trunc">
              …({model.meta.maxDepth ? 'max depth' : 'truncated'})
            </div>
          )}
        </div>
      )}
    </div>
  )
}
