import type {
  ConfirmDiff,
  PlanningEditItemAdd,
  PlanningEditItemSet,
  PlanningEditOp,
  PlanningEditPatch
} from '../shared/mcpTypes'
import type { DiagramSpec } from '@expanse-ade/diagram/spec'
import type { SpecOp } from '../renderer/src/lib/specOps'
import { applySpecOps } from '../renderer/src/lib/specOps'
import { diffSpecs, lintSpec } from '../renderer/src/lib/specDiff'
import {
  buildDiagramSpec,
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

/** The editable fields allowed per element kind — a present field NOT in the set is rejected.
 *  A diagram's two content fields are further gated by its resolved ENGINE (Phase 3): `source`
 *  edits a Mermaid diagram, `specOps` a structured (expanse) one — enforced in the builder. */
const ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  note: new Set(['text', 'tint']),
  text: new Set(['text']),
  checklist: new Set(['title', 'setItems', 'addItems', 'removeItemIds']),
  diagram: new Set(['source', 'specOps']),
  arrow: new Set(['dx', 'dy'])
}
const PATCH_KEYS = [
  'text',
  'tint',
  'title',
  'source',
  'specOps',
  'dx',
  'dy',
  'setItems',
  'addItems',
  'removeItemIds'
] as const

/** Max `specOps` in ONE update call (Phase 3) — a reviewability bound (one confirm row per op),
 *  mirrored name-for-name by the package's transport cap for the cross-repo parity test. */
export const MAX_SPEC_OPS = 100

/** The resolved diagram context the gate passes for a kind:'diagram' target (Phase 3) — its
 *  engine plus, for an expanse element, the full current spec from the validated mirror. */
export interface DiagramEditContext {
  engine?: string
  spec?: DiagramSpec
}

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

const SPEC_OP_KINDS = new Set([
  'upsertNode',
  'removeNode',
  'upsertEdge',
  'removeEdge',
  'upsertGroup',
  'removeGroup',
  'setMeta'
])

/**
 * 🔒 Validate + sanitize ONE `specOps` batch against the element's CURRENT spec (Phase 3). Shape-checks
 * each op lightly (the deep judge is the RESULT: `applySpecOps` then the authoritative
 * `buildDiagramSpec` gate — caps, closed enums, referential integrity, control-char reject, 16 KB
 * bound — so an op batch can never land a spec the emit path would reject), and rejects a batch that
 * nets to ZERO change (idempotent removes make a typo'd id a silent no-op otherwise — the empty-patch
 * doctrine). Returns the cloned ops + the validated resulting spec.
 */
function buildSpecOps(raw: unknown, current: DiagramSpec): { ops: SpecOp[]; next: DiagramSpec } {
  if (!Array.isArray(raw)) throw new PlanningContentError('specOps is not an array')
  if (raw.length === 0) throw new PlanningContentError('specOps is empty')
  if (raw.length > MAX_SPEC_OPS) {
    throw new PlanningContentError(`specOps has more than ${MAX_SPEC_OPS} ops`)
  }
  for (const [i, op] of raw.entries()) {
    if (!isRecord(op) || typeof op.op !== 'string' || !SPEC_OP_KINDS.has(op.op)) {
      throw new PlanningContentError(`specOps[${i}] is not a recognized op`)
    }
    if (op.op === 'upsertNode' && !isRecord(op.node)) {
      throw new PlanningContentError(`specOps[${i}] upsertNode carries no node object`)
    }
    if (op.op === 'upsertEdge' && !isRecord(op.edge)) {
      throw new PlanningContentError(`specOps[${i}] upsertEdge carries no edge object`)
    }
    if (op.op === 'upsertGroup' && !isRecord(op.group)) {
      throw new PlanningContentError(`specOps[${i}] upsertGroup carries no group object`)
    }
    if (
      (op.op === 'removeNode' || op.op === 'removeEdge' || op.op === 'removeGroup') &&
      typeof op.id !== 'string'
    ) {
      throw new PlanningContentError(`specOps[${i}] ${op.op} carries no id`)
    }
  }
  const ops = raw as SpecOp[]
  // Judge the RESULT with the same authoritative gate the emit path uses; its clone also proves
  // the applied shape is plain JSON. Malformed op payloads surface here as result violations.
  const next = buildDiagramSpec(applySpecOps(current, ops), 'specOps result')
  const d = diffSpecs(current, next)
  if (d.added + d.changed + d.removed === 0) {
    throw new PlanningContentError('specOps produce no change (check the ids)')
  }
  return { ops: JSON.parse(JSON.stringify(ops)) as SpecOp[], next }
}

/**
 * Build the Option-B {@link ConfirmDiff} for a specOps edit (Phase 3) — the semantic old→new diff +
 * lint over the PROPOSED spec. Presentation only; the plain body stays the complete fallback.
 */
export function buildSpecOpsConfirmDiff(current: DiagramSpec, next: DiagramSpec): ConfirmDiff {
  const d = diffSpecs(current, next)
  const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8')
  const summary =
    `${d.added + d.changed + d.removed} change(s) · +${d.added} · ~${d.changed} · −${d.removed} · ` +
    `nodes ${current.nodes.length}→${next.nodes.length} · ${(bytes / 1024).toFixed(1)} KB of 16 KB`
  return { summary, sections: d.sections, lints: lintSpec(next) }
}

/**
 * Build a SANITIZED, kind-validated `update` op for one existing element (S6). `kind` is the element's
 * RESOLVED kind (read from the live mirror by the gate); a patch field that doesn't apply to it is
 * rejected. For a diagram target, `diagram` carries the resolved engine + current spec (Phase 3) —
 * `source` applies only to a Mermaid diagram, `specOps` only to a structured (expanse) one. Throws
 * {@link PlanningContentError} on any violation or an empty (no-applicable-field) patch.
 */
export function buildPlanningUpdateOp(
  elementId: string,
  kind: string,
  patch: unknown,
  diagram?: DiagramEditContext
): { op: Extract<PlanningEditOp, { op: 'update' }>; nextSpec?: DiagramSpec } {
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
  let nextSpec: DiagramSpec | undefined
  const p: PlanningEditPatch = {}
  if (kind === 'diagram') {
    // Phase 3 engine split. The mirror's `engine` may be absent on a legacy element — absent
    // reads as Mermaid (the pre-engine shape), matching the renderer's own default.
    const isExpanse = diagram?.engine === 'expanse'
    if (patch.source !== undefined && patch.specOps !== undefined) {
      throw new PlanningContentError(
        'supply either "source" (Mermaid) or "specOps" (expanse), not both'
      )
    }
    if (patch.source !== undefined && isExpanse) {
      throw new PlanningContentError(
        'a structured (expanse) diagram is edited via "specOps", not "source"'
      )
    }
    if (patch.specOps !== undefined) {
      if (!isExpanse) {
        throw new PlanningContentError(
          '"specOps" applies only to a structured (expanse) diagram — edit a Mermaid diagram via "source"'
        )
      }
      if (diagram?.spec === undefined) {
        throw new PlanningContentError(
          'the structured diagram carries no readable spec (stale mirror) — re-read the board and retry'
        )
      }
      const built = buildSpecOps(patch.specOps, diagram.spec)
      p.specOps = built.ops
      nextSpec = built.next
    }
  }
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
  // Only attach a checklist array when it carries ≥1 entry: an EXPLICIT empty array (`setItems: []`)
  // is a no-op, and attaching it would slip past the "no applicable field" guard below and produce a
  // confirmed/audited/undoable no-op edit with an empty confirm body. An empty array alongside a real
  // field (e.g. `{ title, setItems: [] }`) is simply ignored, so the real field still applies.
  if (patch.setItems !== undefined) {
    const setItems = buildSetItems(patch.setItems)
    if (setItems.length > 0) p.setItems = setItems
  }
  if (patch.addItems !== undefined) {
    const addItems = buildAddItems(patch.addItems)
    if (addItems.length > 0) p.addItems = addItems
  }
  if (patch.removeItemIds !== undefined) {
    const removeItemIds = buildRemoveItemIds(patch.removeItemIds)
    if (removeItemIds.length > 0) p.removeItemIds = removeItemIds
  }
  if (Object.keys(p).length === 0) {
    throw new PlanningContentError(`patch has no field that applies to a ${kind} element`)
  }
  return {
    op: { op: 'update', elementId, kind, patch: p },
    ...(nextSpec !== undefined ? { nextSpec } : {})
  }
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
  elementDesc: string,
  specDiff?: ConfirmDiff
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
  if (p.specOps !== undefined && specDiff !== undefined) {
    // Phase 3: the plain-text fallback of the Option-B diff — the FULL change list (ADR 0003;
    // also what the Jarvis body-only route shows). The structured payload rides beside it.
    lines.push(`• Update structured diagram (${p.specOps.length} op(s)) — ${specDiff.summary}`)
    for (const s of specDiff.sections) {
      for (const row of s.rows) lines.push(`    ${row.sig} ${confirmField(row.text, '      ')}`)
    }
    for (const warn of specDiff.lints) lines.push(`    ⚠ ${confirmField(warn, '      ')}`)
  }
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
