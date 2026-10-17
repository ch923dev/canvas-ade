import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { useTerminalRuntimeStore } from './terminalRuntimeStore'
import { usePreviewStore } from './previewStore'
import { useAttentionStore } from './attentionStore'
import { useCanvasViewStore, type PaneSize } from './canvasViewStore'
import { buildBoardSnapshot } from './boardStatus'
import {
  installRoleSignalFeeds,
  useRoleSignalsStore,
  type RoleSignalsState
} from './roleSignalsStore'
import { isAgentTerminal } from '../lib/agentClassify'
import { visibleWorld } from '../../../shared/spatialGeometry'
import type { BoardContextFields, CanvasView } from '../../../shared/spatialTypes'
import type { CanvasViewport } from '../lib/boardSchema'

/** Warn once if the preload bridge is missing in Electron (vs silently in tests). */
let warnedMissingBridge = false

/** The board fields {@link boardContextFields} reads — every live `Board` satisfies it structurally. */
export interface BoardContextSource {
  id?: string
  type: string
  cwd?: string
  previewSourceId?: string
  dockedIn?: string
  sourceBoardId?: string
  /** Read ONLY by `isAgentTerminal`, which returns a boolean (D9) — never copied anywhere. */
  agentKind?: string
  launchCommand?: string
}

/** The ephemeral C9 signal maps {@link boardContextFields} reads (`roleSignalsStore`). */
export type RoleSignalsSnapshot = Pick<RoleSignalsState, 'ports' | 'callsPorts' | 'lastFocusedAt'>

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * The C1 context signals one board carries on the mirror — ONLY classified fields, each on its own
 * board type: a terminal's configured `cwd` + its swarm dock (`dockedIn`), a browser's driving
 * terminal (`previewSourceId`), a data-flow board's bound browser (`sourceBoardId`) — plus the C9
 * role signals (L11): a terminal's `agent` (set only when true) and detected `ports`, a browser's
 * `callsPorts` (D10), and any board's `lastFocusedAt`, read from `signals` (`roleSignalsStore`).
 * Pure. 🔒 D9: picked field by field — the launch line only ever reaches `isAgentTerminal`, which
 * returns a boolean; never `launchCommand`, `agentKind` or env. MAIN re-validates and clamps every
 * field (`boardRegistry.sanitizeContextFields`).
 */
export function boardContextFields(
  b: BoardContextSource,
  signals?: RoleSignalsSnapshot
): BoardContextFields {
  const out: BoardContextFields = {}
  const id = b.id
  if (b.type === 'terminal') {
    if (nonEmpty(b.cwd)) out.cwd = b.cwd
    if (nonEmpty(b.dockedIn)) out.dockedIn = b.dockedIn
    if (isAgentTerminal(b)) out.agent = true
    const ports = id !== undefined ? signals?.ports[id] : undefined
    if (ports && ports.length > 0) out.ports = [...ports]
  } else if (b.type === 'browser') {
    if (nonEmpty(b.previewSourceId)) out.previewSourceId = b.previewSourceId
    const calls = id !== undefined ? signals?.callsPorts[id] : undefined
    if (calls && calls.length > 0) out.callsPorts = [...calls]
  } else if (b.type === 'dataflow') {
    if (nonEmpty(b.sourceBoardId)) out.sourceBoardId = b.sourceBoardId
  }
  const focusedAt = id !== undefined ? signals?.lastFocusedAt[id] : undefined
  if (focusedAt !== undefined) out.lastFocusedAt = focusedAt
  return out
}

/**
 * Assemble the C1 `view` from the settled pane + camera (+ the device pixel ratio), or null while
 * either is unknown (no Canvas mounted / no camera frame yet) — the payload then omits `view` and
 * MAIN reports no screen. `visibleWorld` is derived from pane + camera (MAIN re-derives it after
 * sanitizing). Pure.
 */
export function buildCanvasView(
  pane: PaneSize | null,
  camera: CanvasViewport | null,
  dpr: number
): CanvasView | null {
  if (!pane || !camera) return null
  const cam = { x: camera.x, y: camera.y, zoom: camera.zoom }
  return {
    pane: { w: pane.w, h: pane.h },
    dpr,
    camera: cam,
    visibleWorld: visibleWorld(pane, cam)
  }
}

/**
 * Publish a board snapshot (id/type/title + derived status bucket, T1.1) to MAIN's
 * MCP board registry whenever the canvas OR a board's live runtime changes. The
 * status bucket is derived in the renderer (the only place that holds the live
 * `terminalRuntimeStore` + `previewStore` state) so the agent-facing
 * `canvas://boards` view and the on-canvas pill share one source of truth.
 *
 * Spatial awareness C1: each board also carries its context signals ({@link boardContextFields}),
 * and the payload carries the user's `view` (pane · dpr · settled camera · visible world) — session
 * state that rides this same debounce and is re-published when the camera SETTLES or the pane
 * resizes (`canvasViewStore`), never per frame.
 *
 * Debounced; control-plane metadata only (no board content — `previewStore` snapshots
 * etc. never leave the renderer). A no-op if the bridge is absent (e.g. a non-Electron
 * test runtime) — but if `window.api` exists yet `mcp.publishBoards` does not, the
 * preload bridge has regressed: warn once so a dropped bridge surfaces instead of
 * silently leaving the MAIN mirror (and `canvas://boards`) permanently empty.
 */
export function useMcpPublish(): void {
  const boards = useCanvasStore((s) => s.boards)
  // Orchestration connectors authorize agent-to-agent relay (T4.6); mirror them to MAIN
  // alongside boards so the dispatch adapter can resolve a relay edge. Subscribing
  // re-publishes when a cable is drawn/removed.
  const connectors = useCanvasStore((s) => s.connectors)
  // PR-5: mirror Named Board Groups (feature zones) to MAIN alongside boards/connectors so the
  // app self-model's `canvas.groups` goes live. Subscribing re-publishes when a group is
  // created/renamed/membership-changed.
  const groups = useCanvasStore((s) => s.groups)
  // Subscribe to the runtime slices so a liveness change (terminal start/exit, a
  // browser load/fail) re-publishes even when the durable `boards` array is unchanged.
  const running = useTerminalRuntimeStore((s) => s.running)
  const previewById = usePreviewStore((s) => s.byId)
  // Desktop-notifications P2: unseen attention shifts a board's bucket (needs-input →
  // awaiting-review, error → failed), so a set/clear must re-publish — MAIN's status differ
  // is what raises/settles the `canvas://attention` queue entry.
  const attention = useAttentionStore((s) => s.byId)
  // C1: the SETTLED view (pane resize · camera settle) — both change at settle cadence only.
  const pane = useCanvasViewStore((s) => s.pane)
  const camera = useCanvasViewStore((s) => s.camera)
  // C9 (L11): the ephemeral role signals — a change re-publishes through the same debounce. The
  // feeds (selection · board delete · terminal exit · the D10 preview event) are wired once here.
  const ports = useRoleSignalsStore((s) => s.ports)
  const callsPorts = useRoleSignalsStore((s) => s.callsPorts)
  const lastFocusedAt = useRoleSignalsStore((s) => s.lastFocusedAt)
  useEffect(() => installRoleSignalFeeds(), [])
  useEffect(() => {
    const publish = window.api?.mcp?.publishBoards
    if (!publish) {
      if (window.api && !warnedMissingBridge) {
        warnedMissingBridge = true
        // eslint-disable-next-line no-console -- intentional one-time regression warning
        console.error(
          'useMcpPublish: window.api.mcp.publishBoards missing — MCP board list will be empty'
        )
      }
      return
    }
    const t = setTimeout(() => {
      // buildBoardSnapshot maps 1:1 and in order, so entry i IS boards[i].
      const snapshot = buildBoardSnapshot(boards, { running, preview: previewById, attention })
      const view = buildCanvasView(pane, camera, window.devicePixelRatio || 1)
      const signals = { ports, callsPorts, lastFocusedAt }
      publish({
        boards: snapshot.map((entry, i) => ({
          ...entry,
          ...boardContextFields(boards[i], signals)
        })),
        connectors,
        groups,
        ...(view ? { view } : {})
      })
    }, 150)
    return () => clearTimeout(t)
  }, [
    boards,
    connectors,
    groups,
    running,
    previewById,
    attention,
    pane,
    camera,
    ports,
    callsPorts,
    lastFocusedAt
  ])
}
