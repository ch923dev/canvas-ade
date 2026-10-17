/**
 * Apply the SPATIAL MAIN → renderer MCP commands — `spawnGroup` (feature-zone cluster), `tidyBoards`
 * (whole-canvas reposition) and `focusCamera` (user viewport) — against `canvasStore`, returning the
 * ack. Split out of `useMcpCommands` (spatial awareness C5 pre-split, the `kanbanMcpApply` pattern) so
 * the Wave-3 lanes widen the spatial commands here without colliding in the general applier, which
 * routes these three types to {@link applySpatialMcpCommand} and nothing else.
 *
 * Same contract as every applier case: React-free (unit-testable directly), MAIN is the trust
 * boundary (frame-guarded control plane), and each command is RE-VALIDATED here as defense in depth
 * before anything lands — a malformed envelope acks `{ok:false}` and leaves the canvas untouched.
 */
import { useCanvasStore } from './canvasStore'
import { useCanvasViewStore } from './canvasViewStore'
import { requestCameraFocus } from './cameraRequestStore'
import { viewportCenterWorld } from '../lib/freeSlot'
import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'

/** The MCP commands this module applies (the C5 spatial set). */
export type SpatialMcpCommand = Extract<
  McpCommand,
  { type: 'spawnGroup' } | { type: 'tidyBoards' } | { type: 'focusCamera' }
>

/** Default anchor for an MCP-spawned board; `addBoard`'s free-slot search spreads collisions. */
export const SPAWN_ANCHOR = { x: 120, y: 120 } as const

/** Apply ONE spatial command (see {@link SpatialMcpCommand}) and return its ack. */
export function applySpatialMcpCommand(command: SpatialMcpCommand): McpCommandAck {
  switch (command.type) {
    case 'spawnGroup':
      return applySpawnGroup(command)
    case 'tidyBoards':
      return applyTidyBoards(command)
    case 'focusCamera':
      return applyFocusCamera(command)
  }
}

function applySpawnGroup(command: Extract<McpCommand, { type: 'spawnGroup' }>): McpCommandAck {
  // 🔒 PR-5b: create a feature-zone cluster (boards + Named Group + preview wiring) in one
  // undoable step. MAIN minted every id + clamped the name; the renderer re-validates the
  // envelope (defense in depth, mirroring addBoard) before it lands on the canvas.
  const { group, members } = command
  const validId = (m: { id?: unknown } | undefined): m is { id: string } =>
    m !== null && typeof m === 'object' && typeof m.id === 'string' && m.id.length > 0
  if (group === null || typeof group !== 'object' || !validId(group)) {
    return { ok: false, error: `invalid spawnGroup group: ${JSON.stringify(group)}` }
  }
  if (typeof group.name !== 'string' || group.name.length === 0) {
    return { ok: false, error: `invalid spawnGroup name: ${JSON.stringify(group.name)}` }
  }
  if (members === null || typeof members !== 'object' || !validId(members.terminal)) {
    return { ok: false, error: `invalid spawnGroup members: ${JSON.stringify(members)}` }
  }
  // Optional members, when present, must be well-formed (reject a malformed `{}` member rather
  // than silently dropping it — the agent should learn the spec was bad).
  if (members.planning !== undefined && !validId(members.planning)) {
    return { ok: false, error: `invalid spawnGroup planning member` }
  }
  if (members.browser !== undefined && !validId(members.browser)) {
    return { ok: false, error: `invalid spawnGroup browser member` }
  }
  // v20: the terminal member's OpenRouter intent must be well-shaped when present (defense
  // in depth, mirroring addBoard's check) — reject rather than land a malformed object.
  const or = members.terminal.openRouter
  if (
    or !== undefined &&
    (or === null ||
      typeof or !== 'object' ||
      typeof or.enabled !== 'boolean' ||
      (or.model !== undefined && typeof or.model !== 'string'))
  ) {
    return { ok: false, error: 'invalid spawnGroup terminal openRouter' }
  }
  // Idempotent by group id (mirrors addBoard): a re-delivered spawnGroup whose group already
  // exists is a no-op + ack ok, so it can't push a duplicate zone.
  const store = useCanvasStore.getState()
  if (store.groups.some((g) => g.id === group.id)) return { ok: true, type: 'spawnGroup' }
  // Land the zone where the USER is looking (the Command board is a user-driven dispatch, unlike
  // an agent's headless spawn). The viewport centre maps to a world point; freeSlot then nudges
  // it off the Command board sitting there, so the zone tucks in beside it IN VIEW — not at the
  // fixed canvas-origin anchor (which lands off-screen once the user has panned). BUG: off-screen
  // spawn reported 2026-06-18. Falls back to SPAWN_ANCHOR before the first fit (no viewport yet)
  // OR outside a DOM (the node-env unit tests, where `window` is absent).
  const at =
    typeof window === 'undefined'
      ? SPAWN_ANCHOR
      : viewportCenterWorld(
          store.viewport,
          { w: window.innerWidth, h: window.innerHeight },
          SPAWN_ANCHOR
        )
  store.spawnGroup({ at, group, members })
  return { ok: true, type: 'spawnGroup' }
}

function applyTidyBoards(command: Extract<McpCommand, { type: 'tidyBoards' }>): McpCommandAck {
  // 🔒 P2: reposition the WHOLE canvas via the existing deterministic packer. Reposition-only +
  // content-less — MAIN sends no geometry; the renderer's OWN `tidyBoards` action computes the
  // clean arrangement. Re-validate `mode` (defense in depth, mirroring spawnGroup): fall back to
  // 'smart' for an absent/off-enum value rather than trusting the IPC-crossed string.
  const raw = command.mode
  const mode = raw === 'smart' || raw === 'by-type' || raw === 'grid' ? raw : 'smart'
  // G1: pack toward the PANE aspect exactly like the UI's tidyAndFit (useTidyTile: w / max(1, h)),
  // read off the session-only view bus the mounted Canvas feeds. No pane (no Canvas mounted) ⇒
  // no aspect ⇒ the packer's own default, i.e. the pre-S0 behaviour.
  const pane = useCanvasViewStore.getState().pane
  const aspect = pane ? pane.w / Math.max(1, pane.h) : undefined
  // `tidyBoards` is ALREADY ONE undoable `trackedChange` step that no-ops when nothing moved — do
  // NOT wrap it in beginChange() (that's for the additive content writes). Snapshot positions
  // around the call so the ack can report how many boards actually moved (0 ⇒ already tidy).
  const store = useCanvasStore.getState()
  const before = new Map(store.boards.map((b) => [b.id, { x: b.x, y: b.y }]))
  store.tidyBoards(mode, aspect)
  let moved = 0
  for (const b of useCanvasStore.getState().boards) {
    const prev = before.get(b.id)
    if (prev && (prev.x !== b.x || prev.y !== b.y)) moved++
  }
  // G4: frame the camera on the result, like tidyAndFit's fitToBoards — through the SAME camera
  // path focusCamera uses (parked fit-all → useCameraFocusRequests → FIT_FRAME fit). Viewport-only:
  // no undo involvement, so the tidy stays ONE undo step.
  requestCameraFocus({ kind: 'all' })
  return { ok: true, type: 'tidyBoards', moved }
}

function applyFocusCamera(command: Extract<McpCommand, { type: 'focusCamera' }>): McpCommandAck {
  // 🔒 H1: move the USER'S VIEWPORT to a board / group / the whole canvas. Viewport-only +
  // content-less (the canvas doc is untouched — the camera is ephemeral session state), so no
  // beginChange/undo involvement at all. Re-validate the target (defense in depth, mirroring
  // tidyBoards) and resolve it against the LIVE store — an unknown id acks {ok:false} so the
  // agent learns the target is gone instead of the camera silently not moving. The fit itself
  // executes in the provider (useCameraFocusRequests) — this applier is React-free.
  const { boardId, groupId } = command
  if (
    (boardId !== undefined && (typeof boardId !== 'string' || boardId.length === 0)) ||
    (groupId !== undefined && (typeof groupId !== 'string' || groupId.length === 0))
  ) {
    return { ok: false, error: 'focusCamera: invalid target id' }
  }
  if (boardId !== undefined && groupId !== undefined) {
    return { ok: false, error: 'focusCamera: pass at most one of boardId / groupId' }
  }
  const store = useCanvasStore.getState()
  if (boardId !== undefined) {
    if (!store.boards.some((b) => b.id === boardId)) {
      return { ok: false, error: `focusCamera: board not found: ${boardId}` }
    }
    requestCameraFocus({ kind: 'board', id: boardId })
  } else if (groupId !== undefined) {
    const group = store.groups.find((g) => g.id === groupId)
    if (!group) return { ok: false, error: `focusCamera: group not found: ${groupId}` }
    if (group.boardIds.length === 0) {
      // Defensive: empty groups auto-prune, but a fit over zero members would no-op silently —
      // tell the agent instead.
      return { ok: false, error: `focusCamera: group has no members: ${groupId}` }
    }
    requestCameraFocus({ kind: 'group', id: groupId })
  } else {
    // Neither target ⇒ fit ALL boards (the palette's fitAll). An empty canvas still acks ok —
    // fitView no-ops gracefully; there is nothing misleading about "focused: all" on nothing.
    requestCameraFocus({ kind: 'all' })
  }
  return { ok: true, type: 'focusCamera' }
}
