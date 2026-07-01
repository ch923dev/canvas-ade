import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { assertPlanningElement, type BoardType, type PlanningElement } from '../lib/boardSchema'
import { freeSlot, overlapsAny, viewportCenterWorld } from '../lib/freeSlot'
import { sanitizeBoardTitle } from '../../../shared/boardTitle'
import {
  materializePlanningOps,
  neededBoardHeight,
  neededBoardWidth,
  MAX_PLANNING_BOARD_ELEMENTS
} from './planningMcpApply'
import { applyKanbanOps } from './kanbanMcpApply'
import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'

/**
 * MAIN posts {@link McpCommand}s; this module applies them to `canvasStore` and replies with a
 * {@link McpCommandAck}. Both are the canonical definitions imported from the cross-bundle
 * `src/shared/mcpTypes.ts` (W1-D / F9) — the SAME union MAIN's `sendMcpCommand` serializes, so the
 * applier can no longer silently drift from the sender (a new variant added on one side is now a
 * compile error on the other). `addBoard.board.type` is a loose `string` in the canonical union;
 * the SPAWNABLE guard below re-validates it at runtime (defense in depth).
 */

/** Board types the spawn path may create — mirrors the package's closed allowlist. */
const SPAWNABLE: readonly BoardType[] = ['terminal', 'browser', 'planning']
/**
 * Runtime narrow of the canonical command's loose `board.type` (a `string` — MAIN is the sender
 * and does not import renderer types) down to a spawnable `BoardType`. This guard IS the defense-
 * in-depth enforcement point the widening relies on (a value crosses IPC as JSON anyway).
 */
const isSpawnable = (type: string): type is BoardType =>
  (SPAWNABLE as readonly string[]).includes(type)
/** Default anchor for an MCP-spawned board; `addBoard`'s free-slot search spreads collisions. */
const SPAWN_ANCHOR = { x: 120, y: 120 } as const

/**
 * Apply ONE MAIN → renderer MCP command against `canvasStore`, returning the ack.
 * Pure w.r.t. React (no hooks) so it is unit-testable directly. `addBoard`
 * re-validates the type even though MAIN is trusted (frame-guarded control plane) —
 * defense in depth keeps a malformed spec from forging an off-type board.
 */
export function applyMcpCommand(command: McpCommand): McpCommandAck {
  switch (command.type) {
    case 'ping':
      return { ok: true, type: 'ping' }
    case 'addBoard': {
      const { id, type, title } = command.board
      if (typeof id !== 'string' || id.length === 0 || !isSpawnable(type)) {
        return { ok: false, error: `invalid addBoard spec: ${JSON.stringify(command.board)}` }
      }
      // Idempotent by id (mirrors removeBoard): a board with this id already exists →
      // no-op + ack ok, so a re-delivered addBoard can't push a duplicate board.
      const store = useCanvasStore.getState()
      if (store.boards.some((b) => b.id === id)) return { ok: true, type: 'addBoard' }
      // 2b: re-run the SHARED `sanitizeBoardTitle` (defense in depth, a true second pass like the
      // `isSpawnable` re-validation above — not just a length clamp): MAIN already sanitized the title
      // on the real path, but a forged/malformed IPC payload carrying control chars must still get the
      // identical whitespace-collapse + C0/DEL/C1 strip + code-point clamp before it lands in the store.
      // `undefined` (empty/whitespace-only/non-string) ⇒ the per-type default title.
      const cleanTitle = sanitizeBoardTitle(title)
      store.addBoard(type, SPAWN_ANCHOR, { id, ...(cleanTitle ? { title: cleanTitle } : {}) })
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
      // PATCHABLE_KEYS.planning ('elements'). Then auto-grow the board to fit the grid in BOTH
      // dimensions via the UNTRACKED growBoardWidth/Height so the layout bump pushes no phantom
      // undo step (BUG-024) — width too, else a wide batch is clipped on the right (the column→
      // grid fix: a multi-element write widens the board, it no longer only lengthens it).
      store.beginChange()
      store.updateBoard(command.id, { elements: nextElements })
      const needW = neededBoardWidth(nextElements)
      const grewW = needW > board.w
      if (grewW) store.growBoardWidth(command.id, needW)
      const needH = neededBoardHeight(nextElements)
      const grewH = needH > board.h
      if (grewH) store.growBoardHeight(command.id, needH)
      // Canvas-aware nudge: a board grows from its top-left rightward + downward, so a wide/tall
      // agent plan can grow UNDER a neighbouring board. If the board actually grew, re-read its NEW
      // rect and, when it now overlaps another board, move the WHOLE board to the nearest free slot
      // (the same spiral `freeSlot` the spawn path uses, PLACE_GAP margin) so the plan tucks into
      // open canvas instead. UNTRACKED like the grows → reverts with the write, no separate undo
      // step. Skipped for a GROUPED board (a feature zone owns its own arrangement — never yank a
      // member out of its cluster) and when nothing grew (don't move a board the user placed
      // overlapping on purpose). Other boards always stay put.
      if (grewW || grewH) {
        const live = useCanvasStore.getState()
        const grown = live.boards.find((b) => b.id === command.id)
        const inGroup = live.groups.some((g) => g.boardIds.includes(command.id))
        if (grown && !inGroup) {
          const others = live.boards.filter((b) => b.id !== command.id)
          const size = { w: grown.w, h: grown.h }
          const slot = freeSlot(others, { x: grown.x, y: grown.y }, size)
          // Only move if the slot is BOTH different from where the board grew AND verified clear:
          // `freeSlot`'s exhaustion fallback (a fully-packed canvas, all rings probed) returns a
          // not-guaranteed-free position, and moving there could leave the plan overlapping a
          // different neighbour. When no free slot exists, leave the board where it grew rather than
          // shuffle it to another overlap.
          const moved = slot.x !== grown.x || slot.y !== grown.y
          if (moved && !overlapsAny(others, slot, size)) {
            store.repositionBoardUntracked(command.id, slot.x, slot.y)
          }
        }
      }
      return { ok: true, type: 'patchPlanning' }
    }
    case 'patchKanban': {
      // 🔒 P3: mutate a kanban board's cards (add/move/update/remove). MAIN already resolved +
      // kanban-checked the board, minted any new card id, and human-confirmed the ops; the renderer
      // re-validates (board exists + is kanban, target column/card exists) as defense in depth,
      // mirroring patchPlanning, then commits as ONE undoable edit.
      if (typeof command.id !== 'string' || command.id.length === 0) {
        return { ok: false, error: `invalid patchKanban id: ${JSON.stringify(command.id)}` }
      }
      if (!Array.isArray(command.ops) || command.ops.length === 0) {
        return { ok: false, error: 'patchKanban ops must be a non-empty array' }
      }
      const store = useCanvasStore.getState()
      const board = store.boards.find((b) => b.id === command.id)
      if (!board) return { ok: false, error: `patchKanban: board not found: ${command.id}` }
      if (board.type !== 'kanban') {
        return { ok: false, error: `patchKanban: board ${command.id} is not a kanban board` }
      }
      let nextCards
      try {
        nextCards = applyKanbanOps(board, command.ops)
      } catch (err) {
        return {
          ok: false,
          error: `patchKanban: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      // beginChange() FIRST (lazy checkpoint, like patchPlanning/configureBoard) so the agent's card
      // mutation is ONE discrete undo step that chains with human edits; updateBoard filters to
      // PATCHABLE_KEYS.kanban ('cards'). Geometry is untouched (cards flow inside the fixed lanes).
      store.beginChange()
      store.updateBoard(command.id, { cards: nextCards })
      return { ok: true, type: 'patchKanban' }
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
        reply(applyMcpCommand(command as McpCommand))
      } catch (err) {
        // A malformed envelope must never throw PAST the ack — that strands MAIN's
        // sendMcpCommand on its 2s timeout. Convert any unexpected throw into a resolved
        // { ok: false } so the round-trip always completes.
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }, [])
}
