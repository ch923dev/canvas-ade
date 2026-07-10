/**
 * 🔒 PR-3: the read-only "app self-model" — the hybrid agency layer of the Command board.
 *
 * A single self-describing object the orchestrator/agent reasons over: the board TYPES (what each
 * is for + which tools operate on it), the TOOL catalog (name/purpose/tier), the LIVE canvas
 * (boards/connectors/groups), and the orchestration RULES (spawn cap, the every-write-is-gated
 * invariant). It turns decomposition/routing from a hardcoded recipe into reasoned planning
 * grounded in the actual app — while the scripted state machine stays the safety envelope and
 * every cross-board write still pays `runGatedWrite`. Agency lives in the what/why; the gate
 * governs the do.
 *
 * This module is PURE (no electron / @expanse-ade/mcp imports): the static tables are constants and
 * `buildAppModel` takes the live data injected by the orchestrator, so it unit-tests in isolation
 * (mirrors gitDiff.ts's injected-dep discipline). It is exposed app-side via `orchestrator.describeApp`
 * + the CANVAS_E2E seam, AND over the loopback wire as the agent-facing `canvas://app-model` resource
 * (W1-G / C1, @expanse-ade/mcp ≥0.15.0 — orchestrator-tier), which wraps this same builder.
 *
 * Static-table maintenance: `APP_BOARD_TYPES` + `APP_TOOLS` MIRROR the renderer board-type union
 * (`boardSchema.ts` `BoardType`) and the `@expanse-ade/mcp` tool registration (as of 0.15.0). When a
 * board type or tool is added/removed in those, update the matching table here — the
 * `appModelDrift.test.ts` guard (F25) fails the build if `APP_TOOLS` drifts from what the package
 * actually registers for an orchestrator session.
 */

/** The minimum token tier that can call a tool. Mirrors the package `Tier` (worker scopes = read-only). */
export type ToolTier = 'orchestrator' | 'worker'

/** One MCP tool, described for the agent: what it does + the minimum tier that can call it. */
export interface AppModelTool {
  name: string
  purpose: string
  tier: ToolTier
}

/** A board TYPE and its capabilities (static metadata; not a board instance). */
export interface AppModelBoardType {
  type: string
  purpose: string
  /** Tool names (from {@link AppModelTool}) that operate on / produce this board type. */
  tools: string[]
  /** Coarse status buckets a board of this type can report (descriptive). */
  states: string[]
  /** Can the orchestrator seed this board's initial content/command via MCP? */
  seedable: boolean
  /** Automatic wiring behaviour, or null. e.g. browser's runtime port-detect -> push-to-preview. */
  autowire: string | null
}

/** A live board instance (projected from the orchestrator's board mirror). */
export interface AppModelBoard {
  id: string
  type: string
  title: string
  status: string
  agentKind?: string
  monitorActivity?: boolean
  /** P1 canvas awareness: world-space geometry (top-left x/y + size w/h), so an orchestrator
   *  reasoning over the self-model sees where each board sits + how big it is. Absent pre-P1. */
  x?: number
  y?: number
  w?: number
  h?: number
}

/** A live board-to-board connector (directional: source -> target). */
export interface AppModelConnector {
  id: string
  sourceId: string
  targetId: string
  kind: string
}

/** A live Named Group (a feature zone). Empty until PR-5 mirrors groups to MAIN. */
export interface AppModelGroup {
  id: string
  name: string
  boardIds: string[]
}

/** The orchestration rules the agent must plan within. */
export interface AppModelRules {
  /** Hard cap on live MCP-spawned boards (the runaway-swarm guard). */
  spawnCap: number
  /** Invariant: EVERY cross-board write pays `runGatedWrite` (sanitize -> nonce -> confirm -> audit). */
  everyWriteGated: true
}

/** The full read-only app self-model. `version` lets a consumer reason about shape evolution. */
export interface AppModel {
  version: 1
  boardTypes: AppModelBoardType[]
  tools: AppModelTool[]
  canvas: {
    boards: AppModelBoard[]
    connectors: AppModelConnector[]
    /** [] until PR-5 mirrors Named Groups to MAIN. */
    groups: AppModelGroup[]
  }
  rules: AppModelRules
}

/**
 * The MCP tool catalog, mirrored from `@expanse-ade/mcp` (0.11.0) tool registration. `tier` is the
 * minimum token tier that can call the tool: worker tokens hold only `read` scope, so `ping` +
 * `write_result` are the only worker-callable tools; everything that spawns/dispatches/diffs needs
 * orchestrator scope. (git_diff is read-only but registered orchestrator-tier.)
 */
export const APP_TOOLS: readonly AppModelTool[] = [
  { name: 'spawn_board', purpose: 'Create a board on the canvas.', tier: 'orchestrator' },
  {
    name: 'spawn_group',
    purpose: 'Spawn a feature-zone cluster (terminal + optional planning/browser + Named Group).',
    tier: 'orchestrator'
  },
  { name: 'tidy_canvas', purpose: 'Reposition-pack all boards; un-gated.', tier: 'orchestrator' },
  {
    name: 'focus_viewport',
    purpose: "Move the user's camera to a board / a Named Group / fit-all; un-gated.",
    tier: 'orchestrator'
  },
  {
    name: 'close_board',
    purpose: 'Remove a board (human-confirm gated; graceful PTY drain first).',
    tier: 'orchestrator'
  },
  {
    name: 'configure_board',
    purpose: 'Persist a board shell/cwd/launchCommand (gated when launchCommand is set).',
    tier: 'orchestrator'
  },
  {
    name: 'handoff_prompt',
    purpose: 'Dispatch a prompt and await the board settling idle (gated).',
    tier: 'orchestrator'
  },
  {
    name: 'assign_prompt',
    purpose: 'Fire-and-forget dispatch a prompt to a board (gated).',
    tier: 'orchestrator'
  },
  {
    name: 'relay_prompt',
    purpose: 'Relay a prompt board->board over an orchestration connector (gated).',
    tier: 'orchestrator'
  },
  {
    name: 'relay_prompts',
    purpose:
      'Relay N prompts board->board in one batch over orchestration connectors (per-row human-confirm gated).',
    tier: 'orchestrator'
  },
  { name: 'interrupt', purpose: 'Send Ctrl-C to a terminal board (gated).', tier: 'orchestrator' },
  {
    name: 'add_planning_elements',
    purpose: 'Seed planning elements into a planning board (gated; flag-gated off by default).',
    tier: 'orchestrator'
  },
  {
    name: 'update_planning_element',
    purpose:
      'Edit ONE existing planning element in place by id — note/text/checklist/diagram/arrow (gated; flag-gated off by default).',
    tier: 'orchestrator'
  },
  {
    name: 'remove_planning_element',
    purpose: 'Remove ONE planning element by id (gated; flag-gated off by default).',
    tier: 'orchestrator'
  },
  {
    name: 'add_card',
    purpose: 'Add a card to a Kanban board column (gated; flag-gated off by default).',
    tier: 'orchestrator'
  },
  {
    name: 'move_card',
    purpose: 'Move a Kanban card to another column (gated; flag-gated off by default).',
    tier: 'orchestrator'
  },
  {
    name: 'update_card',
    purpose: 'Update fields on a Kanban card (gated; flag-gated off by default).',
    tier: 'orchestrator'
  },
  {
    name: 'remove_card',
    purpose: 'Remove a card from a Kanban board (gated; flag-gated off by default).',
    tier: 'orchestrator'
  },
  {
    name: 'visualize_plan',
    purpose:
      'Propose a plan visualization; the human picks the layout and a new board is created (gated).',
    tier: 'orchestrator'
  },
  { name: 'wait_for_idle', purpose: 'Block until a board settles idle.', tier: 'orchestrator' },
  {
    name: 'wait_for_all',
    purpose: 'Block until all tracked boards settle idle.',
    tier: 'orchestrator'
  },
  { name: 'orchestrator_ping', purpose: 'Orchestrator-tier liveness check.', tier: 'orchestrator' },
  {
    name: 'git_diff',
    purpose: 'Read-only working-tree diff for a terminal board.',
    tier: 'orchestrator'
  },
  {
    name: 'write_result',
    purpose: 'A worker records its OWN board result (status/summary/refs).',
    tier: 'worker'
  },
  { name: 'ping', purpose: 'Worker-tier liveness check.', tier: 'worker' }
]

/**
 * The board-type capability table, mirrored from `boardSchema.ts` `BoardType`. The `command` board
 * (Phase A) is the orchestrator's OWN singleton dock board — listed for self-model completeness (a
 * canvas can contain one) but NOT agent-spawnable and with no tools targeting it. `autowire` for
 * browser is the shipped runtime port-detect -> push-to-preview (Slice C').
 */
export const APP_BOARD_TYPES: readonly AppModelBoardType[] = [
  {
    type: 'terminal',
    purpose: 'A live CLI coding agent running in a real shell.',
    tools: [
      'spawn_board',
      'spawn_group',
      'configure_board',
      'handoff_prompt',
      'assign_prompt',
      'interrupt',
      'git_diff',
      'write_result',
      'close_board'
    ],
    states: ['running', 'idle', 'exited'],
    seedable: true, // launchCommand (the first PTY line on spawn)
    autowire: null
  },
  {
    type: 'browser',
    purpose: 'A responsive preview of the running localhost app in a device frame.',
    tools: ['spawn_board', 'close_board'],
    states: ['idle'],
    seedable: false,
    autowire: 'port-detect->preview'
  },
  {
    type: 'planning',
    purpose: 'A whiteboard: notes, arrows, text, freehand, and checklists.',
    tools: [
      'spawn_board',
      'add_planning_elements',
      'update_planning_element',
      'remove_planning_element',
      'close_board'
    ],
    states: ['static'],
    seedable: true, // add_planning_elements (flag-gated)
    autowire: null
  },
  {
    type: 'command',
    purpose:
      "The orchestrator's own dock board: dispatches tasks to worker groups and collects their results. Singleton; user-created, NOT agent-spawnable.",
    tools: [], // no agent tool targets the command board — it IS the orchestrator's face
    states: ['static'],
    seedable: false,
    autowire: null
  },
  {
    // file-tree S5: a human-created, read-only context surface. NOT agent-spawnable (no MCP tool
    // seeds a file board) and not seedable; an agent READS which file it points at via the file
    // board's `path` on `canvas://boards`, and may close it. File CONTENT is never on this model.
    type: 'file',
    purpose:
      'A project file shown on the canvas (CodeMirror viewer/editor). Human-created context; an agent reads its path via canvas://boards. NOT agent-spawnable.',
    tools: ['close_board'],
    states: ['static'],
    seedable: false,
    autowire: null
  },
  {
    // P4: a Kanban board is never directly spawn_board-able (SPAWNABLE excludes 'kanban') — the only
    // way one lands on the canvas is the human picking the "kanban" layout in the visualize_plan
    // chooser, which mints the board AND seeds its initial columns/cards in one gated call. Once it
    // exists, the flag-gated card tools operate on it (mcpBoardCards.ts / mcpKanbanGate.ts).
    type: 'kanban',
    purpose:
      'A Kanban board: cards organized into columns (renders as passive cards; nothing runs).',
    tools: ['visualize_plan', 'add_card', 'move_card', 'update_card', 'remove_card', 'close_board'],
    states: ['static'],
    seedable: true, // visualize_plan seeds the initial columns/cards as part of creation
    autowire: null
  },
  {
    // JD-4: a network-request graph bound to a Browser board's `osrNetworkStore` capture. Like
    // 'file', it is a human-created context surface (Browser devtools -> "Visualize network") — NOT
    // agent-spawnable (no MCP tool creates a dataflow board) and not seedable; an agent may close it.
    type: 'dataflow',
    purpose:
      "A network-request graph visualizing a bound Browser board's captured traffic. Human-created context; NOT agent-spawnable.",
    tools: ['close_board'],
    states: ['static'],
    seedable: false,
    autowire: null
  }
]

/** The live data the orchestrator injects into {@link buildAppModel}. */
export interface AppModelInputs {
  boards: AppModelBoard[]
  connectors: AppModelConnector[]
  /** PR-5: the Named Groups mirror. Defaults to [] until groups reach MAIN. */
  groups?: AppModelGroup[]
  rules: AppModelRules
}

/**
 * Assemble the read-only app self-model from the static capability tables + the injected live data.
 * Pure: no IO, no side effects — the orchestrator owns gathering `boards`/`connectors`/`rules`.
 */
export function buildAppModel(inputs: AppModelInputs): AppModel {
  return {
    version: 1,
    boardTypes: APP_BOARD_TYPES.map((t) => ({ ...t, tools: [...t.tools], states: [...t.states] })),
    tools: APP_TOOLS.map((t) => ({ ...t })),
    canvas: {
      boards: inputs.boards,
      connectors: inputs.connectors,
      groups: inputs.groups ?? []
    },
    rules: inputs.rules
  }
}
