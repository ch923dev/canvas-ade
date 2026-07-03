import { randomUUID } from 'node:crypto'
import type { BoardId } from '@expanse-ade/mcp'
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
 * Cap on a spawn-time launchCommand (spawnBoard's `prompt` AND spawnGroup's `launchCommand` — one
 * constant so the two spawn paths can't drift). The command becomes the terminal's first PTY line,
 * so it is clamped at the agent-facing entry like every other agent-supplied write.
 */
const SPAWN_LAUNCH_MAX = 400

/**
 * Sanitize an agent-supplied spawn-time launchCommand → a single PTY-safe line, trimmed + clamped.
 * 🔒 F5: routes through the centralized `sanitizeDispatchText` (strips C0/DEL/C1; REJECTS embedded
 * CR/LF via DispatchPayloadError, which propagates — a multiline command is rejected to the caller,
 * not silently flattened into multiple PTY commands). Empty/whitespace-only ⇒ undefined (bare shell).
 * Shared by `spawnBoard` (its `prompt` param) and `spawnGroup` so both spawn paths apply ONE rule.
 */
const sanitizeLaunch = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const clean = sanitizeDispatchText(raw).trim().slice(0, SPAWN_LAUNCH_MAX)
  return clean || undefined
}
/** Deps the lifecycle cluster needs from the orchestrator (DI factory; mirrors the store-slice split #101). */
export interface McpLifecycleDeps {
  registry: BoardRegistry
  now: () => number
  /**
   * The runaway-swarm spawn cap. A fixed number, OR a getter read fresh on each spawn check so a
   * user's Settings change applies live (buildOrchestrator passes a getter; tests pass a number).
   */
  cap: number | (() => number)
  spawnGraceMs: number
  /**
   * BUG-019: notified with a board's id right after `closeBoard` tears it down (the human-gated
   * close_board tool), so the host can revoke that board's `connected`-tier MCP token in the same
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
}

export function createMcpLifecycle(deps: McpLifecycleDeps): McpLifecycle {
  const { registry, now, cap: capInput, spawnGraceMs, onBoardClosed } = deps
  // Normalize the cap to a getter so it can be read fresh per spawn attempt (live config). Each
  // spawn reads it ONCE into a local `cap` so the check and the error message agree even if the
  // configured value changes mid-flight.
  const getCap = typeof capInput === 'function' ? capInput : (): number => capInput
  // Boards this orchestrator has spawned — the cap budget (T3.1). `spawnedAt` gates
  // reconciliation (T3.4): an id absent from the live mirror is dropped only after the
  // spawn grace, so a just-spawned not-yet-published board isn't pruned.
  const tracked = new Map<string, { spawnedAt: number }>()

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
    // prompt/cwd are TERMINAL-ONLY (the prompt becomes the terminal's first PTY line; cwd its
    // spawn directory). Reject a mismatched type BEFORE any side effect — no orphan board — the
    // agent learns the call was wrong instead of getting a board that silently ignored them.
    const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim().length > 0
    const hasCwd = typeof input.cwd === 'string' && input.cwd.trim().length > 0
    if ((hasPrompt || hasCwd) && input.type !== 'terminal') {
      throw new Error('spawn_board: prompt/cwd are only valid for a terminal board')
    }
    // Sanitize the prompt with the SAME spawn-time launchCommand rule as spawnGroup (one line,
    // control-char-free, ≤400); DispatchPayloadError (embedded CR/LF) propagates — reject, never
    // flatten. This also runs BEFORE the cap reservation, so a rejected prompt burns no slot.
    const launchCommand = hasPrompt ? sanitizeLaunch(input.prompt) : undefined
    const cwd = hasCwd ? input.cwd!.trim() : undefined
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
    tracked.set(id, { spawnedAt: now() })
    try {
      const ack = await registry.sendCommand({
        type: 'addBoard',
        board: {
          id,
          type: input.type,
          ...(title ? { title } : {}),
          ...(launchCommand ? { launchCommand } : {}),
          ...(cwd ? { cwd } : {})
        }
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
    // Sanitize the worker launchCommand with the shared spawn-time rule (`sanitizeLaunch` — the
    // same one `spawnBoard`'s prompt uses, so the two spawn paths can't drift). Empty ⇒ a bare
    // shell (legacy contract); DispatchPayloadError (multiline) propagates — reject, never flatten.
    const launchCommand = sanitizeLaunch(input.launchCommand)
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
    for (const id of boardIds) tracked.set(id, { spawnedAt: at })
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
    // slot (BUG-009). The throw still propagates to the caller.
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

  // NOTE (2026-07-02): the idle reaper (T3.4 `reapIdle`) that used to live here was REMOVED —
  // it silently deleted agent-spawned boards after an idle TTL, which guaranteed the loss of
  // every passive board (browser previews read 'idle' once loaded; planning/kanban are
  // permanently 'static'). Boards are now deleted ONLY by the user, or by the human-gated
  // `close_board` tool (the confirm gate lives in the orchestrator's closeBoard wrapper).
  return { spawnBoard, spawnGroup, closeBoard }
}
