import type {
  PlanningEditItemAdd,
  PlanningEditItemSet,
  PlanningEditOp,
  PlanningEditPatch
} from '../shared/mcpTypes'
import {
  confirmField,
  MAX_PLANNING_DIAGRAM,
  MAX_PLANNING_ITEMS,
  MAX_PLANNING_LABEL,
  MAX_PLANNING_TEXT,
  MAX_PLANNING_TITLE,
  PlanningContentError,
  sanitizePlanningText
} from './mcpPlanning'

/**
 * 🔒 MAIN-side validation, sanitization, and caps for an agent-authored planning-element EDIT (S6).
 *
 * `update_planning_element` / `remove_planning_element` mutate durable-canvas content the same class as
 * `add_planning_elements` (ADR 0003). The @expanse-ade/mcp tool schema is a first (transport) check, but
 * MAIN is the authority: it resolves the element's KIND from the live mirror and re-validates the patch
 * AGAINST that kind — a field for another kind (a `source` on a note) is REJECTED, never applied — then
 * sanitizes every field (reusing the S2 planning sanitizers so an edit lands byte-identical to an add).
 * The cleaned op is shown to the human IN FULL via the confirm gate before it reaches the renderer, which
 * re-resolves the element + applies via the pure `planning/elements` mutators (defense in depth).
 *
 * Reuses {@link PlanningContentError} (the gate audits it `rejected` and throws), so an invalid edit is
 * indistinguishable in the audit trail from an invalid add.
 */

const TINTS = ['yellow', 'blue', 'green', 'plain'] as const
/** Bound on an arrow delta (mirrors mcpPlanning's private MAX_ARROW_DELTA). */
const MAX_ARROW_DELTA = 5000
/** Bound on an agent-supplied checklist-item id it echoes back from the read resource. */
const MAX_ITEM_ID = 200

/** The editable fields allowed per element kind — a present field NOT in the set is rejected. */
const ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  note: new Set(['text', 'tint']),
  text: new Set(['text']),
  checklist: new Set(['title', 'setItems', 'addItems', 'removeItemIds']),
  diagram: new Set(['source']),
  arrow: new Set(['dx', 'dy'])
}
const PATCH_KEYS = [
  'text',
  'tint',
  'title',
  'source',
  'dx',
  'dy',
  'setItems',
  'addItems',
  'removeItemIds'
] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a non-empty, control-free, bounded checklist-item id an agent echoes back (matched verbatim). */
function sanitizeItemId(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new PlanningContentError(`${field} must be a string`)
  const s = raw.trim()
  if (s.length === 0) throw new PlanningContentError(`${field} is empty`)
  if (s.length > MAX_ITEM_ID)
    throw new PlanningContentError(`${field} exceeds the ${MAX_ITEM_ID}-char limit`)
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      throw new PlanningContentError(`${field} contains a control character`)
    }
  }
  return s
}

/** Validate + sanitize the `setItems` edits (target existing items by id; set label and/or done). */
function buildSetItems(raw: unknown): PlanningEditItemSet[] {
  if (!Array.isArray(raw)) throw new PlanningContentError('setItems is not an array')
  if (raw.length > MAX_PLANNING_ITEMS) {
    throw new PlanningContentError(`setItems has more than ${MAX_PLANNING_ITEMS} entries`)
  }
  return raw.map((it, j) => {
    if (!isRecord(it)) throw new PlanningContentError(`setItems[${j}] is not an object`)
    const edit: PlanningEditItemSet = { id: sanitizeItemId(it.id, `setItems[${j}].id`) }
    if (it.label !== undefined) {
      edit.label = sanitizePlanningText(it.label, MAX_PLANNING_LABEL, `setItems[${j}].label`)
    }
    if (it.done !== undefined) {
      if (typeof it.done !== 'boolean') {
        throw new PlanningContentError(`setItems[${j}].done is not a boolean`)
      }
      edit.done = it.done
    }
    if (edit.label === undefined && edit.done === undefined) {
      throw new PlanningContentError(`setItems[${j}] has neither label nor done`)
    }
    return edit
  })
}

/** Validate + sanitize the `addItems` appends (a fully-specified label + done). */
function buildAddItems(raw: unknown): PlanningEditItemAdd[] {
  if (!Array.isArray(raw)) throw new PlanningContentError('addItems is not an array')
  if (raw.length > MAX_PLANNING_ITEMS) {
    throw new PlanningContentError(`addItems has more than ${MAX_PLANNING_ITEMS} entries`)
  }
  return raw.map((it, j) => {
    if (!isRecord(it)) throw new PlanningContentError(`addItems[${j}] is not an object`)
    const label = sanitizePlanningText(it.label, MAX_PLANNING_LABEL, `addItems[${j}].label`)
    if (it.done !== undefined && typeof it.done !== 'boolean') {
      throw new PlanningContentError(`addItems[${j}].done is not a boolean`)
    }
    return { label, done: it.done === true }
  })
}

/** Validate the `removeItemIds` list (opaque item ids). */
function buildRemoveItemIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new PlanningContentError('removeItemIds is not an array')
  if (raw.length > MAX_PLANNING_ITEMS) {
    throw new PlanningContentError(`removeItemIds has more than ${MAX_PLANNING_ITEMS} entries`)
  }
  return raw.map((id, j) => sanitizeItemId(id, `removeItemIds[${j}]`))
}

/**
 * Build a SANITIZED, kind-validated `update` op for one existing element (S6). `kind` is the element's
 * RESOLVED kind (read from the live mirror by the gate); a patch field that doesn't apply to it is
 * rejected. Throws {@link PlanningContentError} on any violation or an empty (no-applicable-field) patch.
 */
export function buildPlanningUpdateOp(
  elementId: string,
  kind: string,
  patch: unknown
): Extract<PlanningEditOp, { op: 'update' }> {
  if (!isRecord(patch)) throw new PlanningContentError('patch is not an object')
  const allowed = ALLOWED_FIELDS[kind]
  if (!allowed) {
    throw new PlanningContentError(`a ${kind} element cannot be edited (remove it instead)`)
  }
  // Reject any present field that doesn't apply to this element's kind BEFORE sanitizing.
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined && !allowed.has(key)) {
      throw new PlanningContentError(`field "${key}" does not apply to a ${kind} element`)
    }
  }
  const p: PlanningEditPatch = {}
  if (patch.text !== undefined) p.text = sanitizePlanningText(patch.text, MAX_PLANNING_TEXT, 'text')
  if (patch.tint !== undefined) {
    if (!TINTS.includes(patch.tint as (typeof TINTS)[number])) {
      throw new PlanningContentError('tint is not one of yellow|blue|green|plain')
    }
    p.tint = patch.tint as (typeof TINTS)[number]
  }
  if (patch.title !== undefined) {
    p.title = sanitizePlanningText(patch.title, MAX_PLANNING_TITLE, 'title')
  }
  if (patch.source !== undefined) {
    p.source = sanitizePlanningText(patch.source, MAX_PLANNING_DIAGRAM, 'source')
  }
  if (patch.dx !== undefined || patch.dy !== undefined) {
    const dx = patch.dx
    const dy = patch.dy
    if (
      typeof dx !== 'number' ||
      !Number.isFinite(dx) ||
      typeof dy !== 'number' ||
      !Number.isFinite(dy)
    ) {
      throw new PlanningContentError('arrow edit requires finite dx AND dy')
    }
    if (Math.abs(dx) > MAX_ARROW_DELTA || Math.abs(dy) > MAX_ARROW_DELTA) {
      throw new PlanningContentError(`arrow delta exceeds ${MAX_ARROW_DELTA}px`)
    }
    p.dx = dx
    p.dy = dy
  }
  if (patch.setItems !== undefined) p.setItems = buildSetItems(patch.setItems)
  if (patch.addItems !== undefined) p.addItems = buildAddItems(patch.addItems)
  if (patch.removeItemIds !== undefined) p.removeItemIds = buildRemoveItemIds(patch.removeItemIds)
  if (Object.keys(p).length === 0) {
    throw new PlanningContentError(`patch has no field that applies to a ${kind} element`)
  }
  return { op: 'update', elementId, kind, patch: p }
}

/** A short, single-line human description of the target element for the confirm body. */
export function describeElement(kind: string, label: string | undefined): string {
  const trimmed = (label ?? '').replace(/\s+/g, ' ').trim()
  const preview = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
  return preview ? `${kind} "${preview}"` : `${kind} element`
}

/**
 * Render the FULL human-readable content of an edit/remove op for the write-time confirm body — the human
 * sees exactly what changes on which element (never a bare "1 change"). Multi-line fields are indented via
 * {@link confirmField} so they can't forge the bullet structure (ADR 0003).
 */
export function renderPlanningEditConfirmBody(
  boardTitle: string,
  op: PlanningEditOp,
  elementDesc: string
): string {
  if (op.op === 'remove') {
    return (
      `The agent wants to REMOVE ${elementDesc} from planning board "${boardTitle}".\n\n` +
      'This deletes it from the board (nothing runs).'
    )
  }
  const p = op.patch
  const lines: string[] = [
    `The agent wants to edit ${elementDesc} on planning board "${boardTitle}" ` +
      '(renders as passive content — nothing runs):',
    ''
  ]
  if (p.title !== undefined) lines.push(`• Set title: ${confirmField(p.title, '  ')}`)
  if (p.text !== undefined) lines.push(`• Set text: ${confirmField(p.text, '  ')}`)
  if (p.tint !== undefined) lines.push(`• Set tint: ${p.tint}`)
  if (p.source !== undefined) {
    lines.push('• Replace diagram source:')
    lines.push(`    ${confirmField(p.source, '    ')}`)
  }
  if (p.dx !== undefined || p.dy !== undefined) {
    lines.push(`• Set arrow delta (Δx ${p.dx ?? 0}, Δy ${p.dy ?? 0})`)
  }
  for (const it of p.setItems ?? []) {
    const parts: string[] = []
    if (it.done !== undefined) parts.push(it.done ? 'mark done' : 'mark not done')
    if (it.label !== undefined) parts.push(`relabel "${confirmField(it.label, '      ')}"`)
    lines.push(`• Item ${it.id}: ${parts.join(', ')}`)
  }
  for (const it of p.addItems ?? []) {
    lines.push(`• Add item ${it.done ? '☑' : '☐'} ${confirmField(it.label, '      ')}`)
  }
  for (const id of p.removeItemIds ?? []) lines.push(`• Remove item ${id}`)
  return lines.join('\n')
}
