/**
 * Pure selection summary for the Planning Board Inspector's ELEMENT section (P4). Given the board's
 * elements + the (group-expanded) selected ids, it reports what the inspector needs to decide WHICH
 * per-kind controls to surface: the selection's kind (a single element kind when homogeneous, else
 * `mixed`), its count, and — for a homogeneous TEXT selection — the common typography tokens (a
 * `null` attribute means the selected texts disagree → the segmented control shows no active option).
 *
 * This is the P4 "multi-select gating" rule in ONE place (decision 3, signed off 2026-07-01):
 * homogeneous → per-kind controls (typography for text, tint for notes); mixed → shared controls
 * only. No React, no DOM — safe in the node test env and unit-tested directly.
 */
import type { PlanningElement, TextElement } from '../../../../lib/boardSchema'
import {
  TEXT_DEFAULTS,
  type FontFamilyToken,
  type FontSizeToken,
  type TextAlignToken,
  type TextColorToken
} from '../textStyle'

/** The selection's kind: a single element kind when homogeneous, or `mixed` across ≥2 kinds. */
export type SelectionKind = PlanningElement['kind'] | 'mixed'

/** Common typography across a homogeneous text selection. A `null` attribute = the selected texts
 *  disagree on it (indeterminate → no active segment). `bold` is true only when ALL are bold. */
export interface TypographyCommon {
  fontFamily: FontFamilyToken | null
  fontSize: FontSizeToken | null
  align: TextAlignToken | null
  color: TextColorToken | null
  bold: boolean
}

export interface ElementSelectionSummary {
  /** The selected element ids (order-stable, from `elements`). */
  ids: string[]
  count: number
  /** `null` when nothing is selected. */
  kind: SelectionKind | null
  mixed: boolean
  /** Header label for the section, e.g. `text` / `note` / `mixed`. */
  kindLabel: string
  isAllText: boolean
  isAllNotes: boolean
  /** Common typography across a homogeneous text selection; `null` for any other selection. */
  typography: TypographyCommon | null
}

const EMPTY: ElementSelectionSummary = {
  ids: [],
  count: 0,
  kind: null,
  mixed: false,
  kindLabel: '',
  isAllText: false,
  isAllNotes: false,
  typography: null
}

/** The single common value across `vals`, or `null` when they disagree (or the list is empty). */
function common<T>(vals: T[]): T | null {
  if (vals.length === 0) return null
  return vals.every((v) => v === vals[0]) ? vals[0] : null
}

function typographyOf(texts: TextElement[]): TypographyCommon {
  return {
    fontFamily: common(texts.map((t) => t.fontFamily ?? TEXT_DEFAULTS.fontFamily)),
    fontSize: common(texts.map((t) => t.fontSize ?? TEXT_DEFAULTS.fontSize)),
    align: common(texts.map((t) => t.align ?? TEXT_DEFAULTS.align)),
    color: common(texts.map((t) => t.color ?? TEXT_DEFAULTS.color)),
    bold: texts.every((t) => t.bold ?? TEXT_DEFAULTS.bold)
  }
}

/** Summarize the selection for the inspector's Element section. `ids` is the group-expanded set the
 *  actions operate on (same set the right-click menu is built with). */
export function summarizeSelection(
  elements: PlanningElement[],
  ids: ReadonlySet<string>
): ElementSelectionSummary {
  const sel = elements.filter((e) => ids.has(e.id))
  if (sel.length === 0) return EMPTY
  const kinds = new Set(sel.map((e) => e.kind))
  const mixed = kinds.size > 1
  const kind: SelectionKind = mixed ? 'mixed' : sel[0].kind
  const isAllText = kind === 'text'
  const isAllNotes = kind === 'note'
  return {
    ids: sel.map((e) => e.id),
    count: sel.length,
    kind,
    mixed,
    kindLabel: mixed ? 'mixed' : kind,
    isAllText,
    isAllNotes,
    typography: isAllText ? typographyOf(sel as TextElement[]) : null
  }
}
