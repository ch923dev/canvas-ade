import type { ConfirmDiff, PlanningOp, PlanningOpTint } from '../shared/mcpTypes'
import type { DiagramSpec } from '@expanse-ade/diagram/spec'
import { assertDiagramSpec } from '@expanse-ade/diagram/spec'
import { diffSpecs, lintSpec } from '../renderer/src/lib/specDiff'

/**
 * 🔒 MAIN-side validation, sanitization, and caps for agent-authored planning CONTENT (S2).
 *
 * `add_planning_elements` is the first MCP path that writes attacker-influenceable content
 * onto the durable canvas (ADR 0003). The @expanse-ade/mcp tool schema is a first
 * (transport) check, but MAIN is the authority — it re-validates every element, strips
 * dangerous control characters, and caps element count + total byte size (the canvas doc /
 * undo-snapshot bloat risk: no upper bound otherwise). The cleaned ops are then shown to the
 * human IN FULL via the confirm gate before they ever reach the renderer.
 *
 * MAIN cannot import the renderer's `assertPlanningElement` in shipped code (separate
 * bundle), so this validator mirrors the constraints for the agent-content kinds (note ·
 * checklist · text · arrow · diagram); the
 * renderer applier then RE-validates every materialized element against the real
 * `assertPlanningElement` before it lands (defense in depth) — so an off-shape op can never
 * reach a board even if this mirror and the schema ever drift.
 */

/** A content rejection — the orchestrator audits it `rejected` and throws. */
export class PlanningContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanningContentError'
  }
}

// ── Caps (MAIN-authoritative; the package mirrors looser transport caps) ──────────
/** Max elements written in ONE call. */
export const MAX_PLANNING_ELEMENTS = 50
/** Max items in one checklist element. */
export const MAX_PLANNING_ITEMS = 100
/** Max chars for a free-text body (note / text). */
export const MAX_PLANNING_TEXT = 4000
/** Max chars for a checklist title. */
export const MAX_PLANNING_TITLE = 200
/** Max chars for one checklist item label. */
export const MAX_PLANNING_LABEL = 500
/** Max chars for a `diagram` element's Mermaid source (the worker also caps at render time). */
export const MAX_PLANNING_DIAGRAM = 4000
/** Max chars for an element's optional `section` tag (2a) — a short single-line column label. */
export const MAX_PLANNING_SECTION = 60
/**
 * Max total byte size (UTF-8) of one batch's ops, kept small enough that the FULL content
 * stays human-reviewable in the confirm modal (the security premise: injected text can't be
 * rubber-stamped if it can't be seen). Bounds canvas.json / undo-snapshot growth per call.
 */
export const MAX_PLANNING_BYTES = 16 * 1024
/**
 * Serialized-bytes bound for ONE structured DiagramSpec (Phase 3) — the same 16 KB
 * confirm-reviewability premise, applied per spec so the cross-repo parity test can pin the
 * package's `MAX_DIAGRAM_SPEC_BYTES` to it name-for-name. (The whole-batch cap above still
 * governs the batch.)
 */
export const MAX_DIAGRAM_SPEC_BYTES = MAX_PLANNING_BYTES
/** Bound on an arrow delta so a single op can't span an absurd distance. */
const MAX_ARROW_DELTA = 5000

const TINTS: readonly PlanningOpTint[] = ['yellow', 'blue', 'green', 'plain']
const DEFAULT_TINT: PlanningOpTint = 'yellow'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Reduce one agent text field to safe, bounded content. Normalizes CR/CRLF → LF; strips C0
 * control chars EXCEPT newline (0x0A) and tab (0x09), DEL (0x7F), and C1 controls
 * (0x80–0x9F) — the terminal-escape / injection surface — while KEEPING the newlines a note
 * legitimately contains (unlike the single-line PTY dispatch sanitizer). Caps the length and
 * requires non-empty after trimming.
 */
export function sanitizePlanningText(raw: unknown, max: number, field: string): string {
  if (typeof raw !== 'string') throw new PlanningContentError(`${field} must be a string`)
  // Normalize line endings first so a CRLF doesn't leave a stray CR to be stripped to nothing.
  const normalized = raw.replace(/\r\n?/g, '\n')
  let out = ''
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x09) {
      out += ch
      continue
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    out += ch
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) throw new PlanningContentError(`${field} is empty after sanitization`)
  if (trimmed.length > max) {
    throw new PlanningContentError(`${field} exceeds the ${max}-char limit`)
  }
  return trimmed
}

/**
 * Reduce an element's optional `section` tag (2a) to a safe, SINGLE-LINE column label, or
 * `undefined` when absent/empty. Unlike {@link sanitizePlanningText} (which keeps newlines for
 * note bodies), a section is a heading: all whitespace (incl. newlines/tabs) collapses to single
 * spaces — so it can't forge multiple confirm-body lines — and C0/C1/DEL controls are stripped.
 * The bracket chars `[`/`]` are also stripped: the confirm body wraps the section as `[label]`, so
 * a section like `Build] Note:` would otherwise blur the label/kind boundary on that line and
 * weaken the "human sees the TRUE structure" premise (ADR 0003). An empty-after-sanitize value is
 * dropped to `undefined` (treated as "no section") rather than rejected, so a blank tag just falls
 * back to the masonry instead of failing the whole batch.
 */
function sanitizeSection(raw: unknown, index: number): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new PlanningContentError(`element ${index} section must be a string`)
  }
  let out = ''
  for (const ch of raw.replace(/\s+/g, ' ')) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    if (code === 0x5b || code === 0x5d) continue // [ / ] — would blur the [label] confirm boundary
    out += ch
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_PLANNING_SECTION) {
    throw new PlanningContentError(
      `element ${index} section exceeds the ${MAX_PLANNING_SECTION}-char limit`
    )
  }
  return trimmed
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 🔒 The MAIN-authoritative gate for ONE structured DiagramSpec (Phase 3). Reuses the renderer's
 * canonical `assertDiagramSpec` (@expanse-ade/diagram/spec — an import-free LEAF designed for exactly
 * this cross-bundle reuse: shape, caps, closed enums, referential integrity), then adds the two
 * checks that are MCP-specific: a control-character REJECT over every string (unlike prose
 * fields, a spec is not sanitized-in-place — it arrives atomically from one author, so a control
 * char is an authoring bug worth surfacing, the same doctrine as dangling refs), and the 16 KB
 * serialized-bytes confirm-reviewability bound. Returns a deep JSON clone so the minted op can
 * never share references with (or carry getters from) the agent payload.
 */
export function buildDiagramSpec(raw: unknown, field: string): DiagramSpec {
  const fail = (msg: string): never => {
    throw new PlanningContentError(`${field}: ${msg}`)
  }
  assertDiagramSpec(raw, fail, isRecord, isFiniteNum)
  const spec = raw as DiagramSpec
  const scan = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const ch of v) {
        const code = ch.codePointAt(0) ?? 0
        if (code === 0x0a || code === 0x09) continue // legit multi-line labels/details
        if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
          fail('contains a control character')
        }
      }
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) scan(x)
      return
    }
    if (isRecord(v)) for (const k of Object.keys(v)) scan(v[k])
  }
  scan(spec)
  const bytes = Buffer.byteLength(JSON.stringify(spec), 'utf8')
  if (bytes > MAX_DIAGRAM_SPEC_BYTES) {
    fail(`serializes to ${bytes} bytes (cap ${MAX_DIAGRAM_SPEC_BYTES})`)
  }
  return JSON.parse(JSON.stringify(spec)) as DiagramSpec
}

/** Validate one agent-supplied element → a clean, fully-specified {@link PlanningOp}. */
function buildOp(el: unknown, index: number): PlanningOp {
  if (!isRecord(el)) throw new PlanningContentError(`element ${index} is not an object`)
  // The optional column label applies to every kind; sanitize once and attach below.
  const section = sanitizeSection(el.section, index)
  const withSection = <T extends object>(op: T): T & { section?: string } =>
    section ? { ...op, section } : op
  switch (el.kind) {
    case 'note': {
      const text = sanitizePlanningText(el.text, MAX_PLANNING_TEXT, `note[${index}].text`)
      let tint: PlanningOpTint = DEFAULT_TINT
      if (el.tint !== undefined) {
        if (!TINTS.includes(el.tint as PlanningOpTint)) {
          throw new PlanningContentError(`note[${index}] has an invalid tint`)
        }
        tint = el.tint as PlanningOpTint
      }
      return withSection({ kind: 'note', text, tint })
    }
    case 'text': {
      const text = sanitizePlanningText(el.text, MAX_PLANNING_TEXT, `text[${index}].text`)
      return withSection({ kind: 'text', text })
    }
    case 'checklist': {
      const title = sanitizePlanningText(el.title, MAX_PLANNING_TITLE, `checklist[${index}].title`)
      if (!Array.isArray(el.items)) {
        throw new PlanningContentError(`checklist[${index}].items is not an array`)
      }
      if (el.items.length === 0) {
        throw new PlanningContentError(`checklist[${index}] has no items`)
      }
      if (el.items.length > MAX_PLANNING_ITEMS) {
        throw new PlanningContentError(
          `checklist[${index}] has more than ${MAX_PLANNING_ITEMS} items`
        )
      }
      const items = el.items.map((it, j) => {
        if (!isRecord(it)) throw new PlanningContentError(`checklist[${index}].items[${j}] invalid`)
        const label = sanitizePlanningText(
          it.label,
          MAX_PLANNING_LABEL,
          `checklist[${index}].items[${j}].label`
        )
        if (it.done !== undefined && typeof it.done !== 'boolean') {
          throw new PlanningContentError(`checklist[${index}].items[${j}].done is not a boolean`)
        }
        return { label, done: it.done === true }
      })
      return withSection({ kind: 'checklist', title, items })
    }
    case 'arrow': {
      const { dx, dy } = el
      if (
        typeof dx !== 'number' ||
        !Number.isFinite(dx) ||
        typeof dy !== 'number' ||
        !Number.isFinite(dy)
      ) {
        throw new PlanningContentError(`arrow[${index}] has non-finite dx/dy`)
      }
      if (Math.abs(dx) > MAX_ARROW_DELTA || Math.abs(dy) > MAX_ARROW_DELTA) {
        throw new PlanningContentError(`arrow[${index}] delta exceeds ${MAX_ARROW_DELTA}px`)
      }
      return withSection({ kind: 'arrow', dx, dy })
    }
    case 'diagram': {
      // Phase 3: a diagram carries EXACTLY ONE content form — Mermaid `source` (engine 'mermaid',
      // the pre-Phase-3 shape) or a structured `spec` (engine 'expanse'). The transport schema
      // already enforces the XOR; MAIN re-checks from scratch (untrusted input).
      const hasSource = el.source !== undefined
      const hasSpec = el.spec !== undefined
      if (hasSource === hasSpec) {
        throw new PlanningContentError(
          `diagram[${index}] must carry exactly one of "source" (Mermaid) or "spec" (expanse)`
        )
      }
      if (hasSpec) {
        if (el.engine !== undefined && el.engine !== 'expanse') {
          throw new PlanningContentError(
            `diagram[${index}] engine "${String(el.engine)}" cannot carry a structured spec`
          )
        }
        const spec = buildDiagramSpec(el.spec, `diagram[${index}].spec`)
        return withSection({ kind: 'diagram', engine: 'expanse', spec })
      }
      if (el.engine !== undefined && el.engine !== 'mermaid') {
        throw new PlanningContentError(
          `diagram[${index}] engine "${String(el.engine)}" cannot carry a Mermaid source`
        )
      }
      // Sanitize the Mermaid source like any multi-line text field (strip control/escape chars,
      // keep newlines, cap length). It is rendered later by the sandboxed worker, never executed.
      const source = sanitizePlanningText(
        el.source,
        MAX_PLANNING_DIAGRAM,
        `diagram[${index}].source`
      )
      return withSection({ kind: 'diagram', engine: 'mermaid', source })
    }
    default:
      throw new PlanningContentError(`element ${index} has an unsupported kind ${String(el.kind)}`)
  }
}

/**
 * Validate + sanitize + cap a whole agent batch into clean {@link PlanningOp}s. Throws a
 * {@link PlanningContentError} on any violation (no partial writes). The byte cap is checked
 * on the CLEANED ops (what actually lands) so a payload can't dodge it with control chars.
 */
export function buildPlanningOps(elements: unknown): PlanningOp[] {
  if (!Array.isArray(elements)) {
    throw new PlanningContentError('elements is not an array')
  }
  if (elements.length === 0) {
    throw new PlanningContentError('no elements to write')
  }
  if (elements.length > MAX_PLANNING_ELEMENTS) {
    throw new PlanningContentError(
      `too many elements (${elements.length} > ${MAX_PLANNING_ELEMENTS})`
    )
  }
  const ops = elements.map((el, i) => buildOp(el, i))
  const bytes = Buffer.byteLength(JSON.stringify(ops), 'utf8')
  if (bytes > MAX_PLANNING_BYTES) {
    throw new PlanningContentError(`content too large (${bytes} > ${MAX_PLANNING_BYTES} bytes)`)
  }
  return ops
}

/**
 * 🔒 Render ONE agent text field for the confirm body without letting it spoof the body's
 * structure. Embedded newlines are kept (a note is legitimately multi-line) but every
 * continuation line is INDENTED so it can't masquerade as a top-level "• " bullet or a
 * checklist row — and runs of 3+ blank lines are collapsed so padded whitespace can't push
 * the real subsequent elements out of the scrollable confirm viewport. Both close the
 * confirm-body injection vector: the human must see the TRUE structure (ADR 0003).
 */
export function confirmField(text: string, indent: string): string {
  return text.replace(/\n{3,}/g, '\n\n').replace(/\n/g, `\n${indent}`)
}

/**
 * Render the FULL human-readable content of a batch for the write-time confirm body. Shows
 * every note/text body and every checklist item (✓/☐) so injected content is visible and
 * can't be rubber-stamped — never a bare count (ADR 0003). Each field is run through
 * {@link confirmField} so multi-line content can't forge the bullet/row structure.
 */
export function renderPlanningConfirmBody(boardTitle: string, ops: PlanningOp[]): string {
  const lines: string[] = [
    `The agent wants to write ${ops.length} element(s) to planning board "${boardTitle}".`,
    '',
    'Content to be added (renders as passive notes — nothing runs):'
  ]
  for (const op of ops) {
    // Surface the agent's column label (2a) so the human sees the structure being written, not just
    // the content. Already sanitized in buildOp to a single line with no `[`/`]`, so it can neither
    // forge new body lines nor blur this line's [label]/kind boundary.
    const sec = op.section ? `[${op.section}] ` : ''
    switch (op.kind) {
      case 'note':
        lines.push(`• ${sec}Note: ${confirmField(op.text, '  ')}`)
        break
      case 'text':
        lines.push(`• ${sec}Text: ${confirmField(op.text, '  ')}`)
        break
      case 'checklist':
        lines.push(
          `• ${sec}Checklist "${confirmField(op.title, '  ')}" (${op.items.length} item(s)):`
        )
        for (const it of op.items) {
          lines.push(`    ${it.done ? '☑' : '☐'} ${confirmField(it.label, '      ')}`)
        }
        break
      case 'arrow':
        lines.push(`• ${sec}Arrow (Δx ${op.dx}, Δy ${op.dy})`)
        break
      case 'diagram':
        if (op.engine === 'expanse') {
          // Full-content plain-text fallback (ADR 0003 + the Jarvis body-only route): every
          // node/edge/group as a describe row — the structured ConfirmDiff is presentation on top.
          const d = diffSpecs(null, op.spec)
          const title = op.spec.title !== undefined ? ` "${confirmField(op.spec.title, '  ')}"` : ''
          lines.push(
            `• ${sec}Diagram (structured${title} — ${op.spec.nodes.length} node(s), ` +
              `${op.spec.edges.length} edge(s)${(op.spec.groups?.length ?? 0) > 0 ? `, ${op.spec.groups?.length} group(s)` : ''}):`
          )
          for (const s of d.sections) {
            for (const row of s.rows)
              lines.push(`    ${row.sig} ${confirmField(row.text, '      ')}`)
          }
          for (const warn of lintSpec(op.spec)) {
            lines.push(`    ⚠ ${confirmField(warn, '      ')}`)
          }
        } else {
          lines.push(`• ${sec}Diagram (Mermaid — renders as an image):`)
          lines.push(`    ${confirmField(op.source, '    ')}`)
        }
        break
    }
  }
  return lines.join('\n')
}

/**
 * Build the OPTIONAL structured {@link ConfirmDiff} for an add batch (Phase 3, Option B) —
 * present only when the batch carries ≥1 structured diagram. Sections come from
 * {@link diffSpecs}(null, spec) (everything added, grouped Nodes/Edges/Groups), prefixed with
 * the diagram's title when the batch has several. Presentation only: the plain body above stays
 * the complete authoritative fallback.
 */
export function buildPlanningConfirmDiff(ops: PlanningOp[]): ConfirmDiff | undefined {
  const specs = ops.filter(
    (op): op is Extract<PlanningOp, { kind: 'diagram'; engine: 'expanse' }> =>
      op.kind === 'diagram' && op.engine === 'expanse'
  )
  if (specs.length === 0) return undefined
  const sections: ConfirmDiff['sections'] = []
  const lints: string[] = []
  let nodes = 0
  let edges = 0
  for (const op of specs) {
    const d = diffSpecs(null, op.spec)
    const prefix =
      specs.length > 1 ? `${op.spec.title !== undefined ? `"${op.spec.title}" · ` : ''}` : ''
    for (const s of d.sections) sections.push({ title: `${prefix}${s.title}`, rows: s.rows })
    lints.push(...lintSpec(op.spec))
    nodes += op.spec.nodes.length
    edges += op.spec.edges.length
  }
  const bytes = specs.reduce((n, op) => n + Buffer.byteLength(JSON.stringify(op.spec), 'utf8'), 0)
  const kb = (bytes / 1024).toFixed(1)
  const summary =
    `${specs.length > 1 ? `${specs.length} diagrams · ` : 'new diagram · '}` +
    `${nodes} node(s) · ${edges} edge(s) · ${kb} KB of ${MAX_DIAGRAM_SPEC_BYTES / 1024} KB`
  return { summary, sections, lints }
}
