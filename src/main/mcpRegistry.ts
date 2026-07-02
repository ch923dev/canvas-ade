import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { AuditInput } from './auditLog'
import type { ConfirmDecision, ConfirmRequest } from './mcpConfirm'
import type { DispatchGuard } from './dispatchGuard'
import type { BoardOutput, BoardResult, MemoryDoc, Orchestrator } from '@expanse-ade/mcp'
import type { AppModel } from './appModel'
import type { LayoutDigest } from './layoutModel'
import type { BoardCards } from './mcpBoardCards'
import type { SpawnGroupInput, SpawnGroupResult } from './mcpLifecycle'

/**
 * 🔒 Hard cap on the number of live boards a single MCP session may have spawned
 * (the runaway-swarm guard, T3.1). Reconciled against the live mirror + idle-reaped
 * (T3.4). Spawns past the cap are rejected with a clear error.
 */
export const MCP_SPAWN_CAP = 4

/** Default idle TTL before an MCP-spawned board is reaped (T3.4). */
export const MCP_IDLE_TTL_MS = 5 * 60 * 1000

/**
 * BUG-007: how long a live terminal's PTY output must be SILENT before the idle-reaper
 * counts it as dormant. A live agent shell's coarse status pill stays 'running' for its
 * whole lifetime (no per-task running->idle transition), so the reaper measures dormancy
 * by output silence instead. Mirrors `summaryLoop`'s IDLE_AFTER_MS (the same "no activity
 * for this long reads as idle" threshold the recap/summary paths use). Once a board is
 * counted idle, the existing idleSince clock still requires a full MCP_IDLE_TTL_MS of
 * continuous dormancy before it is reaped.
 */
export const MCP_IDLE_ACTIVITY_MS = 60_000

/**
 * Grace after a spawn during which a tracked board is NOT reconciled away even if it
 * is absent from the mirror — the renderer publishes the new board asynchronously
 * (~150ms debounce), so a just-spawned id legitimately isn't in `listBoards()` yet.
 */
export const MCP_SPAWN_GRACE_MS = 5_000

/**
 * 🔒 The closed forensic vocabulary every dispatch audit entry records (T4.1). These
 * exact strings ARE the forensic record (`AuditInput.status`), so the orchestrator types
 * its audit calls against this union — a typo or an off-vocabulary status is a compile
 * error, not a silently-mislabelled audit line. `rejected` covers a pre-write refusal
 * (not-found / non-terminal / unsafe payload / replayed nonce / removed cable);
 * `denied` is a human "no"; `failed` is an attempted-but-errored write; `dispatched`
 * is a landed write; `completed`/`closed`/`timed_out` are the handoff await-idle exits;
 * `configured` is a persisted launchCommand; `applied` is a confirmed planning content
 * write that landed on the canvas (S2 `add_planning_elements`).
 */
export type DispatchStatus =
  | 'rejected'
  | 'denied'
  | 'failed'
  | 'dispatched'
  | 'completed'
  | 'closed'
  | 'timed_out'
  | 'configured'
  | 'applied'

/** Tuning + clock seam for the lifecycle cap/reaper (all optional; injected by tests). */
export interface OrchestratorOpts {
  now?: () => number
  /**
   * The runaway-swarm spawn cap. A fixed number, OR a getter read fresh on each spawn check so a
   * user's Settings change to the cap applies live (no orchestrator rebuild). Defaults to
   * {@link MCP_SPAWN_CAP} when unset. Tests pass a plain number.
   */
  cap?: number | (() => number)
  idleTtlMs?: number
  spawnGraceMs?: number
  /**
   * BUG-007: output-silence threshold (ms) above which a live terminal counts as dormant for the
   * idle-reaper. Defaults to {@link MCP_IDLE_ACTIVITY_MS}; injected by tests to drive the path
   * deterministically.
   */
  idleActivityMs?: number
  /** 🔒 Single-use-nonce authority for dispatch (T4.3); a fresh guard per orchestrator by default. */
  guard?: DispatchGuard
  /** Backstop timer seam for the handoff await-idle deadline (injected by tests to avoid real timers). */
  sleep?: (ms: number) => Promise<void>
  /** Backstop deadline for the handoff await-idle (M5: the await is event-driven via subscribeStatus). */
  handoffTimeoutMs?: number
  /**
   * BUG-019: fired with a board's id once the lifecycle's `closeBoard` has torn it down (via the
   * `close_board` tool OR an idle-reap sweep), so the host can revoke that board's `connected`-tier
   * MCP token in the SAME step. Without this hook a token minted for a board stays valid in the
   * `TokenStore` after the board is gone — live until that id happens to be re-spawned (rotates) or
   * a full consent-revoke fires — a real bearer-token leak for a dead board. Optional; tests omit it.
   */
  onBoardClosed?: (boardId: string) => void
}

/**
 * The adapter + the T3.4 idle-reap sweep + awaitSettled (extras beyond the package contract), PLUS
 * app-side NARROWING of two methods the package `Orchestrator` now declares as of ≥0.15.0 (W1-G):
 * `describeApp(): Promise<unknown>` (the package does not own `AppModel`) and a structurally-
 * equivalent `spawnGroup`. We `Omit` both from the package base and re-declare them with the app's
 * concrete `AppModel` / `SpawnGroupResult` types so MAIN keeps full typing (a plain intersection
 * would resolve the call to the package's looser signature first).
 */
export type LifecycleOrchestrator = Omit<
  Orchestrator,
  | 'describeApp'
  | 'spawnGroup'
  | 'describeLayout'
  | 'boardCards'
  | 'tidyCanvas'
  | 'addCard'
  | 'moveCard'
  | 'updateCard'
  | 'removeCard'
  | 'visualizePlan'
> & {
  /** Close every MCP-spawned board idle past the TTL; returns the reaped ids. */
  reapIdle(): Promise<string[]>
  /**
   * Assemble the read-only app self-model (board types · tool catalog · live canvas · rules).
   * NARROWS the package's `describeApp(): Promise<unknown>` to the concrete `AppModel` (the package
   * does not own that type). Now wired over the wire as the `canvas://app-model` resource (W1-G / C1).
   */
  describeApp(): Promise<AppModel>
  /**
   * Assemble the read-only SPATIAL digest (bbox · per-board geometry+group · overlaps · arrangement).
   * NARROWS the package's `describeLayout(): Promise<unknown>` to the concrete `LayoutDigest` (the
   * package does not own that type — same discipline as `describeApp`). Wired as the `canvas://layout`
   * resource (P1b, @expanse-ade/mcp ≥ 0.18.0). Omitting `describeLayout` from the base is a harmless
   * no-op on a package that predates it, so this type compiles against 0.17.0 AND 0.18.0-rc.1.
   */
  describeLayout(): Promise<LayoutDigest>
  /**
   * Project one Kanban board's lanes + cards (P3b) — the read half of the card loop, served as
   * `canvas://board/{id}/cards`. NARROWS the package's `boardCards(): Promise<unknown>` to the concrete
   * host-owned `BoardCards` (the package does not own that type — same discipline as `describeLayout`).
   * Omitting `boardCards` from the base is a harmless no-op on a package predating it (0.17.0), and
   * matches the concrete method on 0.18.0-rc.4 at integration.
   */
  boardCards(boardId: string): Promise<BoardCards>
  /**
   * 🔒 Tidy the whole canvas (P2) — reposition every board into a clean, non-overlapping arrangement
   * via the renderer's deterministic packer (`canvasStore.tidyBoards`). NARROWS the package's
   * `tidyCanvas(): Promise<unknown>` to the concrete host-owned `{ moved }` (the package does not own
   * that type — same discipline as `describeLayout`). UN-GATED + content-less (reposition-only, one
   * host-undo reversible). Omitting `tidyCanvas` from the base is a harmless no-op on a package
   * predating it (0.17.0), and matches the concrete method on 0.18.0-rc.5 at integration.
   */
  tidyCanvas(input: { mode?: string }): Promise<{ moved: number }>
  /**
   * Spawn a feature-zone cluster (terminal + optional planning/browser + a Named Group + preview
   * wiring) in one undoable step. Re-declared with the app's `SpawnGroupInput/Result` (structurally
   * equal to the package's). Now wired as the `spawn_group` MCP tool (W1-G / C2). Cap-checked
   * (reserves all member slots), not human-gated (content-less empty boards).
   */
  spawnGroup(input: SpawnGroupInput): Promise<SpawnGroupResult>
  /**
   * C2e: await a dispatched worker's task to SETTLE (output silence after activity / its own
   * `write_result` / a backstop) WITHOUT a write — the verdict for a dispatch whose prompt was
   * delivered as a launch arg. App-local (NOT on the package `Orchestrator` interface), read-only:
   * no nonce, no confirm, no PTY write. Resolves with the board's result.
   */
  awaitSettled(boardId: string): Promise<BoardResult>
  /**
   * 🔒 Kanban card writes (P3) — add / move / update / remove a card on a kanban board. Each resolves
   * + kanban-checks the target, sanitizes + caps the content, human-confirms the op, applies it via
   * the `patchKanban` command, and audits every branch (mirrors `addPlanningElements`). `addCard`
   * MINTS the card id and returns it. Host-local inline types (the installed package predates the
   * `@expanse-ade/mcp` `KanbanCardSpec`/`KanbanCardPatch`); Omitting them from the base is a harmless
   * no-op on 0.17.0 and matches the concrete methods on 0.18.0-rc.2 at integration — same discipline
   * as `describeLayout`.
   */
  addCard(
    boardId: string,
    spec: { columnId: string; title: string; tag?: string; assignee?: string; ref?: string }
  ): Promise<{ id: string }>
  moveCard(boardId: string, cardId: string, toColumnId: string): Promise<void>
  updateCard(
    boardId: string,
    cardId: string,
    patch: { title?: string; tag?: string; assignee?: string; ref?: string }
  ): Promise<void>
  removeCard(boardId: string, cardId: string): Promise<void>
  /**
   * 🔒 Visualize a plan as a NEW board (P5) — validate/sanitize/cap the plan, surface the UPGRADED
   * human-confirm CHOOSER (kanban/grid/checklist/columns), and on approval create the chosen board
   * (tidied into open space) via the `visualizePlan` command; audits every branch. MINTS + returns the
   * board id. Host-local inline types (the installed package predates `VisualizePlanSpec`); Omitting it
   * from the base is a harmless no-op on 0.17.0 and matches the concrete method on 0.18.0-rc.3 — same
   * discipline as `describeLayout` / the card methods.
   */
  visualizePlan(spec: {
    items: Array<{ title: string; status?: string; tag?: string; assignee?: string; note?: string }>
    suggested?: 'kanban' | 'grid' | 'checklist' | 'columns'
    title?: string
  }): Promise<{ id: string }>
}

/** A board↔board connector the renderer mirrors to MAIN (M2). Direction: source → target. */
export interface ConnectorMirrorEntry {
  id: string
  sourceId: string
  targetId: string
  kind: string
}

/** A Named Board Group the renderer mirrors to MAIN (PR-5) — a feature zone of boards. */
export interface GroupMirrorEntry {
  id: string
  name: string
  boardIds: string[]
}

/** MAIN-owned board sources the adapter reads: the renderer mirror + the PTY map. */
export interface BoardRegistry {
  listBoards(): Array<{
    id: string
    type: string
    title: string
    status?: string
    /** v10 agent-preset id (Phase B) — forwarded to `canvas://boards`. */
    agentKind?: string
    /** v10 monitoring opt-out (Phase B) — gates the `canvas://attention` queue. */
    monitorActivity?: boolean
    /** file-tree S5: a file board's project-relative path — forwarded to `canvas://boards`. */
    path?: string
    /** file-tree S5: a planning board's `fileref` paths+labels — forwarded to `canvas://boards`. */
    fileRefs?: Array<{ path: string; label: string }>
    /** P1 canvas awareness: world-space board geometry (top-left x/y + size w/h), forwarded to
     *  `canvas://boards` + the app self-model so an agent can reason about the spatial layout. */
    x?: number
    y?: number
    w?: number
    h?: number
    /** P3b: a kanban board's bounded lanes + cards (mirror-sanitized), grouped + served as
     *  `canvas://board/{id}/cards`. Absent on every non-kanban board. */
    kanban?: {
      columns: Array<{ id: string; title: string; wip?: number }>
      cards: Array<{
        id: string
        columnId: string
        title: string
        tag?: string
        assignee?: string
        ref?: string
      }>
    }
  }>
  /**
   * The connector graph the renderer mirrors (T4.6). Only `orchestration` edges authorize
   * an agent-to-agent relay; directional (source → target). MAIN injects `listConnectors`
   * from `boardRegistry.ts`.
   */
  listConnectors(): ConnectorMirrorEntry[]
  /**
   * PR-5: the Named Board Group mirror (feature zones). MAIN injects `boardRegistry.ts`'s
   * `listGroups`; the app self-model projects it as `canvas.groups` so the orchestrator/agent can
   * reason about feature zones. Optional so a registry/test that does not wire it keeps the
   * empty-groups behaviour (read-only — groups are metadata, no action surface).
   */
  listGroups?(): GroupMirrorEntry[]
  listSessions(): Array<{ id: string; status: string }>
  /**
   * BUG-007: ms since terminal board `id` last produced PTY output (its dormancy measure for the
   * idle-reaper). MAIN injects `pty.ts`'s `getTerminalActivityStaleMs`; returns undefined for any id
   * without a LIVE terminal session (non-terminal / closed / parked), in which case the reaper falls
   * back to its derived status bucket. Read-only; control-plane only. Optional so a registry that
   * does not wire it (older tests / non-terminal-only stubs) keeps the status-bucket behaviour.
   */
  boardActivityStaleMs?(id: string): number | undefined
  /**
   * Subscribe to per-board coarse status changes (M5 event-driven attention). MAIN injects
   * `boardRegistry.ts`'s `subscribeBoardStatus`. Emits `{ id, status }` on each change
   * (`status: 'gone'` when a board leaves the canvas); returns an unsubscribe fn. The handoff
   * await-idle wakes on these instead of polling. Phase B: each change also carries the board's
   * `monitorActivity` (absent ⇒ monitored) so the attention notifier can gate its push.
   */
  subscribeStatus(
    listener: (change: { id: string; status: string; monitorActivity?: boolean }) => void
  ): () => void
  /**
   * Drive the canvas via the MAIN → renderer control-plane command channel (T3.1+).
   * MAIN injects a frame-guarded `sendMcpCommand`; the renderer applies the command
   * to `canvasStore` and acks. The ONLY write path from the MCP layer to the canvas.
   */
  sendCommand(command: McpCommand): Promise<McpCommandAck>
  /**
   * Read one capped, ANSI-stripped page of a board's PTY scrollback (T1.4 🔒).
   * MAIN injects `pty.ts`'s `readPtyOutput`; non-terminal/unknown ids read empty.
   */
  readOutput(id: string, opts?: { cursor?: number }): BoardOutput
  /**
   * Read a board's structured last result (T1.5). MAIN injects `boardResults.ts`'s
   * `readBoardResult`; a board with no recorded result reads the empty shell.
   */
  readResult(id: string): BoardResult
  /**
   * Read the project memory index (T1.7 🔒). MAIN injects `boardMemory.ts`'s
   * `readProjectMemory`; empty shell when the memory engine is absent.
   */
  readMemory(): MemoryDoc
  /**
   * Read a board's memory summary (T1.7 🔒). MAIN injects `readBoardSummary` (which
   * path-guards the agent-supplied id); empty shell when absent/invalid.
   */
  readSummary(id: string): MemoryDoc
  /**
   * Gracefully drain (then tree-kill) a board's PTY before it is removed (T3.2).
   * MAIN injects `pty.ts`'s `drainPty`; a non-terminal / absent id resolves to a
   * no-op. Always resolves — close is best-effort graceful, never throws on the PTY.
   */
  drainPty(id: string): Promise<void>
  /**
   * 🔒 Write `text` into a terminal board's PTY (T4.3 dispatch). MAIN injects
   * `pty.ts`'s `writeToPty`; a non-terminal / absent id returns false (no write). The
   * orchestrator calls this ONLY after id-resolution + terminal-check + a single-use
   * nonce + a human confirm + an audit entry have authorized it.
   */
  writeToPty(id: string, text: string): boolean
  /**
   * 🔒 Block on a mandatory human confirm (T4.2). MAIN injects `requestConfirm`
   * (fail-closed everywhere); resolves `{ approved }` only on an explicit human yes.
   * The decision authority is the human via our own trusted UI — never the
   * worker-originated content that prompted the dispatch. P5: a request may carry a bounded
   * `choices` chooser, and the decision then carries the human's `choice` (the requesting gate
   * re-validates it against the offered set — see `ConfirmChoices`).
   */
  confirm(req: ConfirmRequest): Promise<ConfirmDecision>
  /**
   * 🔒 Append one dispatch audit entry (T4.1). MAIN injects `getAuditLog().append`.
   * Every dispatch attempt — rejected / denied / failed / completed — is recorded with
   * the resolved target, full prompt, and nonce before/after the action runs.
   */
  audit(input: AuditInput): Promise<void>
  /**
   * 🔒 Record a board's structured last result (T4.4 `write_result`). MAIN injects
   * `boardResults.ts`'s `recordBoardResult`, which feeds `canvas://board/{id}/result`
   * (T1.5). The caller binds `id` to the worker's own token-bound board, so a worker can
   * only write its own result. No PTY write, no confirm — the agent reports its outcome.
   */
  recordResult(id: string, result: BoardResult): void
  /**
   * PR-2: read-only working-tree diff for a board. MAIN injects gitDiff.ts's `boardGitDiff`,
   * which resolves the board's resolved spawn cwd (pty.ts `getTerminalCwd`) and runs `simple-git`
   * (MAIN-only, read-only). The orchestrator owns board-resolution + terminal-check + the output
   * bound (GITDIFF_MAX_BYTES); this returns the raw diff ('' for a non-repo / unknown cwd).
   * Optional so a registry/test that does not wire it keeps the "unavailable" behaviour.
   */
  gitDiff?(id: string): Promise<string>
}

/**
 * Coarse status bucket for a board (T1.1). The renderer-supplied `status` bucket
 * wins — it is derived from the live runtime stores (terminalRuntimeStore +
 * previewStore) and is the single source of truth shared with the on-canvas pill.
 * When the mirror carries no bucket (a renderer predating T1.1, or a board not yet
 * republished), fall back to a bucket derived from MAIN's own signals: the PTY
 * session map for terminals, presence for the rest. The fallback is intentionally
 * coarse — `running` only when the PTY is live, otherwise `idle`; `browser` is
 * `idle` (presence, not liveness — a crashed browser still reads idle here);
 * `planning` and any forward/unknown type are `static`.
 *
 * `sessionStatusFor` is consulted ONLY on the terminal-fallback branch, so the caller
 * passes a LAZY lookup ({@link makeSessionLookup}) that reads `listSessions()` at most
 * once and only when a terminal-without-mirror-status is actually derived — the common
 * status read (mirror status present, or a non-terminal board) never touches the PTY map.
 */
export function deriveStatus(
  board: { id: string; type: string; status?: string },
  sessionStatusFor: (id: string) => string | undefined
): string {
  if (board.status) return board.status
  if (board.type === 'terminal')
    return sessionStatusFor(board.id) === 'running' ? 'running' : 'idle'
  if (board.type === 'browser') return 'idle'
  return 'static'
}

/**
 * Build a LAZY per-call session-status resolver for {@link deriveStatus}. The PTY session
 * map is materialised from `listSessions()` at most once — on the FIRST terminal lookup —
 * and never at all when no terminal-without-mirror-status board is derived. Build a fresh
 * one per logical status read so it always reflects the LIVE sessions (BUG-008: the
 * handoff await-idle re-resolves the live status on every wake — a stale snapshot must
 * never be reused), never a captured snapshot.
 */
export function makeSessionLookup(
  listSessions: () => Array<{ id: string; status: string }>
): (id: string) => string | undefined {
  let map: Map<string, string> | null = null
  return (id) => {
    if (!map) map = new Map(listSessions().map((s) => [s.id, s.status]))
    return map.get(id)
  }
}
