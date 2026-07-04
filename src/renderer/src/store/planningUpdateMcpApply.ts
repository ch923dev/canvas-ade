import type { ChecklistItem, NoteTint, PlanningElement } from '../lib/boardSchema'
import type { PlanningEditOp, PlanningEditPatch } from '../../../shared/mcpTypes'
import { removeElement } from '../canvas/boards/planning/elements'

/**
 * Renderer-side materialization of an MCP planning-element EDIT/REMOVE op (S6) — the read-then-update
 * loop that closes the append-only gap. MAIN resolved the element by id, validated the patch against its
 * kind, and human-confirmed it; this applies the SINGLE {@link PlanningEditOp} to the live `elements`
 * array. PURE (reads `els`, returns a fresh array) so it unit-tests in isolation; the applier
 * (`useMcpCommands`) re-validates the changed element with `assertPlanningElement` (defense in depth)
 * before it lands, then commits it as ONE undoable edit (PATCHABLE_KEYS.planning `elements`).
 *
 * - `remove` deletes the element by id (reusing the shared {@link removeElement} mutator).
 * - `update` edits the element in place per its kind: note text/tint, text body, checklist
 *   title/items (set by id · append · remove by id), diagram source (invalidating its SVG cache so it
 *   re-renders), or arrow delta. A field for another kind was already rejected host-side.
 *
 * Throws when the element id is absent (a stale read → the applier acks `{ok:false}`, nothing lands) or
 * its live kind no longer matches the op's kind (the element was replaced under the agent — never edit
 * the wrong element).
 */

function newItemId(): string {
  return crypto.randomUUID()
}

/**
 * Cumulative cap on a checklist's TOTAL item count (S6). `update_planning_element` caps each `addItems`
 * batch at 100 transport-side, but only the RENDERER knows the checklist's live item count (the MCP board
 * mirror truncates items to a preview), so — exactly like `add_planning_elements`' per-board
 * `MAX_PLANNING_BOARD_ELEMENTS` cap — the running-total bound is enforced here, where the live count is
 * authoritative. Matches the per-call/mirror item cap so an MCP-grown checklist can't sprawl unbounded.
 */
const MAX_CHECKLIST_ITEMS = 100

export function applyPlanningEditOp(els: PlanningElement[], op: PlanningEditOp): PlanningElement[] {
  const target = els.find((e) => e.id === op.elementId)
  if (!target) throw new Error(`planning element not found: ${op.elementId}`)
  if (op.op === 'remove') return removeElement(els, op.elementId)
  if (target.kind !== op.kind) {
    throw new Error(
      `planning element ${op.elementId} kind mismatch (live=${target.kind}, op=${op.kind})`
    )
  }
  return els.map((el) => (el.id === op.elementId ? editElement(el, op.patch) : el))
}

/** Apply a validated patch to ONE element, dispatching on its (discriminated) kind. Immutable. */
function editElement(el: PlanningElement, p: PlanningEditPatch): PlanningElement {
  switch (el.kind) {
    case 'note': {
      const n = { ...el }
      if (p.text !== undefined) n.text = p.text
      if (p.tint !== undefined) n.tint = p.tint as NoteTint
      return n
    }
    case 'text':
      return p.text !== undefined ? { ...el, text: p.text } : el
    case 'checklist': {
      // 🔒 An item id that matches no LIVE item is a stale/raced read — throw (→ useMcpCommands acks
      // {ok:false}) rather than silently no-op'ing to a false-positive {ok:true}, mirroring
      // kanbanMcpApply's "unknown card" and the gate's "element not found". A false success would
      // undermine the read → update-the-existing-element discipline this feature is built on.
      const liveIds = new Set(el.items.map((it) => it.id))
      let items: ChecklistItem[] = el.items
      if (p.setItems && p.setItems.length > 0) {
        for (const s of p.setItems) {
          if (!liveIds.has(s.id)) throw new Error(`unknown checklist item: ${s.id}`)
        }
        const byId = new Map(p.setItems.map((s) => [s.id, s]))
        items = items.map((it) => {
          const s = byId.get(it.id)
          if (!s) return it
          return {
            ...it,
            ...(s.label !== undefined ? { label: s.label } : {}),
            ...(s.done !== undefined ? { done: s.done } : {})
          }
        })
      }
      if (p.removeItemIds && p.removeItemIds.length > 0) {
        for (const id of p.removeItemIds) {
          if (!liveIds.has(id)) throw new Error(`unknown checklist item: ${id}`)
        }
        const rm = new Set(p.removeItemIds)
        items = items.filter((it) => !rm.has(it.id))
      }
      if (p.addItems && p.addItems.length > 0) {
        items = [
          ...items,
          ...p.addItems.map((a) => ({ id: newItemId(), label: a.label, done: a.done }))
        ]
        // 🔒 Reject an add that grows the checklist past the cumulative cap (an already-over-cap list can
        // still be edited/pruned — only growth is bounded). Throws → useMcpCommands acks {ok:false},
        // nothing lands, and the agent learns the write was rejected.
        if (items.length > MAX_CHECKLIST_ITEMS) {
          throw new Error(
            `checklist item cap exceeded (${items.length} > ${MAX_CHECKLIST_ITEMS}); remove items before adding more`
          )
        }
      }
      const n = { ...el, items }
      if (p.title !== undefined) n.title = p.title
      return n
    }
    case 'diagram': {
      if (p.source === undefined) return el
      const n = { ...el, source: p.source }
      // A source change invalidates the derived SVG cache; drop it so the card re-renders from source.
      delete n.svgCache
      return n
    }
    case 'arrow':
      return p.dx !== undefined && p.dy !== undefined
        ? { ...el, x2: el.x + p.dx, y2: el.y + p.dy }
        : el
    default:
      // image / fileref / stroke — not editable (host rejects an update; a remove is handled above).
      return el
  }
}
