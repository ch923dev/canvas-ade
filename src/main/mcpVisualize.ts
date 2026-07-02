import type { PlanItem, Visualization } from './mcpCommand'

/**
 * 🔒 MAIN-side validation, sanitization, and caps for an agent-authored plan (P5, `visualize_plan`).
 *
 * `visualize_plan` writes attacker-influenceable content onto the durable canvas (ADR 0003), the same
 * class as `add_planning_elements` / the Kanban card tools. The @expanse-ade/mcp tool schema is a first
 * (transport) check, but MAIN is the authority — it re-validates every field, collapses the short
 * fields (title/status/tag/assignee) to safe SINGLE-LINE labels, keeps the note multi-line but strips
 * control chars + caps it, and bounds the item count. The cleaned plan is shown to the human IN FULL
 * via the confirm chooser before any board is created; the renderer applier re-validates before it
 * lands (defense in depth). MAIN mints the board id (an agent can never forge/collide one), and the
 * shape is the option the HUMAN picked in the chooser (re-validated against {@link VISUALIZATIONS}).
 */

/** A content rejection — the orchestrator audits it `rejected` and throws. */
export class VisualizeContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisualizeContentError'
  }
}

// ── Caps (MAIN-authoritative; the package mirrors matching transport caps) ──────────
export const MAX_PLAN_ITEMS = 100
export const MAX_PLAN_ITEM_TITLE = 200
export const MAX_PLAN_ITEM_STATUS = 60
export const MAX_PLAN_ITEM_TAG = 40
export const MAX_PLAN_ITEM_ASSIGNEE = 40
export const MAX_PLAN_ITEM_NOTE = 2000
export const MAX_PLAN_TITLE = 200
/**
 * Max total byte size (UTF-8) of the cleaned items, mirroring MAX_PLANNING_BYTES in
 * mcpPlanning.ts — kept small enough that the FULL content stays human-reviewable in the
 * confirm modal. Bounds canvas.json / undo-snapshot growth per call.
 */
export const MAX_PLAN_BYTES = 16 * 1024

/** The layout shapes `visualize_plan` may render into. The chooser's option set; MAIN re-validates
 *  the human's pick against this so a forged `choice` can never produce an off-shape board. */
export const VISUALIZATIONS = ['kanban', 'grid', 'checklist', 'columns'] as const

/** Human-readable chooser labels (kept beside the ids so the modal + the confirm body stay in sync). */
export const VISUALIZATION_LABEL: Record<Visualization, string> = {
  kanban: 'Kanban',
  grid: 'Grid',
  checklist: 'Checklist',
  columns: 'Columns'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True if a code point is a C0/DEL/C1 control (the terminal-escape / injection surface). */
function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/**
 * Reduce one short agent field (title / status / tag / assignee) to a safe, bounded SINGLE-LINE label:
 * collapse ALL whitespace (incl. newlines/tabs) to single spaces so it can't forge extra confirm-body
 * lines, strip C0/C1/DEL controls, trim, require non-empty, and clamp. Throws {@link VisualizeContentError}.
 */
export function sanitizeLabel(raw: unknown, max: number, field: string): string {
  if (typeof raw !== 'string') throw new VisualizeContentError(`${field} must be a string`)
  let out = ''
  for (const ch of raw.replace(/\s+/g, ' ')) {
    if (!isControl(ch.codePointAt(0) ?? 0)) out += ch
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) throw new VisualizeContentError(`${field} is empty after sanitization`)
  if (trimmed.length > max)
    throw new VisualizeContentError(`${field} exceeds the ${max}-char limit`)
  return trimmed
}

/**
 * Sanitize a MULTI-LINE note: strip C0/C1/DEL control chars EXCEPT newline (a note is legitimately
 * multi-line prose), collapse runs of 3+ blank lines (padded whitespace can't push real content out of
 * the scrollable confirm viewport), trim, require non-empty, and clamp. Throws on violation.
 */
export function sanitizeNote(raw: unknown, max: number, field: string): string {
  if (typeof raw !== 'string') throw new VisualizeContentError(`${field} must be a string`)
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\n' || !isControl(code)) out += ch
  }
  const cleaned = out.replace(/\n{3,}/g, '\n\n').trim()
  if (cleaned.length === 0) throw new VisualizeContentError(`${field} is empty after sanitization`)
  if (cleaned.length > max)
    throw new VisualizeContentError(`${field} exceeds the ${max}-char limit`)
  return cleaned
}

/** One clean, fully-validated plan item + optional board title, ready to hand to the renderer. */
export interface CleanPlan {
  title?: string
  items: PlanItem[]
}

/** Validate + sanitize + cap an agent plan into a {@link CleanPlan}. Throws on any violation (no
 *  partial writes) — a malformed/oversized plan is rejected BEFORE the human gate. */
export function buildPlanItems(rawItems: unknown, rawTitle: unknown): CleanPlan {
  if (!Array.isArray(rawItems)) throw new VisualizeContentError('items is not an array')
  if (rawItems.length === 0) throw new VisualizeContentError('no items to visualize')
  if (rawItems.length > MAX_PLAN_ITEMS) {
    throw new VisualizeContentError(`too many items (${rawItems.length} > ${MAX_PLAN_ITEMS})`)
  }
  const items = rawItems.map((raw, i) => {
    if (!isRecord(raw)) throw new VisualizeContentError(`item ${i} is not an object`)
    const item: PlanItem = {
      title: sanitizeLabel(raw.title, MAX_PLAN_ITEM_TITLE, `item[${i}].title`)
    }
    if (raw.status !== undefined) {
      item.status = sanitizeLabel(raw.status, MAX_PLAN_ITEM_STATUS, `item[${i}].status`)
    }
    if (raw.tag !== undefined)
      item.tag = sanitizeLabel(raw.tag, MAX_PLAN_ITEM_TAG, `item[${i}].tag`)
    if (raw.assignee !== undefined) {
      item.assignee = sanitizeLabel(raw.assignee, MAX_PLAN_ITEM_ASSIGNEE, `item[${i}].assignee`)
    }
    if (raw.note !== undefined) {
      item.note = sanitizeNote(raw.note, MAX_PLAN_ITEM_NOTE, `item[${i}].note`)
    }
    return item
  })
  const clean: CleanPlan = { items }
  if (rawTitle !== undefined) clean.title = sanitizeLabel(rawTitle, MAX_PLAN_TITLE, 'title')
  const bytes = Buffer.byteLength(JSON.stringify(clean), 'utf8')
  if (bytes > MAX_PLAN_BYTES) {
    throw new VisualizeContentError(`content too large (${bytes} > ${MAX_PLAN_BYTES} bytes)`)
  }
  return clean
}

/** Resolve the agent's suggested shape to a valid {@link Visualization}; unknown/absent ⇒ `grid`
 *  (a neutral, always-valid default — the human still picks the final shape in the chooser). */
export function resolveVisualization(suggested: unknown): Visualization {
  return (VISUALIZATIONS as readonly string[]).includes(suggested as string)
    ? (suggested as Visualization)
    : 'grid'
}

/** Indent every continuation line of a multi-line field so it can't forge a top-level "• " bullet. */
function confirmField(text: string, indent: string): string {
  return text.replace(/\n/g, `\n${indent}`)
}

/**
 * Render the FULL plan for the write-time confirm body — every item's title + chips + note, grouped by
 * status (in first-appearance order), so injected content is visible and can't be rubber-stamped (never
 * a bare count, ADR 0003). The layout is the human's to pick (the chooser), so the body only describes
 * the CONTENT + the suggestion. Every field is already single-line (title/status/tag/assignee) or
 * indent-guarded (note), so none can forge additional body lines.
 */
export function renderVisualizeConfirmBody(plan: CleanPlan, suggested: Visualization): string {
  const lines: string[] = [
    `The agent wants to visualize a ${plan.items.length}-item plan as a new board on the canvas` +
      ` (renders as passive content — nothing runs).`,
    `Suggested layout: ${VISUALIZATION_LABEL[suggested]}. Pick the layout below.`,
    ''
  ]
  if (plan.title) lines.push(`Board title: ${plan.title}`, '')
  // Group by status in first-appearance order (matches the kanban/columns materialization).
  const order: string[] = []
  const groups = new Map<string, PlanItem[]>()
  for (const it of plan.items) {
    const key = it.status ?? ''
    let g = groups.get(key)
    if (!g) {
      g = []
      groups.set(key, g)
      order.push(key)
    }
    g.push(it)
  }
  for (const key of order) {
    lines.push(key ? `[${key}]` : '[no status]')
    for (const it of groups.get(key) as PlanItem[]) {
      const chips = [it.tag, it.assignee ? `@${it.assignee}` : undefined].filter(Boolean)
      const suffix = chips.length ? `  (${chips.join(' · ')})` : ''
      lines.push(`  • ${it.title}${suffix}`)
      if (it.note) lines.push(`      ${confirmField(it.note, '      ')}`)
    }
  }
  return lines.join('\n')
}
