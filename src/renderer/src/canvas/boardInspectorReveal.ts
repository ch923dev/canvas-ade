/**
 * Pure reveal predicates for the Board Inspector (kept out of BoardInspector.tsx so the component
 * file only exports a component — react-refresh / HMR — and the logic is unit-testable in isolation).
 */

/** Below this zoom the on-board board itself degrades to an LOD card; the full Inspector hides too
 *  (a single-action micro-rail is the later-phase overview-zoom affordance). */
export const MIN_ZOOM = 0.4

/** The Inspector has CONTENT only for an unambiguous single selection at a usable zoom. */
export function inspectorEligible(selectedCount: number, zoom: number): boolean {
  return selectedCount === 1 && zoom >= MIN_ZOOM
}

/** Given content exists, the panel reveals on right-edge proximity or focus-within — never on
 *  selection alone in P0, so synthetic e2e clicks (which never sweep to the screen edge) can't
 *  raise it over a board. */
export function inspectorRevealed(eligible: boolean, inZone: boolean, focused: boolean): boolean {
  return eligible && (inZone || focused)
}
