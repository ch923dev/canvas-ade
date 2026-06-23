/**
 * Data-Flow board content (JD-4) — the dedicated board that visualizes a Browser board's captured API
 * surface: endpoint inventory → inferred schemas → entities → id-lineage, as a focus-on-node graph (or
 * a sequence layout). Idempotent regenerate + diff-highlight; "→ Planning" materializes the inferred ER
 * as an editable Mermaid diagram; "Agent context" exports the structure-only model.
 *
 * Data source: the bound Browser board's (`sourceBoardId`) `osrNetworkStore` capture, watched via the
 * refcounted `useSharedOsrNet`. The inferred model is derived live (pure libs) and held EPHEMERALLY —
 * nothing here is serialized (ADR 0010; only `sourceBoardId` persists). Privacy: the inventory + graph
 * are body-free; schema/lineage are opt-in (the source board's "infer shapes" gate); the only value
 * read (id-lineage) is MAIN-side + value-less over IPC. Page strings are React-escaped (no innerHTML).
 */
import { useEffect, useMemo, useCallback, type ReactElement } from 'react'
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
import { layoutGraph } from '../../lib/graphLayout'
import { toErMermaid } from '../../lib/erMermaid'
import { DIAGRAM_SIZE } from './planning/elements'
import { useSharedOsrNet } from './osr/useSharedOsrNet'
import { GraphCanvas, SequenceView } from './osr/DataFlowGraphView'

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
  // Stable fingerprint of the bindable Browser boards (id+title only — not position, so a drag never
  // re-renders this subtree). Parsed into options below.
  const browserKey = useCanvasStore((s) =>
    JSON.stringify(s.boards.filter((b) => b.type === 'browser').map((b) => [b.id, b.title]))
  )
  const browsers = useMemo<{ id: string; title: string }[]>(
    () => (JSON.parse(browserKey) as [string, string][]).map(([id, title]) => ({ id, title })),
    [browserKey]
  )

  const net = useOsrNetworkStore((s) => (sourceId ? s.byBoard[sourceId] : undefined))
  const setInferShapes = useOsrNetworkStore((s) => s.setInferShapes)
  const setSchema = useOsrNetworkStore((s) => s.setSchema)

  const view = useDataFlowStore((s) => s.byBoard[board.id])
  const setTab = useDataFlowStore((s) => s.setTab)
  const setFocus = useDataFlowStore((s) => s.setFocus)
  const setBaseline = useDataFlowStore((s) => s.setBaseline)
  const setBodyLineage = useDataFlowStore((s) => s.setBodyLineage)
  useEffect(() => () => useDataFlowStore.getState().clear(board.id), [board.id])

  const records = net?.records ?? NO_RECORDS
  const inferShapes = net?.inferShapes ?? false
  const schemas = net?.schemas ?? NO_SCHEMAS
  // Stable locals (the React Compiler can't preserve a useMemo over an optional-chained dep).
  const bodyLineage = view?.bodyLineage
  const baseline = view?.baseline

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
  const busiest = useMemo(
    () =>
      groups.reduce<TemplateGroup | undefined>(
        (a, b) => (b.calls > (a?.calls ?? -1) ? b : a),
        undefined
      ),
    [groups]
  )
  const focusId = view?.focusId ?? busiest?.key
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
    const planId = addBoard('planning', { x: board.x + board.w + 48, y: board.y })
    const el: DiagramElement = {
      id: crypto.randomUUID(),
      kind: 'diagram',
      x: 24,
      y: 24,
      w: DIAGRAM_SIZE.w,
      h: DIAGRAM_SIZE.h,
      source: toErMermaid(model),
      engine: 'mermaid'
    }
    updateBoard(planId, { elements: [el] } as Partial<Board>)
    useToastStore
      .getState()
      .showToast({ message: 'Data model sketched to a Planning board.', kind: 'ok' })
  }, [model, addBoard, updateBoard, board.x, board.y, board.w])

  const exportAgentContext = useCallback(async () => {
    // Structure-only digest (names + types + relationships — no values). The model is already
    // value-less; Task-6 routes this through the MAIN scrub + a .canvas/memory write (the consent
    // moment). For now it lands on the clipboard — value-free, so safe without a MAIN scrub.
    const lines = ['# Inferred data model', '']
    for (const e of model.entities.filter((x) => x.kind === 'entity')) {
      lines.push(`## ${e.name}${e.pk ? ` (pk: ${e.pk})` : ''}`)
      for (const f of e.fields) lines.push(`- ${f.key}`)
    }
    for (const r of model.relationships)
      lines.push(`- ${r.from} —${r.kind}→ ${r.to} (via ${r.via})`)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      useToastStore
        .getState()
        .showToast({ message: 'Data model copied (structure only).', kind: 'ok' })
    } catch {
      useToastStore.getState().showToast({ message: 'Could not copy to clipboard.', kind: 'error' })
    }
  }, [model])

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
  } else if (records.length === 0) {
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
          <button className="df-btn" onClick={exportAgentContext}>
            ✦ Agent context
          </button>
        </div>

        {flat && (
          <div className="df-banner" role="status">
            <b>Flat API</b> — no relationships between endpoints found across {totalCalls} calls.
            Inventory and inferred schemas are still shown; we never invent edges.
          </div>
        )}

        <div className="df-body">
          {tab === 'graph' ? (
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
  )
}
