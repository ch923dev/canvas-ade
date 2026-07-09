/**
 * Tier-1 reopen digest panel (presentational). Renders the CanvasDigest from
 * `buildDigest` (T-D1) as an auto slide-in side panel of per-board cards. Pure: all
 * state (open/closed) is owned by the container in Canvas.tsx. No LLM / no key — this
 * is the no-cost reopen context. T-M4: renders cached Tier-2 prose (the `prose` prop,
 * heading-stripped) when present, else the Tier-1 lines.
 */
import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { CanvasDigest } from '../lib/digest'
import { stripHeading } from '../lib/digest'
import { PROSE_CLAMP_CHARS, digestStatusTone, type DigestRefreshResult } from '../lib/digestPanel'

const TYPE_TAG: Record<string, string> = {
  terminal: 'TERM',
  browser: 'WEB',
  planning: 'PLAN'
}

export interface DigestPanelProps {
  digest: CanvasDigest
  /** T-M4: cached Tier-2 prose by board id (raw board-<id>.md). Absent → Tier-1 lines. */
  prose?: Record<string, string>
  /**
   * T-F4: force a re-summary of one board, then refresh its prose. The container owns the IPC
   * (memory.refresh → memory.readBoards → setProse); the panel only drives the ⟳ + "updating…"
   * state. Absent → no refresh control is rendered (keeps the panel usable with no brain wired).
   * MCP-04: may resolve to a {@link DigestRefreshResult} whose `message` the panel shows on the
   * card when the refresh produced nothing (no key / budget / error).
   */
  onRefresh?: (boardId: string) => Promise<DigestRefreshResult | void> | DigestRefreshResult | void
  open: boolean
  onOpen: () => void
  onClose: () => void
}

function DigestPanelImpl({
  digest,
  prose,
  onRefresh,
  open,
  onOpen,
  onClose
}: DigestPanelProps): ReactElement {
  // T-F3 a11y: the panel stays mounted + slid off-screen when closed, so without `inert` its
  // buttons keep stealing focus/Tab. React 18.3 doesn't render a boolean `inert` prop, so reflect
  // it imperatively (presence = inert) — open removes it, closed sets it. (aria-hidden stays for AT.)
  const asideRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = asideRef.current
    if (!el) return
    if (open) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  }, [open])

  // T-F4: per-card "updating…" state while a manual refresh is in flight. A board already
  // refreshing ignores repeat clicks. We never read back into prose here — the container's
  // onRefresh rewrites the prose prop; this only gates the spinner.
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  // MCP-08: per-card "show full prose" state — long Tier-2 prose is clamped by default.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // MCP-04: per-card transient feedback message from the last refresh that produced nothing.
  const [feedback, setFeedback] = useState<Record<string, string>>({})
  // Auto-dismiss the feedback a few seconds after the last one lands (it's an at-a-glance hint, not
  // a persistent error). Re-arms whenever `feedback` changes, so a newer message resets the clock.
  useEffect(() => {
    if (Object.keys(feedback).length === 0) return
    const t = setTimeout(() => setFeedback({}), 8000)
    return () => clearTimeout(t)
  }, [feedback])

  const toggleExpanded = useCallback((boardId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(boardId)) next.delete(boardId)
      else next.add(boardId)
      return next
    })
  }, [])

  const refresh = useCallback(
    async (boardId: string): Promise<void> => {
      if (!onRefresh) return
      let started = false
      setBusy((prev) => {
        if (prev.has(boardId)) return prev // already in flight → no-op
        started = true
        const next = new Set(prev)
        next.add(boardId)
        return next
      })
      if (!started) return
      try {
        const res = await onRefresh(boardId)
        // MCP-04: surface the reason a refresh produced nothing; clear any stale note on success.
        setFeedback((prev) => {
          const msg = res && typeof res === 'object' ? res.message : undefined
          if (msg) return { ...prev, [boardId]: msg }
          if (!(boardId in prev)) return prev
          const next = { ...prev }
          delete next[boardId]
          return next
        })
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(boardId)
          return next
        })
      }
    },
    [onRefresh]
  )

  return (
    <>
      {!open && (
        <button
          type="button"
          className="digest-reopen"
          data-test="digest-reopen"
          onClick={onOpen}
          title="Show project context"
        >
          Context
        </button>
      )}
      <aside
        ref={asideRef}
        className="digest-panel"
        data-test="digest-panel"
        data-open={open}
        aria-hidden={!open}
      >
        <header className="digest-head">
          <span className="digest-head-title">Project context</span>
          <button
            type="button"
            className="digest-close"
            data-test="digest-close"
            onClick={onClose}
            aria-label="Dismiss context panel"
          >
            ✕
          </button>
        </header>
        <p className="digest-sub">{digest.header}</p>
        <div className="digest-list">
          {digest.boards.map((b) => (
            <article key={b.boardId} className="digest-card" data-test="digest-card">
              <div className="digest-card-top">
                <span className="digest-tag">{TYPE_TAG[b.type] ?? b.type.toUpperCase()}</span>
                <span className="digest-card-title">{b.title}</span>
                <span
                  className="digest-status"
                  data-status={b.status}
                  data-tone={digestStatusTone(b.status)}
                >
                  {b.status}
                </span>
                {onRefresh && (
                  <button
                    type="button"
                    className="digest-refresh"
                    data-test="digest-refresh"
                    data-busy={busy.has(b.boardId)}
                    disabled={busy.has(b.boardId)}
                    onClick={() => void refresh(b.boardId)}
                    aria-label={`Refresh summary for ${b.title}`}
                    title="Refresh summary"
                  >
                    ⟳
                  </button>
                )}
              </div>
              {(() => {
                const raw = prose?.[b.boardId]
                const body = raw ? stripHeading(raw) : ''
                if (!body) {
                  return (
                    <ul className="digest-lines">
                      {b.lines.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  )
                }
                // MCP-08: clamp long prose behind a Show more / less toggle (heuristic on length).
                const clampable = body.length > PROSE_CLAMP_CHARS
                const isExpanded = expanded.has(b.boardId)
                return (
                  <>
                    <p
                      className="digest-prose"
                      data-test="digest-prose"
                      data-clamped={clampable && !isExpanded}
                    >
                      {body}
                    </p>
                    {clampable && (
                      <button
                        type="button"
                        className="digest-prose-toggle"
                        data-test="digest-prose-toggle"
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpanded(b.boardId)}
                      >
                        {isExpanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </>
                )
              })()}
              {/* MCP-04: why the last refresh produced nothing (no key / budget / error). */}
              {feedback[b.boardId] && (
                <p className="digest-feedback" data-test="digest-feedback" role="status">
                  {feedback[b.boardId]}
                </p>
              )}
            </article>
          ))}
        </div>
      </aside>
    </>
  )
}

// H8: memoized. CanvasInner re-renders on every board-drag frame + planning keystroke (it
// subscribes to the whole `boards` array); this stops the panel reconciling on re-renders whose
// props are unchanged. NOTE its `digest`/`prose` DO change identity when `boards` changes (they are
// derived `[boards, connectors]` — see M8), so during an actual drag the memo is a partial win;
// full drag insulation is M8 (gate/position-strip the digest), out of scope for this pass.
export const DigestPanel = memo(DigestPanelImpl)
