import { randomUUID } from 'node:crypto'
import type { BoardId, BoardSummary } from '@expanse-ade/mcp'
import type { BoardRegistry } from './mcpRegistry'

/**
 * 🔒 Board types the MCP layer may spawn — mirrors the renderer's SPAWNABLE allowlist
 * (`useMcpCommands.ts`). The renderer's `applyMcpCommand` already rejects an off-type
 * spawn, but the adapter is the trust boundary, so it rejects an unknown type HERE too
 * (defense-in-depth, APP-N3) rather than forwarding it to the renderer.
 */
const SPAWNABLE = new Set(['terminal', 'browser', 'planning'])

/** Deps the lifecycle cluster needs from the orchestrator (DI factory; mirrors the store-slice split #101). */
export interface McpLifecycleDeps {
  registry: BoardRegistry
  now: () => number
  cap: number
  idleTtlMs: number
  spawnGraceMs: number
  /** The orchestrator's read-only listBoards — reapIdle reads derived per-board statuses through it. */
  listBoards: () => Promise<BoardSummary[]>
}

export interface McpLifecycle {
  spawnBoard(input: { type: string; prompt?: string; cwd?: string }): Promise<{ id: BoardId }>
  closeBoard(boardId: BoardId): Promise<void>
  reapIdle(): Promise<string[]>
}

export function createMcpLifecycle(deps: McpLifecycleDeps): McpLifecycle {
  const { registry, now, cap, idleTtlMs, spawnGraceMs, listBoards } = deps
  // Boards this orchestrator has spawned — the cap budget (T3.1). `spawnedAt` gates
  // reconciliation (T3.4): an id absent from the live mirror is dropped only after the
  // spawn grace, so a just-spawned not-yet-published board isn't pruned. `idleSince`
  // tracks how long the board has been idle for the reaper.
  const tracked = new Map<string, { spawnedAt: number; idleSince: number | null }>()
  // 🔒 Re-entrancy latch for reapIdle (APP-N2): true while a sweep is in flight so an
  // overlapping sweep (periodic interval vs an explicit call) can't double-close a board.
  let sweeping = false

  /** Drop tracked boards the user has since closed (gone from the mirror past the grace). */
  const reconcile = (): void => {
    const live = new Set(registry.listBoards().map((b) => b.id))
    const t = now()
    for (const [id, rec] of tracked) {
      if (!live.has(id) && t - rec.spawnedAt > spawnGraceMs) tracked.delete(id)
    }
  }

  const spawnBoard = async (input: {
    type: string
    prompt?: string
    cwd?: string
  }): Promise<{ id: BoardId }> => {
    // 🔒 Defense-in-depth (APP-N3): reject an off-type spawn at the adapter — BEFORE any
    // side effect — rather than relying on the renderer's allowlist as the only gate.
    if (!SPAWNABLE.has(input.type)) {
      throw new Error(`spawn_board: unsupported board type "${input.type}"`)
    }
    // 🔒 Runaway-swarm guard: reconcile away user-closed boards first (so a real
    // slot can be reused), then reject BEFORE minting/sending so a capped spawn has
    // no side effects.
    reconcile()
    if (tracked.size >= cap) {
      throw new Error(
        `MCP spawn concurrency cap reached (${cap} live spawned boards); close one first`
      )
    }
    // MAIN mints the id (server-issued) so the tool can return it to the agent and
    // later lifecycle tools (close/configure) can address the exact board. The
    // renderer builds the full board (free-slot placement, per-type defaults).
    // `prompt`/`cwd` are accepted now but applied in T3.3 (configure_board).
    const id = randomUUID()
    // 🔒 Optimistic reservation (BUG-003): the cap check above is synchronous but
    // `sendCommand` yields the event loop. Reserve the slot in `tracked` NOW — BEFORE the
    // await — so a second concurrent spawn near the cap sees the reservation and is rejected
    // by the check rather than both passing it and adding → cap+1. Release the reservation on
    // a failed ack so a rejected spawn doesn't permanently burn the slot (mirrors closeBoard's
    // finally-guarded delete).
    tracked.set(id, { spawnedAt: now(), idleSince: null })
    try {
      const ack = await registry.sendCommand({
        type: 'addBoard',
        board: { id, type: input.type }
      })
      if (!ack.ok) throw new Error(`spawn_board failed: ${ack.error}`)
    } catch (err) {
      tracked.delete(id)
      throw err
    }
    return { id }
  }

  const closeBoard = async (boardId: BoardId): Promise<void> => {
    // Graceful FIRST: drain (then tree-kill) the PTY so the shell/agent gets a clean
    // exit rather than an abrupt SIGKILL. Best-effort — a non-terminal id is a no-op.
    await registry.drainPty(boardId)
    // The PTY is already drained/killed above, so the board is dead either way. Free the
    // cap budget in a `finally` so a failed removeBoard ack does NOT permanently burn the
    // slot (BUG-009): leaving it tracked would also make every reapIdle sweep retry the
    // same already-dead board forever. The throw still propagates to the caller.
    try {
      const ack = await registry.sendCommand({ type: 'removeBoard', id: boardId })
      if (!ack.ok) throw new Error(`close_board failed: ${ack.error}`)
    } finally {
      tracked.delete(boardId)
    }
  }

  const reapIdle = async (): Promise<string[]> => {
    // 🔒 Re-entrancy guard (APP-N2): the periodic reaper interval and an explicit
    // reapIdle() (e.g. the smoke) can overlap — each close awaits drainPty + a renderer
    // round-trip — so two sweeps could read the same id and closeBoard it twice (and
    // re-arm idleSince on an already-deleted record). Skip a sweep that starts while
    // another is still in flight; the in-flight one already covers the idle set.
    if (sweeping) return []
    sweeping = true
    try {
      // 🔒 Idle-reaping (T3.4): close MCP-spawned boards that have stayed idle past the
      // TTL — the swarm doesn't accrete dormant boards. `idleSince` is sweep-tracked:
      // first idle sighting arms the clock; a return to running clears it; an idle span
      // ≥ TTL reaps. Reconcile first so a user-closed board isn't reaped twice.
      reconcile()
      const statuses = new Map((await listBoards()).map((b) => [b.id, b.status] as const))
      const t = now()
      const reapable: string[] = []
      for (const [id, rec] of tracked) {
        const status = statuses.get(id)
        const idle = status === undefined || status === 'idle'
        if (!idle) {
          rec.idleSince = null
          continue
        }
        if (rec.idleSince === null) {
          rec.idleSince = t
          continue
        }
        if (t - rec.idleSince >= idleTtlMs) reapable.push(id)
      }
      // Close each reapable board independently: a single failed close (e.g. the renderer
      // never acks removeBoard) must NOT abort the whole sweep and leave the rest of the
      // idle boards un-reaped (BUG-009). Swallow per-id so the loop continues, and return
      // only the ids that actually closed.
      const reaped: string[] = []
      for (const id of reapable) {
        try {
          await closeBoard(id)
          reaped.push(id)
        } catch {
          // best-effort: skip a board that failed to close and continue the sweep. Its
          // cap slot is already freed (closeBoard's finally), so it won't re-enter the
          // budget; the next sweep re-evaluates it from the live mirror.
        }
      }
      return reaped
    } finally {
      sweeping = false
    }
  }

  return { spawnBoard, closeBoard, reapIdle }
}
