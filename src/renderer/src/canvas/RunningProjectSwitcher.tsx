/**
 * The running-projects switcher overlay (Alt-Tab-style). Mounted once at the App root so it
 * survives a project switch. Opens off the switch hotkey (useProjectSwitchHotkey drives the
 * store), shows the currently-running projects — the active one first, then backgrounded residents
 * — over a frosted, dimmed whole-app backdrop, and commits the highlighted pick through the shared
 * performProjectSwitch pipeline.
 *
 * Interaction (locked design): the hotkey opens + advances the highlight; Tab / ] / arrows advance,
 * Shift+Tab / [ go back, Enter or a click opens the highlighted project, Esc cancels with no change.
 * Cold recents never appear here — the universe is running projects only, snapshotted once by the
 * store so the cycle is stable.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useRunningSwitcherStore } from '../store/runningSwitcherStore'
import { performProjectSwitch } from '../store/projectSwitch'
import { bgBadge, toastLockedSwitch } from './projectSessionsShared'

export function RunningProjectSwitcher(): ReactElement | null {
  const open = useRunningSwitcherStore((s) => s.open)
  const cards = useRunningSwitcherStore((s) => s.cards)
  const index = useRunningSwitcherStore((s) => s.index)
  const advance = useRunningSwitcherStore((s) => s.advance)
  const setIndex = useRunningSwitcherStore((s) => s.setIndex)
  const close = useRunningSwitcherStore((s) => s.close)
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

        <div className="rps-cards" role="listbox" aria-label="Running projects">
          {cards.map((c, i) => {
            const live = c.active || c.terminalsRunning + c.previews > 0
            const selected = i === index
            return (
              <button
                key={c.dir}
                type="button"
                role="option"
                aria-selected={selected}
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
            No other project is running. Open one from the switcher pill or your recents — the
            switch key only cycles projects you&rsquo;re currently working in.
          </div>
        ) : (
          <div className="rps-foot">
            <span>
              <span className="rps-key">Tab</span> advance
            </span>
            <span>
              <span className="rps-key">Shift+Tab</span> back
            </span>
            <span>
              <span className="rps-key">↵</span> open
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
