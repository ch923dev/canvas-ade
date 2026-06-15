/**
 * The Planning whiteboard's tool set + pure keyboard mapping (W1.2). Lives in its
 * own module so the `PlanTool` type is shareable (PlanningBoard + this map) and the
 * key→tool logic is unit-testable without React.
 *
 * Letters ONLY (s/n/c/a/p/e): the number row is deliberately avoided so a board
 * shortcut never collides with the live global 1=fit / 0=recenter / t=tidy canvas
 * bindings (Canvas.tsx). The board-internal tool set; distinct from the dock's
 * add-board tool.
 */

export type PlanTool = 'select' | 'note' | 'text' | 'check' | 'arrow' | 'pen' | 'erase' | 'diagram'

const SHORTCUTS: Record<string, PlanTool> = {
  s: 'select',
  n: 'note',
  c: 'check',
  a: 'arrow',
  p: 'pen',
  e: 'erase'
}

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
