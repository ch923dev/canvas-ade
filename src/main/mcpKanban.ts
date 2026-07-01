import type { KanbanOp } from './mcpCommand'

/**
 * 🔒 MAIN-side validation, sanitization, and caps for agent-authored KANBAN card content (P3).
 *
 * The `add_card`/`move_card`/`update_card`/`remove_card` tools write attacker-influenceable content
 * onto the durable canvas (ADR 0003), same class as `add_planning_elements`. The @expanse-ade/mcp
 * tool schema is a first (transport) check, but MAIN is the authority — it re-validates every field,
 * collapses each to a safe SINGLE-LINE label (a card title/chip is not multi-line prose), strips
 * dangerous control chars, and caps lengths. The cleaned op is shown to the human IN FULL via the
 * confirm gate before it reaches the renderer; the renderer applier RE-validates (target column/card
 * exists) before it lands (defense in depth). MAIN mints the card id (for `add`) so an agent can
 * never forge or collide an id.
 */

/** A content rejection — the orchestrator audits it `rejected` and throws. */
export class KanbanContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KanbanContentError'
  }
}

// ── Caps (MAIN-authoritative; the package mirrors matching transport caps) ──────────
export const MAX_CARD_TITLE = 200
export const MAX_CARD_TAG = 40
export const MAX_CARD_ASSIGNEE = 40
export const MAX_CARD_REF = 80
/** Bound on an opaque id/slug an agent supplies (a minted card id, or a column slug it targets). */
export const MAX_CARD_ID = 200
export const MAX_COLUMN_ID = 200

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True if a code point is a C0/DEL/C1 control (the terminal-escape / injection surface). */
function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/**
 * Reduce one agent card field (title / tag / assignee / ref) to a safe, bounded SINGLE-LINE label:
 * collapse ALL whitespace (incl. newlines/tabs) to single spaces so it can't forge extra confirm-body
 * lines, strip C0/C1/DEL controls, trim, require non-empty, and clamp. Throws {@link KanbanContentError}.
 */
export function sanitizeCardLabel(raw: unknown, max: number, field: string): string {
  if (typeof raw !== 'string') throw new KanbanContentError(`${field} must be a string`)
  let out = ''
  for (const ch of raw.replace(/\s+/g, ' ')) {
    if (!isControl(ch.codePointAt(0) ?? 0)) out += ch
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) throw new KanbanContentError(`${field} is empty after sanitization`)
  if (trimmed.length > max) throw new KanbanContentError(`${field} exceeds the ${max}-char limit`)
  return trimmed
}

/**
 * Validate an agent-supplied opaque id (a minted card id it echoes back, or a column slug it
 * targets): a non-empty, control-free string within `max`. Never mutated beyond a trim — an id is
 * matched verbatim against the board's cards/columns by the renderer applier.
 */
export function sanitizeId(raw: unknown, max: number, field: string): string {
  if (typeof raw !== 'string') throw new KanbanContentError(`${field} must be a string`)
  const s = raw.trim()
  if (s.length === 0) throw new KanbanContentError(`${field} is empty`)
  if (s.length > max) throw new KanbanContentError(`${field} exceeds the ${max}-char limit`)
  for (const ch of s) {
    if (isControl(ch.codePointAt(0) ?? 0)) {
      throw new KanbanContentError(`${field} contains a control character`)
    }
  }
  return s
}

type AddOp = Extract<KanbanOp, { op: 'add' }>
type UpdateOp = Extract<KanbanOp, { op: 'update' }>

/** Build a sanitized `add` op for a host-minted `id` from the agent's card spec. */
export function buildAddCardOp(id: string, spec: unknown): AddOp {
  if (!isRecord(spec)) throw new KanbanContentError('card spec is not an object')
  const card: AddOp['card'] = {
    id,
    columnId: sanitizeId(spec.columnId, MAX_COLUMN_ID, 'columnId'),
    title: sanitizeCardLabel(spec.title, MAX_CARD_TITLE, 'title')
  }
  if (spec.tag !== undefined) card.tag = sanitizeCardLabel(spec.tag, MAX_CARD_TAG, 'tag')
  if (spec.assignee !== undefined) {
    card.assignee = sanitizeCardLabel(spec.assignee, MAX_CARD_ASSIGNEE, 'assignee')
  }
  if (spec.ref !== undefined) card.ref = sanitizeCardLabel(spec.ref, MAX_CARD_REF, 'ref')
  return { op: 'add', card }
}

/** Build a sanitized `move` op. */
export function buildMoveCardOp(
  cardId: unknown,
  toColumnId: unknown
): Extract<KanbanOp, { op: 'move' }> {
  return {
    op: 'move',
    cardId: sanitizeId(cardId, MAX_CARD_ID, 'cardId'),
    toColumnId: sanitizeId(toColumnId, MAX_COLUMN_ID, 'toColumnId')
  }
}

/** Build a sanitized `update` op — requires at least one supplied field. */
export function buildUpdateCardOp(cardId: unknown, patch: unknown): UpdateOp {
  const id = sanitizeId(cardId, MAX_CARD_ID, 'cardId')
  if (!isRecord(patch)) throw new KanbanContentError('card patch is not an object')
  const p: UpdateOp['patch'] = {}
  if (patch.title !== undefined) p.title = sanitizeCardLabel(patch.title, MAX_CARD_TITLE, 'title')
  if (patch.tag !== undefined) p.tag = sanitizeCardLabel(patch.tag, MAX_CARD_TAG, 'tag')
  if (patch.assignee !== undefined) {
    p.assignee = sanitizeCardLabel(patch.assignee, MAX_CARD_ASSIGNEE, 'assignee')
  }
  if (patch.ref !== undefined) p.ref = sanitizeCardLabel(patch.ref, MAX_CARD_REF, 'ref')
  if (Object.keys(p).length === 0) throw new KanbanContentError('update patch has no fields')
  return { op: 'update', cardId: id, patch: p }
}

/** Build a sanitized `remove` op. */
export function buildRemoveCardOp(cardId: unknown): Extract<KanbanOp, { op: 'remove' }> {
  return { op: 'remove', cardId: sanitizeId(cardId, MAX_CARD_ID, 'cardId') }
}

/** The card's chips as a short " (tag · @assignee · ref)" suffix for the confirm body. */
function chipSuffix(c: { tag?: string; assignee?: string; ref?: string }): string {
  const parts = [c.tag, c.assignee ? `@${c.assignee}` : undefined, c.ref].filter(Boolean)
  return parts.length ? `  (${parts.join(' · ')})` : ''
}

/**
 * Render ONE sanitized card op for the write-time confirm body — the human sees exactly what will
 * change (never a bare "1 change"). Every field is already single-line + control-free (sanitize
 * above), so no field can forge additional body lines (ADR 0003).
 */
export function renderKanbanConfirmBody(boardTitle: string, op: KanbanOp): string {
  const head = `The agent wants to modify kanban board "${boardTitle}" (renders as passive cards — nothing runs):`
  switch (op.op) {
    case 'add':
      return `${head}\n\n• Add card to column "${op.card.columnId}": ${op.card.title}${chipSuffix(op.card)}`
    case 'move':
      return `${head}\n\n• Move card ${op.cardId} → column "${op.toColumnId}"`
    case 'update': {
      const parts = Object.entries(op.patch).map(([k, v]) => `${k}: ${v}`)
      return `${head}\n\n• Update card ${op.cardId} — ${parts.join(' · ')}`
    }
    case 'remove':
      return `${head}\n\n• Remove card ${op.cardId}`
  }
}
