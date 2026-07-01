/**
 * Data-Flow board content (JD-4) — the dedicated board that visualizes a Browser board's captured API
 * surface: endpoint inventory → inferred schemas → entities → id-lineage, as a focus-on-node graph (or
 * a sequence layout). Idempotent regenerate + diff-highlight; "→ Planning" materializes the inferred ER
 * as an editable Mermaid diagram. (The shape-only "Agent context" → `.canvas/memory/` export is deferred
 * to a follow-up — ADR 0010 §B makes it a consent-gated MAIN write, not a clipboard egress.)
 *
 * Data source: the bound Browser board's (`sourceBoardId`) `osrNetworkStore` capture, watched via the
 * refcounted `useSharedOsrNet`. The inferred model is derived live (pure libs) and held EPHEMERALLY —
 * nothing here is serialized (ADR 0010; only `sourceBoardId` persists). Privacy: the inventory + graph
 * are body-free; schema/lineage are opt-in (the source board's "infer shapes" gate); the only value
 * read (id-lineage) is MAIN-side + value-less over IPC. Page strings are React-escaped (no innerHTML).
 */
import { useEffect, useMemo, useCallback, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type {
  Board,
  DataFlowBoard as DataFlowBoardData,
  DiagramElement
} from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { useOsrNetworkStore, type SchemaState } from '../../store/osrNetworkStore'
import { useDataFlowStore } from '../../store/dataFlowStore'
import { useToastStore } from '../../store/toastStore'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { groupByTemplate, type RouteTemplate, type TemplateGroup } from '../../lib/routeTemplate'
import { mergeShapes } from '../../lib/schemaInfer'
import { inferEntities, type EntityModel } from '../../lib/entityInfer'
import {
  urlSideLineage,
  liftEdgesToTemplates,
  mergeLineage,
  type RequestLineageEdge
} from '../../lib/lineage'
import { buildGraph, focusSubgraph, diffGraphs } from '../../lib/dataFlowGraph'
import { filterNetRecords, urlDomain } from '../../lib/netFilter'
import { layoutGraph } from '../../lib/graphLayout'
import { toErMermaid, erDiagramSize } from '../../lib/erMermaid'
import { useSharedOsrNet } from './osr/useSharedOsrNet'
import { GraphCanvas, SequenceView } from './osr/DataFlowGraphView'
import { DataFlowInspector } from './dataflow/DataFlowInspector'
import { useInspectorSlot } from '../inspector/inspectorSlotStore'

const NO_RECORDS: never[] = []
const NO_SCHEMAS: Record<string, SchemaState> = {}
const SAMPLE_CAP = 20

/** The last static path segment (the resource name) of a template — names the route's entity. */
function lastStatic(tpl: RouteTemplate): string {
  const segs = tpl.template.split('/').filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) if (tpl.segKinds[i] === 'static') return segs[i]
  return segs[0] ?? 'root'
}
function entityInputs(
  groups: TemplateGroup[],
  schemas: Record<string, SchemaState>
): Parameters<typeof inferEntities>[0] {
  return groups
    .map((g) => {
      const st = schemas[g.key]
      return st && 'schema' in st
        ? { key: g.key, routeName: lastStatic(g.tpl), method: g.tpl.method, schema: st.schema }
        : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

export function DataFlowBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onRemoveFromAllGroups,
  onStartConnect
}: BoardViewProps<DataFlowBoardData>): ReactElement {
  const sourceId = board.sourceBoardId
  useSharedOsrNet(sourceId, !!sourceId) // refcounted: watch the source board's capture while mounted

  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const addBoard = useCanvasStore((s) => s.addBoard)
  // Board Inspector slot (P2): non-null only while THIS board is the single eligible selection.
  const inspectorSlot = useInspectorSlot(board.id)
  // Stable fingerprint of the bindable Browser boards (id+title only — not position, so a drag never
  // re-renders this subtree). Parsed into options below.
  const browserKey = useCanvasStore((s) =>
    JSON.stringify(s.boards.filter((b) => b.type === 'browser').map((b) => [b.id, b.title]))
  )
  const browsers = useMemo<{ id: string; title: string }[]>(
    () => (JSON.parse(browserKey) as [string, string][]).map(([id, title]) => ({ id, title })),
    [browserKey]
  )
  // The bound Browser board's registrable domain — drives the first-party filter (primitive ⇒ stable).
  const sourceDomain = useCanvasStore((s) => {
    const b = sourceId ? s.boards.find((x) => x.id === sourceId) : undefined
    return b && b.type === 'browser' ? urlDomain(b.url) : undefined
  })

  const net = useOsrNetworkStore((s) => (sourceId ? s.byBoard[sourceId] : undefined))
  const setInferShapes = useOsrNetworkStore((s) => s.setInferShapes)
  const setSchema = useOsrNetworkStore((s) => s.setSchema)

  const view = useDataFlowStore((s) => s.byBoard[board.id])
  const setTab = useDataFlowStore((s) => s.setTab)
  const setFocus = useDataFlowStore((s) => s.setFocus)
  const setBaseline = useDataFlowStore((s) => s.setBaseline)
  const setBodyLineage = useDataFlowStore((s) => s.setBodyLineage)
  const setApiOnly = useDataFlowStore((s) => s.setApiOnly)
  const setFirstParty = useDataFlowStore((s) => s.setFirstParty)
  useEffect(() => () => useDataFlowStore.getState().clear(board.id), [board.id])

  const allRecords = net?.records ?? NO_RECORDS
  const inferShapes = net?.inferShapes ?? false
  const schemas = net?.schemas ?? NO_SCHEMAS
  // Stable locals (the React Compiler can't preserve a useMemo over an optional-chained dep).
  const bodyLineage = view?.bodyLineage
  const baseline = view?.baseline
  const apiOnly = view?.apiOnly ?? true // noise filters default ON — a raw production capture is mostly
  const firstParty = view?.firstParty ?? true // assets + third-party beacons; show "just my app" first.

  // Screen out asset/document + third-party noise BEFORE templating (the JD-4 production-data fix).
  const records = useMemo(
    () => filterNetRecords(allRecords, { apiOnly, firstParty, firstPartyDomain: sourceDomain }),
    [allRecords, apiOnly, firstParty, sourceDomain]
  )
  const hiddenCount = allRecords.length - records.length

  const groups = useMemo(() => groupByTemplate(records), [records])
  const model: EntityModel = useMemo(
    () => inferEntities(entityInputs(groups, schemas)),
    [groups, schemas]
  )
  const lineage = useMemo(() => {
    const url = urlSideLineage(records)
    const body = bodyLineage ? liftEdgesToTemplates(bodyLineage, records) : []
    return mergeLineage(body, url)
  }, [records, bodyLineage])
  const graph = useMemo(() => buildGraph(groups, model, lineage), [groups, model, lineage])
  const layout = useMemo(() => layoutGraph(graph), [graph])
  const diff = useMemo(() => diffGraphs(baseline, graph), [baseline, graph])

  const tab = view?.tab ?? 'graph'
  // Default focus = the busiest endpoint that maps to an inferred entity (so the focus subgraph shows a
  // route + its entity + any lineage), falling back to the busiest endpoint overall (flat API).
  const defaultFocus = useMemo(() => {
    const producing = new Set(model.entities.flatMap((e) => [...e.producedBy, ...e.consumedBy]))
    const pool = groups.filter((g) => producing.has(g.key))
    const pick = (pool.length ? pool : groups).reduce<TemplateGroup | undefined>(
      (a, b) => (b.calls > (a?.calls ?? -1) ? b : a),
      undefined
    )
    return pick?.key
  }, [groups, model])
  const focusId = view?.focusId ?? defaultFocus
  const bright = useMemo(() => focusSubgraph(graph, focusId), [graph, focusId])

  const filled = groups.filter((g) => {
    const st = schemas[g.key]
    return st && 'schema' in st
  }).length
  const flat =
    inferShapes && filled >= 2 && model.relationships.length === 0 && lineage.length === 0
  const totalCalls = groups.reduce((n, g) => n + g.calls, 0)

  // ── handlers ──────────────────────────────────────────────────────────────────────────────────
  const sampleAll = useCallback(async () => {
    if (!sourceId) return
    for (const g of groups) {
      const ids = g.records
        .filter((r) => r.type !== 'websocket')
        .slice(-SAMPLE_CAP)
        .map((r) => r.requestId)
      if (ids.length === 0) continue
      const res = await window.api.sampleOsrNetSchema(sourceId, ids)
      if (res?.samples) {
        setSchema(sourceId, g.key, {
          schema: mergeShapes(res.samples),
          sampled: res.sampled ?? 0,
          requested: res.requested ?? ids.length
        })
      } else if (res?.error) {
        setSchema(sourceId, g.key, { error: res.error })
      }
    }
    const lin = await window.api.lineageOsrNet(sourceId)
    if (lin?.edges) setBodyLineage(board.id, lin.edges as RequestLineageEdge[])
  }, [sourceId, groups, setSchema, setBodyLineage, board.id])

  const regenerate = useCallback(() => {
    setBaseline(board.id, graph) // snapshot the current graph as the diff baseline ("since last run")
    if (inferShapes) void sampleAll()
  }, [board.id, graph, inferShapes, sampleAll, setBaseline])

  const toggleInfer = useCallback(() => {
    if (!sourceId) return
    const next = !inferShapes
    setInferShapes(sourceId, next)
    if (next) void sampleAll()
  }, [sourceId, inferShapes, setInferShapes, sampleAll])

  const exportPlanning = useCallback(() => {
    if (!model.entities.some((e) => e.kind === 'entity')) {
      useToastStore
        .getState()
        .showToast({ message: 'No entities to sketch yet — infer shapes first.', kind: 'info' })
      return
    }
    // Size the diagram element + its host board to the model so a production-scale ER isn't crushed into
    // the default thumbnail (the readability fix — the SVG scales to fill via object-fit).
    const { w: dw, h: dh } = erDiagramSize(model)
    const planId = addBoard('planning', { x: board.x + board.w + 48, y: board.y })
    const el: DiagramElement = {
      id: crypto.randomUUID(),
      kind: 'diagram',
      x: 24,
      y: 24,
      w: dw,
      h: dh,
      source: toErMermaid(model),
      engine: 'mermaid'
    }
    updateBoard(planId, { elements: [el], w: dw + 48, h: dh + 48 } as Partial<Board>)
    useToastStore
      .getState()
      .showToast({ message: 'Data model sketched to a Planning board.', kind: 'ok' })
  }, [model, addBoard, updateBoard, board.x, board.y, board.w])

  // NB: the "Agent context" export (the shape-only model → `.canvas/memory/`) is deferred. ADR 0010 §B
  // makes it JD-4's consent moment: it MUST go through a consent dialog + a MAIN-side scrubbed write to
  // `.canvas/memory/<ts>-dataflow-context.md` — NOT a clipboard egress (no consent, wrong destination).
  // Rather than ship a divergent clipboard stub, the button is omitted until the proper consent + MAIN
  // write path lands (the "→ Planning" in-app ER export is the export shipping in this slice).

  // ── body states ───────────────────────────────────────────────────────────────────────────────
  let body: ReactElement
  if (!sourceId) {
    body = (
      <div className="df-empty">
        <div className="df-empty-h">Bind a Browser board</div>
        <div className="df-empty-d">
          Pick the Browser board whose API surface this board should map. Its captured traffic is
          analyzed body-free; schema &amp; lineage inference is opt-in.
        </div>
        {browsers.length === 0 ? (
          <div className="df-empty-note">No Browser boards on the canvas yet.</div>
        ) : (
          <div className="df-bind-row">
            {browsers.map((b) => (
              <button
                key={b.id}
                className="df-bind-btn"
                onClick={() => updateBoard(board.id, { sourceBoardId: b.id } as Partial<Board>)}
              >
                {b.title}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  } else if (allRecords.length === 0) {
    body = (
      <div className="df-empty">
        <div className="df-empty-h">No captures yet</div>
        <div className="df-empty-d">
          Interact with the bound Browser board to capture its requests, then they map here
          automatically.
        </div>
        <button className="df-btn" onClick={regenerate}>
          ⟳ Regenerate
        </button>
      </div>
    )
  } else {
    body = (
      <>
        <div className="df-bar">
          <div className="df-tabs" role="tablist">
            <button
              className={'df-tab' + (tab === 'graph' ? ' df-on' : '')}
              role="tab"
              aria-selected={tab === 'graph'}
              onClick={() => setTab(board.id, 'graph')}
            >
              ⟲ Graph
            </button>
            <button
              className={'df-tab' + (tab === 'sequence' ? ' df-on' : '')}
              role="tab"
              aria-selected={tab === 'sequence'}
              onClick={() => setTab(board.id, 'sequence')}
            >
              ⇉ Sequence
            </button>
          </div>
          <button
            className={'df-optin' + (inferShapes ? ' df-on' : '')}
            role="checkbox"
            aria-checked={inferShapes}
            onClick={toggleInfer}
            title="Infer data shapes (reads response bodies, in the main process, capped)"
          >
            <span className="df-box">{inferShapes && '✓'}</span> Infer shapes
          </button>
          <button
            className={'df-optin' + (apiOnly ? ' df-on' : '')}
            role="checkbox"
            aria-checked={apiOnly}
            onClick={() => setApiOnly(board.id, !apiOnly)}
            title="Show only data calls (fetch/xhr/websocket) — hide scripts, styles, images, fonts, documents"
          >
            <span className="df-box">{apiOnly && '✓'}</span> API only
          </button>
          <button
            className={'df-optin' + (firstParty ? ' df-on' : '')}
            role="checkbox"
            aria-checked={firstParty}
            disabled={!sourceDomain}
            onClick={() => setFirstParty(board.id, !firstParty)}
            title={
              sourceDomain
                ? `Show only ${sourceDomain} — hide third-party origins (analytics, CDNs, widgets)`
                : 'First-party filter needs the bound board URL'
            }
          >
            <span className="df-box">{firstParty && '✓'}</span> First-party
          </button>
          {hiddenCount > 0 && (
            <span className="df-hidden" title="Records hidden by the active filters">
              hidden {hiddenCount}
            </span>
          )}
          {(diff.added.size > 0 || diff.changed.size > 0) && (
            <span className="df-diffchip">
              {diff.added.size > 0 && <>+{diff.added.size} new</>}
              {diff.added.size > 0 && diff.changed.size > 0 && ' · '}
              {diff.changed.size > 0 && <>{diff.changed.size} changed</>}
              <span className="df-dim-txt"> · since last run</span>
            </span>
          )}
          <span className="df-spacer" />
          <button
            className="df-btn"
            onClick={regenerate}
            title="Re-run inference over fresh captures"
          >
            ⟳ Regenerate
          </button>
          <button className="df-btn df-primary" onClick={exportPlanning}>
            → Planning
          </button>
        </div>

        {flat && (
          <div className="df-banner" role="status">
            <b>Flat API</b> — no relationships between endpoints found across {totalCalls} calls.
            Inventory and inferred schemas are still shown; we never invent edges.
          </div>
        )}

        <div className="df-body">
          {groups.length === 0 ? (
            <div className="df-empty">
              <div className="df-empty-h">Everything&apos;s filtered out</div>
              <div className="df-empty-d">
                {hiddenCount} record{hiddenCount === 1 ? '' : 's'} hidden by the API-only /
                first-party filters. Turn one off above to widen the view.
              </div>
            </div>
          ) : tab === 'graph' ? (
            <GraphCanvas
              layout={layout}
              edges={graph.edges}
              bright={bright}
              diff={diff}
              focusId={focusId}
              onFocus={(id) => setFocus(board.id, id === focusId ? undefined : id)}
            />
          ) : (
            <SequenceView groups={groups} lineage={lineage} />
          )}
        </div>

        <div className="df-legend">
          <span className="df-lg df-lg-call">— call</span>
          <span className="df-lg df-lg-ret">— returns</span>
          <span className="df-lg df-lg-lin">┄ id-lineage</span>
          <span className="df-spacer" />
          <span className="df-legend-meta">
            {focusId ? 'focus subgraph' : 'full surface'} · {groups.length} routes ·{' '}
            {lineage.length} lineage · {inferShapes ? 'values scrubbed' : 'bodies off'}
          </span>
        </div>
      </>
    )
  }

  return (
    <>
      {inspectorSlot &&
        createPortal(
          <DataFlowInspector
            browsers={browsers}
            sourceId={sourceId}
            sourceTitle={browsers.find((b) => b.id === sourceId)?.title}
            onBindSource={(id) => updateBoard(board.id, { sourceBoardId: id } as Partial<Board>)}
            hasRecords={allRecords.length > 0}
            routeCount={groups.length}
            lineageCount={lineage.length}
            tab={tab}
            onTab={(t) => setTab(board.id, t)}
            inferShapes={inferShapes}
            onToggleInfer={toggleInfer}
            apiOnly={apiOnly}
            onSetApiOnly={(next) => setApiOnly(board.id, next)}
            firstParty={firstParty}
            onSetFirstParty={(next) => setFirstParty(board.id, next)}
            firstPartyAvailable={!!sourceDomain}
            hiddenCount={hiddenCount}
            diffAdded={diff.added.size}
            diffChanged={diff.changed.size}
            onRegenerate={regenerate}
            onExportPlanning={exportPlanning}
          />,
          inspectorSlot
        )}
      <BoardFrame
        type={board.type}
        boardId={board.id}
        title={board.title}
        selected={selected}
        hovered={hovered}
        dimmed={dimmed}
        onFull={onFull}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onAddToGroup={onAddToGroup}
        onRemoveFromGroup={onRemoveFromGroup}
        onRemoveFromAllGroups={onRemoveFromAllGroups}
        onStartConnect={onStartConnect}
      >
        <div className="df-root">{body}</div>
      </BoardFrame>
    </>
  )
}
