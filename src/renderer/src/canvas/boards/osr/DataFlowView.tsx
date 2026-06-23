/**
 * Data Flow tab (JD-3) — the body-free endpoint inventory + opt-in inferred schemas + entity/shape
 * inspector for the Network inspector. Renders inside `OsrNetworkPanel` when `tab==='dataflow'`.
 *
 * Privacy contract (ADR 0010): the inventory is body-free and always shown; schema inference is gated
 * behind the per-board "Infer data shapes" opt-in and samples bodies LAZILY (only for an expanded
 * template) via MAIN's capped `sampleOsrNetSchema`, which returns VALUE-LESS shape skeletons. The
 * renderer merges skeletons → schema (schemaInfer) → entities (entityInfer). No raw value is ever
 * received here, and every page string is React-escaped (no `dangerouslySetInnerHTML`).
 *
 * Scope: JD-3 ships inventory + inspector with TEXTUAL relationships; the visual graph + id-lineage are
 * JD-4.
 */
import {
  useMemo,
  useState,
  useRef,
  type ReactElement,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useOsrNetworkStore, type SchemaState } from '../../../store/osrNetworkStore'
import type { NetRecord } from '../../../../../preload'
import { groupByTemplate, type RouteTemplate, type TemplateGroup } from '../../../lib/routeTemplate'
import { mergeShapes, type InferredField } from '../../../lib/schemaInfer'
import { inferEntities, fkBaseName, type EntityModel } from '../../../lib/entityInfer'

/** Pre-trim before the (also-capped) MAIN pass: sample the newest N responses of a template. */
const SAMPLE_REQUEST_CAP = 20
/** Stable empty fallback so the schemas-keyed useMemo dep doesn't change identity every render. */
const NO_SCHEMAS: Record<string, SchemaState> = {}

export function DataFlowView({
  boardId,
  records
}: {
  boardId: string
  records: NetRecord[]
}): ReactElement {
  const board = useOsrNetworkStore((s) => s.byBoard[boardId])
  const setInferShapes = useOsrNetworkStore((s) => s.setInferShapes)
  const toggleExpanded = useOsrNetworkStore((s) => s.toggleExpanded)
  const setSchema = useOsrNetworkStore((s) => s.setSchema)
  const setDfInspW = useOsrNetworkStore((s) => s.setDfInspW)

  const inferShapes = board?.inferShapes ?? false
  const expanded = board?.expanded ?? []
  const schemas = board?.schemas ?? NO_SCHEMAS
  const inspW = board?.dfInspW

  const groups = useMemo(() => groupByTemplate(records), [records])
  const [query, setQuery] = useState('')
  // Filter the inventory by method / origin / template (e.g. "localhost", "prod-api", "/api"). The
  // entity MODEL stays global (built from every inferred route) so relationships remain accurate.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return groups
    return groups.filter((g) =>
      `${g.tpl.method} ${g.tpl.origin}${g.tpl.template}`.toLowerCase().includes(q)
    )
  }, [groups, query])
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined)
  const selected = groups.find((g) => g.key === selectedKey) ?? shown[0] ?? groups[0]

  // Drag-resize the inspector column (its left edge). Width is persisted per board in the store.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const onInspDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic pointer (e2e) — drag still works */
    }
  }
  const onInspMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    const r = bodyRef.current?.getBoundingClientRect()
    if (!r) return
    setDfInspW(boardId, Math.round(Math.max(220, Math.min(r.width - 260, r.right - e.clientX))))
  }
  const onInspUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* nothing captured */
    }
  }

  // Entity model over the templates whose schema has been inferred (name+type structural — no values).
  const model: EntityModel = useMemo(() => {
    const inputs = groups
      .map((g) => {
        const st = schemas[g.key]
        return st && 'schema' in st
          ? { key: g.key, routeName: lastStatic(g.tpl), method: g.tpl.method, schema: st.schema }
          : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    return inferEntities(inputs)
  }, [groups, schemas])

  /** Sample + merge a template's response shapes (called lazily on expand / enable). */
  const ensureSchema = async (g: TemplateGroup): Promise<void> => {
    if (schemas[g.key]) return // already loading / errored / done
    const ids = g.records
      .filter((r) => r.type !== 'websocket')
      .slice(-SAMPLE_REQUEST_CAP)
      .map((r) => r.requestId)
    if (ids.length === 0) {
      setSchema(boardId, g.key, { error: 'no response bodies to sample' })
      return
    }
    const sampler = window.api?.sampleOsrNetSchema
    if (!sampler) {
      setSchema(boardId, g.key, { error: 'sampling unavailable' })
      return
    }
    setSchema(boardId, g.key, { loading: true })
    const res = await sampler(boardId, ids)
    if (res.error) {
      setSchema(boardId, g.key, { error: res.error })
      return
    }
    setSchema(boardId, g.key, {
      schema: mergeShapes(res.samples ?? []),
      sampled: res.sampled ?? 0,
      requested: res.requested ?? ids.length
    })
  }

  const onToggleRow = (g: TemplateGroup): void => {
    const willExpand = !expanded.includes(g.key)
    toggleExpanded(boardId, g.key)
    setSelectedKey(g.key)
    if (willExpand && inferShapes) void ensureSchema(g)
  }

  const enableInference = (): void => {
    setInferShapes(boardId, true)
    for (const key of expanded) {
      const g = groups.find((x) => x.key === key)
      if (g) void ensureSchema(g)
    }
  }
  const onToggleOptIn = (): void => {
    if (inferShapes) setInferShapes(boardId, false)
    else enableInference()
  }

  // Resolve a field key to the entity it FK-references (drives the accent + tag), at any nesting depth.
  const fkOf = (key: string): string | undefined => {
    const base = fkBaseName(key)
    if (!base) return undefined
    return model.entities.find((x) => x.name === pascalSingular(base))?.name
  }

  const totalCalls = groups.reduce((n, g) => n + g.calls, 0)
  const filledSchemas = groups.filter((g) => {
    const st = schemas[g.key]
    return st && 'schema' in st
  }).length
  const flat = inferShapes && filledSchemas >= 2 && model.relationships.length === 0

  return (
    <div className="bb-net-df">
      {/* toolbar: opt-in gate + privacy chip */}
      <div className="bb-net-df-tools">
        <button
          className={'bb-net-df-optin' + (inferShapes ? ' bb-net-on' : '')}
          role="checkbox"
          aria-checked={inferShapes}
          onClick={onToggleOptIn}
        >
          <span className="bb-net-df-box">{inferShapes && '✓'}</span>
          Infer data shapes <span className="bb-net-df-dim">(reads response bodies)</span>
        </button>
        <span className="bb-net-spacer" />
        <input
          className="bb-net-df-filter"
          value={query}
          placeholder="Filter routes (localhost, /api…)"
          aria-label="Filter routes"
          spellCheck={false}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="bb-net-df-privacy">
          {inferShapes ? '🔒 values scrubbed · structure only' : '🔒 bodies off · inventory only'}
        </span>
      </div>

      {flat && (
        <div className="bb-net-df-banner" role="status">
          <b>Flat API</b> — no relationships between endpoints found. Inventory and inferred schemas
          are still shown; we never invent edges.
          <span className="bb-net-spacer" />
          <span className="bb-net-df-layers">
            <span className="bb-net-df-layer on">inventory</span>
            <span className="bb-net-df-layer on">schemas</span>
            <span className="bb-net-df-layer">relationships</span>
            <span className="bb-net-df-layer">lineage</span>
          </span>
        </div>
      )}

      <div className="bb-net-df-body" ref={bodyRef}>
        {/* ── inventory ── */}
        <div className="bb-net-df-inv">
          <div className="bb-net-df-colhead">
            Endpoint Inventory
            <span className="bb-net-spacer" />
            <span className="bb-net-df-ct">
              {shown.length === groups.length
                ? `${groups.length} ${groups.length === 1 ? 'template' : 'templates'} · ${totalCalls} calls`
                : `${shown.length} / ${groups.length} templates`}
              {!inferShapes && shown.length === groups.length && ' · body-free'}
            </span>
          </div>
          <div className="bb-net-df-list">
            {shown.length === 0 && (
              <div className="bb-net-df-empty">
                {groups.length === 0 ? 'No requests captured yet…' : 'No matching routes'}
              </div>
            )}
            {shown.map((g) => (
              <InventoryRow
                key={g.key}
                group={g}
                open={expanded.includes(g.key)}
                selected={selected?.key === g.key}
                inferShapes={inferShapes}
                schema={schemas[g.key]}
                fkOf={fkOf}
                onToggle={() => onToggleRow(g)}
                onEnable={enableInference}
              />
            ))}
          </div>
        </div>

        {/* drag the inspector's left edge to resize it */}
        <div
          className="bb-net-df-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inspector"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={onInspDown}
          onPointerMove={onInspMove}
          onPointerUp={onInspUp}
          onPointerCancel={onInspUp}
        />

        {/* ── entity / shape inspector ── */}
        <Inspector
          group={selected}
          model={model}
          width={inspW}
          inferShapes={inferShapes}
          schema={selected ? schemas[selected.key] : undefined}
        />
      </div>
    </div>
  )
}

/* ── inventory row ─────────────────────────────────────────────────────────────────────────────── */

function InventoryRow({
  group,
  open,
  selected,
  inferShapes,
  schema,
  fkOf,
  onToggle,
  onEnable
}: {
  group: TemplateGroup
  open: boolean
  selected: boolean
  inferShapes: boolean
  schema: SchemaState | undefined
  fkOf: (key: string) => string | undefined
  onToggle: () => void
  onEnable: () => void
}): ReactElement {
  const fieldCount = schema && 'schema' in schema ? topFields(schema.schema.root).length : undefined
  return (
    <>
      <div
        className={
          'bb-net-df-row' + (selected ? ' bb-net-df-sel' : '') + (open ? ' bb-net-df-open' : '')
        }
        onClick={onToggle}
      >
        <span className="bb-net-df-method">{group.tpl.method}</span>
        <span className="bb-net-df-route">{renderRoute(group.tpl)}</span>
        <span className="bb-net-df-calls">{group.calls}</span>
        <StatusMixBar mix={group.statusMix} />
        <span className="bb-net-df-p50">
          {group.p50Ms !== undefined ? (
            <>
              <b>{group.p50Ms}</b>ms
            </>
          ) : (
            '—'
          )}
        </span>
        <span className="bb-net-df-schemacell">
          {group.tpl.method === 'WS'
            ? '~frames'
            : !inferShapes
              ? '🔒'
              : fieldCount !== undefined
                ? `{${fieldCount}}`
                : ''}
        </span>
      </div>
      {open && (
        <div className="bb-net-df-schema">
          {!inferShapes ? (
            <div className="bb-net-df-gate">
              <div className="bb-net-df-gate-txt">
                <div className="bb-net-df-gate-h">Shapes are off</div>
                <div className="bb-net-df-gate-d">
                  Enable <b>Infer data shapes</b> to sample this endpoint&apos;s response bodies (in
                  the main process, capped) and infer its schema. Values are dropped — only types,
                  field names &amp; presence are shown.
                </div>
              </div>
              <button
                className="bb-net-df-enable"
                onClick={(e) => (e.stopPropagation(), onEnable())}
              >
                Enable
              </button>
            </div>
          ) : (
            <SchemaReveal schema={schema} routeName={lastStatic(group.tpl)} fkOf={fkOf} />
          )}
        </div>
      )}
    </>
  )
}

function SchemaReveal({
  schema,
  routeName,
  fkOf
}: {
  schema: SchemaState | undefined
  routeName: string
  fkOf: (key: string) => string | undefined
}): ReactElement {
  if (!schema || 'loading' in schema)
    return (
      <div className="bb-net-df-note">
        {schema ? 'Sampling response bodies…' : 'Expand to infer…'}
      </div>
    )
  if ('error' in schema)
    return <div className="bb-net-df-note">Could not infer: {schema.error}</div>
  const fields = topFields(schema.schema.root)
  return (
    <>
      <div className="bb-net-df-schemahead">
        <span className="bb-net-df-lbl">Inferred response</span>
        <span className="bb-net-df-ent">{pascalSingular(routeName)}</span>
        <span className="bb-net-df-src">
          merged from {schema.sampled} of {schema.requested} sampled
        </span>
      </div>
      <div className="bb-net-df-fields">
        <SchemaTree fields={fields} depth={0} fkOf={fkOf} />
      </div>
      <div className="bb-net-df-note">
        sampled {schema.sampled} of {schema.requested} · newest-first · values dropped in main
      </div>
    </>
  )
}

/** Render the inferred schema as a nested tree — nested objects / array elements are EXPANDED inline
 *  (the response is fully deconstructed, not summarized to `{N}`), so an enveloped/nested entity shows. */
function SchemaTree({
  fields,
  depth,
  fkOf
}: {
  fields: InferredField[]
  depth: number
  fkOf: (key: string) => string | undefined
}): ReactElement {
  return (
    <>
      {fields.map((f) => (
        <FieldRow key={f.key} field={f} depth={depth} fkOf={fkOf} />
      ))}
    </>
  )
}

function FieldRow({
  field,
  depth,
  fkOf
}: {
  field: InferredField
  depth: number
  fkOf: (key: string) => string | undefined
}): ReactElement {
  const kids = field.children ?? field.elem?.children
  const fk = fkOf(field.key)
  const t = typeLabel(field, !!fk)
  return (
    <>
      <div className="bb-net-df-field" style={{ paddingLeft: depth * 12 }}>
        <span className="bb-net-df-fkey">{field.key}</span>
        {!field.required && <span className="bb-net-df-opt">?</span>}
        <span className="bb-net-df-colon">:</span>
        <span className={'bb-net-df-ftype' + (t.idLike ? ' bb-net-df-id' : '')}>{t.text}</span>
        {field.required ? (
          <span className="bb-net-df-req">
            <i />
            required
          </span>
        ) : (
          <span className="bb-net-df-optn">
            optional · {field.presentIn}/{field.sampleCount}
          </span>
        )}
        {field.pii && <span className="bb-net-df-pii">⚠ PII · value hidden</span>}
        {fk && <span className="bb-net-df-fk">→ FK {fk}</span>}
      </div>
      {kids && <SchemaTree fields={kids} depth={depth + 1} fkOf={fkOf} />}
    </>
  )
}

function StatusMixBar({ mix }: { mix: TemplateGroup['statusMix'] }): ReactElement {
  const total = mix.c2xx + mix.c3xx + mix.c4xx + mix.c5xx + mix.other || 1
  const pct = (n: number): string => `${(n / total) * 100}%`
  return (
    <span className="bb-net-df-mix" aria-hidden>
      {mix.c2xx > 0 && <i className="bb-net-df-2xx" style={{ width: pct(mix.c2xx) }} />}
      {mix.c3xx > 0 && <i className="bb-net-df-3xx" style={{ width: pct(mix.c3xx) }} />}
      {mix.c4xx > 0 && <i className="bb-net-df-4xx" style={{ width: pct(mix.c4xx) }} />}
      {mix.c5xx > 0 && <i className="bb-net-df-4xx" style={{ width: pct(mix.c5xx) }} />}
    </span>
  )
}

/* ── inspector ─────────────────────────────────────────────────────────────────────────────────── */

function Inspector({
  group,
  model,
  width,
  inferShapes,
  schema
}: {
  group: TemplateGroup | undefined
  model: EntityModel
  width?: number
  inferShapes: boolean
  schema: SchemaState | undefined
}): ReactElement {
  const style = width ? { width, flexShrink: 0 } : undefined
  if (!group) return <div className="bb-net-df-insp" style={style} />
  const routeName = lastStatic(group.tpl)
  // The route's PRIMARY entity is the one named for the route (the unwrapped root/envelope entity);
  // fall back to the first entity this route produced. Its fields are the UNWRAPPED member set.
  const produced = model.entities.filter(
    (e) => e.producedBy.includes(group.key) || e.consumedBy.includes(group.key)
  )
  const entity = produced.find((e) => e.name === pascalSingular(routeName)) ?? produced[0]
  const rels = entity
    ? model.relationships.filter((r) => r.from === entity.name || r.to === entity.name)
    : []
  const fields = entity
    ? entity.fields
    : schema && 'schema' in schema
      ? topFields(schema.schema.root)
      : []

  return (
    <div className="bb-net-df-insp" style={style}>
      <div className="bb-net-df-insphead">
        <span className="bb-net-df-entname">
          {entity ? entity.name : pascalSingular(routeName)}
        </span>
        <span className="bb-net-df-entpill">{entity ? entity.kind : 'endpoint'}</span>
      </div>
      <div className="bb-net-df-entmeta">
        {group.tpl.method} {group.tpl.template} · {group.calls} calls
        {group.p95Ms !== undefined && ` · p95 ${group.p95Ms}ms`}
      </div>

      {!inferShapes ? (
        <div className="bb-net-df-section">
          <div className="bb-net-df-sech">Inferred schema</div>
          <div className="bb-net-df-none">
            Off
            <div className="bb-net-df-noned">
              Turn on <b>Infer data shapes</b> to read response bodies and infer fields, entities
              &amp; relationships. Nothing is read until you do.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="bb-net-df-section">
            <div className="bb-net-df-sech">
              Inferred fields{' '}
              {fields.length > 0 && <span className="bb-net-df-ct">{fields.length}</span>}
            </div>
            {fields.length === 0 ? (
              <div className="bb-net-df-none">
                {schema && 'loading' in schema
                  ? 'Sampling…'
                  : 'Expand a route to infer its schema.'}
              </div>
            ) : (
              fields.map((f) => (
                <div key={f.key} className="bb-net-df-inspline">
                  <span className={f.pii ? 'bb-net-df-pii-key' : undefined}>{f.key}</span>
                  <span className="bb-net-df-spacer" />
                  <span className="bb-net-df-inspt">{typeLabel(f, false).text}</span>
                </div>
              ))
            )}
          </div>

          <div className="bb-net-df-section">
            <div className="bb-net-df-sech">
              Relationships {rels.length > 0 && <span className="bb-net-df-ct">{rels.length}</span>}
            </div>
            {rels.length === 0 ? (
              <div className="bb-net-df-none">
                None detected
                <div className="bb-net-df-noned">
                  No id field, or no field name references another endpoint&apos;s entity. A leaf —
                  expected for widgets &amp; third-party feeds. We never invent edges.
                </div>
              </div>
            ) : (
              rels.map((r) => (
                <div key={`${r.from}-${r.to}-${r.via}-${r.kind}`} className="bb-net-df-rel">
                  <span className="bb-net-df-relname">
                    {r.from}{' '}
                    <span className="bb-net-df-relcard">
                      {r.kind === '1-1' ? '1 — 1' : '1 — *'}
                    </span>{' '}
                    {r.to}
                  </span>
                  <div className="bb-net-df-relsub">
                    via {r.via} · {r.confidence}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* ── pure helpers ──────────────────────────────────────────────────────────────────────────────── */

/** The entity's top-level fields: object root → its members; array root → the element's members. */
function topFields(root: InferredField): InferredField[] {
  if (root.children) return root.children
  if (root.elem?.children) return root.elem.children
  return []
}

function isIdLike(field: InferredField): boolean {
  return field.format === 'uuid' || /^id$/i.test(field.key) || /Id$/.test(field.key)
}

/** A compact type label for a field + whether it should render in the id/FK accent. Containers show an
 *  opener (`{ }` / `[ ]`) since their members render indented below; array-of-scalar shows `type[]`. */
function typeLabel(field: InferredField, fk: boolean): { text: string; idLike: boolean } {
  if (field.children) return { text: '{ }', idLike: false }
  if (field.elem) {
    if (field.elem.children) return { text: '[ ]', idLike: false }
    return { text: `${field.elem.types.join('|') || 'unknown'}[]`, idLike: false }
  }
  const base = field.types.join(' | ') || 'unknown'
  const text = field.format ? `${base} · ${field.format}` : base
  return { text, idLike: fk || isIdLike(field) }
}

/** Render a route template with dynamic segments in the accent color. */
function renderRoute(tpl: RouteTemplate): ReactElement[] {
  const segs = tpl.template.split('/').filter(Boolean)
  if (segs.length === 0) return [<span key="root">/</span>]
  const out: ReactElement[] = []
  segs.forEach((s, i) => {
    out.push(<span key={`sl${i}`}>/</span>)
    out.push(
      tpl.segKinds[i] && tpl.segKinds[i] !== 'static' ? (
        <span key={`s${i}`} className="bb-net-df-dyn">
          {s}
        </span>
      ) : (
        <span key={`s${i}`}>{s}</span>
      )
    )
  })
  return out
}

/** The last static path segment (the resource name) of a template. */
function lastStatic(tpl: RouteTemplate): string {
  const segs = tpl.template.split('/').filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) if (tpl.segKinds[i] === 'static') return segs[i]
  return segs[0] ?? 'root'
}

function singular(s: string): string {
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y'
  if (/s$/i.test(s) && s.length > 1) return s.slice(0, -1)
  return s
}
function pascalSingular(s: string): string {
  const w = singular(s)
  return w ? w[0].toUpperCase() + w.slice(1) : w
}
