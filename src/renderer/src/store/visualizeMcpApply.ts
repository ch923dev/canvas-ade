/**
 * Build a fully-populated board from a sanitized plan (P5, MCP `visualize_plan`). Pure:
 * `buildVisualizedContent` takes the chosen shape + the plan items and returns the board's content
 * (kanban columns+cards, or planning elements) + a fit size — so `useMcpCommands`'s `visualizePlan`
 * handler can place it (free-slot) + insert it as ONE undoable board, and it unit-tests directly.
 *
 * MAIN already validated + sanitized + capped the items and the human PICKED the shape in the confirm
 * chooser; this materializes the board. grid/checklist/columns reuse the planning masonry
 * (`materializePlanningOps`) so a visualized plan lays out exactly like an `add_planning_elements`
 * write; kanban derives its columns from the items' distinct `status` values (first-appearance order).
 * 🔒 Untrusted passive content: the board renders, never auto-arms an action.
 */
import type { PlanItem, PlanningOp, PlanningOpTint, Visualization } from '../../../shared/mcpTypes'
import type { KanbanCard, KanbanColumn, PlanningElement } from '../lib/boardSchema'
import { DEFAULT_KANBAN_COLUMNS } from '../lib/kanbanSchema'
import { materializePlanningOps, neededBoardHeight, neededBoardWidth } from './planningMcpApply'

/** Cumulative cap on items one visualize call may carry (mirrors the host `MAX_PLAN_ITEMS`). */
export const MAX_VISUALIZE_ITEMS = 100

/** The valid visualization ids (runtime mirror of the {@link Visualization} type) for re-validation. */
export const VISUALIZATIONS = ['kanban', 'grid', 'checklist', 'columns'] as const

/** Runtime guard the applier uses to re-validate the command's `visualization` (defense in depth). */
export function isVisualization(v: unknown): v is Visualization {
  return (VISUALIZATIONS as readonly string[]).includes(v as string)
}

// Kanban board sizing: a lane is ~200px; keep a sensible minimum + a fixed height (the board scrolls).
const KANBAN_COL_W = 200
const KANBAN_MIN_W = 560
const KANBAN_H = 520
// Planning board minimum (a small plan still gets a usable board; content grows it beyond this).
const PLANNING_MIN_W = 360
const PLANNING_MIN_H = 260

const newId = (): string => crypto.randomUUID()

/** The materialized board content + fit size the applier places + inserts. */
export interface VisualizedContent {
  kind: 'kanban' | 'planning'
  size: { w: number; h: number }
  /** The board title to use when the agent didn't name the plan (per-shape). */
  defaultTitle: string
  /** Present for `kind:'kanban'`. */
  columns?: KanbanColumn[]
  cards?: KanbanCard[]
  /** Present for `kind:'planning'`. */
  elements?: PlanningElement[]
}

/** Stable column-id slug from a free-text status (e.g. "In Progress" → "in-progress"). */
function slug(status: string): string {
  return status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Map a tag hint to a note tint so a visualized grid/columns reads with colour like the mock. */
function tintFor(tag?: string): PlanningOpTint {
  if (!tag) return 'yellow'
  const t = tag.toLowerCase()
  if (/(done|shipped|complete|completed|ok|pass|merged)/.test(t)) return 'green'
  if (/(decision|info|note|blocked|review|research)/.test(t)) return 'blue'
  return 'yellow'
}

/** True when a status reads as "finished" — drives a checklist item's checked state. */
function isDoneStatus(status?: string): boolean {
  return !!status && /^(done|complete|completed|shipped|closed|merged)$/i.test(status.trim())
}

/** A note's body: the title, plus the optional longer note beneath it. */
function noteText(it: PlanItem): string {
  return it.note ? `${it.title}\n\n${it.note}` : it.title
}

/**
 * Derive kanban columns from the items' distinct `status` values (first-appearance order). No status
 * anywhere → the default lanes (everything in the first). Items without a status land in the first
 * column. Returns the columns + a resolver from an item's status to its column id.
 */
function deriveColumns(items: PlanItem[]): {
  columns: KanbanColumn[]
  columnIdFor: (status?: string) => string
} {
  const statuses: string[] = []
  for (const it of items) {
    if (it.status && !statuses.includes(it.status)) statuses.push(it.status)
  }
  if (statuses.length === 0) {
    const columns = DEFAULT_KANBAN_COLUMNS.map((c) => ({ ...c }))
    const firstId = columns[0].id
    return { columns, columnIdFor: () => firstId }
  }
  const seen = new Set<string>()
  const idByStatus = new Map<string, string>()
  const columns: KanbanColumn[] = statuses.map((s, i) => {
    let id = slug(s) || `col-${i}`
    while (seen.has(id)) id = `${id}-${i}` // dedupe two statuses that slug identically
    seen.add(id)
    idByStatus.set(s, id)
    return { id, title: s }
  })
  const firstId = columns[0].id
  return { columns, columnIdFor: (status) => (status && idByStatus.get(status)) || firstId }
}

function buildKanban(items: PlanItem[]): VisualizedContent {
  const { columns, columnIdFor } = deriveColumns(items)
  const cards: KanbanCard[] = items.map((it) => {
    const card: KanbanCard = { id: newId(), columnId: columnIdFor(it.status), title: it.title }
    if (it.tag !== undefined) card.tag = it.tag
    if (it.assignee !== undefined) card.assignee = it.assignee
    return card
  })
  return {
    kind: 'kanban',
    size: { w: Math.max(KANBAN_MIN_W, columns.length * KANBAN_COL_W), h: KANBAN_H },
    defaultTitle: 'Kanban',
    columns,
    cards
  }
}

/** grid / checklist / columns → planning ops → materialized elements (the planning masonry). */
function buildPlanning(visualization: Visualization, items: PlanItem[]): VisualizedContent {
  let ops: PlanningOp[]
  if (visualization === 'checklist') {
    ops = [
      {
        kind: 'checklist',
        title: 'Checklist',
        items: items.map((it) => ({ label: it.title, done: isDoneStatus(it.status) }))
      }
    ]
  } else {
    // grid → loose masonry (no section); columns → grouped side-by-side by status (section).
    ops = items.map((it) => {
      const base = { kind: 'note' as const, text: noteText(it), tint: tintFor(it.tag) }
      return visualization === 'columns' && it.status ? { ...base, section: it.status } : base
    })
  }
  const elements = materializePlanningOps(ops, [])
  return {
    kind: 'planning',
    size: {
      w: Math.max(PLANNING_MIN_W, neededBoardWidth(elements)),
      h: Math.max(PLANNING_MIN_H, neededBoardHeight(elements))
    },
    defaultTitle: visualization === 'checklist' ? 'Checklist' : 'Plan',
    elements
  }
}

/**
 * Materialize a sanitized plan into board content in the chosen shape. `kanban` builds columns+cards;
 * `grid`/`checklist`/`columns` build planning elements via the shared masonry. Throws on an empty plan
 * (the applier acks `{ok:false}` and nothing lands) — mirrors the planning/kanban re-validate discipline.
 */
export function buildVisualizedContent(
  visualization: Visualization,
  items: PlanItem[]
): VisualizedContent {
  if (items.length === 0) throw new Error('visualizePlan: no items')
  if (items.length > MAX_VISUALIZE_ITEMS) throw new Error('visualizePlan: item cap exceeded')
  return visualization === 'kanban' ? buildKanban(items) : buildPlanning(visualization, items)
}
