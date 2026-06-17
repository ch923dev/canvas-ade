import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { assertPlanningElement, type BoardType, type PlanningElement } from '../lib/boardSchema'
import { viewportCenterWorld } from '../lib/freeSlot'
import {
  materializePlanningOps,
  neededBoardHeight,
  MAX_PLANNING_BOARD_ELEMENTS,
  type PlanningOp
} from './planningMcpApply'

/**
 * Renderer mirror of MAIN's `McpCommand` union (`src/main/mcpCommand.ts`) — kept in
 * sync BY HAND (the two live in separate bundles). MAIN posts these; this module
 * applies them to `canvasStore` and acks.
 */
export type McpCommandIn =
  | { type: 'ping' }
  | { type: 'addBoard'; board: { id: string; type: BoardType } }
  | { type: 'removeBoard'; id: string }
  | {
      type: 'configureBoard'
      id: string
      patch: { shell?: string; launchCommand?: string; cwd?: string }
    }
  | { type: 'patchPlanning'; id: string; ops: PlanningOp[] }
  | {
      type: 'spawnGroup'
      group: { id: string; name: string }
      members: {
        // Phase C: the terminal may boot an agentic CLI (MAIN-sanitized) so a dispatched prompt
        // reaches an agent, not a bare shell.
        terminal: { id: string; launchCommand?: string }
        planning?: { id: string }
        browser?: { id: string }
      }
    }

/** The ack shape MAIN's `sendMcpCommand` awaits (`McpCommandAck`). */
export type McpAck = { ok: true; type: string } | { ok: false; error: string }

/** Board types the spawn path may create — mirrors the package's closed allowlist. */
const SPAWNABLE: readonly BoardType[] = ['terminal', 'browser', 'planning']
/** Default anchor for an MCP-spawned board; `addBoard`'s free-slot search spreads collisions. */
const SPAWN_ANCHOR = { x: 120, y: 120 } as const

/**
 * Apply ONE MAIN → renderer MCP command against `canvasStore`, returning the ack.
 * Pure w.r.t. React (no hooks) so it is unit-testable directly. `addBoard`
 * re-validates the type even though MAIN is trusted (frame-guarded control plane) —
 * defense in depth keeps a malformed spec from forging an off-type board.
 */
export function applyMcpCommand(command: McpCommandIn): McpAck {
  switch (command.type) {
    case 'ping':
      return { ok: true, type: 'ping' }
    case 'addBoard': {
      const { id, type } = command.board
      if (typeof id !== 'string' || id.length === 0 || !SPAWNABLE.includes(type)) {
        return { ok: false, error: `invalid addBoard spec: ${JSON.stringify(command.board)}` }
      }
      // Idempotent by id (mirrors removeBoard): a board with this id already exists →
      // no-op + ack ok, so a re-delivered addBoard can't push a duplicate board.
      const store = useCanvasStore.getState()
      if (store.boards.some((b) => b.id === id)) return { ok: true, type: 'addBoard' }
      store.addBoard(type, SPAWN_ANCHOR, { id })
      return { ok: true, type: 'addBoard' }
    }
    case 'removeBoard': {
      if (typeof command.id !== 'string' || command.id.length === 0) {
        return { ok: false, error: `invalid removeBoard id: ${JSON.stringify(command.id)}` }
      }
      // Idempotent: removeBoard no-ops on an unknown id (a board the user already
      // closed), so a double close still acks ok.
      useCanvasStore.getState().removeBoard(command.id)
      return { ok: true, type: 'removeBoard' }
    }
    case 'configureBoard': {
      if (typeof command.id !== 'string' || command.id.length === 0) {
        return { ok: false, error: `invalid configureBoard id: ${JSON.stringify(command.id)}` }
      }
      if (command.patch === null || typeof command.patch !== 'object') {
        return {
          ok: false,
          error: `invalid configureBoard patch: ${JSON.stringify(command.patch)}`
        }
      }
      // updateBoard filters to PATCHABLE_KEYS per board type, so an off-type/identity/
      // ephemeral key (e.g. id, a browser `url` on a terminal) is dropped — the patch
      // can never forge a cross-type hybrid or change identity. No-ops on an unknown id.
      // beginChange() FIRST (mirroring every user-gesture call site, e.g. the New Terminal dialog)
      // so the agent's config edit is checkpointed onto `past` and is undoable; without it
      // the change is non-undoable and a no-op edit would still clear an armed redo branch.
      // beginChange dedups (a genuine no-op reconfigure pushes no phantom snapshot).
      const store = useCanvasStore.getState()
      store.beginChange()
      store.updateBoard(command.id, command.patch)
      return { ok: true, type: 'configureBoard' }
    }
    case 'patchPlanning': {
      // 🔒 S2: append agent-authored CONTENT to a planning board. MAIN already validated +
      // sanitized + capped + human-confirmed the ops; the renderer materializes + applies
      // them. Re-validate every materialized element (defense in depth) before it lands —
      // even though MAIN is trusted (frame-guarded control plane), mirroring addBoard.
      if (typeof command.id !== 'string' || command.id.length === 0) {
        return { ok: false, error: `invalid patchPlanning id: ${JSON.stringify(command.id)}` }
      }
      if (!Array.isArray(command.ops) || command.ops.length === 0) {
        return { ok: false, error: 'patchPlanning ops must be a non-empty array' }
      }
      // One synchronous read→compute→write tick (no async gap → no lost-update window):
      // read the LIVE elements, materialize below them, then commit as one undoable step.
      const store = useCanvasStore.getState()
      const board = store.boards.find((b) => b.id === command.id)
      if (!board) return { ok: false, error: `patchPlanning: board not found: ${command.id}` }
      if (board.type !== 'planning') {
        return { ok: false, error: `patchPlanning: board ${command.id} is not a planning board` }
      }
      // Cumulative cap (resource guard the renderer enforces — only it knows the live count;
      // MAIN caps each batch). Reject, don't truncate, so the agent learns nothing landed.
      if (board.elements.length + command.ops.length > MAX_PLANNING_BOARD_ELEMENTS) {
        return { ok: false, error: 'patchPlanning: planning board element cap exceeded' }
      }
      let added: PlanningElement[]
      try {
        added = materializePlanningOps(command.ops, board.elements)
        added.forEach(assertPlanningElement)
      } catch (err) {
        return {
          ok: false,
          error: `patchPlanning: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      const nextElements = [...board.elements, ...added]
      // beginChange() FIRST (lazy checkpoint, like configureBoard) so the agent's write is ONE
      // discrete undo step that chains with human edits (BUG-023); updateBoard filters to
      // PATCHABLE_KEYS.planning ('elements'). Then auto-grow the board to fit via the
      // UNTRACKED growBoardHeight so the layout bump pushes no phantom undo step (BUG-024).
      store.beginChange()
      store.updateBoard(command.id, { elements: nextElements })
      const needed = neededBoardHeight(nextElements)
      if (needed > board.h) store.growBoardHeight(command.id, needed)
      return { ok: true, type: 'patchPlanning' }
    }
    case 'spawnGroup': {
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
    default:
      return { ok: false, error: `unknown command: ${(command as { type: string }).type}` }
  }
}

/**
 * Wire the MAIN → renderer command channel — the inverse of {@link useMcpPublish}
 * (which pushes board facts out). Each command is applied by {@link applyMcpCommand}
 * and acked on MAIN's reply channel. A no-op if the bridge is absent (a non-electron
 * test runtime).
 */
export function useMcpCommands(): void {
  useEffect(() => {
    const onCommand = window.api?.mcp?.onCommand
    if (!onCommand) return
    return onCommand((command, reply) => {
      try {
        reply(applyMcpCommand(command as McpCommandIn))
      } catch (err) {
        // A malformed envelope must never throw PAST the ack — that strands MAIN's
        // sendMcpCommand on its 2s timeout. Convert any unexpected throw into a resolved
        // { ok: false } so the round-trip always completes.
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }, [])
}
