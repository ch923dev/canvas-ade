/**
 * The running-projects switcher overlay (Alt-Tab-style). Mounted once at the App root so it
 * survives a project switch. Opens off the switch hotkey (useProjectSwitchHotkey drives the
 * store), shows the currently-running projects — the active one first, then backgrounded residents
 * — over a frosted, dimmed whole-app backdrop, and commits the highlighted pick through the shared
 * performProjectSwitch pipeline.
 *
 * Interaction (locked design, R16): the hotkey opens + advances the highlight; RELEASING the held
 * Ctrl/Cmd commits the highlighted card — matching Windows Alt-Tab and VS Code's Ctrl+Tab, which
 * are both commit-on-release with a frozen MRU order. Tab / ] / arrows advance, Shift+Tab / [ go
 * back, Enter or a click remain explicit commits, Esc cancels with no change. Cold recents never
 * appear here — the universe is running projects only, snapshotted once by the store so the cycle
 * is stable.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useRunningSwitcherStore } from '../store/runningSwitcherStore'
import { performProjectSwitch } from '../store/projectSwitch'
import { bgBadge, toastLockedSwitch } from './projectSessionsShared'

/** How the held modifier is spelled in the footer hint (the accelerator is user-rebindable, so
 *  this follows what MAIN actually bound rather than assuming Ctrl). */
const HOLD_LABEL: Record<'Control' | 'Meta' | 'Alt', string> = {
  Control: 'Ctrl',
  Meta: '⌘',
  Alt: 'Alt'
}

export function RunningProjectSwitcher(): ReactElement | null {
  const open = useRunningSwitcherStore((s) => s.open)
  const cards = useRunningSwitcherStore((s) => s.cards)
  const index = useRunningSwitcherStore((s) => s.index)
  const advance = useRunningSwitcherStore((s) => s.advance)
  const setIndex = useRunningSwitcherStore((s) => s.setIndex)
  const close = useRunningSwitcherStore((s) => s.close)
  const holdKey = useRunningSwitcherStore((s) => s.holdKey)
  const holdReleased = useRunningSwitcherStore((s) => s.holdReleased)
  const panelRef = useRef<HTMLDivElement>(null)
  // Cached canvas thumbnails per dir (data URLs) — a miss falls back to the dot-grid placeholder.
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  // Commit reads the LIVE store (not a render-time closure) so a keypress lands on the current
  // highlight. The active card (or none) just dismisses — there is nothing to switch to.
  const commit = useCallback((i: number): void => {
    const s = useRunningSwitcherStore.getState()
    const card = s.cards[i]
    s.close()
    if (!card || card.active) return
    void performProjectSwitch(() => window.api.project.open(card.dir), {
      incomingName: card.name
    }).then(toastLockedSwitch)
  }, [])

  // R16 commit-on-release. The release itself is observed by useProjectSwitchHotkey (armed at
  // chord time, because a fast tap lets go before this component even mounts); this effect is the
  // other half — the moment an OPEN overlay sees the hold let go, the highlight is committed.
  // Landing here already-released is the normal fast-tap case, not an edge case: the overlay
  // flashes and the switch runs, exactly like a quick Alt+Tab.
  useEffect(() => {
    if (!open || holdKey === null || !holdReleased) return
    commit(useRunningSwitcherStore.getState().index)
  }, [open, holdKey, holdReleased, commit])

  // Keyboard nav while open — window capture so it works regardless of where focus sat when the
  // overlay opened. Handled keys are swallowed (Tab must not move DOM focus behind the scrim).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      let handled = true
      switch (e.key) {
        case 'Tab':
          advance(e.shiftKey ? -1 : 1)
          break
        case 'ArrowRight':
        case 'ArrowDown':
        case ']':
          advance(1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
        case '[':
          advance(-1)
          break
        case 'Enter':
          commit(useRunningSwitcherStore.getState().index)
          break
        case 'Escape':
          close()
          break
        default:
          handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, advance, close, commit])

  // Pull the thumbnails once per interaction; the cleanup clears them on close so a stale snapshot
  // never flashes on the next open.
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.all(
      cards.map(
        async (c) => [c.dir, await window.api.project.thumb(c.dir).catch(() => null)] as const
      )
    ).then((pairs) => {
      if (!alive) return
      const next: Record<string, string> = {}
      for (const [dir, url] of pairs) if (url) next[dir] = url
      setThumbs(next)
    })
    return () => {
      alive = false
      setThumbs({})
    }
  }, [open, cards])

  // Move focus onto the panel on open so the surface reads as modal to AT (keydown is on window,
  // so nav itself doesn't depend on this).
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null
  const single = cards.length === 1

  return (
    <div
      className="rps-overlay"
      data-testid="running-switcher"
      onMouseDown={(e) => {
        // A backdrop click (outside the panel) cancels — mirrors modal dismiss.
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        className="rps-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Switch project"
        tabIndex={-1}
      >
        <div className="rps-head">
          <span className="rps-diamond" aria-hidden />
          <span className="rps-title">
            Switch project <b>· running</b>
          </span>
          <span className="rps-count">{cards.length} running</span>
        </div>

        {/* A group of choice buttons, not a listbox: an ARIA `option` must not be interactive,
            so the highlighted card is marked with aria-current instead of role=option/aria-selected. */}
        <div className="rps-cards" role="group" aria-label="Running projects">
          {cards.map((c, i) => {
            const live = c.active || c.terminalsRunning + c.previews > 0
            const selected = i === index
            return (
              <button
                key={c.dir}
                type="button"
                aria-current={selected ? 'true' : undefined}
                className={selected ? 'rps-card rps-sel' : 'rps-card'}
                style={single ? { width: '100%' } : undefined}
                title={c.dir}
                onMouseEnter={() => setIndex(i)}
                onClick={() => commit(i)}
              >
                <span
                  className="rps-thumb"
                  style={
                    thumbs[c.dir]
                      ? { backgroundImage: `url(${thumbs[c.dir]})`, backgroundSize: 'cover' }
                      : undefined
                  }
                />
                <span className="rps-meta">
                  <span className={live ? 'rps-dot rps-live' : 'rps-dot rps-idle'} aria-hidden />
                  <span className="rps-name">{c.name}</span>
                  {c.active ? (
                    <span className="rps-tagnow">now</span>
                  ) : (
                    <span className="rps-badge">
                      {c.terminalsRunning + c.previews > 0 ? bgBadge(c) : 'idle'}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>

        {single ? (
          <div className="rps-empty">
            Only one project is running. Open another from the switcher pill or your recents — the
            switch key cycles the projects you have running.
          </div>
        ) : (
          <div className="rps-foot">
            {/* R16: release is the primary gesture now, so it is named FIRST — and it shares the
                one "open" cell with Enter rather than adding a second cell that says the same
                word twice. A modifier-free rebind (holdKey null) has nothing to release, so that
                case keeps the original Enter-only hint. */}
            <span>
              {holdKey !== null && (
                <>
                  release <span className="rps-key">{HOLD_LABEL[holdKey]}</span> /{' '}
                </>
              )}
              <span className="rps-key">↵</span> open
            </span>
            <span>
              <span className="rps-key">Tab</span> advance
            </span>
            <span>
              <span className="rps-key">Shift+Tab</span> back
            </span>
            <span>
              <span className="rps-key">Esc</span> cancel
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
