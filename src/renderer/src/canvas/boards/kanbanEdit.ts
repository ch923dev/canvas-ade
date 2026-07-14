/**
 * Pure edit operations for a Kanban board's human interaction (v17, MCP canvas-awareness P4.2).
 * Each function takes the board + intent and returns the NEW `columns`/`cards` array (never mutates),
 * so `KanbanBoard` can commit it via `updateBoard` as ONE undoable, autosaved edit — mirroring
 * `kanbanMcpApply.applyKanbanOps` (the agent path) but keyed off direct human intent instead of a
 * confirmed op batch. Pure ⇒ unit-tested in isolation; the component stays presentational.
 *
 * Guards match the schema contract: a card needs a non-empty title, a column needs a non-empty title,
 * `columnId` order is array order, and a Kanban board must keep at least one column (`removeColumn`
 * refuses the last one). Empty-input commits are treated as no-ops (return the input array unchanged)
 * so the caller can blindly commit on blur without special-casing.
 */
import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanFileRef } from '../../lib/boardSchema'
import type { KanbanAttachment } from '../../lib/kanbanSchema'

const newId = (): string => crypto.randomUUID()

/**
 * Coarse tint bucket for a card's label chip, inferred from its free text (falls back to muted). Pure +
 * shared by the card face AND the card-detail modal (lives here rather than in a component so both read
 * one source — and so it stays unit-testable without a DOM).
 */
export function tagTint(tag: string): 'ok' | 'warn' | 'accent' | 'muted' {
  const t = tag.toLowerCase()
  if (t.includes('ship') || t.includes('done') || t.includes('merged')) return 'ok'
  if (t.includes('review') || t.includes('block') || t.includes('wait')) return 'warn'
  if (t.includes('feature') || t.includes('feat')) return 'accent'
  return 'muted'
}

/** A card's effective label chips: the v19 `tags` list, else the legacy singular `tag`, else none. */
export function effectiveTags(card: KanbanCard): string[] {
  return card.tags ?? (card.tag ? [card.tag] : [])
}

/** A 1-based line clamped to a positive integer, or `undefined` for anything else (0/NaN/negative). */
const normLine = (n: number | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined

/** Structural equality for two (possibly absent) fileRef lists — the no-op guard for setCardFileRefs. */
function fileRefsEqual(a: KanbanFileRef[] | undefined, b: KanbanFileRef[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  return x.every(
    (r, i) => r.path === y[i].path && r.line === y[i].line && r.endLine === y[i].endLine
  )
}

/** Structural equality for two (possibly absent) attachment lists — the no-op guard for setCardAttachments. */
function attachmentsEqual(
  a: KanbanAttachment[] | undefined,
  b: KanbanAttachment[] | undefined
): boolean {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  return x.every(
    (t, i) =>
      t.assetId === y[i].assetId &&
      t.url === y[i].url &&
      t.name === y[i].name &&
      t.kind === y[i].kind &&
      t.mime === y[i].mime &&
      t.size === y[i].size
  )
}

/** Trim + drop blanks and case-sensitive duplicates (first wins, order preserved). Shared by the tag ops. */
function cleanTags(tags: string[]): string[] {
  const cleaned: string[] = []
  for (const t of tags) {
    const v = t.trim()
    if (v && !cleaned.includes(v)) cleaned.push(v)
  }
  return cleaned
}

/**
 * Normalize a fileRef list (shared by setCardFileRefs + addCardDetailed): path trimmed (blank ⇒
 * dropped); `line` clamped to a positive integer (else the line/endLine pair is dropped — the file
 * opens at the top); `endLine` kept only when it is a positive integer STRICTLY greater than `line`.
 */
function cleanFileRefs(fileRefs: KanbanFileRef[]): KanbanFileRef[] {
  const cleaned: KanbanFileRef[] = []
  for (const r of fileRefs) {
    const path = r.path.trim()
    if (!path) continue
    const ref: KanbanFileRef = { path }
    const line = normLine(r.line)
    if (line !== undefined) {
      ref.line = line
      const endLine = normLine(r.endLine)
      if (endLine !== undefined && endLine > line) ref.endLine = endLine
    }
    cleaned.push(ref)
  }
  return cleaned
}

// ── card ops (return the new `cards` array) ──────────────────────────────────

/** Append a new card (fresh id) to `columnId`'s tail. Empty/blank title ⇒ no-op. */
export function addCard(board: KanbanBoard, columnId: string, title: string): KanbanCard[] {
  const t = title.trim()
  if (!t) return board.cards
  return [...board.cards, { id: newId(), columnId, title: t }]
}

/** The full set of fields the create-mode modal can seed a new card with (#346). Only `title` is required. */
export interface NewCardDraft {
  title: string
  description?: string
  tags?: string[]
  assignee?: string
  ref?: string
  fileRefs?: KanbanFileRef[]
  attachments?: KanbanAttachment[]
}

/**
 * Append a fully-formed new card built from the create-mode modal's draft (#346) — the rich
 * counterpart to `addCard` (title-only). Every field is normalized through the SAME cleaners the
 * per-field edit ops use (trim, tag dedupe, fileRef line clamp), and an empty/absent field simply
 * doesn't get its key — so the new card is byte-identical to one built field-by-field in edit mode.
 * Blank title ⇒ ref-stable no-op (a card must keep a title); the modal guards this before committing.
 */
export function addCardDetailed(
  board: KanbanBoard,
  columnId: string,
  draft: NewCardDraft
): KanbanCard[] {
  const title = draft.title.trim()
  if (!title) return board.cards
  const card: KanbanCard = { id: newId(), columnId, title }
  const description = draft.description?.trim()
  if (description) card.description = description
  const tags = draft.tags ? cleanTags(draft.tags) : []
  if (tags.length) card.tags = tags
  const assignee = draft.assignee?.trim()
  if (assignee) card.assignee = assignee
  const ref = draft.ref?.trim()
  if (ref) card.ref = ref
  const fileRefs = draft.fileRefs ? cleanFileRefs(draft.fileRefs) : []
  if (fileRefs.length) card.fileRefs = fileRefs
  if (draft.attachments && draft.attachments.length) card.attachments = draft.attachments
  return [...board.cards, card]
}

/** Retitle a card. Blank or unchanged title ⇒ ref-stable no-op (a card must keep a title). */
export function renameCard(board: KanbanBoard, cardId: string, title: string): KanbanCard[] {
  const t = title.trim()
  const cur = board.cards.find((c) => c.id === cardId)
  if (!t || !cur || cur.title === t) return board.cards
  return board.cards.map((c) => (c.id === cardId ? { ...c, title: t } : c))
}

/** Drop a card. Unknown id ⇒ returns the same array (map/filter no-op). */
export function removeCard(board: KanbanBoard, cardId: string): KanbanCard[] {
  return board.cards.filter((c) => c.id !== cardId)
}

/**
 * Move a card to `toColumnId`, re-appending it to that column's tail (array order = within-column
 * order, matching the agent `move` op). Same-column or unknown card ⇒ no-op. Unknown target column ⇒
 * no-op (defensive; the UI only ever passes a real column id).
 */
export function moveCard(board: KanbanBoard, cardId: string, toColumnId: string): KanbanCard[] {
  const card = board.cards.find((c) => c.id === cardId)
  if (!card || card.columnId === toColumnId) return board.cards
  if (!board.columns.some((c) => c.id === toColumnId)) return board.cards
  return [...board.cards.filter((c) => c.id !== cardId), { ...card, columnId: toColumnId }]
}

// ── card-detail ops (v19 — description / tags / fileRefs) ──────────────────────
// Each edits ONE card in the flat list (the card-detail modal commits them). All follow the return-
// new-array + ref-stable-no-op discipline above: an unknown card or an unchanged value returns the
// input array unchanged so the modal can commit blindly on blur. Clearing a field DROPS the key (via
// rest destructure) rather than persisting an empty value — a card carries only the fields it has.

/**
 * Set or clear a card's plain-text description. Trimmed; blank ⇒ the key is dropped (no description).
 * Unknown card or unchanged text ⇒ ref-stable no-op.
 */
export function setCardDescription(
  board: KanbanBoard,
  cardId: string,
  description: string
): KanbanCard[] {
  const cur = board.cards.find((c) => c.id === cardId)
  if (!cur) return board.cards
  const next = description.trim() || undefined
  if (cur.description === next) return board.cards
  return board.cards.map((c) => {
    if (c.id !== cardId) return c
    const { description: _drop, ...rest } = c
    return next === undefined ? rest : { ...rest, description: next }
  })
}

/**
 * Replace a card's label chips. Each tag is trimmed; blanks and case-sensitive duplicates are dropped
 * (first wins, order preserved). Writing `tags` SUPERSEDES the legacy singular `tag` — it is always
 * dropped here, so editing a pre-v19 card migrates it forward. Empty result ⇒ neither key is kept.
 * Unknown card, or no effective change (same tags AND no legacy `tag` to shed) ⇒ ref-stable no-op.
 */
export function setCardTags(board: KanbanBoard, cardId: string, tags: string[]): KanbanCard[] {
  const cur = board.cards.find((c) => c.id === cardId)
  if (!cur) return board.cards
  const cleaned = cleanTags(tags)
  const next = cleaned.length ? cleaned : undefined
  const curTags = cur.tags ?? []
  const unchanged = curTags.length === cleaned.length && curTags.every((t, i) => t === cleaned[i])
  // A no-op needs BOTH the same tags AND no legacy `tag` still hanging on (which this op sheds).
  if (unchanged && cur.tag === undefined) return board.cards
  return board.cards.map((c) => {
    if (c.id !== cardId) return c
    const { tags: _t, tag: _legacy, ...rest } = c
    return next === undefined ? rest : { ...rest, tags: next }
  })
}

/**
 * Replace a card's file+line references. Each ref is normalized: path trimmed (blank ⇒ dropped); `line`
 * clamped to a positive integer (else the whole line/endLine pair is dropped — a ref with no line opens
 * the file at the top); `endLine` kept only when it is a positive integer STRICTLY greater than `line`
 * (a real range; otherwise it collapses to the single `line`). Empty result ⇒ the key is dropped.
 * Unknown card or a structurally-identical list ⇒ ref-stable no-op.
 */
export function setCardFileRefs(
  board: KanbanBoard,
  cardId: string,
  fileRefs: KanbanFileRef[]
): KanbanCard[] {
  const cur = board.cards.find((c) => c.id === cardId)
  if (!cur) return board.cards
  const cleaned = cleanFileRefs(fileRefs)
  const next = cleaned.length ? cleaned : undefined
  if (fileRefsEqual(cur.fileRefs, next)) return board.cards
  return board.cards.map((c) => {
    if (c.id !== cardId) return c
    const { fileRefs: _drop, ...rest } = c
    return next === undefined ? rest : { ...rest, fileRefs: next }
  })
}

/**
 * Replace a card's attachments (v19 / #346). The entries arrive already-built by the capture path
 * (assetId + name + derived kind + optional mime/size) — this op only stores them, matching the
 * setCardFileRefs discipline: empty ⇒ the key is dropped; unknown card or a structurally-identical
 * list ⇒ ref-stable no-op (so the modal can commit blindly on each add/remove).
 */
export function setCardAttachments(
  board: KanbanBoard,
  cardId: string,
  attachments: KanbanAttachment[]
): KanbanCard[] {
  const cur = board.cards.find((c) => c.id === cardId)
  if (!cur) return board.cards
  const next = attachments.length ? attachments : undefined
  if (attachmentsEqual(cur.attachments, next)) return board.cards
  return board.cards.map((c) => {
    if (c.id !== cardId) return c
    const { attachments: _drop, ...rest } = c
    return next === undefined ? rest : { ...rest, attachments: next }
  })
}

/**
 * Set or clear a card's assignee (an agent-preset id / free label — the coloured dot). Trimmed; blank ⇒
 * the key is dropped (unassigned). Unknown card or unchanged ⇒ ref-stable no-op. The card-detail modal
 * surfaces this existing field for editing (before v19 it was settable only by an agent / hand-edit).
 */
export function setCardAssignee(
  board: KanbanBoard,
  cardId: string,
  assignee: string
): KanbanCard[] {
  const cur = board.cards.find((c) => c.id === cardId)
  if (!cur) return board.cards
  const next = assignee.trim() || undefined
  if (cur.assignee === next) return board.cards
  return board.cards.map((c) => {
    if (c.id !== cardId) return c
    const { assignee: _drop, ...rest } = c
    return next === undefined ? rest : { ...rest, assignee: next }
  })
}

/**
 * Set or clear a card's external reference chip (e.g. "PR #271"). Trimmed; blank ⇒ the key is dropped.
 * Unknown card or unchanged ⇒ ref-stable no-op. Surfaced for editing by the card-detail modal.
 */
export function setCardRef(board: KanbanBoard, cardId: string, ref: string): KanbanCard[] {
  const cur = board.cards.find((c) => c.id === cardId)
  if (!cur) return board.cards
  const next = ref.trim() || undefined
  if (cur.ref === next) return board.cards
  return board.cards.map((c) => {
    if (c.id !== cardId) return c
    const { ref: _drop, ...rest } = c
    return next === undefined ? rest : { ...rest, ref: next }
  })
}

// ── column ops ───────────────────────────────────────────────────────────────

/** Append a new lane (fresh id) to the right. Blank title ⇒ no-op. */
export function addColumn(board: KanbanBoard, title: string): KanbanColumn[] {
  const t = title.trim()
  if (!t) return board.columns
  return [...board.columns, { id: newId(), title: t }]
}

/** Retitle a lane. Blank or unchanged title ⇒ ref-stable no-op (a column must keep a title). */
export function renameColumn(board: KanbanBoard, columnId: string, title: string): KanbanColumn[] {
  const t = title.trim()
  const cur = board.columns.find((c) => c.id === columnId)
  if (!t || !cur || cur.title === t) return board.columns
  return board.columns.map((c) => (c.id === columnId ? { ...c, title: t } : c))
}

/**
 * Set or clear a lane's WIP limit. A positive finite `wip` sets the limit (floored); `undefined` /
 * zero / non-finite clears it (the badge disappears). WIP is SOFT — nothing here blocks a move; the
 * board just paints the badge in the warn colour when the live card count reaches the limit.
 */
export function setColumnWip(
  board: KanbanBoard,
  columnId: string,
  wip: number | undefined
): KanbanColumn[] {
  const limit = wip !== undefined && Number.isFinite(wip) && wip > 0 ? Math.floor(wip) : undefined
  const cur = board.columns.find((c) => c.id === columnId)
  // No change (unknown column, or the limit already matches — both-undefined included) ⇒ same ref.
  if (!cur || cur.wip === limit) return board.columns
  return board.columns.map((c) => {
    if (c.id !== columnId) return c
    if (limit === undefined) return { id: c.id, title: c.title }
    return { ...c, wip: limit }
  })
}

/**
 * Remove a lane, reflowing its cards to the neighbouring lane (the one that slides into its place, or
 * the previous lane when it was the last) so NO card is silently lost. Returns `null` — a refused
 * edit — for an unknown column or the last remaining column (a Kanban board keeps ≥1 lane).
 */
export function removeColumn(
  board: KanbanBoard,
  columnId: string
): { columns: KanbanColumn[]; cards: KanbanCard[] } | null {
  if (board.columns.length <= 1) return null
  const idx = board.columns.findIndex((c) => c.id === columnId)
  if (idx < 0) return null
  const columns = board.columns.filter((c) => c.id !== columnId)
  const fallback = (columns[idx] ?? columns[idx - 1]).id
  const cards = board.cards.map((c) => (c.columnId === columnId ? { ...c, columnId: fallback } : c))
  return { columns, cards }
}
