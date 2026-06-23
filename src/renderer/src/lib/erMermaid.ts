/**
 * Inferred entity model → Mermaid `erDiagram` source (JD-4 — "Sketch the data model").
 *
 * Serializes the JD-3 `EntityModel` (entities + PK/FK + relationships) into an editable Mermaid
 * `erDiagram` that the "→ Planning" action materializes as a Diagram element (via `makeDiagram` /
 * the diagram worker). **Structure only — names + types + relationships, never values** (ADR 0010):
 * the model already carries no values (entity/PK-FK detection is name+type structural), and format
 * hints (`uuid` / `date-time` / …) are pattern classes, not data. Pure + unit-tested.
 *
 * Only identity-bearing entities (`kind === 'entity'`) are drawn — lonely leaf shapes would clutter the
 * model. A flat API (no entities) yields a header-only diagram the caller does not materialize.
 */
import type { Entity, EntityModel } from './entityInfer'
import type { FormatHint, InferredField, ShapeType } from './schemaInfer'

/**
 * Mermaid identifiers/attribute names allow `[A-Za-z0-9_]`; anything else collapses to `_`. A Mermaid
 * `erDiagram` identifier also may NOT start with a digit (its lexer splits `6985e…` and the parse fails
 * with `Expecting 'COLON', got 'UNICODE_TEXT'`), so a digit-leading name is prefixed `E_`. This is the
 * hard guarantee that "→ Planning" can never emit unparseable Mermaid, even for an odd entity name.
 */
function safeIdent(s: string, fallback: string): string {
  let cleaned = s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
  if (cleaned.length === 0) cleaned = fallback
  if (/^[0-9]/.test(cleaned)) cleaned = 'E_' + cleaned
  return cleaned
}

/** A Mermaid label string (relationship `via`) — strip quotes/newlines so it can't break the syntax. */
function safeLabel(s: string): string {
  return s.replace(/["\r\n]/g, ' ').trim() || 'ref'
}

const SCALAR_TYPE: Record<ShapeType, string> = {
  string: 'string',
  number: 'number',
  bool: 'boolean',
  null: 'null',
  object: 'object',
  array: 'list',
  unknown: 'string'
}

const FORMAT_TYPE: Record<FormatHint, string> = {
  uuid: 'uuid',
  'date-time': 'datetime',
  email: 'string',
  uri: 'string',
  int64: 'bigint'
}

/** A single Mermaid attribute type token (no spaces/brackets) for an inferred field. */
function attrType(f: InferredField): string {
  if (f.children) return 'object'
  if (f.elem) return 'list'
  if (f.format) return FORMAT_TYPE[f.format]
  const t = f.types.find((x) => x !== 'null') ?? f.types[0] ?? 'unknown'
  return SCALAR_TYPE[t]
}

/** Members shown per entity — the structural skeleton (PK + FKs) is always kept, the rest fill up to
 *  this cap with a final "+N more" row. Stops one wide entity (a 30-field row) from making the whole
 *  diagram so tall it can't be read (the export-readability fix; mirrors the graph node's `+N more`). */
const ER_FIELD_CAP = 12

function entityBlock(e: Entity): string {
  const name = safeIdent(e.name, 'Entity')
  const fkKeys = new Set(e.fkFields.map((fk) => fk.via))
  // Keep PK first, then FKs, then the rest — so a cap never hides the keys that carry the relationships.
  const pk = e.fields.filter((f) => f.key === e.pk)
  const fks = e.fields.filter((f) => f.key !== e.pk && fkKeys.has(f.key))
  const rest = e.fields.filter((f) => f.key !== e.pk && !fkKeys.has(f.key))
  const ordered = [...pk, ...fks, ...rest]
  const shown = ordered.slice(0, ER_FIELD_CAP)
  const lines = shown.map((f) => {
    const type = attrType(f)
    const attr = safeIdent(f.key, 'field')
    const key = f.key === e.pk ? ' PK' : fkKeys.has(f.key) ? ' FK' : ''
    return `    ${type} ${attr}${key}`
  })
  const extra = ordered.length - shown.length
  if (extra > 0) lines.push(`    more fields "+${extra} more"`)
  // A Mermaid entity with no attributes is still valid (empty braces); keep the box so a relationship
  // endpoint always resolves.
  return `  ${name} {\n${lines.join('\n')}\n  }`
}

/**
 * A generous element size for the rendered ER diagram, scaled to the model (entity count → width, field
 * rows → height) and clamped to canvas-friendly bounds. The default Diagram card (280×200) crushes a
 * production-scale model into an unreadable thumbnail at the 2.5× zoom ceiling — sizing the element (the
 * SVG scales to fill it via object-fit) is what makes the export legible. Pure, so the export can size
 * both the element and its host Planning board before render.
 */
export function erDiagramSize(model: EntityModel): { w: number; h: number } {
  const ents = model.entities.filter((e) => e.kind === 'entity')
  if (ents.length === 0) return { w: 360, h: 240 }
  const maxRows = Math.min(ER_FIELD_CAP + 1, Math.max(3, ...ents.map((e) => e.fields.length)))
  const w = Math.max(420, Math.min(2400, 280 + ents.length * 130))
  const h = Math.max(300, Math.min(1500, 200 + maxRows * 30 + ents.length * 12))
  return { w, h }
}

/**
 * Serialize an inferred entity model to Mermaid `erDiagram` source. Returns a header-only diagram
 * (`erDiagram` + a comment) when there are no identity-bearing entities — callers should guard the
 * "→ Planning" export on `model.entities.some(e => e.kind === 'entity')` rather than materialize that.
 */
export function toErMermaid(model: EntityModel): string {
  const entities = model.entities.filter((e) => e.kind === 'entity')
  if (entities.length === 0) {
    return 'erDiagram\n  %% no entities inferred — flat API (no shared identifiers)'
  }
  const drawn = new Set(entities.map((e) => safeIdent(e.name, 'Entity')))
  const out: string[] = ['erDiagram']
  for (const e of entities) out.push(entityBlock(e))
  for (const r of model.relationships) {
    const from = safeIdent(r.from, 'Entity')
    const to = safeIdent(r.to, 'Entity')
    // Only draw a relationship whose BOTH endpoints are entity boxes we emitted.
    if (!drawn.has(from) || !drawn.has(to)) continue
    const card = r.kind === '1-1' ? '||--||' : '||--o{'
    out.push(`  ${from} ${card} ${to} : "${safeLabel(r.via)}"`)
  }
  return out.join('\n')
}
