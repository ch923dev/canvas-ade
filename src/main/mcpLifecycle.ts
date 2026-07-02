import { randomUUID } from 'node:crypto'
import type { BoardId, BoardSummary } from '@expanse-ade/mcp'
import { sanitizeDispatchText } from './dispatchSanitize'
import { sanitizeBoardTitle } from '../shared/boardTitle'
import type { BoardRegistry } from './mcpRegistry'

/**
 * 🔒 Board types the MCP layer may spawn — mirrors the renderer's SPAWNABLE allowlist
 * (`useMcpCommands.ts`). The renderer's `applyMcpCommand` already rejects an off-type
 * spawn, but the adapter is the trust boundary, so it rejects an unknown type HERE too
 * (defense-in-depth, APP-N3) rather than forwarding it to the renderer.
 */
const SPAWNABLE = new Set(['terminal', 'browser', 'planning'])

/**
 * Cap on a spawned group's display name (PR-5b). The name is agent/user-provided text that
 * lands in a renderer `NamedGroup.name` (rendered, never executed) — clamp it here at the
 * agent-facing entry (belt-and-suspenders, mirroring the gitDiff/writeResult output clamps) so
 * an unbounded name can't bloat the canvas/mirror. Whitespace is collapsed (a multi-line name
 * would break the group-tab layout) before the clamp.
 */
const SPAWN_GROUP_MAX_NAME = 80

/**
 * BUG-003: `reapIdle`'s status-bucket fallback (used for any board without a live PTY/preview
 * session, e.g. planning/kanban) must treat every bucket it doesn't recognize as idle-eligible,
 * not the reverse — mirrors `BoardStatusBucket` (`boardStatus.ts`) minus 'idle'/'static': the only
 * buckets that mean "still busy, don't reap" are liveness ('running') and the attention states.
 */
const NON_IDLE_STATUSES = new Set(['running', 'awaiting-review', 'blocked', 'failed'])

/** Deps the lifecycle cluster needs from the orchestrator (DI factory; mirrors the store-slice split #101). */
export interface McpLifecycleDeps {
  registry: BoardRegistry
  now: () => number
  /**
   * The runaway-swarm spawn cap. A fixed number, OR a getter read fresh on each spawn check so a
   * user's Settings change applies live (buildOrchestrator passes a getter; tests pass a number).
   */
  cap: number | (() => number)
  idleTtlMs: number
  spawnGraceMs: number
  /**
   * BUG-007: output-silence threshold (ms) above which a live terminal counts as dormant for the
   * reaper. Only consulted on the terminal-with-live-session branch (where the status bucket is
   * permanently 'running'); a board with no live session still uses its derived status bucket.
   */
  idleActivityMs: number
  /** The orchestrator's read-only listBoards — reapIdle reads derived per-board statuses through it. */
  listBoards: () => Promise<BoardSummary[]>
  /**
   * BUG-019: notified with a board's id right after `closeBoard` tears it down (close_board tool OR
   * an idle-reap sweep), so the host can revoke that board's `connected`-tier MCP token in the same
   * step instead of leaving it live in the TokenStore. Optional; tests omit it.
   */
  onBoardClosed?: (boardId: BoardId) => void
}

/** The members a {@link McpLifecycle.spawnGroup} cluster may carry (terminal is always present). */
export interface SpawnGroupInput {
  name: string
  /** Add a Planning member to the zone (the decomposed-subtask checklist surface). */
  planning?: boolean
  /** Add a Browser member, pre-wired to the terminal via `previewSourceId`. */
  browser?: boolean
  /**
   * Agentic CLI the terminal member boots as its first PTY line (e.g. `claude`) so a dispatched
   * prompt reaches an AGENT, not a bare shell. Sanitized to a single line here (it becomes a PTY
   * write). Renderer-originated for the Command board (the user's chosen agent); the future
   * agent-callable `spawn_group` tool (PR-5c) MUST gate/validate this as an exec vector.
   */
  launchCommand?: string
}

/** The minted ids a {@link McpLifecycle.spawnGroup} returns so the orchestrator can address the zone. */
export interface SpawnGroupResult {
  groupId: BoardId
  terminalId: BoardId
  planningId?: BoardId
  browserId?: BoardId
}

export interface McpLifecycle {
  spawnBoard(input: {
    type: string
    prompt?: string
    cwd?: string
    /** Agent-chosen board title (2b); host sanitizes + clamps. Absent/empty ⇒ per-type default. */
    title?: string
  }): Promise<{ id: BoardId }>
  /**
   * PR-5b: spawn a whole feature-zone CLUSTER in one undoable step — a terminal (always) plus an
   * optional planning + browser member, a Named Group over them, and the browser→terminal preview
   * wiring. Mints every id in MAIN (returned so later lifecycle/dispatch tools can address each
   * member); reserves ALL member slots against the same cap budget as `spawnBoard` BEFORE the
   * await (so a near-cap group can't burst past it), and releases them on a failed ack. Content-
   * less (empty boards), so it is cap-checked, not human-gated — the gate stays on content writes.
   */
  spawnGroup(input: SpawnGroupInput): Promise<SpawnGroupResult>
  closeBoard(boardId: BoardId): Promise<void>
  reapIdle(): Promise<string[]>
}

export function createMcpLifecycle(deps: McpLifecycleDeps): McpLifecycle {
  const {
    registry,
    now,
    cap: capInput,
    idleTtlMs,
    spawnGraceMs,
    idleActivityMs,
    listBoards,
    onBoardClosed
  } = deps
  // Normalize the cap to a getter so it can be read fresh per spawn attempt (live config). Each
  // spawn reads it ONCE into a local `cap` so the check and the error message agree even if the
  // configured value changes mid-flight.
  const getCap = typeof capInput === 'function' ? capInput : (): number => capInput
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
    title?: string
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
    const cap = getCap()
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
    // 2b: sanitize + clamp the optional agent title here (the trust boundary) so the renderer
    // receives a single-line, control-char-free, bounded label. Omitted when nothing usable
    // remains → the renderer falls back to the per-type default title.
    const title = sanitizeBoardTitle(input.title)
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
        board: { id, type: input.type, ...(title ? { title } : {}) }
      })
      if (!ack.ok) throw new Error(`spawn_board failed: ${ack.error}`)
    } catch (err) {
      tracked.delete(id)
      throw err
    }
    return { id }
  }

  const spawnGroup = async (input: SpawnGroupInput): Promise<SpawnGroupResult> => {
    // Collapse whitespace (a multi-line name breaks the group-tab layout) → trim → clamp. The
    // renderer re-validates a non-empty string before it lands (defense in depth).
    const name = String(input?.name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SPAWN_GROUP_MAX_NAME)
    if (name.length === 0) {
      throw new Error('spawn_group: a non-empty group name is required')
    }
    // Sanitize the worker launchCommand → a single PTY-safe line, then trim + clamp. Empty ⇒ a
    // bare shell (legacy contract).
    const rawSrc = typeof input.launchCommand === 'string' ? input.launchCommand : ''
    let launchCommand: string | undefined
    if (rawSrc) {
      // 🔒 F5: route through the centralized sanitizer (strips C0/DEL/C1; rejects embedded CR/LF)
      // so spawnGroup and the configureBoard/runGatedWrite dispatch path share ONE sanitization
      // rule. The old inline `c >= ' '` filter PASSED DEL (0x7F) + the C1 range (0x80-0x9F) — the
      // 8-bit CSI/OSC/NEL escape openers — a terminal-escape injection on the PTY write path.
      // DispatchPayloadError propagates (not caught): a multiline launchCommand is rejected to the
      // caller, not silently flattened into multiple PTY commands.
      const clean = sanitizeDispatchText(rawSrc).trim().slice(0, 400)
      launchCommand = clean || undefined
    }
    // Compose the cluster: terminal always; planning/browser opt-in. The member COUNT is the
    // cap budget this spawn consumes (the group record itself isn't a board, so it's uncapped).
    const wantPlanning = input.planning === true
    const wantBrowser = input.browser === true
    const memberCount = 1 + (wantPlanning ? 1 : 0) + (wantBrowser ? 1 : 0)
    // 🔒 Runaway-swarm guard (mirrors spawnBoard): reconcile away user-closed boards first, then
    // reject BEFORE minting/sending if the WHOLE cluster would exceed the cap — so a capped group
    // spawn has no side effects (no half-built zone).
    reconcile()
    const cap = getCap()
    if (tracked.size + memberCount > cap) {
      throw new Error(
        `MCP spawn concurrency cap reached (${cap} live spawned boards); spawning this group of ` +
          `${memberCount} would exceed it — close some first`
      )
    }
    // MAIN mints every id (server-issued) so the tool can return them + later lifecycle/dispatch
    // tools can address each member. The renderer lays out the cluster + names the group.
    // Annotate as plain `string` (randomUUID's template-literal type otherwise breaks the
    // `x is string` narrowing below + the `tracked` map's string keys).
    const groupId: string = randomUUID()
    const terminalId: string = randomUUID()
    const planningId: string | undefined = wantPlanning ? randomUUID() : undefined
    const browserId: string | undefined = wantBrowser ? randomUUID() : undefined
    const boardIds = [terminalId, planningId, browserId].filter((x): x is string => x !== undefined)
    // 🔒 Optimistic reservation (BUG-003, group form): reserve ALL member slots NOW — before the
    // await — so a concurrent spawn near the cap sees them and is rejected rather than both passing
    // the check → cap+N. Release every reserved slot on a failed ack so a rejected group spawn
    // doesn't permanently burn the budget (mirrors spawnBoard's single-slot release).
    const at = now()
    for (const id of boardIds) tracked.set(id, { spawnedAt: at, idleSince: null })
    try {
      const ack = await registry.sendCommand({
        type: 'spawnGroup',
        group: { id: groupId, name },
        members: {
          terminal: { id: terminalId, ...(launchCommand ? { launchCommand } : {}) },
          ...(planningId ? { planning: { id: planningId } } : {}),
          ...(browserId ? { browser: { id: browserId } } : {})
        }
      })
      if (!ack.ok) throw new Error(`spawn_group failed: ${ack.error}`)
    } catch (err) {
      for (const id of boardIds) tracked.delete(id)
      throw err
    }
    return {
      groupId,
      terminalId,
      ...(planningId ? { planningId } : {}),
      ...(browserId ? { browserId } : {})
    }
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
      // BUG-019: revoke the board's connected-tier MCP token (if any) in the SAME step it's torn
      // down. The board is dead either way at this point (PTY already drained/killed above), so
      // this fires unconditionally — including when the removeBoard ack failed — mirroring the
      // cap-slot release just above.
      onBoardClosed?.(boardId)
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
        // BUG-007: a live terminal's coarse status bucket is permanently 'running' (no per-task
        // running->idle transition), so the reaper measures its dormancy by OUTPUT SILENCE — a
        // board whose PTY has been quiet for >= idleActivityMs counts as idle. The activity
        // predicate returns undefined for any board WITHOUT a live terminal session (non-terminal,
        // or a closed/parked terminal), in which case we fall back to the derived status bucket
        // (the browser/planning idle path, and a session-gone terminal that reads 'idle').
        const staleMs = registry.boardActivityStaleMs?.(id)
        let idle: boolean
        if (staleMs !== undefined) {
          idle = staleMs >= idleActivityMs
        } else {
          // BUG-003: invert to an explicit non-idle allowlist rather than an idle allowlist —
          // a passive-content bucket like 'static' (planning/kanban boards, which never carry a
          // live PTY/preview session and so never hit the staleMs branch above) must count as
          // reapable, and a positive-match `=== 'idle'` check silently excluded it forever. Only
          // the liveness/attention buckets ('running' + the attention states) are non-idle, so any
          // future BoardStatusBucket addition defaults to idle-eligible instead of repeating the gap.
          const status = statuses.get(id)
          idle = status === undefined || !NON_IDLE_STATUSES.has(status)
        }
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
          // budget. The id is also removed from `tracked`, so subsequent sweeps won't
          // attempt to reap it again; it becomes invisible to the reaper (user can close
          // the stale board manually if it is still visible in the canvas).
        }
      }
      return reaped
    } finally {
      sweeping = false
    }
  }

  return { spawnBoard, spawnGroup, closeBoard, reapIdle }
}
