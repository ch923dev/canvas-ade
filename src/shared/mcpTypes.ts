/**
 * Cross-bundle MCP type contract — TYPE-ONLY.
 *
 * Imported by both MAIN (`src/main/`) and the renderer (`src/renderer/src/`) as
 * `import type { … } from '../shared/mcpTypes'` (MAIN) / `'../../../shared/mcpTypes'`
 * (renderer depth). Contains NO value exports and NO Node/Electron/DOM imports — so it
 * compiles cleanly under tsconfig.node, tsconfig.preload, and tsconfig.web, and is erased
 * entirely at build time (no `require()`/`import()` in any output bundle).
 *
 * Single source of truth for:
 *   McpCommand                 — the MAIN → renderer control-plane union
 *   McpCommandAck              — the renderer → MAIN ack
 *   PlanningOp / PlanningOpTint — planning-element write-op types
 *   AuditEntry / AuditInput    — MCP dispatch audit-trail entry shapes
 *
 * 🔒 Do not add value exports or Node/DOM/Electron imports to this file. A value export
 * would be bundled into the renderer; if it transitively pulled in MAIN's Node built-ins
 * the renderer bundle would break. Keeping this file declaration-only is the safeguard.
 *
 * (W1-D / F9: extracted from the formerly hand-mirrored copies in `src/main/mcpCommand.ts`,
 * `src/main/auditLog.ts`, `src/renderer/src/store/useMcpCommands.ts`,
 * `src/renderer/src/store/planningMcpApply.ts`, and `src/renderer/src/canvas/AuditLogViewer.tsx`.)
 */

// ── Planning op types (formerly hand-mirrored in mcpCommand.ts + planningMcpApply.ts) ──

/** Note tint a `note` op carries (mirrors the renderer `NoteTint`). */
export type PlanningOpTint = 'yellow' | 'blue' | 'green' | 'plain'

/**
 * One SANITIZED, fully-normalized planning-element write op (S2), MAIN → renderer. The
 * orchestrator's `addPlanningElements` validates + sanitizes + caps the agent's content
 * BEFORE minting these (so the renderer receives clean, fully-specified ops: `tint` and
 * item `done` are no longer optional). The renderer materializes each into a full
 * `PlanningElement` — minting ids, stacking positions below existing content, and default
 * sizes — and re-validates against the schema (defense in depth) before it lands. The schema
 * kinds that carry agent content are expressible (note · checklist · text · arrow · diagram); a
 * `diagram` carries a Mermaid `source` the renderer materializes into a `DiagramElement` (host
 * schema v11) and renders to a themed SVG in the sandboxed worker. 🔒 Untrusted passive content:
 * it renders, never auto-arms an action.
 *
 * Every op may carry an optional sanitized `section` (2a) — a short column label MAIN passes
 * through from the agent. The renderer groups ops by `section` and lays out one column per section
 * (first-appearance order). Layout-only: it drives `x/y` at materialize time and is never persisted
 * on the resulting `PlanningElement` (so no schema bump). Absent everywhere → the renderer's masonry.
 */
export type PlanningOp =
  | { kind: 'note'; text: string; tint: PlanningOpTint; section?: string }
  | {
      kind: 'checklist'
      title: string
      items: Array<{ label: string; done: boolean }>
      section?: string
    }
  | { kind: 'text'; text: string; section?: string }
  | { kind: 'arrow'; dx: number; dy: number; section?: string }
  | { kind: 'diagram'; source: string; section?: string }

// ── Kanban card op types (P3 — MCP card mutation, MAIN → renderer) ──

/**
 * One SANITIZED Kanban card write op (P3), MAIN → renderer. The orchestrator's addCard / moveCard /
 * updateCard / removeCard resolves + kanban-checks the board, validates + sanitizes + caps the
 * agent's content, and MINTS the card id (for `add`) BEFORE minting these — so the renderer receives
 * clean, fully-specified ops. The renderer's applier re-validates (board exists + is kanban, the
 * target column/card exists) as defense in depth, then commits via `updateBoard` (the
 * `PATCHABLE_KEYS.kanban` `cards` key) as one undoable edit. 🔒 Untrusted passive content: a card
 * renders on the board, never auto-arms an action.
 *
 * - `add` carries the FULLY-SPECIFIED card (host-minted id + the target column + sanitized chips).
 * - `move` re-parents an existing card to another column (`toColumnId`).
 * - `update` merges the supplied fields onto an existing card (only present keys change).
 * - `remove` deletes an existing card by id.
 */
export type KanbanOp =
  | {
      op: 'add'
      card: {
        id: string
        columnId: string
        title: string
        tag?: string
        assignee?: string
        ref?: string
      }
    }
  | { op: 'move'; cardId: string; toColumnId: string }
  | {
      op: 'update'
      cardId: string
      patch: { title?: string; tag?: string; assignee?: string; ref?: string }
    }
  | { op: 'remove'; cardId: string }

// ── Plan-visualization types (P5 — visualize_plan, MAIN → renderer) ──

/** The layout shapes `visualize_plan` renders a plan into (P5) — the confirm-gate chooser options. */
export type Visualization = 'kanban' | 'grid' | 'checklist' | 'columns'

/**
 * One SANITIZED plan item (P5), MAIN → renderer. The orchestrator's `visualizePlan` validates +
 * sanitizes + caps the agent's flat plan and the human PICKS the shape in the confirm chooser BEFORE
 * MAIN mints the `visualizePlan` command carrying these. The renderer groups items by `status` into
 * kanban columns / `columns` sections and materializes the chosen board shape (reusing the planning
 * masonry for grid/checklist/columns), re-validating as defense in depth before it lands. 🔒 Untrusted
 * passive content: the board renders, never auto-arms an action.
 */
export interface PlanItem {
  title: string
  /** Status/stage bucket — groups items into kanban columns / `columns` sections. Absent ⇒ a default lane. */
  status?: string
  /** Free-text type chip (kanban card / note tag hint). */
  tag?: string
  /** Assignee agent-preset id — the kanban card dot. */
  assignee?: string
  /** Optional longer note body (grid/columns notes; ignored by kanban/checklist). */
  note?: string
}

// ── Command union (formerly hand-mirrored in mcpCommand.ts + useMcpCommands.ts) ──

/**
 * Control-plane command envelope, MAIN → renderer — the inverse of the `mcp:boards`
 * mirror (which carries board facts renderer → MAIN). This is how the MCP layer *drives*
 * the canvas once it gains write tools. MAIN's `sendMcpCommand` serializes a value of this
 * type; the renderer's `applyMcpCommand` switches on it and acks on the CSPRNG reply channel.
 *
 * Adding a variant here propagates the type error to BOTH sides simultaneously — the
 * compile-time safety this shared module exists to enforce (W1-D / F9).
 *
 * - `addBoard` carries only a MINIMAL spec (id + type + optional title/launchCommand/cwd), NOT a
 *   full PersistedBoard: MAIN mints the id but does not know canvas geometry, so the renderer builds
 *   the full board (free-slot placement, per-type defaults) from this spec. `board.type` is a loose
 *   `string` (MAIN is the sender and does not import renderer types); the renderer re-validates it
 *   against its SPAWNABLE allowlist at runtime (defense in depth — the value crosses IPC as JSON
 *   anyway). `board.title` (2b) is the agent-chosen display name, already sanitized + clamped by
 *   MAIN (`mcpLifecycle.spawnBoard`); absent ⇒ the renderer uses the per-type default title.
 *   `board.launchCommand`/`board.cwd` are TERMINAL-ONLY (the spawn_board `prompt`/`cwd` params —
 *   the same first-PTY-line delivery `spawnGroup.members.terminal` uses): MAIN sanitized the
 *   launchCommand to a single ≤400-char PTY-safe line and rejected either field on a non-terminal
 *   type BEFORE sending; the renderer re-validates both (defense in depth) and lands them on the
 *   created board so `useTerminalSpawn` boots the CLI at first spawn. `cwd` is never executed
 *   (pty `safeCwd` stats it and falls back to the home directory). `connector` (rc.6 auto-cable)
 *   asks the renderer to ALSO create a directed ORCHESTRATION connector `sourceId → <new board>`:
 *   MAIN only includes it when the spawn is a terminal, the source resolves to a live TERMINAL in
 *   the mirror, and the sourceId is the spawning agent's own token-derived board id (unforgeable —
 *   the package tool passes ctx.boardId, never client input), so a connected terminal can
 *   immediately `relay_prompt` into the terminal it spawned. The renderer re-validates (terminal-
 *   only, source exists) and `addConnector` itself still rejects self/dup/missing endpoints; the
 *   cable stays visible + deletable on canvas, and every relay still pays the human confirm.
 * - `removeBoard` (T3.2) tears one down by id.
 * - `configureBoard` (T3.3) changes a board's durable per-type config (the renderer applies it
 *   through `updateBoard`, which filters to PATCHABLE_KEYS).
 * - `patchPlanning` (S2) appends agent-authored CONTENT (notes/checklists/text/arrows) to a
 *   planning board's `elements`; the ops are already validated + sanitized + capped + human-
 *   confirmed by the orchestrator before this carries them.
 * - `patchKanban` (P3) mutates a KANBAN board's `cards` — add / move / update / remove, one or more
 *   ops per confirmed call. The orchestrator resolved + kanban-checked the board, minted any new card
 *   id, and human-confirmed the ops before this carries them; the renderer re-validates + applies.
 * - `visualizePlan` (P5) CREATES a new board from a flat plan in the shape the human picked in the
 *   confirm chooser (kanban/grid/checklist/columns). MAIN minted the board id, sanitized + capped the
 *   items, and confirmed the choice before this carries them; the renderer builds the fully-populated
 *   board (kanban columns+cards, or a planning board via the masonry) + tidies it into open space in
 *   ONE undoable step. Content-only like `patchPlanning` — the board renders, nothing runs.
 * - `spawnGroup` (PR-5b) creates a whole feature-zone cluster — a terminal (always) + an
 *   optional planning + browser member, plus a Named Group over them and the browser→terminal
 *   preview wiring — in ONE undoable step. MAIN mints every id (so the tool can return them and
 *   later lifecycle tools can address each member); the renderer lays out the cluster (free-slot
 *   placement, per-type defaults) and folds the browser's `previewSourceId` onto the terminal.
 *   Content-less like `addBoard` (empty boards), so it is cap-checked, not human-gated.
 * - `tidyBoards` (P2) repositions the WHOLE canvas into a clean, non-overlapping arrangement via the
 *   existing `canvasStore.tidyBoards` action (`smart`/`by-type`/`grid`). Reposition-only + content-less
 *   (never resizes/creates/deletes a board); `tidyBoards` is ALREADY one undoable `trackedChange` step
 *   that no-ops when nothing moved, so the renderer applier calls it directly (no `beginChange`
 *   wrapper). The applier re-validates `mode` (defense in depth) and reports the moved count on the ack.
 */
export type McpCommand =
  | { type: 'ping' }
  | {
      type: 'addBoard'
      board: { id: string; type: string; title?: string; launchCommand?: string; cwd?: string }
      connector?: { sourceId: string }
    }
  | { type: 'removeBoard'; id: string }
  | {
      type: 'configureBoard'
      id: string
      patch: { shell?: string; launchCommand?: string; cwd?: string }
    }
  | { type: 'patchPlanning'; id: string; ops: PlanningOp[] }
  | { type: 'patchKanban'; id: string; ops: KanbanOp[] }
  | {
      type: 'visualizePlan'
      id: string
      visualization: Visualization
      title?: string
      items: PlanItem[]
    }
  | {
      type: 'spawnGroup'
      group: { id: string; name: string }
      members: {
        // Phase C: the terminal member may boot an agentic CLI (sanitized to a single line in
        // `mcpLifecycle.spawnGroup`) so a dispatched prompt reaches an agent, not a bare shell.
        terminal: { id: string; launchCommand?: string }
        planning?: { id: string }
        browser?: { id: string }
      }
    }
  | { type: 'tidyBoards'; mode?: 'smart' | 'by-type' | 'grid' }

/**
 * The renderer's reply to a McpCommand. `type` echoes the handled command. The optional `moved` (P2)
 * rides on a successful `tidyBoards` ack — the count of boards whose position changed (0 ⇒ already
 * tidy) — so the host can surface it to the agent; absent on every other command.
 */
export type McpCommandAck =
  | { ok: true; type: string; moved?: number }
  | { ok: false; error: string }

// ── Audit entry types (formerly hand-mirrored in auditLog.ts + AuditLogViewer.tsx) ──

/** The unstamped input shape callers hand to `AuditLog.append` (seq + ts are stamped there). */
export interface AuditInput {
  /** The dispatch tool that produced this entry (e.g. 'handoff_prompt', 'interrupt'). */
  type: string
  /** The RESOLVED opaque server board id the action targeted (never a user label). */
  targetId: string
  /** The full prompt text written to the target PTY ('' for a content-less action). */
  prompt: string
  /** The single-use nonce that authorized this dispatch (T4.3). */
  nonce: string
  /** Outcome bucket; defaults to 'dispatched' when the entry is recorded pre-result. */
  status?: string
  /** Captured output / result text, when the action produced one. */
  outputs?: string
  /** Free-form extra context (e.g. a rejection reason). */
  detail?: string
}

/** One persisted (JSONL) MCP dispatch audit entry — the stamped, fully-formed record. */
export interface AuditEntry {
  /** Monotonic, gap-free sequence across the life of the log (replay/order evidence). */
  seq: number
  ts: number
  type: string
  targetId: string
  prompt: string
  nonce: string
  status: string
  outputs?: string
  detail?: string
}
