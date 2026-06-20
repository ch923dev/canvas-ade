/**
 * The Planning whiteboard's tool set + pure keyboard mapping (W1.2). Lives in its
 * own module so the `PlanTool` type is shareable (PlanningBoard + this map) and the
 * key→tool logic is unit-testable without React.
 *
 * Letters ONLY (s/n/x/c/d/a/p/e): the number row is deliberately avoided so a board
 * shortcut never collides with the live global 1=fit / 0=recenter / t=tidy canvas
 * bindings (Canvas.tsx) — which is also why `text` is `x` and `diagram` is `d`, NOT
 * `t` (PLAN-03). The board-internal tool set; distinct from the dock's add-board tool.
 */

export type PlanTool = 'select' | 'note' | 'text' | 'check' | 'arrow' | 'pen' | 'erase' | 'diagram'

/**
 * Per-tool human label (PLAN-02 a11y — the accessible name passed to IconBtn) + its
 * bare-letter keyboard shortcut (PLAN-03, surfaced in the tooltip as e.g. "Sticky note
 * (N)"). This is the SINGLE SOURCE OF TRUTH for both: `SHORTCUTS` below is derived from
 * it so the tooltip letter and the key the handler accepts can never drift apart.
 *
 * Keys are collision-checked against each other AND the global bare-key canvas bindings
 * (1 fit / 0 recenter / t tidy) — hence text=x, diagram=d (never t).
 */
export const TOOL_META: Record<PlanTool, { label: string; key: string }> = {
  select: { label: 'Select', key: 's' },
  note: { label: 'Sticky note', key: 'n' },
  text: { label: 'Text', key: 'x' },
  check: { label: 'Checklist', key: 'c' },
  diagram: { label: 'Diagram', key: 'd' },
  arrow: { label: 'Arrow', key: 'a' },
  pen: { label: 'Pen', key: 'p' },
  erase: { label: 'Eraser', key: 'e' }
}

const SHORTCUTS: Record<string, PlanTool> = Object.fromEntries(
  (Object.entries(TOOL_META) as Array<[PlanTool, { label: string; key: string }]>).map(
    ([tool, meta]) => [meta.key, tool]
  )
)

/**
 * Map a bare letter key to a tool. Returns null for an unmapped key OR any modified
 * chord (Ctrl/Cmd/Alt) so app-level shortcuts like Ctrl+A / Cmd+Z pass straight
 * through to the global handler.
 */
export function shortcutTool(
  key: string,
  mods: { ctrl: boolean; meta: boolean; alt: boolean }
): PlanTool | null {
  if (mods.ctrl || mods.meta || mods.alt) return null
  return SHORTCUTS[key.toLowerCase()] ?? null
}
