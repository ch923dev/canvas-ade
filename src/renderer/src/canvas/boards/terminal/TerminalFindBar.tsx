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
import { buildSearchOptions, formatMatchCount } from './terminalSearch'

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
  // skip; the count updates via the onDidChangeResults listener above, so no setState runs here.
  // A bad regex mid-typing makes findNext throw — swallow it; the count reports 0 and the bar
  // stays usable.
  useEffect(() => {
    const addon = api.addonRef.current
    if (!addon) return
    if (!query) {
      addon.clearDecorations()
      return
    }
    try {
      addon.findNext(query, buildSearchOptions({ caseSensitive, regex, incremental: true }))
    } catch {
      /* invalid regex while typing */
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
    const opts = buildSearchOptions({ caseSensitive, regex, incremental: false })
    try {
      if (dir === 'prev') addon.findPrevious(query, opts)
      else addon.findNext(query, opts)
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

  const label = query ? formatMatchCount(results.index, results.count) : ''
  const none = query !== '' && results.count === 0

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
        disabled={none || !label}
        onClick={() => step('prev')}
      >
        ↑
      </button>
      <button
        type="button"
        className="tf-btn"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={none || !label}
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
