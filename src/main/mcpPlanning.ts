import type { PlanningOp, PlanningOpTint } from './mcpCommand'

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
 * An empty-after-sanitize value is dropped to `undefined` (treated as "no section") rather than
 * rejected, so a blank tag just falls back to the masonry instead of failing the whole batch.
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
      // Sanitize the Mermaid source like any multi-line text field (strip control/escape chars,
      // keep newlines, cap length). It is rendered later by the sandboxed worker, never executed.
      const source = sanitizePlanningText(
        el.source,
        MAX_PLANNING_DIAGRAM,
        `diagram[${index}].source`
      )
      return withSection({ kind: 'diagram', source })
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
function confirmField(text: string, indent: string): string {
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
    // the content. Already sanitized to a single line in buildOp, so it can't forge body lines.
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
        lines.push(`• ${sec}Diagram (Mermaid — renders as an image):`)
        lines.push(`    ${confirmField(op.source, '    ')}`)
        break
    }
  }
  return lines.join('\n')
}
