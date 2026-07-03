// Pure helpers for the terminal find bar (Phase 2 — find-in-terminal). The EFFECTFUL wiring
// (loading the SearchAddon onto the live term, running findNext/findPrevious, the decoration
// lifecycle) lives in TerminalFindBar + useTerminalSpawn and is covered by the @terminal e2e.
// What is isolated here are the two DECIDABLE seams: the match-count label and the per-call
// search-option builder — unit-tested without an xterm instance.
//
// Only TYPES are imported from '@xterm/addon-search' (erased at compile), so this module carries
// no runtime dependency on the addon and loads fine under jsdom/node.
import type { ISearchOptions, ISearchDecorationOptions } from '@xterm/addon-search'

/**
 * Match-highlight colours handed to the SearchAddon. One accent (blue) per DESIGN.md: every match
 * gets a muted-blue cell wash; the active match a brighter wash + a light-blue ring. The
 * `*Background` fields MUST be `#RRGGBB` (addon constraint — no rgba/var()); the two overview-ruler
 * fields are required by the addon's type even though our terminals render no ruler (width 0).
 * Mirrors the tokens.css accent (#4f8cff / --accent-hover #6ea0ff); tune alongside DESIGN.md.
 */
export const SEARCH_DECORATIONS: ISearchDecorationOptions = {
  matchBackground: '#2b3b5e',
  matchOverviewRuler: '#4f8cff',
  activeMatchBackground: '#3f74d6',
  activeMatchBorder: '#6ea0ff',
  activeMatchColorOverviewRuler: '#6ea0ff'
}

/**
 * Build the SearchAddon options for one find call. Decorations are ALWAYS attached: the addon only
 * emits `onDidChangeResults` (the match counter's sole source) when decorations are enabled.
 * `incremental` keeps the selection from leaping forward while the user is still typing — it is
 * meaningful only on findNext (the addon ignores it on findPrevious), so callers pass it true for
 * type-ahead and false for an explicit next/prev step.
 */
export function buildSearchOptions(opts: {
  caseSensitive: boolean
  regex: boolean
  incremental: boolean
}): ISearchOptions {
  return {
    caseSensitive: opts.caseSensitive,
    regex: opts.regex,
    incremental: opts.incremental,
    decorations: SEARCH_DECORATIONS
  }
}

/**
 * The find-bar counter label from the addon's `{resultIndex, resultCount}`. `resultIndex` is the
 * 0-based active match; it is -1 when nothing matches OR when the highlight threshold was exceeded
 * (too many matches to index a current one). The caller shows '' for an empty query and never
 * calls this then.
 *   count 0           -> "No results"
 *   index -1, count N -> "N"          (threshold exceeded: a total without a cursor)
 *   index i,  count N -> "i+1 / N"
 */
export function formatMatchCount(resultIndex: number, resultCount: number): string {
  if (resultCount <= 0) return 'No results'
  if (resultIndex < 0) return String(resultCount)
  return `${resultIndex + 1} / ${resultCount}`
}

/**
 * Find-count fix: how long after a type-ahead search the bar re-runs the SAME incremental search
 * once. The addon's decoration count can transiently read 0 on a just-revealed / mid-refit
 * terminal even though the match was found+selected, and it only self-corrects on the next PTY
 * write (its `onWriteParsed` recount, +200ms debounce) — minutes away on an idle terminal. One
 * settle re-run re-registers the decorations after the addon's 200ms highlight debounce AND the
 * 120ms liveness reveal settle (+ a frame), converging the count without further output.
 */
export const SEARCH_SETTLE_MS = 350
