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

/** v2 reveal-on-select: the compact left-docked popover is shown whenever there is a single
 *  eligible selection — selecting a board IS the trigger (mirrors a properties panel). There is no
 *  proximity/focus gate anymore. Dismissal is deselection (click empty canvas / select another
 *  board), which the canvas already does — so reveal simply tracks eligibility. */
export function inspectorRevealed(eligible: boolean): boolean {
  return eligible
}
