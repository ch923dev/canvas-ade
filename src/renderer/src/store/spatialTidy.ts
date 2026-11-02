/**
 * The tidy ENGINE (spatial-awareness I2, SPEC C4 / C5 / C9 / C10) — ONE React-free entry point,
 * {@link runTidy}, shared by the MCP applier (`spatialMcpApply` `tidyBoards`, for agents and
 * Jarvis) and the UI (`useTidyTile`: the `t` key, the palette and the Tidy picker), so a tidy is
 * the same arrangement whoever asked for it.
 *
 * Per mode:
 *  - `fit`   → `fitLayout` (C4): Named Groups + derived contexts (C3) packed as units, shelf-packed
 *              toward the PANE aspect; positions only unless `overflow:'shrink'`.
 *  - `roles` → `deriveRoles` + `deriveContexts` + `buildRoleUnits` + `roleLayout` (C9 / C10), all
 *              four over the SAME `RoleInput` list (live C9 signals: `roleSignalsStore` ports /
 *              callsPorts / lastFocusedAt + `agentClassify`), the lead from `orchestrationStore`.
 *  - `tile`  → the tile presets (`tileLayout` over a pane-aspect area); resizes every board.
 *  - `smart` / `by-type` / `grid` → `tidyLayout`, unchanged.
 * Every arrangement lands through `canvasStore.applyLayout` — ONE undo step (none when nothing
 * changed), x/y always, w/h only where the engine sized a board. `fit !== false` then frames the
 * camera through the SAME bus `focusCamera` uses (`cameraRequestStore`).
 *
 * Everything is RE-VALIDATED here (defence in depth — MAIN validated too): the shared
 * `parseTidyArgs`, then every id against the LIVE store (unknown ⇒ error, docked ⇒ error).
 */
import { useCanvasStore, type CanvasState } from './canvasStore'
import { useCanvasViewStore } from './canvasViewStore'
import { useRoleSignalsStore } from './roleSignalsStore'
import { useOrchestrationStore } from './orchestrationStore'
import { requestCameraFocus, type CameraFocusTarget } from './cameraRequestStore'
import { boardContextFields } from './useMcpPublish'
import type { LayoutPlacement } from './slices/layoutSlice'
import { isDockedTerminal, type Board } from '../lib/boardSchema'
import { boardsBounds, type BoardRect } from '../lib/boardGeometry'
import { DEFAULT_ASPECT, tidyLayout } from '../lib/tidyLayout'
import { tileArea, tileLayout } from '../lib/tileLayout'
import { fitLayout, type FitUnit } from '../lib/fitLayout'
import { roleLayout } from '../lib/roleLayout'
import {
  buildRoleUnits,
  classifyScene,
  deriveRoles,
  type RoleBoardInput,
  type RoleUnit,
  type Scene
} from '../../../shared/boardRoles'
import {
  deriveContexts,
  type ContextBoardInput,
  type ContextConnectorInput,
  type DerivedContext
} from '../../../shared/deriveContexts'
import {
  READABLE_ZOOM,
  fitZoom,
  rectsIntersect,
  visibleWorld,
  type Rect
} from '../../../shared/spatialGeometry'
import {
  parseTidyArgs,
  type TidyArgs,
  type TidyArgsInput,
  type TidyScope
} from '../../../shared/tidyContract'

/** The pane assumed when no Canvas is mounted (node-env tests, the welcome screen): 16:10. */
export const FALLBACK_PANE = { w: 1600, h: 1000 } as const

/** One arranged unit (roles), with the names the W7 toast and the ack need. */
export interface TidyUnitInfo {
  key: string
  /** A human label: group name · context name · hub / board title. */
  name: string
  scene: Scene
  heroIds: string[]
  why: string
  boardIds: string[]
}

/** A successful run — the C6 ack facts plus what the UI feedback needs. */
export interface TidyRun {
  ok: true
  args: TidyArgs
  /** Boards that moved or resized (0 ⇒ already tidy; no undo step was recorded). */
  moved: number
  /** Boards arranged (the scope's size). */
  count: number
  fitZoom?: number
  readable?: boolean
  /** Page count, only when `overflow:'pages'` actually paged (> 1). */
  pages?: number
  /** Roles only: the stage first, then the off-stage units. */
  units?: TidyUnitInfo[]
}

export type TidyRunResult = TidyRun | { ok: false; error: string }

/** One board as every role / context engine reads it — ONE list for all four (the L10 rule). */
type RoleInput = RoleBoardInput & ContextBoardInput

interface Plan {
  placements: LayoutPlacement[]
  /** Where the camera goes when `fit !== false` (null ⇒ frame the arranged boards). */
  camera: CameraFocusTarget | null
  fitZoom?: number
  readable?: boolean
  pages?: number
  units?: TidyUnitInfo[]
}

const titleOf = (b: Board): string => (b.title && b.title.trim().length > 0 ? b.title : b.type)

function roleInputs(boards: readonly Board[]): RoleInput[] {
  const { ports, callsPorts, lastFocusedAt } = useRoleSignalsStore.getState()
  return boards.map((b) => {
    const fields = boardContextFields(b, { ports, callsPorts, lastFocusedAt })
    const input: RoleInput = {
      id: b.id,
      type: b.type,
      title: titleOf(b),
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      ...fields
    }
    if (b.type === 'file' && b.path) input.path = b.path
    if (b.type === 'planning') {
      const refs = b.elements.flatMap((e) => (e.kind === 'fileref' ? [{ path: e.path }] : []))
      if (refs.length > 0) input.fileRefs = refs
    }
    return input
  })
}

/** The camera-framing rect of the given boards AFTER the arrangement (or null for none). */
function rectOf(boards: readonly BoardRect[]): Rect | null {
  const bb = boardsBounds([...boards])
  return bb ? { x: bb.minX, y: bb.minY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY } : null
}

/** Resolve `scope` to the arranged board ids (null ⇒ the whole canvas), or an error string. */
function resolveScope(
  scope: TidyScope | undefined,
  st: CanvasState,
  canvasIds: ReadonlySet<string>,
  pane: { w: number; h: number }
): Set<string> | null | string {
  if (scope === undefined || scope === 'all') return null
  if (scope === 'visible') {
    const camera = useCanvasViewStore.getState().camera ?? st.viewport
    if (!camera) return 'scope "visible" needs a canvas view (no camera yet)'
    const view = visibleWorld(pane, camera)
    return new Set(
      st.boards.filter((b) => canvasIds.has(b.id) && rectsIntersect(view, b)).map((b) => b.id)
    )
  }
  if ('groupId' in scope) {
    const group = st.groups.find((g) => g.id === scope.groupId)
    if (!group) return `group not found: ${scope.groupId}`
    return new Set(group.boardIds.filter((id) => canvasIds.has(id)))
  }
  const docked = new Set(st.boards.filter(isDockedTerminal).map((b) => b.id))
  for (const id of scope.boardIds) {
    if (docked.has(id)) return `board is docked in a swarm board: ${id}`
    if (!canvasIds.has(id)) return `board not found: ${id}`
  }
  return new Set(scope.boardIds)
}

/** C4 units: every Named Group, plus each derived context that is not already a group. */
function fitUnits(st: CanvasState, contexts: readonly DerivedContext[]): FitUnit[] {
  return [
    ...st.groups.map((g) => ({ id: `group:${g.id}`, boardIds: [...g.boardIds] })),
    ...contexts
      .filter((c) => c.existingGroupId === undefined)
      .map((c) => ({ id: `context:${c.key}`, boardIds: [...c.boardIds] }))
  ]
}

function contextsOf(st: CanvasState, inputs: readonly RoleInput[]): DerivedContext[] {
  const connectors: ContextConnectorInput[] = st.connectors.map((c) => ({
    sourceId: c.sourceId,
    targetId: c.targetId,
    kind: c.kind
  }))
  return deriveContexts(inputs, connectors, st.groups)
}

/** A role unit's human label (W7): group / context name, else its hub or board title. */
function unitName(
  key: string,
  st: CanvasState,
  contexts: readonly DerivedContext[],
  titles: ReadonlyMap<string, string>
): string {
  const k = key.replace(/\++$/, '')
  const group = st.groups.find((g) => g.id === k)
  if (group) return group.name
  const ctx = contexts.find((c) => c.key === k)
  if (ctx) return ctx.suggestedName
  const id = k.replace(/^(team|single):/, '')
  return titles.get(id) ?? 'boards'
}

/**
 * MAIN + SIDEBAR (`primary`; I2 dev-check amendment 2026-11-02 — the tiling-WM "promote to master"
 * model, docs/research/2026-11-02-main-sidebar-intent): EVERY in-scope board joins ONE unit whose
 * hero is the main board, so roleLayout lays it out as `hero-rail` (sidebar right, wide pane) or
 * `hero-strip` (bottom, tall pane). Groups and contexts do not split it — "make X the main one"
 * means the rest of the canvas is X's sidebar, not X alone on stage with everything off-screen.
 */
function mainUnit(
  primary: string,
  st: CanvasState,
  scoped: Set<string> | null,
  roles: ReturnType<typeof deriveRoles>,
  inputs: RoleInput[]
): RoleUnit[] {
  const ids = st.boards
    .filter((b) => !isDockedTerminal(b) && (scoped === null || scoped.has(b.id)))
    .map((b) => b.id)
    .sort()
  return [
    {
      key: `main:${primary}`,
      boardIds: ids,
      source: 'group',
      ...classifyScene(ids, inputs, roles)
    }
  ]
}

function planRoles(
  args: TidyArgs,
  st: CanvasState,
  scoped: Set<string> | null,
  pane: { w: number; h: number }
): Plan {
  const inputs = roleInputs(st.boards)
  const connectors: ContextConnectorInput[] = st.connectors.map((c) => ({
    sourceId: c.sourceId,
    targetId: c.targetId,
    kind: c.kind
  }))
  const leadBoardId = useOrchestrationStore.getState().leadBoardId
  const roles = deriveRoles(inputs, connectors, { leadBoardId })
  const contexts = deriveContexts(inputs, connectors, st.groups)
  const units = args.primary
    ? mainUnit(args.primary, st, scoped, roles, inputs)
    : buildRoleUnits(inputs, connectors, st.groups, contexts, roles)
  const titleMap = new Map(st.boards.map((b) => [b.id, titleOf(b)]))
  const res = roleLayout(inputs, roles, units, {
    pane,
    primary: args.primary,
    side: args.side,
    scope: scoped ? { boardIds: [...scoped] } : 'all',
    overflow: args.overflow,
    resize: args.resize,
    implicit: args.implicit,
    selectedIds: st.selectedIds,
    titles: Object.fromEntries(titleMap)
  })
  return {
    placements: res.placements,
    camera: { kind: 'viewport', viewport: res.camera },
    fitZoom: res.targetZoom,
    readable: res.readable,
    ...(res.pages && res.pages.length > 1 ? { pages: res.pages.length } : {}),
    units: res.units.map((u) => ({
      key: u.key,
      name: unitName(u.key, st, contexts, titleMap),
      scene: u.scene,
      heroIds: [...u.heroIds],
      why: u.why,
      boardIds: [...u.boardIds]
    }))
  }
}

function planFor(
  args: TidyArgs,
  st: CanvasState,
  targets: readonly Board[],
  scoped: Set<string> | null,
  pane: { w: number; h: number }
): Plan {
  const aspect = pane.w / Math.max(1, pane.h)
  switch (args.mode) {
    case 'roles':
      return planRoles(args, st, scoped, pane)
    case 'fit': {
      const units = fitUnits(st, contextsOf(st, roleInputs(st.boards)))
      const res = fitLayout(targets, { pane, units, overflow: args.overflow })
      const camera: CameraFocusTarget | null = res.pages
        ? { kind: 'rect', rect: res.pages[0].bbox }
        : null
      return {
        placements: res.placements,
        camera,
        fitZoom: res.fitZoom,
        readable: res.readable,
        ...(res.pages && res.pages.length > 1 ? { pages: res.pages.length } : {})
      }
    }
    case 'tile': {
      const area = tileArea([...targets], Number.isFinite(aspect) ? aspect : DEFAULT_ASPECT)
      const rects = area ? tileLayout(targets, args.template ?? 'grid', area) : []
      return { placements: rects, camera: null }
    }
    default:
      return { placements: tidyLayout(targets, { mode: args.mode, aspect }), camera: null }
  }
}

/**
 * Run ONE tidy (see the module header). `raw` is the C5 argument shape — an omitted `mode` is the
 * implicit `roles` default (D8 a). Returns the C6 facts on success, or the reason it refused (the
 * canvas is then untouched).
 */
export function runTidy(raw: TidyArgsInput): TidyRunResult {
  const parsed = parseTidyArgs(raw)
  if (!parsed.ok) return { ok: false, error: `tidyBoards: ${parsed.error}` }
  const args = parsed.args
  const st = useCanvasStore.getState()
  const viewPane = useCanvasViewStore.getState().pane
  const pane = viewPane && viewPane.w > 0 && viewPane.h > 0 ? viewPane : FALLBACK_PANE
  const canvas = st.boards.filter((b) => !isDockedTerminal(b))
  const canvasIds = new Set(canvas.map((b) => b.id))

  const scoped = resolveScope(args.scope, st, canvasIds, pane)
  if (typeof scoped === 'string') return { ok: false, error: `tidyBoards: ${scoped}` }
  if (args.primary !== undefined) {
    if (!canvasIds.has(args.primary)) {
      return { ok: false, error: `tidyBoards: primary is not a canvas board: ${args.primary}` }
    }
    if (scoped && !scoped.has(args.primary)) {
      return { ok: false, error: `tidyBoards: primary is outside the tidy scope: ${args.primary}` }
    }
  }
  const targets = scoped ? canvas.filter((b) => scoped.has(b.id)) : canvas
  if (targets.length === 0) return { ok: true, args, moved: 0, count: 0 }

  const plan = planFor(args, st, targets, scoped, pane)
  const moved = useCanvasStore.getState().applyLayout(plan.placements)

  const after = useCanvasStore
    .getState()
    .boards.filter((b) => scoped?.has(b.id) ?? canvasIds.has(b.id))
  const bbox = rectOf(after)
  const zoom = plan.fitZoom ?? (bbox ? fitZoom(bbox, pane) : undefined)
  if (args.fit !== false) {
    const target = plan.camera ?? (bbox ? { kind: 'rect' as const, rect: bbox } : null)
    if (target) requestCameraFocus(target)
  }
  return {
    ok: true,
    args,
    moved,
    count: targets.length,
    ...(zoom !== undefined ? { fitZoom: zoom } : {}),
    readable: plan.readable ?? (zoom !== undefined ? zoom >= READABLE_ZOOM : true),
    ...(plan.pages !== undefined ? { pages: plan.pages } : {}),
    ...(plan.units ? { units: plan.units } : {})
  }
}
