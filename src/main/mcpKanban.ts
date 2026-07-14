import type { KanbanOp, KanbanOpFileRef } from './mcpCommand'
import { confirmField } from './mcpPlanning'

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
// v19 card-detail caps (agent read/write of the fields #345 added). `description` is MULTI-LINE
// (unlike the single-line chips); `tags` is the plural list; `fileRefs` is a bounded list of
// {path, line?, endLine?} pointers. MAIN is authoritative — the package mirrors matching transport caps.
export const MAX_CARD_DESCRIPTION = 4000
export const MAX_CARD_TAGS = 20
export const MAX_CARD_FILE_REFS = 50
// Matches the renderer→MAIN mirror-ingest cap (`boardRegistry.ts` MAX_FIELD_LEN = 256): a path the write
// gate accepts here MUST survive the mirror round-trip, else it'd be silently dropped from the read-back
// (`canvas://board/{id}/cards`) after the agent already got `ack: true`. `sanitizeId` rejects over-length
// LOUDLY, so an over-256 path is a clear write error, not a silent read-time vanish.
export const MAX_CARD_FILE_REF_PATH = 256
/** Max chars for a kanban board's v19 `axisLabel` (a short single-line caption). */
export const MAX_AXIS_LABEL = 60

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

/**
 * Reduce the agent card `description` to safe, bounded MULTI-LINE content — the ONE card field that is
 * legitimately multi-line (the modal body, not a chip). Normalizes CR/CRLF → LF, KEEPS newlines + tabs,
 * strips C0/C1/DEL controls (the terminal-escape / injection surface), trims, requires non-empty, caps.
 * Mirrors the planning `sanitizePlanningText` discipline; the confirm body indents it via `confirmField`
 * so a multi-line description can never forge the confirm structure (ADR 0003).
 */
export function sanitizeCardText(raw: unknown, max: number, field: string): string {
  if (typeof raw !== 'string') throw new KanbanContentError(`${field} must be a string`)
  const normalized = raw.replace(/\r\n?/g, '\n')
  let out = ''
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x09) {
      out += ch
      continue
    }
    if (isControl(code)) continue
    out += ch
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) throw new KanbanContentError(`${field} is empty after sanitization`)
  if (trimmed.length > max) throw new KanbanContentError(`${field} exceeds the ${max}-char limit`)
  return trimmed
}

/**
 * Sanitize the agent card `tags` list — each entry a single-line label (reuse {@link sanitizeCardLabel}),
 * duplicates dropped (first wins, order preserved), count capped. Requires at least one valid entry
 * (an empty/all-blank list is rejected, matching the "no empty chip" rule — clearing tags is a human-UI
 * action, not an MCP one). Writing `tags` supersedes the legacy singular `tag` (shed in the applier).
 */
export function sanitizeCardTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new KanbanContentError('tags must be an array')
  if (raw.length > MAX_CARD_TAGS) {
    throw new KanbanContentError(`tags exceeds the ${MAX_CARD_TAGS}-entry limit`)
  }
  const out: string[] = []
  for (const t of raw) {
    const v = sanitizeCardLabel(t, MAX_CARD_TAG, 'tag')
    if (!out.includes(v)) out.push(v)
  }
  if (out.length === 0) throw new KanbanContentError('tags is empty after sanitization')
  return out
}

/** A finite positive INTEGER, else throw (mirrors the package `.int().positive()` schema, MAIN-authoritative). */
function positiveInt(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new KanbanContentError(`${field} must be a positive integer`)
  }
  return raw
}

/**
 * Sanitize the agent card `fileRefs` list — each a `{path, line?, endLine?}` pointer. `path` is a
 * single-line, control-free, capped id-like string (a path never spans lines); `line`/`endLine` are
 * positive integers, `endLine` kept only when STRICTLY greater than `line` (a real range, else it
 * collapses to the single line — the human `setCardFileRefs` normalization). An `endLine` without a
 * `line` is dropped (a ref with no line opens at the file top). Count capped; ≥1 valid entry required.
 */
export function sanitizeCardFileRefs(raw: unknown): KanbanOpFileRef[] {
  if (!Array.isArray(raw)) throw new KanbanContentError('fileRefs must be an array')
  if (raw.length > MAX_CARD_FILE_REFS) {
    throw new KanbanContentError(`fileRefs exceeds the ${MAX_CARD_FILE_REFS}-entry limit`)
  }
  const out: KanbanOpFileRef[] = []
  for (const r of raw) {
    if (!isRecord(r)) throw new KanbanContentError('fileRef must be an object')
    const ref: KanbanOpFileRef = {
      path: sanitizeId(r.path, MAX_CARD_FILE_REF_PATH, 'fileRef path')
    }
    if (r.line !== undefined) {
      const line = positiveInt(r.line, 'fileRef line')
      ref.line = line
      if (r.endLine !== undefined) {
        const endLine = positiveInt(r.endLine, 'fileRef endLine')
        if (endLine > line) ref.endLine = endLine
      }
    }
    out.push(ref)
  }
  if (out.length === 0) throw new KanbanContentError('fileRefs is empty after sanitization')
  return out
}

/** The v19 detail fields shared by an `add` card + an `update` patch (already sanitized). */
interface CardDetailFields {
  description?: string
  tags?: string[]
  fileRefs?: KanbanOpFileRef[]
}

/** Sanitize + attach whichever v19 detail fields the agent supplied onto an add-card / update-patch target. */
function applyCardDetail(target: CardDetailFields, src: Record<string, unknown>): void {
  if (src.description !== undefined) {
    target.description = sanitizeCardText(src.description, MAX_CARD_DESCRIPTION, 'description')
  }
  if (src.tags !== undefined) target.tags = sanitizeCardTags(src.tags)
  if (src.fileRefs !== undefined) target.fileRefs = sanitizeCardFileRefs(src.fileRefs)
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
  applyCardDetail(card, spec) // v19: description / tags / fileRefs
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
  applyCardDetail(p, patch) // v19: description / tags / fileRefs
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

/** Format one file+line ref as "path", "path:line", or "path:line-endLine" (all single-line, control-free). */
function fmtFileRef(r: KanbanOpFileRef): string {
  if (r.line === undefined) return r.path
  return r.endLine !== undefined ? `${r.path}:${r.line}-${r.endLine}` : `${r.path}:${r.line}`
}

/**
 * Indented sub-lines for the v19 detail fields the human must SEE before approving (ADR 0003). `tags`
 * and `fileRefs` are already single-line + control-free (sanitize above); `description` is multi-line,
 * so it is run through {@link confirmField} (indented continuation lines) so it can never forge a
 * top-level "• " bullet. Returns [] when the op carries no detail fields.
 */
function detailLines(c: CardDetailFields): string[] {
  const lines: string[] = []
  if (c.tags && c.tags.length > 0) lines.push(`    tags: ${c.tags.join(', ')}`)
  if (c.fileRefs && c.fileRefs.length > 0) {
    lines.push(`    files: ${c.fileRefs.map(fmtFileRef).join(', ')}`)
  }
  if (c.description !== undefined)
    lines.push(`    description: ${confirmField(c.description, '      ')}`)
  return lines
}

/**
 * Render ONE sanitized card op for the write-time confirm body — the human sees exactly what will
 * change (never a bare "1 change"). The single-line chips are already control-free; the v19 detail
 * fields are shown on indented sub-lines (description via {@link confirmField}) so no field can forge
 * additional top-level body lines (ADR 0003).
 */
export function renderKanbanConfirmBody(boardTitle: string, op: KanbanOp): string {
  const head = `The agent wants to modify kanban board "${boardTitle}" (renders as passive cards — nothing runs):`
  switch (op.op) {
    case 'add':
      return [
        `${head}\n\n• Add card to column "${op.card.columnId}": ${op.card.title}${chipSuffix(op.card)}`,
        ...detailLines(op.card)
      ].join('\n')
    case 'move':
      return `${head}\n\n• Move card ${op.cardId} → column "${op.toColumnId}"`
    case 'update': {
      // Only the single-line chips go inline; the v19 detail fields (incl. multi-line description) go
      // on their own indented sub-lines via detailLines so they can't forge the confirm structure.
      const chips = (['title', 'tag', 'assignee', 'ref'] as const)
        .filter((k) => op.patch[k] !== undefined)
        .map((k) => `${k}: ${op.patch[k]}`)
      const headLine = `• Update card ${op.cardId}${chips.length ? ` — ${chips.join(' · ')}` : ''}`
      return [`${head}\n`, headLine, ...detailLines(op.patch)].join('\n')
    }
    case 'remove':
      return `${head}\n\n• Remove card ${op.cardId}`
  }
}

/** The sanitized v19 kanban board-AXIS config an agent may set via `configure_board`. */
export interface KanbanAxisConfig {
  columnAxis?: 'flow' | 'category'
  axisLabel?: string
}

/**
 * 🔒 Validate + sanitize the v19 kanban board-axis config from a `configure_board` call. `columnAxis`
 * must be the two-value enum; `axisLabel` is collapsed to a safe SINGLE-LINE label (reuse
 * {@link sanitizeCardLabel} — control-free, non-empty, capped). Requires at least one field. Throws
 * {@link KanbanContentError} on bad input (the gate audits it `rejected`).
 */
export function buildKanbanAxisConfig(raw: unknown): KanbanAxisConfig {
  if (!isRecord(raw)) throw new KanbanContentError('kanban axis config is not an object')
  const out: KanbanAxisConfig = {}
  if (raw.columnAxis !== undefined) {
    if (raw.columnAxis !== 'flow' && raw.columnAxis !== 'category') {
      throw new KanbanContentError('columnAxis must be "flow" or "category"')
    }
    out.columnAxis = raw.columnAxis
  }
  if (raw.axisLabel !== undefined) {
    out.axisLabel = sanitizeCardLabel(raw.axisLabel, MAX_AXIS_LABEL, 'axisLabel')
  }
  if (out.columnAxis === undefined && out.axisLabel === undefined) {
    throw new KanbanContentError('kanban axis config has no fields')
  }
  return out
}

/**
 * Render a sanitized kanban axis config for the write-time confirm body. Both fields are already
 * single-line + control-free, so neither can forge additional body lines (ADR 0003).
 */
export function renderKanbanAxisConfirmBody(boardTitle: string, cfg: KanbanAxisConfig): string {
  const parts: string[] = []
  if (cfg.columnAxis !== undefined) parts.push(`axis: ${cfg.columnAxis}`)
  if (cfg.axisLabel !== undefined) parts.push(`label: ${cfg.axisLabel}`)
  return (
    `The agent wants to set the column axis of kanban board "${boardTitle}" ` +
    `(passive config — nothing runs):\n\n• ${parts.join(' · ')}`
  )
}
