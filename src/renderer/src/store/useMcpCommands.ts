import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import type { BoardType } from '../lib/boardSchema'

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
      // Idempotent: removeBoard no-ops on an unknown id (a board the user already
      // closed), so a double close still acks ok.
      useCanvasStore.getState().removeBoard(command.id)
      return { ok: true, type: 'removeBoard' }
    }
    case 'configureBoard': {
      // updateBoard filters to PATCHABLE_KEYS per board type, so an off-type/identity/
      // ephemeral key (e.g. id, a browser `url` on a terminal) is dropped — the patch
      // can never forge a cross-type hybrid or change identity. No-ops on an unknown id.
      useCanvasStore.getState().updateBoard(command.id, command.patch)
      return { ok: true, type: 'configureBoard' }
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
      reply(applyMcpCommand(command as McpCommandIn))
    })
  }, [])
}
