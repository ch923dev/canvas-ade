// Phase 2 — find-in-terminal. A calm floating find bar over the terminal well (top-right),
// opened by Ctrl/Cmd+F (routed through terminalKeymap → useTerminalSpawn's `find` effect). It is a
// plain DOM input, NOT xterm, so its Enter/Shift+Enter never collide with xterm's newline (LF)
// handler. All search state (query/options/results) is LOCAL here so a keystroke re-renders only
// the bar, not the whole TerminalBoard; the host just mounts us with the stable `find` api.
//
// memo'd because TerminalBoard re-renders ~12×/s while an agent runs (the braille spinner) — `api`
// is stable (useMemo in useTerminalSpawn), so memo keeps those ticks from re-rendering the bar.
// No manual useCallback/useMemo inside: the type-ahead search is inlined in its effect (stable
// primitive deps) and the explicit next/prev `step` is a plain handler-only fn — compiler-clean.
import { memo, useEffect, useRef, useState, type ReactElement } from 'react'
import type { TerminalFindApi } from './useTerminalSpawn'
import { buildSearchOptions, formatMatchCount, SEARCH_SETTLE_MS } from './terminalSearch'

function TerminalFindBarImpl({ api }: { api: TerminalFindApi }): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  // Seed from a single-line xterm selection at open (lazy initialiser — avoids a setState in the
  // mount effect). A multi-line selection is not a sensible search term, so it seeds empty.
  const [query, setQuery] = useState(() => {
    const sel = api.termRef.current?.getSelection() ?? ''
    return sel && !sel.includes('\n') ? sel : ''
  })
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState<{ index: number; count: number }>({ index: -1, count: 0 })
  // Find-count fix: did the LAST search call actually find a match (findNext's boolean)?
  // The decoration-based `results.count` can transiently read 0 for a found+selected match on a
  // just-revealed / mid-refit terminal — while that holds, the bar shows a quiet pending count
  // instead of a false "No results" (the count converges via the settle re-search below).
  const [lastFound, setLastFound] = useState(false)

  // The match counter's only source: the addon emits this only when decorations are enabled
  // (buildSearchOptions always attaches them). The setState here is in an event callback, not the
  // effect body, so it does not cascade-render the effect.
  useEffect(() => {
    const addon = api.addonRef.current
    if (!addon) return
    const sub = addon.onDidChangeResults((e) =>
      setResults({ index: e.resultIndex, count: e.resultCount })
    )
    return () => sub.dispose()
  }, [api])

  // Mount: focus + select the input (the query is seeded by the lazy useState initialiser above).
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Type-ahead: re-search as the query/options change. Incremental holds the selection in place
  // while typing. Inlined (no shared useCallback) so there's no manual memo for the compiler to
  // skip. A bad regex mid-typing makes findNext throw — swallow it; the count reports 0 and the
  // bar stays usable.
  //
  // Find-count fix (three moves, one effect):
  //  1. flushPending() first, so the addon scans a buffer that includes bytes still queued for
  //     the next rAF (a query typed in the same tick as fresh output searched a stale buffer).
  //  2. Capture findNext's boolean — the honest "a match exists" signal even when the
  //     decoration-based count transiently reads 0 (see `lastFound` above).
  //  3. ONE settle re-run of the same incremental search: the addon recounts ONLY on PTY
  //     write/resize (its onWriteParsed hook), so a transient initial under-count would latch
  //     until the next output — minutes on an idle terminal. Re-searching after the addon's
  //     200ms highlight debounce + the 120ms liveness settle re-registers the decorations and
  //     fires onDidChangeResults with the true count, no output needed. Timer cleared on every
  //     query/option change, on unmount, AND by step() below (see settleRef); no loop
  //     (onDidChangeResults only sets `results`, which is not a dep of this effect).
  //
  // settleRef: a pending settle re-run is SUPERSEDED by a manual step. Incremental "holds the
  // selection" only when the selection came from an incremental search — after an
  // incremental:false step, a late settle re-run ADVANCES the cursor past the user's position
  // (caught by the Ctrl+F e2e under load: Enter to 2/3, late settle pushed it to 3/3). The
  // step's own find call refreshes the decorations/count anyway, so the settle is redundant then.
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // @xterm/addon-search 0.16 bug (T3, xterm 6.0 bump): SearchAddon.findNext assigns its
  // `lastSearchOptions = n` BEFORE the `didOptionsChange(n)` check reads it, so toggling
  // caseSensitive/regex on the SAME term always sees "no change" → it skips `_highlightAllMatches`,
  // and `onDidChangeResults` re-fires the STALE count (match-case ON never narrows). We detect an
  // option change and `clearDecorations()` first: that resets the addon's cached term
  // (clearDecorations → clearCachedTerm), so the next findNext recomputes the decorations + count at
  // the new options. A pure query change needs no clear — the term differs from the cache already.
  const optSigRef = useRef({ caseSensitive, regex })
  useEffect(() => {
    const addon = api.addonRef.current
    if (!addon) return
    if (!query) {
      addon.clearDecorations()
      return
    }
    if (optSigRef.current.caseSensitive !== caseSensitive || optSigRef.current.regex !== regex) {
      addon.clearDecorations() // option toggle on the same term — force a fresh recount (0.16 bug above)
    }
    optSigRef.current = { caseSensitive, regex }
    api.flushPending()
    const search = (): boolean => {
      try {
        return addon.findNext(
          query,
          buildSearchOptions({ caseSensitive, regex, incremental: true })
        )
      } catch {
        return false /* invalid regex while typing */
      }
    }
    // The sync setState mirrors the search we just ran (same tick as the user's keystroke) — the
    // async-boundary caveat of the lint rule doesn't apply, matches the RecapView.tsx precedent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastFound(search())
    settleRef.current = setTimeout(() => {
      settleRef.current = null
      setLastFound(search())
    }, SEARCH_SETTLE_MS)
    return () => {
      if (settleRef.current) clearTimeout(settleRef.current)
      settleRef.current = null
    }
  }, [query, caseSensitive, regex, api])

  // Close: clear the highlights and hand focus back to xterm so typing resumes immediately.
  useEffect(
    () => () => {
      api.addonRef.current?.clearDecorations()
      api.termRef.current?.focus()
    },
    [api]
  )

  // Explicit next/prev (Enter / Shift+Enter / the ↑↓ buttons). Plain fn — only ever called from
  // event handlers, never a hook dependency, so its per-render identity is harmless.
  const step = (dir: 'next' | 'prev'): void => {
    const addon = api.addonRef.current
    if (!addon || !query) return
    // A manual step supersedes any pending settle re-run — a late incremental re-search after
    // an incremental:false step advances the cursor past the user's position (see settleRef).
    if (settleRef.current) {
      clearTimeout(settleRef.current)
      settleRef.current = null
    }
    api.flushPending() // find-count fix: step against a buffer that matches the screen
    const opts = buildSearchOptions({ caseSensitive, regex, incremental: false })
    try {
      setLastFound(dir === 'prev' ? addon.findPrevious(query, opts) : addon.findNext(query, opts))
    } catch {
      /* invalid regex */
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Keep React Flow globals (board-delete on Backspace, 1/0 zoom, Esc→exit-full-view) from
    // firing while the user types in the bar — the bar owns Enter/Shift+Enter/Esc.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? 'prev' : 'next')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      api.close()
    }
  }

  // Find-count fix: "no results" needs BOTH signals to agree — a zero decoration count while
  // findNext just returned true is a transient under-count (match found+selected, decorations not
  // yet registered), shown as a quiet pending '' until the settle re-search converges the count.
  const none = query !== '' && results.count === 0 && !lastFound
  const label = query
    ? results.count === 0 && lastFound
      ? ''
      : formatMatchCount(results.index, results.count)
    : ''

  return (
    <div
      className="tf-find nodrag nowheel"
      data-test="terminal-find"
      // The well's onMouseDown focuses xterm — stop it here or clicking the bar would yank focus
      // out of the input back into the terminal.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="tf-glass" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={inputRef}
        className="tf-input"
        data-test="terminal-find-input"
        aria-label="Find in terminal"
        placeholder="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span
        className={none ? 'tf-count warn' : 'tf-count'}
        data-test="terminal-find-count"
        aria-live="polite"
      >
        {label}
      </span>
      <span className="tf-sep" />
      <button
        type="button"
        className={caseSensitive ? 'tf-opt is-on' : 'tf-opt'}
        title="Match case"
        aria-pressed={caseSensitive}
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button
        type="button"
        className={regex ? 'tf-opt is-on' : 'tf-opt'}
        title="Use regular expression"
        aria-pressed={regex}
        onClick={() => setRegex((v) => !v)}
      >
        .*
      </button>
      <span className="tf-sep" />
      <button
        type="button"
        className="tf-btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={none || query === ''}
        onClick={() => step('prev')}
      >
        ↑
      </button>
      <button
        type="button"
        className="tf-btn"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={none || query === ''}
        onClick={() => step('next')}
      >
        ↓
      </button>
      <span className="tf-sep" />
      <button
        type="button"
        className="tf-btn tf-close"
        title="Close (Esc)"
        aria-label="Close find"
        onClick={api.close}
      >
        ✕
      </button>
    </div>
  )
}

export const TerminalFindBar = memo(TerminalFindBarImpl)
